// Win32 heap emulation (HeapCreate/HeapAlloc/...). Segregated size classes carved from chunks obtained from the VM manager.
import type { GuestMem } from "./mem.ts";
import type { Vm } from "./vm.ts";
import { PAGE_READWRITE } from "./vm.ts";

const HDR = 16; // block header (keeps payload 16-byte aligned)
const MAGIC = 0xa110c8ed;
const CHUNK = 1024 * 1024;
const LARGE = 256 * 1024; // allocations above this get their own region

export const HEAP_ZERO_MEMORY = 8, HEAP_NO_SERIALIZE = 1, HEAP_GENERATE_EXCEPTIONS = 4;

function classOf(payload: number): number {
  // returns class index; capacity(class) >= payload
  if (payload <= 1024) return Math.max(0, Math.ceil(payload / 16) - 1); // 0..63 => 16..1024
  // powers of two with 4 steps per doubling: 1280,1536,1792,2048, 2560,...
  let c = 64;
  let base = 1024;
  while (base < payload) {
    const step = base / 4;
    for (let k = 1; k <= 4; k++) {
      if (base + step * k >= payload) return c + k - 1;
    }
    c += 4;
    base *= 2;
  }
  return c;
}
function capacityOf(cls: number): number {
  if (cls < 64) return (cls + 1) * 16;
  const j = cls - 64;
  const base = 1024 * Math.pow(2, Math.floor(j / 4));
  return base + (base / 4) * ((j % 4) + 1);
}

export class Heap {
  readonly mem: GuestMem;
  readonly vm: Vm;
  readonly handle: number;
  readonly flags: number;
  private free: number[][] = [];
  private bumpPtr = 0;
  private bumpEnd = 0;
  private chunks: number[] = [];
  private large = new Set<number>();
  allocated = 0;
  count = 0;
  constructor(mem: GuestMem, vm: Vm, handle: number, flags: number) {
    this.mem = mem;
    this.vm = vm;
    this.handle = handle;
    this.flags = flags;
  }

  private newChunk(min: number): boolean {
    const size = Math.max(CHUNK, Math.ceil((min + HDR) / 65536) * 65536);
    const base = this.vm.alloc(size, { commit: true, prot: PAGE_READWRITE, tag: "heap" });
    if (!base) return false;
    this.chunks.push(base);
    this.bumpPtr = base;
    this.bumpEnd = base + size;
    return true;
  }

  alloc(size: number, flags = 0): number {
    if (size < 0 || size > 0x7fffffff) return 0;
    const payload = Math.max(size, 1);
    let p: number;
    if (payload > LARGE) {
      const total = payload + HDR;
      const base = this.vm.alloc(total, { commit: true, prot: PAGE_READWRITE, tag: "heap-large" });
      if (!base) return 0;
      p = base + HDR;
      this.mem.w32(base, MAGIC);
      this.mem.w32(base + 4, payload);
      this.mem.w32(base + 8, 0xffffffff); // class = large
      this.mem.w32(base + 12, this.handle);
      this.large.add(base);
    } else {
      const cls = classOf(payload);
      const cap = capacityOf(cls);
      const fl = this.free[cls];
      if (fl && fl.length) {
        const blk = fl.pop()!;
        p = blk + HDR;
        this.mem.w32(blk + 4, size);
      } else {
        if (this.bumpPtr + HDR + cap > this.bumpEnd && !this.newChunk(cap)) return 0;
        const blk = this.bumpPtr;
        this.bumpPtr += HDR + cap;
        this.mem.w32(blk, MAGIC);
        this.mem.w32(blk + 4, size);
        this.mem.w32(blk + 8, cls);
        this.mem.w32(blk + 12, this.handle);
        p = blk + HDR;
      }
      // fresh bump memory from a new chunk is already zero, recycled memory may not be
      if (flags & HEAP_ZERO_MEMORY) this.mem.fill(p, 0, size);
      this.allocated += cap;
      this.count++;
      return p;
    }
    if (flags & HEAP_ZERO_MEMORY) this.mem.fill(p, 0, size);
    this.allocated += size;
    this.count++;
    return p;
  }

  owns(p: number): boolean {
    if (!p || p < HDR) return false;
    const blk = p - HDR;
    return this.mem.r32(blk) === MAGIC && this.mem.r32(blk + 12) === this.handle;
  }

  size(p: number): number {
    return this.mem.r32(p - HDR + 4);
  }

  free_(p: number): boolean {
    if (!this.owns(p)) return false;
    const blk = p - HDR;
    const cls = this.mem.r32(blk + 8);
    this.mem.w32(blk, 0xdeadc0de);
    if (cls === 0xffffffff) {
      this.large.delete(blk);
      this.allocated -= this.mem.r32(blk + 4);
      this.vm.release(blk);
    } else {
      this.mem.w32(blk, MAGIC);
      this.mem.w32(blk + 4, 0xfeeefeee);
      (this.free[cls] ??= []).push(blk);
      this.allocated -= capacityOf(cls);
    }
    this.count--;
    return true;
  }

  realloc(p: number, size: number, flags = 0): number {
    if (!p) return this.alloc(size, flags);
    if (!this.owns(p)) return 0;
    const blk = p - HDR;
    const cls = this.mem.r32(blk + 8);
    const old = this.mem.r32(blk + 4);
    const cap = cls === 0xffffffff ? old : capacityOf(cls);
    if (size <= cap && size > 0) {
      this.mem.w32(blk + 4, size);
      if ((flags & HEAP_ZERO_MEMORY) && size > old) this.mem.fill(p + old, 0, size - old);
      return p;
    }
    const np = this.alloc(size, 0);
    if (!np) return 0;
    this.mem.copy(np, p, Math.min(old, size));
    if ((flags & HEAP_ZERO_MEMORY) && size > old) this.mem.fill(np + old, 0, size - old);
    this.free_(p);
    return np;
  }
}
