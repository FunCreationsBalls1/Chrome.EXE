// ntdll: Rtl*/Nt*/Ldr* subset plus the C library functions it exports.
import type { Process } from "./process.ts";
import { ProcessExit } from "./process.ts";
import { ERROR, fileTimeNow } from "./k32-core.ts";
import { decodeAnsi, encodeAnsi } from "./k32-str.ts";
import { VaList, formatPrintf } from "./printf.ts";
import { HEAP_ZERO_MEMORY } from "./heap.ts";
import { PAGE_READWRITE } from "./vm.ts";

export const STATUS = {
  SUCCESS: 0, UNSUCCESSFUL: 0xc0000001, NOT_IMPLEMENTED: 0xc0000002, INVALID_HANDLE: 0xc0000008, INVALID_PARAMETER: 0xc000000d,
  NO_MEMORY: 0xc0000017, ACCESS_DENIED: 0xc0000022, BUFFER_TOO_SMALL: 0xc0000023, OBJECT_NAME_NOT_FOUND: 0xc0000034,
  NOT_SUPPORTED: 0xc00000bb, INFO_LENGTH_MISMATCH: 0xc0000004, DLL_NOT_FOUND: 0xc0000135, PROCEDURE_NOT_FOUND: 0xc000007a,
  TIMEOUT: 0x102, NO_MORE_ENTRIES: 0x8000001a,
} as const;

const ntToDos: Record<number, number> = {
  0: 0, [STATUS.INVALID_HANDLE]: 6, [STATUS.INVALID_PARAMETER]: 87, [STATUS.NO_MEMORY]: 8, [STATUS.ACCESS_DENIED]: 5, [STATUS.OBJECT_NAME_NOT_FOUND]: 2,
  [STATUS.NOT_IMPLEMENTED]: 120, [STATUS.BUFFER_TOO_SMALL]: 122, [STATUS.NOT_SUPPORTED]: 50, [STATUS.DLL_NOT_FOUND]: 126, [STATUS.PROCEDURE_NOT_FOUND]: 127,
  [STATUS.INFO_LENGTH_MISMATCH]: 24, [STATUS.UNSUCCESSFUL]: 31, 0xc000003a: 3, 0xc0000035: 183,
};

export function installNtdll(p: Process) {
  const n = p.hle.module("ntdll.dll");
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;

  // ---- strings ----
  const initUs = (c: any) => {
    const us = c.arg(0), src = c.arg(1);
    if (!src) { mem.fill(us, 0, 16); return; }
    const len = mem.wstr(src).length * 2;
    mem.w16(us, len); mem.w16(us + 2, len + 2); mem.wptr(us + 8, src);
  };
  n.fn("RtlInitUnicodeString", initUs);
  n.fn("RtlInitUnicodeStringEx", (c) => { initUs(c); return 0; });
  const initAs = (c: any) => {
    const as = c.arg(0), src = c.arg(1);
    if (!src) { mem.fill(as, 0, 16); return; }
    const len = mem.cstr(src).length;
    mem.w16(as, len); mem.w16(as + 2, len + 1); mem.wptr(as + 8, src);
  };
  n.fn("RtlInitAnsiString", initAs);
  n.fn("RtlInitString", initAs);
  const usStr = (us: number) => mem.wstrn(mem.r32(us + 8), mem.r16(us) / 2);
  const asStr = (as: number) => decodeAnsi(1252, mem.bytes(mem.r32(as + 8), mem.r16(as)));
  n.fn("RtlFreeUnicodeString", (c) => { const us = c.arg(0); const b = mem.r32(us + 8); if (b) p.processHeap.free_(b); mem.fill(us, 0, 16); });
  n.fn("RtlFreeAnsiString", (c) => { const us = c.arg(0); const b = mem.r32(us + 8); if (b) p.processHeap.free_(b); mem.fill(us, 0, 16); });
  n.fn("RtlAnsiStringToUnicodeString", (c) => {
    const dst = c.arg(0), src = c.arg(1), alloc = c.arg(2) !== 0;
    const s = asStr(src);
    if (alloc) {
      const b = p.processHeap.alloc(s.length * 2 + 2);
      mem.wwstr(b, s);
      mem.w16(dst, s.length * 2); mem.w16(dst + 2, s.length * 2 + 2); mem.wptr(dst + 8, b);
    } else {
      if (mem.r16(dst + 2) < s.length * 2) return STATUS.BUFFER_TOO_SMALL;
      const b = mem.r32(dst + 8);
      for (let i = 0; i < s.length; i++) mem.w16(b + i * 2, s.charCodeAt(i));
      mem.w16(dst, s.length * 2);
    }
    return 0;
  });
  n.fn("RtlUnicodeStringToAnsiString", (c) => {
    const dst = c.arg(0), src = c.arg(1), alloc = c.arg(2) !== 0;
    const { bytes } = encodeAnsi(1252, usStr(src));
    if (alloc) {
      const b = p.processHeap.alloc(bytes.length + 1);
      mem.write(b, bytes);
      mem.w8(b + bytes.length, 0);
      mem.w16(dst, bytes.length); mem.w16(dst + 2, bytes.length + 1); mem.wptr(dst + 8, b);
    } else {
      if (mem.r16(dst + 2) < bytes.length) return STATUS.BUFFER_TOO_SMALL;
      mem.write(mem.r32(dst + 8), bytes);
      mem.w16(dst, bytes.length);
    }
    return 0;
  });
  n.fn("RtlUnicodeStringToInteger", (c) => { const v = parseInt(usStr(c.arg(0)), c.arg(1) || 10); mem.w32(c.arg(2), Number.isNaN(v) ? 0 : v); return 0; });
  n.fn("RtlEqualUnicodeString", (c) => {
    let a = usStr(c.arg(0)), b = usStr(c.arg(1));
    if (c.arg(2)) { a = a.toUpperCase(); b = b.toUpperCase(); }
    return a === b ? 1 : 0;
  });
  n.fn("RtlEqualString", (c) => {
    let a = asStr(c.arg(0)), b = asStr(c.arg(1));
    if (c.arg(2)) { a = a.toUpperCase(); b = b.toUpperCase(); }
    return a === b ? 1 : 0;
  });
  n.fn("RtlCompareUnicodeString", (c) => {
    let a = usStr(c.arg(0)), b = usStr(c.arg(1));
    if (c.arg(2)) { a = a.toUpperCase(); b = b.toUpperCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  n.fn("RtlCopyUnicodeString", (c) => {
    const d = c.arg(0), s = c.arg(1);
    if (!s) { mem.w16(d, 0); return; }
    const len = Math.min(mem.r16(s), mem.r16(d + 2));
    mem.copy(mem.r32(d + 8), mem.r32(s + 8), len);
    mem.w16(d, len);
  });
  n.fn("RtlUpcaseUnicodeChar", (c) => String.fromCharCode(c.arg(0) & 0xffff).toUpperCase().charCodeAt(0));
  n.fn("RtlDowncaseUnicodeChar", (c) => String.fromCharCode(c.arg(0) & 0xffff).toLowerCase().charCodeAt(0));
  n.fn("RtlMultiByteToUnicodeN", (c) => {
    const s = decodeAnsi(1252, mem.bytes(c.arg(2), c.arg(3)));
    const cap = c.arg(1) / 2;
    const n2 = Math.min(s.length, cap);
    for (let i = 0; i < n2; i++) mem.w16(c.arg(0) + i * 2, s.charCodeAt(i));
    if (c.arg(1) !== undefined && c.arg(2) !== undefined) { /* result length */ }
    return 0;
  });
  n.fn("RtlNtStatusToDosError", (c) => ntToDos[c.arg(0)] ?? 317);
  n.fn("RtlGetLastWin32Error", () => p.getLastError());
  n.fn("RtlSetLastWin32Error", (c) => { p.setLastError(c.arg(0)); });
  n.fn("RtlRestoreLastWin32Error", (c) => { p.setLastError(c.arg(0)); });
  n.fn("RtlGetVersion", (c) => {
    const a = c.arg(0);
    mem.w32(a + 4, 10); mem.w32(a + 8, 0); mem.w32(a + 12, 19045); mem.w32(a + 16, 2);
    return 0;
  });
  n.fn("RtlGetNtVersionNumbers", (c) => { mem.w32(c.arg(0), 10); mem.w32(c.arg(1), 0); mem.w32(c.arg(2), 0xf0004ae5); });
  n.fn("RtlGetCurrentPeb", () => p.peb);
  n.fn("RtlIsProcessorFeaturePresent", () => 0);

  // ---- heap ----
  n.fn("RtlCreateHeap", (c) => p.createHeap(c.arg(0)).handle);
  n.fn("RtlDestroyHeap", (c) => { p.heaps.delete(c.arg(0)); return 0; });
  n.fn("RtlAllocateHeap", (c) => p.heaps.get(c.arg(0))?.alloc(c.arg(2), c.arg(1)) ?? 0);
  n.fn("RtlReAllocateHeap", (c) => p.heaps.get(c.arg(0))?.realloc(c.arg(2), c.arg(3), c.arg(1)) ?? 0);
  n.fn("RtlFreeHeap", (c) => (c.arg(2) ? (p.heaps.get(c.arg(0))?.free_(c.arg(2)) ? 1 : 0) : 1));
  n.fn("RtlSizeHeap", (c) => { const h = p.heaps.get(c.arg(0)); return h && h.owns(c.arg(2)) ? h.size(c.arg(2)) : 0xffffffffffffffffn; });
  n.fn("RtlValidateHeap", () => 1);
  n.fn("RtlProcessHeap", () => p.processHeap.handle);
  n.fn("RtlGetProcessHeaps", () => 1);
  n.fn("RtlLockHeap", () => 1);
  n.fn("RtlUnlockHeap", () => 1);
  void HEAP_ZERO_MEMORY;

  // ---- critical sections / misc (share the kernel32 implementation) ----
  for (const [nt, k32] of [["RtlInitializeCriticalSection", "InitializeCriticalSection"], ["RtlInitializeCriticalSectionAndSpinCount", "InitializeCriticalSectionAndSpinCount"],
    ["RtlInitializeCriticalSectionEx", "InitializeCriticalSectionEx"], ["RtlEnterCriticalSection", "EnterCriticalSection"], ["RtlLeaveCriticalSection", "LeaveCriticalSection"],
    ["RtlTryEnterCriticalSection", "TryEnterCriticalSection"], ["RtlDeleteCriticalSection", "DeleteCriticalSection"],
    ["RtlAcquireSRWLockExclusive", "AcquireSRWLockExclusive"], ["RtlReleaseSRWLockExclusive", "ReleaseSRWLockExclusive"], ["RtlAcquireSRWLockShared", "AcquireSRWLockShared"],
    ["RtlReleaseSRWLockShared", "ReleaseSRWLockShared"], ["RtlInitializeSRWLock", "InitializeSRWLock"], ["RtlWakeConditionVariable", "WakeConditionVariable"],
    ["RtlWakeAllConditionVariable", "WakeAllConditionVariable"], ["RtlInitializeConditionVariable", "InitializeConditionVariable"],
    ["RtlInterlockedPushEntrySList", "InterlockedPushEntrySList"], ["RtlInterlockedPopEntrySList", "InterlockedPopEntrySList"], ["RtlInterlockedFlushSList", "InterlockedFlushSList"],
    ["RtlInitializeSListHead", "InitializeSListHead"], ["RtlQueryDepthSList", "QueryDepthSList"]] as const) {
    const a = k.lookup(k32);
    if (a !== undefined) { n.exports.set(nt.toLowerCase(), a); n.names.set(nt.toLowerCase(), nt); }
  }

  // ---- time ----
  n.fn("NtQuerySystemTime", (c) => { mem.w64(c.arg(0), fileTimeNow()); return 0; });
  n.fn("RtlQueryPerformanceCounter", (c) => { mem.w64(c.arg(0), BigInt(Math.floor(performance.now() * 10000))); return 1; });
  n.fn("RtlQueryPerformanceFrequency", (c) => { mem.w64(c.arg(0), 10000000n); return 1; });
  n.fn("RtlTimeToSecondsSince1970", (c) => { mem.w32(c.arg(1), Number((mem.r64(c.arg(0)) - 116444736000000000n) / 10000000n)); return 1; });
  n.fn("RtlSecondsSince1970ToTime", (c) => { mem.w64(c.arg(1), BigInt(c.arg(0)) * 10000000n + 116444736000000000n); });
  n.fn("RtlTimeToTimeFields", (c) => {
    const d = new Date(Number((mem.r64(c.arg(0)) - 116444736000000000n) / 10000n));
    const a = c.arg(1);
    mem.w16(a, d.getUTCFullYear()); mem.w16(a + 2, d.getUTCMonth() + 1); mem.w16(a + 4, d.getUTCDate()); mem.w16(a + 6, d.getUTCHours());
    mem.w16(a + 8, d.getUTCMinutes()); mem.w16(a + 10, d.getUTCSeconds()); mem.w16(a + 12, d.getUTCMilliseconds()); mem.w16(a + 14, d.getUTCDay());
  });
  let seedState = 0x12345678;
  const rnd = () => { seedState = (Math.imul(seedState, 1103515245) + 12345) >>> 0; return seedState; };
  n.fn("RtlRandom", () => rnd() & 0x7fffffff);
  n.fn("RtlRandomEx", () => rnd() & 0x7fffffff);
  n.fn("NtDelayExecution", (c) => { const t = Number(BigInt.asIntN(64, mem.r64(c.arg(1)))); p.sleep(t < 0 ? -t / 10000 : 0); return 0; });
  n.fn("NtYieldExecution", () => { p.sleep(0); return 0; });

  // ---- nt system calls used by common runtimes ----
  n.fn("NtClose", (c) => (p.handles.close(c.arg(0)) ? 0 : STATUS.INVALID_HANDLE));
  n.fn("NtQueryInformationFile", () => STATUS.NOT_SUPPORTED);
  n.fn("NtQuerySystemInformation", (c) => {
    const cls = c.arg(0), buf = c.arg(1), len = c.arg(2), ret = c.arg(3);
    if (cls === 0) { // SystemBasicInformation
      if (len < 64) return STATUS.INFO_LENGTH_MISMATCH;
      mem.fill(buf, 0, 64);
      mem.w32(buf + 4, 10000); mem.w32(buf + 8, 4096); mem.w32(buf + 12, 0x200000); mem.w32(buf + 16, 0x100000); mem.w32(buf + 20, 0x1000);
      mem.w32(buf + 24, 1); mem.w32(buf + 28, 0x10000); mem.w32(buf + 32, 0x1000000); mem.w32(buf + 36, 0x10000);
      mem.wptr(buf + 40, 0x10000); mem.wptr(buf + 48, 0xfffeffff); mem.wptr(buf + 56, 0xf);
      mem.w8(buf + 60, 4);
      if (ret) mem.w32(ret, 64);
      return 0;
    }
    if (cls === 0x4b || cls === 0x62) { if (ret) mem.w32(ret, 0); return STATUS.NOT_SUPPORTED; } // code integrity etc.
    if (cls === 0x23) { // SystemInterruptInformation / processor performance: report zeros
      if (ret) mem.w32(ret, 0);
      return 0;
    }
    return STATUS.NOT_IMPLEMENTED;
  });
  n.fn("NtQueryInformationProcess", (c) => {
    const cls = c.arg(1), buf = c.arg(2), len = c.arg(3), ret = c.arg(4);
    switch (cls) {
      case 0: // ProcessBasicInformation
        mem.fill(buf, 0, 48); mem.wptr(buf + 8, p.peb); mem.wptr(buf + 32, p.pid);
        if (ret) mem.w32(ret, 48);
        return 0;
      case 26: mem.wptr(buf, 0); if (ret) mem.w32(ret, 8); return 0; // Wow64
      case 0x1e: mem.wptr(buf, 0); if (ret) mem.w32(ret, 8); return 0; // DebugPort
      case 0x1f: mem.wptr(buf, 0); if (ret) mem.w32(ret, 8); return STATUS.SUCCESS;
      case 0x1a: mem.wptr(buf, 0); return 0;
      case 20: mem.w32(buf, 4); return 0; // ProcessHandleCount region
      default: void len; return STATUS.NOT_IMPLEMENTED;
    }
  });
  n.fn("NtSetInformationProcess", () => 0);
  n.fn("NtQueryInformationThread", (c) => {
    const cls = c.arg(1), buf = c.arg(2);
    if (cls === 0) { mem.fill(buf, 0, 48); mem.wptr(buf + 8, p.curThread.teb); mem.wptr(buf + 32, p.curThread.id); return 0; }
    return STATUS.NOT_IMPLEMENTED;
  });
  n.fn("NtSetInformationThread", () => 0);
  n.fn("NtTerminateProcess", (c) => { p.exitCode = c.arg(1); p.exited = true; throw new ProcessExit(c.arg(1)); });
  n.fn("NtTerminateThread", () => 0);
  n.fn("NtAllocateVirtualMemory", (c) => {
    const baseP = c.arg(1), sizeP = c.arg(3);
    const addr = mem.r32(baseP);
    const size = mem.r32(sizeP);
    const type = c.arg(4), prot = c.arg(5);
    const a = p.vm.alloc(size, { addr, commit: (type & 0x1000) !== 0, prot: prot || PAGE_READWRITE });
    if (!a) return STATUS.NO_MEMORY;
    mem.wptr(baseP, a);
    return 0;
  });
  n.fn("NtFreeVirtualMemory", (c) => (p.vm.release(mem.r32(c.arg(1))) ? 0 : STATUS.INVALID_PARAMETER));
  n.fn("NtProtectVirtualMemory", (c) => { const old = p.vm.protect(mem.r32(c.arg(1)), mem.r32(c.arg(2)), c.arg(3)); if (old < 0) return STATUS.INVALID_PARAMETER; if (c.arg(4)) mem.w32(c.arg(4), old); return 0; });
  n.fn("NtFlushInstructionCache", (c) => { if (c.arg(1)) p.m.invalidate(c.arg(1), Math.max(1, c.arg(2))); return 0; });
  n.fn("NtWaitForSingleObject", (c) => {
    const kk = p.hle.module("kernel32.dll").lookup("WaitForSingleObject")!;
    void kk;
    return 0;
  });

  // ---- loader ----
  n.fn("LdrAddRefDll", (c) => { const m = p.moduleByHandle(c.arg(1)); if (m) m.refCount++; return 0; });
  n.fn("LdrGetDllHandle", (c) => {
    const m = p.findModule(p.hle.canonical(usStr(c.arg(3))));
    if (!m) return STATUS.DLL_NOT_FOUND;
    mem.wptr(c.arg(4), m.base);
    return 0;
  });
  n.fn("LdrLoadDll", (c) => {
    const m = p.loadLibrary(usStr(c.arg(2)));
    if (!m) return STATUS.DLL_NOT_FOUND;
    if (!m.initialized) p.initModules(m);
    mem.wptr(c.arg(3), m.base);
    return 0;
  });
  n.fn("LdrUnloadDll", () => 0);
  n.fn("LdrGetProcedureAddress", (c) => {
    const mod = p.moduleByHandle(c.arg(0));
    if (!mod) return STATUS.DLL_NOT_FOUND;
    const nameP = c.arg(1);
    const a = nameP ? p.getProcAddress(mod, asStr(nameP), 0) : p.getProcAddress(mod, null, c.arg(2));
    if (!a) return STATUS.PROCEDURE_NOT_FOUND;
    mem.wptr(c.arg(3), a);
    return 0;
  });
  n.fn("LdrFindEntryForAddress", (c) => {
    const m = p.moduleByAddr(c.arg(0));
    if (!m) return STATUS.UNSUCCESSFUL;
    mem.wptr(c.arg(1), m.ldrEntry);
    return 0;
  });
  n.fn("LdrLockLoaderLock", (c) => { if (c.arg(2)) mem.wptr(c.arg(2), 1); return 0; });
  n.fn("LdrUnlockLoaderLock", () => 0);
  n.fn("LdrDisableThreadCalloutsForDll", () => 0);
  n.fn("LdrProcessRelocationBlock", () => 0);
  n.fn("RtlImageNtHeader", (c) => { const b = c.arg(0); return b + mem.r32(b + 0x3c); });
  n.fn("RtlPcToFileHeader", (c) => { const m = p.moduleByAddr(c.arg(0)); if (c.arg(1)) mem.wptr(c.arg(1), m ? m.base : 0); return m ? m.base : 0; });

  // ---- bitmaps ----
  // RTL_BITMAP: SizeOfBitMap (u32 @0), Buffer (ptr @8)
  n.fn("RtlInitializeBitMap", (c) => { mem.w32(c.arg(0), c.arg(2)); mem.wptr(c.arg(0) + 8, c.arg(1)); });
  const bit = (bm: number, i: number) => (mem.r8(mem.r32(bm + 8) + (i >> 3)) >> (i & 7)) & 1;
  const setBit = (bm: number, i: number, v: number) => {
    const a = mem.r32(bm + 8) + (i >> 3);
    mem.w8(a, v ? mem.r8(a) | (1 << (i & 7)) : mem.r8(a) & ~(1 << (i & 7)));
  };
  n.fn("RtlSetBits", (c) => { for (let i = 0; i < c.arg(2); i++) setBit(c.arg(0), c.arg(1) + i, 1); });
  n.fn("RtlClearBits", (c) => { for (let i = 0; i < c.arg(2); i++) setBit(c.arg(0), c.arg(1) + i, 0); });
  n.fn("RtlSetAllBits", (c) => { const sz = mem.r32(c.arg(0)); for (let i = 0; i < sz; i++) setBit(c.arg(0), i, 1); });
  n.fn("RtlClearAllBits", (c) => { const sz = mem.r32(c.arg(0)); for (let i = 0; i < sz; i++) setBit(c.arg(0), i, 0); });
  n.fn("RtlAreBitsClear", (c) => { if (c.arg(1) + c.arg(2) > mem.r32(c.arg(0))) return 0; for (let i = 0; i < c.arg(2); i++) if (bit(c.arg(0), c.arg(1) + i)) return 0; return 1; });
  n.fn("RtlAreBitsSet", (c) => { if (c.arg(1) + c.arg(2) > mem.r32(c.arg(0))) return 0; for (let i = 0; i < c.arg(2); i++) if (!bit(c.arg(0), c.arg(1) + i)) return 0; return 1; });
  const findRun = (bm: number, n2: number, hint: number, want: number): number => {
    const sz = mem.r32(bm);
    for (let pass = 0; pass < 2; pass++) {
      const start = pass === 0 ? hint : 0, end = pass === 0 ? sz : Math.min(sz, hint + n2);
      for (let i = start; i + n2 <= end; i++) {
        let ok = true;
        for (let j = 0; j < n2; j++) if (bit(bm, i + j) !== want) { ok = false; i += j; break; }
        if (ok) return i;
      }
    }
    return 0xffffffff;
  };
  n.fn("RtlFindClearBits", (c) => findRun(c.arg(0), c.arg(1), c.arg(2), 0));
  n.fn("RtlFindSetBits", (c) => findRun(c.arg(0), c.arg(1), c.arg(2), 1));
  n.fn("RtlFindClearBitsAndSet", (c) => { const i = findRun(c.arg(0), c.arg(1), c.arg(2), 0); if (i !== 0xffffffff) for (let j = 0; j < c.arg(1); j++) setBit(c.arg(0), i + j, 1); return i; });

  // ---- debug-trace stubs used by Wine's builtin DLLs ----
  n.fn("__wine_dbg_get_channel_flags", () => 0);
  n.fn("__wine_dbg_header", () => 0);
  n.fn("__wine_dbg_output", () => 0);
  n.fn("__wine_dbg_strdup", (c) => c.arg(0));
  n.fn("__wine_dbg_vsprintf", (c) => c.arg(0));

  // ---- C library functions exported by ntdll ----
  n.fn("memcpy", (c) => { mem.copy(c.arg(0), c.arg(1), c.argN(2)); return c.arg64(0); });
  n.fn("memmove", (c) => { mem.copy(c.arg(0), c.arg(1), c.argN(2)); return c.arg64(0); });
  n.fn("memset", (c) => { mem.fill(c.arg(0), c.arg(1) & 0xff, c.argN(2)); return c.arg64(0); });
  n.fn("memcmp", (c) => {
    const a = mem.bytes(c.arg(0), c.argN(2)), b = mem.bytes(c.arg(1), c.argN(2));
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  });
  n.fn("strlen", (c) => mem.cstr(c.arg(0)).length);
  n.fn("wcslen", (c) => mem.wstr(c.arg(0)).length);
  n.fn("strcmp", (c) => { const a = mem.cstr(c.arg(0)), b = mem.cstr(c.arg(1)); return a < b ? -1 : a > b ? 1 : 0; });
  n.fn("_stricmp", (c) => { const a = mem.cstr(c.arg(0)).toLowerCase(), b = mem.cstr(c.arg(1)).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; });
  n.fn("strcpy", (c) => { mem.wcstr(c.arg(0), mem.cstr(c.arg(1))); return c.arg64(0); });
  n.fn("strcat", (c) => { mem.wcstr(c.arg(0), mem.cstr(c.arg(0)) + mem.cstr(c.arg(1))); return c.arg64(0); });
  n.fn("strchr", (c) => { const s = mem.cstr(c.arg(0)); const i = c.arg(1) === 0 ? s.length : s.indexOf(String.fromCharCode(c.arg(1) & 0xff)); return i < 0 ? 0 : c.arg(0) + i; });
  n.fn("toupper", (c) => (c.arg(0) >= 97 && c.arg(0) <= 122 ? c.arg(0) - 32 : c.arg(0)));
  n.fn("tolower", (c) => (c.arg(0) >= 65 && c.arg(0) <= 90 ? c.arg(0) + 32 : c.arg(0)));
  n.fn("towupper", (c) => String.fromCharCode(c.arg(0) & 0xffff).toUpperCase().charCodeAt(0));
  n.fn("towlower", (c) => String.fromCharCode(c.arg(0) & 0xffff).toLowerCase().charCodeAt(0));
  const vsnprintf = (c: any, wide: boolean) => {
    const buf = c.arg(0), cap = c.argN(1), fmt = c.arg(2), va = c.arg(3);
    const s = formatPrintf(mem, wide ? mem.wstr(fmt) : mem.cstr(fmt), new VaList(mem, va), wide);
    if (wide) { if (cap > s.length) { mem.wwstr(buf, s); return s.length; } if (cap > 0) mem.wwstr(buf, s, cap); return -1; }
    if (cap > s.length) { mem.wcstr(buf, s); return s.length; }
    if (cap > 0) mem.wcstr(buf, s, cap);
    return -1;
  };
  n.fn("_vsnprintf", (c) => vsnprintf(c, false));
  n.fn("_vsnwprintf", (c) => vsnprintf(c, true));
  const variadic = (c: any, fmtIdx: number, wide: boolean): string => {
    // Win64 varargs: remaining args in rcx/rdx/r8/r9 then stack; build an array starting after the format
    const vals: bigint[] = [];
    for (let i = fmtIdx + 1; i < fmtIdx + 1 + 16; i++) vals.push(c.arg64(i));
    const argsObj = new VaListArray(vals);
    return formatPrintf(mem, wide ? mem.wstr(c.arg(fmtIdx)) : mem.cstr(c.arg(fmtIdx)), argsObj, wide);
  };
  n.fn("sprintf", (c) => { const s = variadic(c, 1, false); mem.wcstr(c.arg(0), s); return s.length; });
  n.fn("_snprintf", (c) => { const s = variadic(c, 2, false); const cap = c.argN(1); if (cap > s.length) { mem.wcstr(c.arg(0), s); return s.length; } if (cap > 0) mem.wcstr(c.arg(0), s, cap); return -1; });
  n.fn("swprintf", (c) => { const s = variadic(c, 2, true); mem.wwstr(c.arg(0), s); return s.length; });
  n.fn("_snwprintf", (c) => { const s = variadic(c, 2, true); const cap = c.argN(1); if (cap > s.length) { mem.wwstr(c.arg(0), s); return s.length; } if (cap > 0) mem.wwstr(c.arg(0), s, cap); return -1; });
  n.fn("atoi", (c) => parseInt(mem.cstr(c.arg(0)), 10) | 0);
  n.fn("abs", (c) => Math.abs(c.argI(0)));
  n.fn("qsort", (c) => {
    const base = c.arg(0), cnt = c.argN(1), size = c.argN(2), cmpFn = c.arg(3);
    const items: Uint8Array[] = [];
    for (let i = 0; i < cnt; i++) items.push(mem.bytes(base + i * size, size).slice());
    const tmpA = p.vm.alloc(size * 2 + 32, { commit: true }), tmpB = tmpA + size + 16;
    items.sort((a, b) => {
      mem.write(tmpA, a); mem.write(tmpB, b);
      return Number(BigInt.asIntN(32, p.callGuest(cmpFn, [tmpA, tmpB])));
    });
    items.forEach((it, i) => mem.write(base + i * size, it));
    p.vm.release(tmpA);
  });
  void p.hle.aliases.set("kernelbase.dll", "kernel32.dll");
}

class VaListArray {
  i = 0;
  vals: bigint[];
  constructor(vals: bigint[]) { this.vals = vals; }
  int(): bigint { return this.vals[this.i++] ?? 0n; }
  dbl(): number { const b = this.vals[this.i++] ?? 0n; const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, b, true); return dv.getFloat64(0, true); }
}

void ERROR;
