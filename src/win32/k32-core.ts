// kernel32: process, module, error, time, system information, environment.
import type { Process, LoadedModule } from "./process.ts";
import { ProcessExit } from "./process.ts";
import * as L from "../jit/layout.ts";

export const ERROR = {
  SUCCESS: 0, INVALID_FUNCTION: 1, FILE_NOT_FOUND: 2, PATH_NOT_FOUND: 3, TOO_MANY_OPEN_FILES: 4, ACCESS_DENIED: 5, INVALID_HANDLE: 6,
  NOT_ENOUGH_MEMORY: 8, INVALID_DATA: 13, OUTOFMEMORY: 14, NO_MORE_FILES: 18, SHARING_VIOLATION: 32, HANDLE_EOF: 38, NOT_SUPPORTED: 50,
  FILE_EXISTS: 80, INVALID_PARAMETER: 87, BROKEN_PIPE: 109, INSUFFICIENT_BUFFER: 122, INVALID_NAME: 123, MOD_NOT_FOUND: 126,
  PROC_NOT_FOUND: 127, DIR_NOT_EMPTY: 145, ALREADY_EXISTS: 183, ENVVAR_NOT_FOUND: 203, NO_DATA: 232, MORE_DATA: 234,
  TIMEOUT: 1460, NOT_FOUND: 1168, INVALID_ADDRESS: 487, NO_UNICODE_TRANSLATION: 1113, IO_PENDING: 997,
  RESOURCE_TYPE_NOT_FOUND: 1813, RESOURCE_NAME_NOT_FOUND: 1814, CALL_NOT_IMPLEMENTED: 120,
} as const;

export const TIME_EPOCH_DIFF = 116444736000000000n; // 100ns ticks between 1601 and 1970

export function fileTimeNow(): bigint {
  return BigInt(Math.floor(Date.now())) * 10000n + TIME_EPOCH_DIFF;
}
export function msToFileTime(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 10000n + TIME_EPOCH_DIFF;
}

declare module "./process.ts" {
  interface Process {
    setLastError(e: number): void;
    getLastError(): number;
    qpcBase: number;
  }
}

export function installKernel32Core(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;
  const cpu = p.cpu;

  (p as any).setLastError = (e: number) => mem.w32(p.curThread.teb + 0x68, e);
  (p as any).getLastError = () => mem.r32(p.curThread.teb + 0x68);
  p.qpcBase = performance.now();

  // ---- errors ----
  k.fn("GetLastError", () => p.getLastError());
  k.fn("SetLastError", (c) => { p.setLastError(c.arg(0)); });
  k.fn("SetLastErrorEx", (c) => { p.setLastError(c.arg(0)); });
  k.fn("SetErrorMode", () => 0);
  k.fn("GetErrorMode", () => 0);
  k.fn("IsDebuggerPresent", () => 0);
  k.fn("CheckRemoteDebuggerPresent", (c) => { mem.w32(c.arg(1), 0); return 1; });
  k.fn("OutputDebugStringA", (c) => { p.log("[dbg] " + mem.cstr(c.arg(0))); });
  k.fn("OutputDebugStringW", (c) => { p.log("[dbg] " + mem.wstr(c.arg(0))); });
  k.fn("DebugBreak", () => { throw new Error("DebugBreak"); });

  // ---- process & thread identity ----
  k.fn("GetCurrentProcess", () => 0xffffffffffffffffn);
  k.fn("GetCurrentProcessId", () => p.pid);
  k.fn("GetCurrentThread", () => 0xfffffffffffffffen);
  k.fn("GetCurrentThreadId", () => p.curThread.id);
  k.fn("GetProcessId", () => p.pid);
  k.fn("GetThreadId", (c) => {
    const o = p.handles.get(c.arg(0));
    return o && o.type === "thread" ? o.thread.id : p.curThread.id;
  });
  k.fn("GetCurrentProcessorNumber", () => 0);
  k.fn("ExitProcess", (c) => {
    p.exitCode = c.arg(0);
    p.exited = true;
    throw new ProcessExit(p.exitCode);
  });
  k.fn("TerminateProcess", (c) => {
    if ((c.argN(0) === 0xffffffff || c.arg(0) === 0xffffffff) || p.handles.get(c.arg(0))?.type === "process") {
      p.exitCode = c.arg(1);
      p.exited = true;
      throw new ProcessExit(p.exitCode);
    }
    return 1;
  });
  k.fn("GetExitCodeProcess", (c) => { mem.w32(c.arg(1), 259); return 1; });
  k.fn("FlushProcessWriteBuffers", () => {});
  k.fn("GetProcessAffinityMask", (c) => { mem.w64(c.arg(1), 0xfn); mem.w64(c.arg(2), 0xfn); return 1; });
  k.fn("SetProcessAffinityMask", () => 1);
  k.fn("GetProcessWorkingSetSize", (c) => { mem.w64(c.arg(1), 0x200000n); mem.w64(c.arg(2), 0x20000000n); return 1; });
  k.fn("SetProcessWorkingSetSize", () => 1);
  k.fn("SetProcessWorkingSetSizeEx", () => 1);
  k.fn("GetPriorityClass", () => 0x20);
  k.fn("SetPriorityClass", () => 1);
  k.fn("IsWow64Process", (c) => { mem.w32(c.arg(1), 0); return 1; });
  k.fn("IsWow64Process2", (c) => { mem.w16(c.arg(1), 0); if (c.arg(2)) mem.w16(c.arg(2), 0x8664); return 1; });
  k.fn("GetProcessHandleCount", (c) => { mem.w32(c.arg(1), 100); return 1; });
  k.fn("GetProcessTimes", (c) => {
    const t = fileTimeNow();
    for (let i = 1; i <= 4; i++) mem.w64(c.arg(i), i === 3 || i === 4 ? 0n : t);
    return 1;
  });
  k.fn("GetThreadTimes", (c) => {
    const t = fileTimeNow();
    for (let i = 1; i <= 4; i++) mem.w64(c.arg(i), i === 3 || i === 4 ? 0n : t);
    return 1;
  });
  k.fn("GetSystemTimes", (c) => {
    for (let i = 0; i < 3; i++) if (c.arg(i)) mem.w64(c.arg(i), 0n);
    return 1;
  });
  k.fn("GetCommandLineA", () => p.ext.cmdA ??= (() => { const a = p.vm.alloc(0x1000, { commit: true, tag: "cmdlineA" }); mem.wcstr(a, p.cmdline); return a; })());
  k.fn("GetCommandLineW", () => p.ext.cmdW ??= (() => { const a = p.vm.alloc(0x2000, { commit: true, tag: "cmdlineW" }); mem.wwstr(a, p.cmdline); return a; })());
  const startupInfo = (c: any, wide: boolean) => {
    const a = c.arg(0);
    mem.fill(a, 0, 104);
    mem.w32(a, 104);
    mem.w32(a + 0x3c, 1); // dwFlags: STARTF_USESHOWWINDOW
    mem.w16(a + 0x40, 1);
    void wide;
  };
  k.fn("GetStartupInfoA", (c) => { startupInfo(c, false); });
  k.fn("GetStartupInfoW", (c) => { startupInfo(c, true); });

  // ---- modules ----
  const hmod = (m: LoadedModule | null | undefined) => (m ? m.base : 0);
  k.fn("GetModuleHandleA", (c) => {
    const n = c.arg(0);
    if (!n) return p.exe!.base;
    const m = p.findModule(p.hle.canonical(mem.cstr(n)));
    if (!m) p.setLastError(ERROR.MOD_NOT_FOUND);
    return hmod(m);
  });
  k.fn("GetModuleHandleW", (c) => {
    const n = c.arg(0);
    if (!n) return p.exe!.base;
    const m = p.findModule(p.hle.canonical(mem.wstr(n)));
    if (!m) p.setLastError(ERROR.MOD_NOT_FOUND);
    return hmod(m);
  });
  const getModuleHandleEx = (c: any, wide: boolean) => {
    const flags = c.arg(0), name = c.arg(1), out = c.arg(2);
    let m: LoadedModule | undefined;
    if (flags & 4) m = p.moduleByAddr(name); // FROM_ADDRESS
    else if (!name) m = p.exe!;
    else m = p.findModule(p.hle.canonical(wide ? mem.wstr(name) : mem.cstr(name)));
    if (!m) { p.setLastError(ERROR.MOD_NOT_FOUND); return 0; }
    if (!(flags & 3)) m.refCount++;
    if (out) mem.wptr(out, m.base);
    return 1;
  };
  k.fn("GetModuleHandleExA", (c) => getModuleHandleEx(c, false));
  k.fn("GetModuleHandleExW", (c) => getModuleHandleEx(c, true));
  const modPathCommon = (c: any, wide: boolean) => {
    const h = c.arg(0), buf = c.arg(1), size = c.arg(2);
    const m = h ? p.moduleByHandle(h) : p.exe!;
    if (!m) { p.setLastError(ERROR.MOD_NOT_FOUND); return 0; }
    const path = m.path;
    if (wide) {
      const n = mem.wwstr(buf, path, size);
      if (n - 1 < path.length) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return n - 1; }
      return n - 1;
    }
    const n = mem.wcstr(buf, path, size);
    if (n - 1 < path.length) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return n - 1; }
    return n - 1;
  };
  k.fn("GetModuleFileNameA", (c) => modPathCommon(c, false));
  k.fn("GetModuleFileNameW", (c) => modPathCommon(c, true));
  const loadLib = (name: string) => {
    const m = p.loadLibrary(name);
    if (!m) {
      p.setLastError(ERROR.MOD_NOT_FOUND);
      return 0;
    }
    if (!m.initialized) p.initModules(m);
    return m.base;
  };
  k.fn("LoadLibraryA", (c) => loadLib(mem.cstr(c.arg(0))));
  k.fn("LoadLibraryW", (c) => loadLib(mem.wstr(c.arg(0))));
  k.fn("LoadLibraryExA", (c) => loadLib(mem.cstr(c.arg(0))));
  k.fn("LoadLibraryExW", (c) => loadLib(mem.wstr(c.arg(0))));
  k.fn("FreeLibrary", (c) => {
    const m = p.moduleByHandle(c.arg(0));
    if (m && m.refCount > 0) m.refCount--;
    return 1;
  });
  k.fn("FreeLibraryAndExitThread", (c) => { throw new ProcessExit(c.arg(1)); });
  k.fn("DisableThreadLibraryCalls", () => 1);
  k.fn("GetProcAddress", (c) => {
    const h = c.arg(0);
    const mod = p.moduleByHandle(h);
    if (!mod) { p.setLastError(ERROR.MOD_NOT_FOUND); return 0; }
    const nm = c.argN(1);
    let a: number;
    if (nm < 0x10000) a = p.getProcAddress(mod, null, nm);
    else a = p.getProcAddress(mod, mem.cstr(nm), 0);
    if (!a) {
      p.setLastError(ERROR.PROC_NOT_FOUND);
      if (nm >= 0x10000) p.log(`[hle] GetProcAddress: ${mod.name}!${mem.cstr(nm)} not found`);
    }
    return a;
  });
  k.fn("ResolveDelayLoadedAPI", () => 0);
  k.fn("DelayLoadFailureHook", () => 0);
  k.fn("GetSystemDirectoryA", (c) => mem.wcstr(c.arg(0), "C:\\Windows\\System32", c.arg(1)) - 1);
  k.fn("GetSystemDirectoryW", (c) => mem.wwstr(c.arg(0), "C:\\Windows\\System32", c.arg(1)) - 1);
  k.fn("GetWindowsDirectoryA", (c) => mem.wcstr(c.arg(0), "C:\\Windows", c.arg(1)) - 1);
  k.fn("GetWindowsDirectoryW", (c) => mem.wwstr(c.arg(0), "C:\\Windows", c.arg(1)) - 1);
  k.fn("GetSystemWindowsDirectoryA", (c) => mem.wcstr(c.arg(0), "C:\\Windows", c.arg(1)) - 1);
  k.fn("GetSystemWindowsDirectoryW", (c) => mem.wwstr(c.arg(0), "C:\\Windows", c.arg(1)) - 1);
  k.fn("GetSystemWow64DirectoryA", () => 0);
  k.fn("GetSystemWow64DirectoryW", () => 0);

  // ---- environment ----
  k.fn("GetEnvironmentStringsW", () => p.buildEnvironmentBlock(true));
  k.fn("GetEnvironmentStringsA", () => p.buildEnvironmentBlock(false));
  k.fn("FreeEnvironmentStringsA", () => 1);
  k.fn("FreeEnvironmentStringsW", () => 1);
  const envLookup = (name: string): string | undefined => {
    const up = name.toLowerCase();
    for (const [kk, v] of p.env) if (kk.toLowerCase() === up) return v;
    return undefined;
  };
  k.fn("GetEnvironmentVariableA", (c) => {
    const v = envLookup(mem.cstr(c.arg(0)));
    if (v === undefined) { p.setLastError(ERROR.ENVVAR_NOT_FOUND); return 0; }
    if (v.length + 1 > c.arg(2)) return v.length + 1;
    mem.wcstr(c.arg(1), v);
    return v.length;
  });
  k.fn("GetEnvironmentVariableW", (c) => {
    const v = envLookup(mem.wstr(c.arg(0)));
    if (v === undefined) { p.setLastError(ERROR.ENVVAR_NOT_FOUND); return 0; }
    if (v.length + 1 > c.arg(2)) return v.length + 1;
    mem.wwstr(c.arg(1), v);
    return v.length;
  });
  const setEnv = (name: string, v: string | null) => {
    for (const kk of [...p.env.keys()]) if (kk.toLowerCase() === name.toLowerCase()) p.env.delete(kk);
    if (v !== null) p.env.set(name, v);
  };
  k.fn("SetEnvironmentVariableA", (c) => { setEnv(mem.cstr(c.arg(0)), c.arg(1) ? mem.cstr(c.arg(1)) : null); return 1; });
  k.fn("SetEnvironmentVariableW", (c) => { setEnv(mem.wstr(c.arg(0)), c.arg(1) ? mem.wstr(c.arg(1)) : null); return 1; });
  const expandEnv = (s: string) => s.replace(/%([^%]+)%/g, (m0, n) => envLookup(n) ?? m0);
  k.fn("ExpandEnvironmentStringsA", (c) => {
    const s = expandEnv(mem.cstr(c.arg(0)));
    if (c.arg(1) && s.length + 1 <= c.arg(2)) mem.wcstr(c.arg(1), s);
    return s.length + 1;
  });
  k.fn("ExpandEnvironmentStringsW", (c) => {
    const s = expandEnv(mem.wstr(c.arg(0)));
    if (c.arg(1) && s.length + 1 <= c.arg(2)) mem.wwstr(c.arg(1), s);
    return s.length + 1;
  });
  k.fn("GetComputerNameA", (c) => { const n = "CHROME-EXE"; mem.wcstr(c.arg(0), n); mem.w32(c.arg(1), n.length); return 1; });
  k.fn("GetComputerNameW", (c) => { const n = "CHROME-EXE"; mem.wwstr(c.arg(0), n); mem.w32(c.arg(1), n.length); return 1; });
  k.fn("GetComputerNameExW", (c) => { const n = "CHROME-EXE"; mem.wwstr(c.arg(1), n); mem.w32(c.arg(2), n.length); return 1; });

  // ---- time ----
  k.fn("GetTickCount", () => Math.floor(performance.now()) >>> 0);
  k.fn("GetTickCount64", () => Math.floor(performance.now()));
  k.fn("QueryPerformanceCounter", (c) => {
    mem.w64(c.arg(0), BigInt(Math.floor((performance.now() - p.qpcBase) * 10000)) + 100000000n);
    return 1;
  });
  k.fn("QueryPerformanceFrequency", (c) => { mem.w64(c.arg(0), 10000000n); return 1; });
  const sysTimeAsFT = (c: any) => { mem.w64(c.arg(0), fileTimeNow()); };
  k.fn("GetSystemTimeAsFileTime", sysTimeAsFT);
  k.fn("GetSystemTimePreciseAsFileTime", sysTimeAsFT);
  const writeSystemTime = (a: number, d: Date, local: boolean) => {
    const g = local ? { y: d.getFullYear(), mo: d.getMonth(), dw: d.getDay(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds() }
      : { y: d.getUTCFullYear(), mo: d.getUTCMonth(), dw: d.getUTCDay(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
    mem.w16(a, g.y); mem.w16(a + 2, g.mo + 1); mem.w16(a + 4, g.dw); mem.w16(a + 6, g.d);
    mem.w16(a + 8, g.h); mem.w16(a + 10, g.mi); mem.w16(a + 12, g.s); mem.w16(a + 14, g.ms);
  };
  k.fn("GetSystemTime", (c) => { writeSystemTime(c.arg(0), new Date(), false); });
  k.fn("GetLocalTime", (c) => { writeSystemTime(c.arg(0), new Date(), true); });
  k.fn("SetSystemTime", () => 0);
  k.fn("SetLocalTime", () => 0);
  const ftToMs = (ft: bigint) => Number((ft - TIME_EPOCH_DIFF) / 10000n);
  k.fn("FileTimeToSystemTime", (c) => { writeSystemTime(c.arg(1), new Date(ftToMs(mem.r64(c.arg(0)))), false); return 1; });
  k.fn("FileTimeToLocalFileTime", (c) => { mem.w64(c.arg(1), mem.r64(c.arg(0)) - BigInt(new Date().getTimezoneOffset()) * 600000000n); return 1; });
  k.fn("LocalFileTimeToFileTime", (c) => { mem.w64(c.arg(1), mem.r64(c.arg(0)) + BigInt(new Date().getTimezoneOffset()) * 600000000n); return 1; });
  k.fn("SystemTimeToFileTime", (c) => {
    const a = c.arg(0);
    const d = Date.UTC(mem.r16(a), mem.r16(a + 2) - 1, mem.r16(a + 6), mem.r16(a + 8), mem.r16(a + 10), mem.r16(a + 12), mem.r16(a + 14));
    mem.w64(c.arg(1), msToFileTime(d));
    return 1;
  });
  k.fn("SystemTimeToTzSpecificLocalTime", (c) => {
    const a = c.arg(1);
    const d = Date.UTC(mem.r16(a), mem.r16(a + 2) - 1, mem.r16(a + 6), mem.r16(a + 8), mem.r16(a + 10), mem.r16(a + 12), mem.r16(a + 14));
    mem.copy(c.arg(2), a, 16);
    void d;
    return 1;
  });
  k.fn("GetTimeZoneInformation", (c) => {
    mem.fill(c.arg(0), 0, 172);
    mem.w32(c.arg(0), (new Date().getTimezoneOffset()) | 0);
    mem.wwstr(c.arg(0) + 4, "UTC", 32);
    return 0;
  });
  k.fn("GetDynamicTimeZoneInformation", (c) => { mem.fill(c.arg(0), 0, 432); return 0; });
  k.fn("GetTimeFormatW", (c) => {
    const d = new Date();
    const s = d.toLocaleTimeString("en-US");
    if (c.arg(5) && c.arg(5) > s.length) { mem.wwstr(c.arg(4), s); return s.length + 1; }
    return s.length + 1;
  });
  k.fn("GetDateFormatW", (c) => {
    const d = new Date();
    const s = d.toLocaleDateString("en-US");
    if (c.arg(5) && c.arg(5) > s.length) { mem.wwstr(c.arg(4), s); return s.length + 1; }
    return s.length + 1;
  });

  // ---- system info ----
  const sysInfo = (c: any) => {
    const a = c.arg(0);
    mem.fill(a, 0, 48);
    mem.w16(a, 9); // PROCESSOR_ARCHITECTURE_AMD64
    mem.w32(a + 4, 4096);
    mem.wptr(a + 8, 0x10000);
    mem.wptr(a + 16, 0xfffeffff);
    mem.wptr(a + 24, 0xf);
    mem.w32(a + 32, 4);
    mem.w32(a + 36, 8664);
    mem.w32(a + 40, 65536);
    mem.w16(a + 44, 6);
    mem.w16(a + 46, 0x3c03);
  };
  k.fn("GetSystemInfo", sysInfo);
  k.fn("GetNativeSystemInfo", sysInfo);
  k.fn("GetLogicalProcessorInformation", () => { p.setLastError(ERROR.CALL_NOT_IMPLEMENTED); return 0; });
  k.fn("GetLogicalProcessorInformationEx", () => { p.setLastError(ERROR.CALL_NOT_IMPLEMENTED); return 0; });
  k.fn("GetActiveProcessorCount", () => 4);
  k.fn("GetMaximumProcessorCount", () => 4);
  k.fn("GetActiveProcessorGroupCount", () => 1);
  k.fn("GetNumaHighestNodeNumber", (c) => { mem.w32(c.arg(0), 0); return 1; });
  k.fn("IsProcessorFeaturePresent", (c) => {
    const f = c.arg(0);
    // 3=MMX 6=SSE 10=SSE2 13=SSE3 17=cmpxchg16b 36=SSSE3 37=SSE4.1 38=SSE4.2(not offered) 23=fast fail 25=FP errata,
    // 7=3DNow no 12=NX 14=RDTSC 18=SSE_DAZ 20=FP emulation no
    return [3, 6, 10, 12, 13, 14, 17, 23, 36, 37, 22, 21].includes(f) ? 1 : 0;
  });
  k.fn("GetVersion", () => 0x4a610a00 >>> 0);
  const verEx = (c: any, wide: boolean) => {
    const a = c.arg(0);
    const sz = mem.r32(a);
    mem.w32(a + 4, 10); mem.w32(a + 8, 0); mem.w32(a + 12, 19045); mem.w32(a + 16, 2);
    if (wide) mem.wwstr(a + 20, "", 128); else mem.wcstr(a + 20, "", 128);
    const extra = wide ? 20 + 256 : 20 + 128;
    if (sz >= extra + 8) { mem.w16(a + extra, 0); mem.w16(a + extra + 2, 0); mem.w16(a + extra + 4, 0); mem.w8(a + extra + 6, 1); mem.w8(a + extra + 7, 0); }
    return 1;
  };
  k.fn("GetVersionExA", (c) => verEx(c, false));
  k.fn("GetVersionExW", (c) => verEx(c, true));
  k.fn("VerifyVersionInfoW", () => 1);
  k.fn("VerSetConditionMask", (c) => c.arg64(0) | 1n);
  k.fn("GetProductInfo", (c) => { mem.w32(c.arg(4), 0x30); return 1; });
  k.fn("GetOsSafeBootMode", (c) => { mem.w32(c.arg(0), 0); return 0; });
  k.fn("GetFirmwareType", (c) => { mem.w32(c.arg(0), 2); return 1; });
  k.fn("GlobalMemoryStatusEx", (c) => {
    const a = c.arg(0);
    mem.w32(a, 64); mem.w32(a + 4, 20);
    mem.w64(a + 8, 8n * 1024n ** 3n); mem.w64(a + 16, 4n * 1024n ** 3n);
    mem.w64(a + 24, 16n * 1024n ** 3n); mem.w64(a + 32, 12n * 1024n ** 3n);
    mem.w64(a + 40, 0x80000000n); mem.w64(a + 48, 0x70000000n); mem.w64(a + 56, 0n);
    return 1;
  });
  k.fn("GlobalMemoryStatus", (c) => {
    const a = c.arg(0);
    mem.w32(a, 32); mem.w32(a + 4, 20);
    mem.wptr(a + 8, 0x80000000); mem.wptr(a + 16, 0x40000000); mem.wptr(a + 24, 0xc0000000); mem.wptr(a + 32, 0x70000000);
    mem.wptr(a + 40, 0x7ffe0000); mem.wptr(a + 48, 0x70000000);
    return 0;
  });
  k.fn("GetPhysicallyInstalledSystemMemory", (c) => { mem.w64(c.arg(0), 8n * 1024n * 1024n); return 1; });
  k.fn("GetUserNameA", (c) => { mem.wcstr(c.arg(0), "user"); mem.w32(c.arg(1), 5); return 1; });
  k.fn("GetUserNameW", (c) => { mem.wwstr(c.arg(0), "user"); mem.w32(c.arg(1), 5); return 1; });
  k.fn("Beep", () => 1);

  // ---- misc ----
  k.fn("RtlPcToFileHeader", (c) => {
    const m = p.moduleByAddr(c.arg(0));
    if (c.arg(1)) mem.wptr(c.arg(1), m ? m.base : 0);
    return m ? m.base : 0;
  });
  k.fn("GetLargePageMinimum", () => 0x200000);
  k.fn("GetCPInfoExW", () => 0);
  k.fn("SetThreadErrorMode", () => 1);
  k.fn("GetThreadErrorMode", () => 0);
  void cpu;
  void L;
}
