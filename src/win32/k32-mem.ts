// kernel32: heaps, virtual memory, global/local allocation, file mappings.
import type { Process } from "./process.ts";
import { ERROR } from "./k32-core.ts";
import { HEAP_ZERO_MEMORY } from "./heap.ts";
import {
  MEM_COMMIT, MEM_DECOMMIT, MEM_FREE, MEM_RELEASE, MEM_RESERVE, MEM_TOP_DOWN, PAGE, PAGE_READWRITE, PAGE_NOACCESS,
} from "./vm.ts";

export function installKernel32Memory(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;
  const vm = p.vm;

  // ---- heaps ----
  const heapOf = (h: number) => p.heaps.get(h);
  k.fn("GetProcessHeap", () => p.processHeap.handle);
  k.fn("HeapCreate", (c) => p.createHeap(c.arg(0), c.arg(1)).handle);
  k.fn("HeapDestroy", (c) => { p.heaps.delete(c.arg(0)); return 1; });
  k.fn("HeapAlloc", (c) => {
    const h = heapOf(c.arg(0));
    if (!h) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const r = h.alloc(c.arg(2), c.arg(1));
    if (!r) p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
    return r;
  });
  k.fn("HeapReAlloc", (c) => {
    const h = heapOf(c.arg(0));
    if (!h) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const r = h.realloc(c.arg(2), c.arg(3), c.arg(1));
    if (!r) p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
    return r;
  });
  k.fn("HeapFree", (c) => {
    const h = heapOf(c.arg(0));
    if (!h) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (!c.arg(2)) return 1;
    return h.free_(c.arg(2)) ? 1 : 0;
  });
  k.fn("HeapSize", (c) => {
    const h = heapOf(c.arg(0));
    if (!h || !h.owns(c.arg(2))) return 0xffffffffffffffffn;
    return h.size(c.arg(2));
  });
  k.fn("HeapValidate", (c) => { const h = heapOf(c.arg(0)); return h && (!c.arg(2) || h.owns(c.arg(2))) ? 1 : 0; });
  k.fn("HeapCompact", () => 0x10000);
  k.fn("HeapLock", () => 1);
  k.fn("HeapUnlock", () => 1);
  k.fn("HeapWalk", () => { p.setLastError(ERROR.NO_MORE_FILES); return 0; });
  k.fn("HeapSetInformation", () => 1);
  k.fn("HeapQueryInformation", (c) => { if (c.arg(3)) mem.w64(c.arg(3), 8n); if (c.arg(2) && c.arg(2) >= 4) mem.w32(c.arg(2), 0); return 1; });
  k.fn("GetProcessHeaps", (c) => { const hs = [...p.heaps.keys()]; for (let i = 0; i < Math.min(hs.length, c.arg(0)); i++) mem.wptr(c.arg(1) + i * 8, hs[i]); return hs.length; });

  // ---- global / local (fixed and "moveable" blocks, both backed by the process heap) ----
  const GMEM_ZEROINIT = 0x40;
  const galloc = (flags: number, size: number) => {
    const r = p.processHeap.alloc(size, flags & GMEM_ZEROINIT ? HEAP_ZERO_MEMORY : 0);
    if (!r) p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
    return r;
  };
  for (const pre of ["Global", "Local"]) {
    k.fn(pre + "Alloc", (c) => galloc(c.arg(0), c.arg(1)));
    k.fn(pre + "ReAlloc", (c) => {
      const r = p.processHeap.realloc(c.arg(0), c.arg(1), c.arg(2) & GMEM_ZEROINIT ? HEAP_ZERO_MEMORY : 0);
      if (!r) p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
      return r;
    });
    k.fn(pre + "Free", (c) => { if (c.arg(0)) p.processHeap.free_(c.arg(0)); return 0; });
    k.fn(pre + "Lock", (c) => c.arg(0));
    k.fn(pre + "Unlock", () => 0);
    k.fn(pre + "Handle", (c) => c.arg(0));
    k.fn(pre + "Size", (c) => (p.processHeap.owns(c.arg(0)) ? p.processHeap.size(c.arg(0)) : 0));
    k.fn(pre + "Flags", () => 0);
    k.fn(pre + "Compact", () => 0);
  }

  // ---- virtual memory ----
  const virtualAlloc = (addr: number, size: number, type: number, prot: number): number => {
    if (size === 0) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    if (!(type & (MEM_COMMIT | MEM_RESERVE))) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    if (addr && !(type & MEM_RESERVE)) {
      // commit inside an existing reservation
      const r = vm.find(addr);
      if (!r) { p.setLastError(ERROR.INVALID_ADDRESS); return 0; }
      const a0 = Math.floor(addr / PAGE) * PAGE;
      const end = Math.ceil((addr + size) / PAGE) * PAGE;
      if (!vm.commit(a0, end - a0, prot || PAGE_READWRITE)) { p.setLastError(ERROR.NOT_ENOUGH_MEMORY); return 0; }
      return a0;
    }
    const base = vm.alloc(size, { addr, commit: !!(type & MEM_COMMIT), prot: prot || PAGE_READWRITE, topDown: !!(type & MEM_TOP_DOWN), tag: "VirtualAlloc" });
    if (!base) {
      p.setLastError(addr ? ERROR.INVALID_ADDRESS : ERROR.NOT_ENOUGH_MEMORY);
      return 0;
    }
    return base;
  };
  k.fn("VirtualAlloc", (c) => virtualAlloc(c.arg(0), c.arg(1), c.arg(2), c.arg(3)));
  k.fn("VirtualAllocEx", (c) => virtualAlloc(c.arg(1), c.arg(2), c.arg(3), c.arg(4)));
  k.fn("VirtualAllocExNuma", (c) => virtualAlloc(c.arg(1), c.arg(2), c.arg(3), c.arg(4)));
  const virtualFree = (addr: number, size: number, type: number): number => {
    if (type & MEM_RELEASE) {
      if (size !== 0) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
      if (!vm.release(addr)) { p.setLastError(ERROR.INVALID_ADDRESS); return 0; }
      return 1;
    }
    if (type & MEM_DECOMMIT) {
      if (!vm.decommit(Math.floor(addr / PAGE) * PAGE, Math.max(size, 1))) { p.setLastError(ERROR.INVALID_ADDRESS); return 0; }
      return 1;
    }
    p.setLastError(ERROR.INVALID_PARAMETER);
    return 0;
  };
  k.fn("VirtualFree", (c) => virtualFree(c.arg(0), c.arg(1), c.arg(2)));
  k.fn("VirtualFreeEx", (c) => virtualFree(c.arg(1), c.arg(2), c.arg(3)));
  const virtualProtect = (addr: number, size: number, prot: number, oldOut: number) => {
    const old = vm.protect(addr, size, prot);
    if (old < 0) { p.setLastError(ERROR.INVALID_ADDRESS); return 0; }
    if (oldOut) mem.w32(oldOut, old);
    return 1;
  };
  k.fn("VirtualProtect", (c) => virtualProtect(c.arg(0), c.arg(1), c.arg(2), c.arg(3)));
  k.fn("VirtualProtectEx", (c) => virtualProtect(c.arg(1), c.arg(2), c.arg(3), c.arg(4)));
  const virtualQuery = (addr: number, out: number, len: number) => {
    if (len < 48) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    const q = vm.query(addr);
    mem.fill(out, 0, 48);
    mem.wptr(out, q.base);
    mem.wptr(out + 8, q.allocBase);
    mem.w32(out + 16, q.allocProt);
    mem.w64(out + 24, BigInt(q.size));
    mem.w32(out + 32, q.state);
    mem.w32(out + 36, q.state === MEM_FREE ? PAGE_NOACCESS : q.prot);
    mem.w32(out + 40, q.type);
    return 48;
  };
  k.fn("VirtualQuery", (c) => virtualQuery(c.arg(0), c.arg(1), Number(c.arg64(2))));
  k.fn("VirtualQueryEx", (c) => virtualQuery(c.arg(1), c.arg(2), Number(c.arg64(3))));
  k.fn("VirtualLock", () => 1);
  k.fn("VirtualUnlock", () => 1);
  k.fn("FlushInstructionCache", (c) => { if (c.arg(1)) p.m.invalidate(c.arg(1), Math.max(c.arg(2), 1)); return 1; });
  k.fn("IsBadReadPtr", (c) => (c.arg(0) && vm.isCommitted(c.arg(0), Math.max(1, c.arg(1))) ? 0 : 1));
  k.fn("IsBadWritePtr", (c) => (c.arg(0) && vm.isCommitted(c.arg(0), Math.max(1, c.arg(1))) ? 0 : 1));
  k.fn("IsBadCodePtr", (c) => (c.arg(0) && vm.isCommitted(c.arg(0), 1) ? 0 : 1));
  k.fn("IsBadStringPtrA", (c) => (c.arg(0) && vm.isCommitted(c.arg(0), 1) ? 0 : 1));
  k.fn("IsBadStringPtrW", (c) => (c.arg(0) && vm.isCommitted(c.arg(0), 1) ? 0 : 1));
  k.fn("ReadProcessMemory", (c) => {
    mem.copy(c.arg(2), c.arg(1), c.argN(3));
    if (c.arg(4)) mem.w64(c.arg(4), c.arg64(3));
    return 1;
  });
  k.fn("WriteProcessMemory", (c) => {
    mem.copy(c.arg(1), c.arg(2), c.argN(3));
    p.m.invalidate(c.arg(1), c.argN(3));
    if (c.arg(4)) mem.w64(c.arg(4), c.arg64(3));
    return 1;
  });
  k.fn("RtlMoveMemory", (c) => { mem.copy(c.arg(0), c.arg(1), c.argN(2)); });
  k.fn("RtlCopyMemory", (c) => { mem.copy(c.arg(0), c.arg(1), c.argN(2)); });
  k.fn("RtlFillMemory", (c) => { mem.fill(c.arg(0), c.arg(2) & 0xff, c.argN(1)); });
  k.fn("RtlZeroMemory", (c) => { mem.fill(c.arg(0), 0, c.argN(1)); });

  // ---- file mappings (shared memory sections are plain regions) ----
  void MEM_RELEASE;
}
