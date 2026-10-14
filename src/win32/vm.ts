// Guest virtual address space manager (VirtualAlloc/VirtualFree semantics) on top of the wasm linear memory.
import type { Machine } from "../jit/machine.ts";
import { HOST_RESERVED_END } from "../jit/layout.ts";

export const PAGE = 4096;
export const ALLOC_GRAN = 65536;

export const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_DECOMMIT = 0x4000, MEM_RELEASE = 0x8000, MEM_RESET = 0x80000,
  MEM_TOP_DOWN = 0x100000, MEM_WRITE_WATCH = 0x200000, MEM_PHYSICAL = 0x400000, MEM_LARGE_PAGES = 0x20000000;
export const MEM_FREE = 0x10000, MEM_PRIVATE = 0x20000, MEM_MAPPED = 0x40000, MEM_IMAGE = 0x1000000;
export const PAGE_NOACCESS = 1, PAGE_READONLY = 2, PAGE_READWRITE = 4, PAGE_WRITECOPY = 8, PAGE_EXECUTE = 0x10, PAGE_EXECUTE_READ = 0x20,
  PAGE_EXECUTE_READWRITE = 0x40, PAGE_EXECUTE_WRITECOPY = 0x80, PAGE_GUARD = 0x100;

export interface Region {
  base: number; // allocation base
  size: number; // reserved size
  type: number; // MEM_PRIVATE | MEM_IMAGE | MEM_MAPPED
  /** per-page protection (0 = reserved but not committed) */
  prot: Uint16Array;
  initialProt: number;
  tag: string;
}

const SMALL_START = Math.max(HOST_RESERVED_END, 0x01000000);
const SMALL_END = 0x30000000;
const BIG_START = 0x30000000;
const BIG_END = 0xfff00000;
const BIG_THRESHOLD = 128 * 1024 * 1024;

export class Vm {
  readonly m: Machine;
  /** regions sorted by base */
  regions: Region[] = [];
  committedBytes = 0;
  constructor(m: Machine) {
    this.m = m;
  }

  private memBytes(): number {
    return this.m.memory.buffer.byteLength;
  }
  /** make sure the wasm memory covers [0, end) */
  ensure(end: number): boolean {
    const have = this.memBytes();
    if (end <= have) return true;
    const pages = Math.ceil((end - have) / 65536);
    try {
      this.m.memory.grow(pages);
      return true;
    } catch {
      return false;
    }
  }

  find(addr: number): Region | undefined {
    // binary search
    let lo = 0, hi = this.regions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.regions[mid];
      if (addr < r.base) hi = mid - 1;
      else if (addr >= r.base + r.size) lo = mid + 1;
      else return r;
    }
    return undefined;
  }

  private insert(r: Region) {
    let i = 0;
    while (i < this.regions.length && this.regions[i].base < r.base) i++;
    this.regions.splice(i, 0, r);
  }

  /** find a free gap of `size` bytes aligned to `align` in [start, end); lowest address first, or highest if topDown */
  private findGap(size: number, align: number, start: number, end: number, topDown: boolean): number {
    const alignUp = (v: number) => Math.ceil(v / align) * align;
    if (!topDown) {
      let cur = alignUp(start);
      for (const r of this.regions) {
        if (r.base + r.size <= cur) continue;
        if (r.base >= end) break;
        if (cur + size <= r.base) return cur;
        cur = alignUp(r.base + r.size);
      }
      return cur + size <= end ? cur : -1;
    }
    let top = Math.floor(end / align) * align;
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (r.base >= top) continue;
      if (r.base + r.size > top) { top = Math.floor(r.base / align) * align; continue; }
      const cand = Math.floor((top - size) / align) * align;
      if (cand >= r.base + r.size) return cand >= start ? cand : -1;
      top = Math.floor(r.base / align) * align;
    }
    const cand = Math.floor((top - size) / align) * align;
    return cand >= start ? cand : -1;
  }

  /** Reserve (and optionally commit) address space. Returns base or 0 on failure. */
  alloc(size: number, opts: { addr?: number; commit?: boolean; prot?: number; type?: number; tag?: string; topDown?: boolean; align?: number } = {}): number {
    size = Math.ceil(size / PAGE) * PAGE;
    if (size <= 0) return 0;
    const align = opts.align ?? ALLOC_GRAN;
    let base: number;
    if (opts.addr) {
      base = Math.floor(opts.addr / ALLOC_GRAN) * ALLOC_GRAN;
      // verify free
      for (const r of this.regions) if (base < r.base + r.size && base + size > r.base) return 0;
      if (base + size > 0xffffffff) return 0;
    } else if (size >= BIG_THRESHOLD) {
      base = this.findGap(size, align, BIG_START, BIG_END, false);
    } else {
      base = this.findGap(size, align, SMALL_START, SMALL_END, opts.topDown ?? false);
      if (base < 0) base = this.findGap(size, align, BIG_START, BIG_END, false);
    }
    if (base < 0) return 0;
    const r: Region = {
      base, size, type: opts.type ?? MEM_PRIVATE, prot: new Uint16Array(size / PAGE), initialProt: opts.prot ?? PAGE_READWRITE, tag: opts.tag ?? "",
    };
    this.insert(r);
    if (opts.commit) {
      if (!this.commit(base, size, opts.prot ?? PAGE_READWRITE)) {
        this.release(base);
        return 0;
      }
    }
    return base;
  }

  commit(addr: number, size: number, prot: number): boolean {
    const r = this.find(addr);
    if (!r) return false;
    const first = Math.floor((addr - r.base) / PAGE);
    const last = Math.ceil((addr + size - r.base) / PAGE);
    if (last > r.prot.length) return false;
    if (!this.ensure(addr + size + PAGE)) return false;
    for (let p = first; p < last; p++) {
      if (r.prot[p] === 0) {
        this.committedBytes += PAGE;
        r.prot[p] = prot;
      } else r.prot[p] = prot;
    }
    return true;
  }
  decommit(addr: number, size: number): boolean {
    const r = this.find(addr);
    if (!r) return false;
    const first = Math.floor((addr - r.base) / PAGE);
    const last = Math.ceil((addr + size - r.base) / PAGE);
    for (let p = first; p < last && p < r.prot.length; p++) {
      if (r.prot[p] !== 0) {
        r.prot[p] = 0;
        this.committedBytes -= PAGE;
      }
    }
    // decommitted pages read as zero when recommitted
    const a = r.base + first * PAGE;
    this.m.u8.fill(0, a, Math.min(a + (last - first) * PAGE, this.m.u8.length));
    return true;
  }
  protect(addr: number, size: number, prot: number): number | -1 {
    const r = this.find(addr);
    if (!r) return -1;
    const first = Math.floor((addr - r.base) / PAGE);
    const last = Math.ceil((addr + size - r.base) / PAGE);
    if (last > r.prot.length) return -1;
    const old = r.prot[first];
    if (old === 0) return -1;
    for (let p = first; p < last; p++) if (r.prot[p]) r.prot[p] = prot;
    return old;
  }
  release(base: number): boolean {
    const i = this.regions.findIndex((r) => r.base === base);
    if (i < 0) return false;
    const r = this.regions[i];
    for (let p = 0; p < r.prot.length; p++) if (r.prot[p]) this.committedBytes -= PAGE;
    // keep guest data defined: zero released memory so a later reservation sees zero pages
    const end = Math.min(r.base + r.size, this.m.u8.length);
    if (r.base < end) this.m.u8.fill(0, r.base, end);
    this.regions.splice(i, 1);
    return true;
  }

  /** true when the whole range is committed */
  isCommitted(addr: number, size: number): boolean {
    const r = this.find(addr);
    if (!r) return false;
    if (addr + size > r.base + r.size) return false;
    const first = Math.floor((addr - r.base) / PAGE);
    const last = Math.ceil((addr + size - r.base) / PAGE);
    for (let p = first; p < last; p++) if (!r.prot[p]) return false;
    return true;
  }

  /** VirtualQuery: describe the run of pages starting at addr sharing the same state/protection */
  query(addr: number): { base: number; allocBase: number; allocProt: number; size: number; state: number; prot: number; type: number } {
    const page = Math.floor(addr / PAGE) * PAGE;
    const r = this.find(page);
    if (!r) {
      // free region until next region
      let next = 0x100000000;
      for (const q of this.regions) if (q.base > page) { next = q.base; break; }
      return { base: page, allocBase: 0, allocProt: 0, size: next - page, state: MEM_FREE, prot: PAGE_NOACCESS, type: 0 };
    }
    const idx = (page - r.base) / PAGE;
    const pr = r.prot[idx];
    let e = idx + 1;
    while (e < r.prot.length && r.prot[e] === pr) e++;
    return {
      base: page, allocBase: r.base, allocProt: r.initialProt, size: (e - idx) * PAGE,
      state: pr ? MEM_COMMIT : MEM_RESERVE, prot: pr || 0, type: r.type,
    };
  }
}
