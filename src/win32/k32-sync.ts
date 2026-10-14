// kernel32: synchronization objects, TLS/FLS, interlocked operations, SList, Sleep.
import type { Process, KObject } from "./process.ts";
import { ERROR } from "./k32-core.ts";

export const WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff, INFINITE = 0xffffffff;

export interface EventObj extends KObject { type: "event"; manual: boolean; signaled: boolean; name: string | null }
export interface MutexObj extends KObject { type: "mutex"; owner: number; count: number; name: string | null }
export interface SemObj extends KObject { type: "semaphore"; count: number; max: number; name: string | null }

declare module "./process.ts" {
  interface Process {
    namedObjects: Map<string, KObject>;
    /** Try to satisfy a wait on object `o` for the current thread without blocking. Returns true if acquired. */
    tryAcquire(o: KObject): boolean;
  }
}

export function installKernel32Sync(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;
  p.namedObjects = new Map();

  // ---- critical sections ----
  const CS_LOCKCOUNT = 8, CS_RECURSION = 12, CS_OWNER = 16, CS_SPIN = 32;
  const initCS = (a: number) => {
    mem.fill(a, 0, 40);
    mem.w32(a + CS_LOCKCOUNT, 0xffffffff);
  };
  k.fn("InitializeCriticalSection", (c) => { initCS(c.arg(0)); });
  k.fn("InitializeCriticalSectionAndSpinCount", (c) => { initCS(c.arg(0)); mem.w32(c.arg(0) + CS_SPIN, c.arg(1)); return 1; });
  k.fn("InitializeCriticalSectionEx", (c) => { initCS(c.arg(0)); return 1; });
  k.fn("SetCriticalSectionSpinCount", () => 0);
  k.fn("DeleteCriticalSection", (c) => { mem.fill(c.arg(0), 0, 40); });
  const tryEnter = (a: number): boolean => {
    const me = p.curThread.id;
    const owner = mem.r32(a + CS_OWNER);
    if (owner === 0 || owner === me) {
      mem.w32(a + CS_OWNER, me);
      mem.w32(a + CS_RECURSION, mem.r32(a + CS_RECURSION) + 1);
      mem.w32(a + CS_LOCKCOUNT, (mem.r32(a + CS_LOCKCOUNT) + 1) >>> 0);
      return true;
    }
    return false;
  };
  const enterCS = (a: number) => {
    if (tryEnter(a)) return;
    // contended: let other threads run until it is released
    p.waitUntil(() => tryEnter(a), INFINITE, "critical section 0x" + a.toString(16));
  };
  k.fn("EnterCriticalSection", (c) => { enterCS(c.arg(0)); });
  k.fn("TryEnterCriticalSection", (c) => (tryEnter(c.arg(0)) ? 1 : 0));
  k.fn("LeaveCriticalSection", (c) => {
    const a = c.arg(0);
    const rec = mem.r32(a + CS_RECURSION) - 1;
    mem.w32(a + CS_RECURSION, rec);
    mem.w32(a + CS_LOCKCOUNT, (mem.r32(a + CS_LOCKCOUNT) - 1) >>> 0);
    if (rec <= 0) mem.w32(a + CS_OWNER, 0);
  });

  // ---- slim reader/writer locks: state = count of shared holders, 0x80000000 flag for exclusive ----
  k.fn("InitializeSRWLock", (c) => { mem.w64(c.arg(0), 0n); });
  const srwTryEx = (a: number) => { if (mem.r32(a) === 0) { mem.w32(a, 0x80000000); return true; } return false; };
  const srwTryShared = (a: number) => { const v = mem.r32(a); if (v < 0x80000000) { mem.w32(a, v + 1); return true; } return false; };
  k.fn("AcquireSRWLockExclusive", (c) => { const a = c.arg(0); if (!srwTryEx(a)) p.waitUntil(() => srwTryEx(a), INFINITE, "SRW exclusive"); });
  k.fn("AcquireSRWLockShared", (c) => { const a = c.arg(0); if (!srwTryShared(a)) p.waitUntil(() => srwTryShared(a), INFINITE, "SRW shared"); });
  k.fn("TryAcquireSRWLockExclusive", (c) => (srwTryEx(c.arg(0)) ? 1 : 0));
  k.fn("TryAcquireSRWLockShared", (c) => (srwTryShared(c.arg(0)) ? 1 : 0));
  k.fn("ReleaseSRWLockExclusive", (c) => { mem.w32(c.arg(0), 0); });
  k.fn("ReleaseSRWLockShared", (c) => { const a = c.arg(0); const v = mem.r32(a); if (v > 0 && v < 0x80000000) mem.w32(a, v - 1); });

  // ---- condition variables: a generation counter in the variable; waiters wait for it to change ----
  k.fn("InitializeConditionVariable", (c) => { mem.w64(c.arg(0), 0n); });
  const wake = (a: number, all: boolean) => { mem.w32(a, mem.r32(a) + 1); mem.w32(a + 4, all ? 1 : 0); };
  k.fn("WakeConditionVariable", (c) => { wake(c.arg(0), false); });
  k.fn("WakeAllConditionVariable", (c) => { wake(c.arg(0), true); });
  const sleepCV = (cv: number, release: () => void, reacquire: () => void, ms: number) => {
    const gen = mem.r32(cv);
    release();
    const ok = p.waitUntil(() => mem.r32(cv) !== gen, ms, "condition variable");
    reacquire();
    if (!ok) p.setLastError(ERROR.TIMEOUT);
    return ok ? 1 : 0;
  };
  k.fn("SleepConditionVariableCS", (c) => {
    const cs = c.arg(1);
    return sleepCV(c.arg(0), () => { mem.w32(cs + CS_RECURSION, 0); mem.w32(cs + CS_OWNER, 0); mem.w32(cs + CS_LOCKCOUNT, 0xffffffff); }, () => enterCS(cs), c.arg(2));
  });
  k.fn("SleepConditionVariableSRW", (c) => {
    const srw = c.arg(1), shared = (c.arg(3) & 1) !== 0;
    return sleepCV(c.arg(0), () => { if (shared) { const v = mem.r32(srw); if (v) mem.w32(srw, v - 1); } else mem.w32(srw, 0); },
      () => { if (shared) p.waitUntil(() => srwTryShared(srw), INFINITE, "srw"); else p.waitUntil(() => srwTryEx(srw), INFINITE, "srw"); }, c.arg(2));
  });

  // ---- one-time init ----
  k.fn("InitOnceInitialize", (c) => { mem.w64(c.arg(0), 0n); });
  k.fn("InitOnceExecuteOnce", (c) => {
    const once = c.arg(0);
    if (mem.r32(once) === 2) return 1;
    const r = p.callGuest(c.arg(1), [once, c.arg(2), c.arg(3)]);
    if (Number(r & 0xffffffffn) === 0) return 0;
    mem.w64(once, 2n);
    return 1;
  });
  k.fn("InitOnceBeginInitialize", (c) => {
    const once = c.arg(0);
    if (mem.r32(once) === 2) { if (c.arg(3)) mem.wptr(c.arg(3), 0); mem.w32(c.arg(2), 0); return 1; }
    mem.w32(c.arg(2), 1); // pending: caller must initialise and call Complete
    return 1;
  });
  k.fn("InitOnceComplete", (c) => { if (c.arg(1) & 2) return 1; mem.w64(c.arg(0), 2n); return 1; });

  // ---- interlocked ----
  const i32 = (a: number) => mem.ri32(a);
  k.fn("InterlockedIncrement", (c) => { const a = c.arg(0); const v = (i32(a) + 1) | 0; mem.w32(a, v); return v >>> 0; });
  k.fn("InterlockedDecrement", (c) => { const a = c.arg(0); const v = (i32(a) - 1) | 0; mem.w32(a, v); return v >>> 0; });
  k.fn("InterlockedExchange", (c) => { const a = c.arg(0); const o = mem.r32(a); mem.w32(a, c.arg(1)); return o; });
  k.fn("InterlockedExchangeAdd", (c) => { const a = c.arg(0); const o = mem.r32(a); mem.w32(a, (o + c.arg(1)) >>> 0); return o; });
  k.fn("InterlockedCompareExchange", (c) => { const a = c.arg(0); const o = mem.r32(a); if (o === c.arg(2)) mem.w32(a, c.arg(1)); return o; });
  k.fn("InterlockedExchange64", (c) => { const a = c.arg(0); const o = mem.r64(a); mem.w64(a, c.arg64(1)); return o; });
  k.fn("InterlockedExchangeAdd64", (c) => { const a = c.arg(0); const o = mem.r64(a); mem.w64(a, o + c.arg64(1)); return o; });
  k.fn("InterlockedCompareExchange64", (c) => { const a = c.arg(0); const o = mem.r64(a); if (o === c.arg64(2)) mem.w64(a, c.arg64(1)); return o; });
  k.fn("InterlockedIncrement64", (c) => { const a = c.arg(0); const v = mem.r64(a) + 1n; mem.w64(a, v); return v; });
  k.fn("InterlockedDecrement64", (c) => { const a = c.arg(0); const v = mem.r64(a) - 1n; mem.w64(a, v); return v; });
  // SLIST_HEADER (16 bytes): [0] first entry, [8] depth/sequence
  k.fn("InitializeSListHead", (c) => { mem.w64(c.arg(0), 0n); mem.w64(c.arg(0) + 8, 0n); });
  k.fn("InterlockedPushEntrySList", (c) => {
    const h = c.arg(0), e = c.arg(1);
    const first = mem.r64(h);
    mem.w64(e, first);
    mem.w64(h, BigInt(e));
    mem.w64(h + 8, mem.r64(h + 8) + 1n);
    return first;
  });
  k.fn("InterlockedPopEntrySList", (c) => {
    const h = c.arg(0);
    const first = Number(mem.r64(h));
    if (!first) return 0;
    mem.w64(h, mem.r64(first));
    mem.w64(h + 8, mem.r64(h + 8) - 1n);
    return first;
  });
  k.fn("InterlockedFlushSList", (c) => {
    const h = c.arg(0);
    const first = mem.r64(h);
    mem.w64(h, 0n);
    mem.w64(h + 8, 0n);
    return first;
  });
  k.fn("QueryDepthSList", (c) => Number(mem.r64(c.arg(0) + 8) & 0xffffn));
  k.fn("RtlFirstEntrySList", (c) => mem.r64(c.arg(0)));

  // ---- TLS ----
  const TLS_SLOTS = 0x1480;
  const tlsUsed = new Array<boolean>(64 + 1024).fill(false);
  k.fn("TlsAlloc", () => {
    for (let i = 0; i < 64; i++) if (!tlsUsed[i]) { tlsUsed[i] = true; return i; }
    p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
    return 0xffffffff;
  });
  k.fn("TlsFree", (c) => { const i = c.arg(0); if (i < 64 && tlsUsed[i]) { tlsUsed[i] = false; for (const t of p.threads.values()) mem.wptr(t.teb + TLS_SLOTS + i * 8, 0); return 1; } p.setLastError(ERROR.INVALID_PARAMETER); return 0; });
  k.fn("TlsGetValue", (c) => { const i = c.arg(0); if (i >= 64) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; } p.setLastError(0); return mem.r64(p.curThread.teb + TLS_SLOTS + i * 8); });
  k.fn("TlsSetValue", (c) => { const i = c.arg(0); if (i >= 64) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; } mem.w64(p.curThread.teb + TLS_SLOTS + i * 8, c.arg64(1)); return 1; });

  // ---- FLS (fiber local storage); callbacks ignored on thread exit ----
  const FLS_MAX = 128;
  const flsUsed = new Array<boolean>(FLS_MAX).fill(false);
  const flsArray = (create: boolean): number => {
    let a = mem.r32(p.curThread.teb + 0x17c8);
    if (!a && create) {
      a = p.vm.alloc(FLS_MAX * 8 + 16, { commit: true, tag: "fls" });
      mem.wptr(p.curThread.teb + 0x17c8, a);
    }
    return a;
  };
  k.fn("FlsAlloc", () => {
    for (let i = 0; i < FLS_MAX; i++) if (!flsUsed[i]) { flsUsed[i] = true; return i; }
    p.setLastError(ERROR.NOT_ENOUGH_MEMORY);
    return 0xffffffff;
  });
  k.fn("FlsFree", (c) => { const i = c.arg(0); if (i < FLS_MAX && flsUsed[i]) { flsUsed[i] = false; return 1; } p.setLastError(ERROR.INVALID_PARAMETER); return 0; });
  k.fn("FlsGetValue", (c) => { const i = c.arg(0); if (i >= FLS_MAX) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; } const a = flsArray(false); p.setLastError(0); return a ? mem.r64(a + i * 8) : 0n; });
  k.fn("FlsSetValue", (c) => { const i = c.arg(0); if (i >= FLS_MAX) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; } mem.w64(flsArray(true) + i * 8, c.arg64(1)); return 1; });

  // ---- kernel objects ----
  const getNamed = <T extends KObject>(name: string | null, type: string): T | null => {
    if (!name) return null;
    const o = p.namedObjects.get(type + ":" + name.toLowerCase());
    return (o as T) ?? null;
  };
  const putNamed = (name: string | null, type: string, o: KObject) => { if (name) p.namedObjects.set(type + ":" + name.toLowerCase(), o); };
  const createEvent = (name: string | null, manual: boolean, initial: boolean) => {
    const ex = getNamed<EventObj>(name, "event");
    if (ex) { p.setLastError(ERROR.ALREADY_EXISTS); return p.handles.alloc(ex); }
    const o: EventObj = { type: "event", manual, signaled: initial, name };
    putNamed(name, "event", o);
    p.setLastError(0);
    return p.handles.alloc(o);
  };
  k.fn("CreateEventA", (c) => createEvent(c.arg(3) ? mem.cstr(c.arg(3)) : null, c.arg(1) !== 0, c.arg(2) !== 0));
  k.fn("CreateEventW", (c) => createEvent(c.arg(3) ? mem.wstr(c.arg(3)) : null, c.arg(1) !== 0, c.arg(2) !== 0));
  k.fn("CreateEventExA", (c) => createEvent(c.arg(1) ? mem.cstr(c.arg(1)) : null, (c.arg(2) & 1) !== 0, (c.arg(2) & 2) !== 0));
  k.fn("CreateEventExW", (c) => createEvent(c.arg(1) ? mem.wstr(c.arg(1)) : null, (c.arg(2) & 1) !== 0, (c.arg(2) & 2) !== 0));
  const openNamed = (type: string, name: string) => {
    const o = getNamed(name, type);
    if (!o) { p.setLastError(ERROR.FILE_NOT_FOUND); return 0; }
    return p.handles.alloc(o);
  };
  k.fn("OpenEventA", (c) => openNamed("event", mem.cstr(c.arg(2))));
  k.fn("OpenEventW", (c) => openNamed("event", mem.wstr(c.arg(2))));
  const evt = (h: number): EventObj | null => { const o = p.handles.get(h); return o && o.type === "event" ? (o as EventObj) : null; };
  k.fn("SetEvent", (c) => { const e = evt(c.arg(0)); if (!e) { p.setLastError(ERROR.INVALID_HANDLE); return 0; } e.signaled = true; return 1; });
  k.fn("ResetEvent", (c) => { const e = evt(c.arg(0)); if (!e) { p.setLastError(ERROR.INVALID_HANDLE); return 0; } e.signaled = false; return 1; });
  k.fn("PulseEvent", (c) => { const e = evt(c.arg(0)); if (!e) return 0; e.signaled = true; p.runOthers(); e.signaled = false; return 1; });
  const createMutex = (name: string | null, owned: boolean) => {
    const ex = getNamed<MutexObj>(name, "mutex");
    if (ex) { p.setLastError(ERROR.ALREADY_EXISTS); return p.handles.alloc(ex); }
    const o: MutexObj = { type: "mutex", owner: owned ? p.curThread.id : 0, count: owned ? 1 : 0, name };
    putNamed(name, "mutex", o);
    p.setLastError(0);
    return p.handles.alloc(o);
  };
  k.fn("CreateMutexA", (c) => createMutex(c.arg(2) ? mem.cstr(c.arg(2)) : null, c.arg(1) !== 0));
  k.fn("CreateMutexW", (c) => createMutex(c.arg(2) ? mem.wstr(c.arg(2)) : null, c.arg(1) !== 0));
  k.fn("CreateMutexExW", (c) => createMutex(c.arg(1) ? mem.wstr(c.arg(1)) : null, (c.arg(2) & 1) !== 0));
  k.fn("OpenMutexA", (c) => openNamed("mutex", mem.cstr(c.arg(2))));
  k.fn("OpenMutexW", (c) => openNamed("mutex", mem.wstr(c.arg(2))));
  k.fn("ReleaseMutex", (c) => {
    const o = p.handles.get(c.arg(0)) as MutexObj | undefined;
    if (!o || o.type !== "mutex" || o.owner !== p.curThread.id) { p.setLastError(288); return 0; }
    if (--o.count === 0) o.owner = 0;
    return 1;
  });
  const createSem = (name: string | null, initial: number, max: number) => {
    const ex = getNamed<SemObj>(name, "semaphore");
    if (ex) { p.setLastError(ERROR.ALREADY_EXISTS); return p.handles.alloc(ex); }
    const o: SemObj = { type: "semaphore", count: initial, max, name };
    putNamed(name, "semaphore", o);
    return p.handles.alloc(o);
  };
  k.fn("CreateSemaphoreA", (c) => createSem(c.arg(3) ? mem.cstr(c.arg(3)) : null, c.argI(1), c.argI(2)));
  k.fn("CreateSemaphoreW", (c) => createSem(c.arg(3) ? mem.wstr(c.arg(3)) : null, c.argI(1), c.argI(2)));
  k.fn("CreateSemaphoreExW", (c) => createSem(c.arg(3) ? mem.wstr(c.arg(3)) : null, c.argI(1), c.argI(2)));
  k.fn("OpenSemaphoreA", (c) => openNamed("semaphore", mem.cstr(c.arg(2))));
  k.fn("OpenSemaphoreW", (c) => openNamed("semaphore", mem.wstr(c.arg(2))));
  k.fn("ReleaseSemaphore", (c) => {
    const o = p.handles.get(c.arg(0)) as SemObj | undefined;
    if (!o || o.type !== "semaphore") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const n = c.argI(1);
    if (o.count + n > o.max) { p.setLastError(298); return 0; }
    if (c.arg(2)) mem.w32(c.arg(2), o.count);
    o.count += n;
    return 1;
  });
  k.fn("CreateWaitableTimerW", () => p.handles.alloc({ type: "timer", signaled: false, due: 0 }));
  k.fn("CreateWaitableTimerExW", () => p.handles.alloc({ type: "timer", signaled: false, due: 0 }));
  k.fn("SetWaitableTimer", (c) => {
    const o = p.handles.get(c.arg(0));
    if (!o) return 0;
    const due = Number(BigInt.asIntN(64, mem.r64(c.arg(1))));
    o.signaled = false;
    o.fireAt = due < 0 ? performance.now() + -due / 10000 : performance.now();
    return 1;
  });
  k.fn("CancelWaitableTimer", () => 1);

  /** try to acquire an object for the current thread */
  p.tryAcquire = (o: KObject): boolean => {
    switch (o.type) {
      case "event": {
        const e = o as EventObj;
        if (!e.signaled) return false;
        if (!e.manual) e.signaled = false;
        return true;
      }
      case "mutex": {
        const m = o as MutexObj;
        if (m.owner === 0 || m.owner === p.curThread.id) { m.owner = p.curThread.id; m.count++; return true; }
        return false;
      }
      case "semaphore": {
        const s = o as SemObj;
        if (s.count > 0) { s.count--; return true; }
        return false;
      }
      case "thread": return o.thread.state === "done";
      case "timer":
        if (o.fireAt !== undefined && performance.now() >= o.fireAt) { o.signaled = true; }
        return !!o.signaled;
      case "process": return false;
      default: return true; // files etc. are always signaled
    }
  };

  const waitMultiple = (handles: number[], all: boolean, ms: number): number => {
    const objs: (KObject | undefined)[] = handles.map((h) => p.handles.get(h));
    if (objs.some((o) => !o)) { p.setLastError(ERROR.INVALID_HANDLE); return WAIT_FAILED; }
    let result = WAIT_TIMEOUT;
    const attempt = (): boolean => {
      if (all) {
        // atomic acquire: check all first (events/semaphores/mutexes), then take
        for (const o of objs) if (!canAcquire(o!)) return false;
        for (const o of objs) p.tryAcquire(o!);
        result = WAIT_OBJECT_0;
        return true;
      }
      for (let i = 0; i < objs.length; i++) {
        if (p.tryAcquire(objs[i]!)) { result = WAIT_OBJECT_0 + i; return true; }
      }
      return false;
    };
    if (attempt()) return result;
    if (ms === 0) return WAIT_TIMEOUT;
    if (p.waitUntil(attempt, ms, "WaitFor*")) return result;
    return WAIT_TIMEOUT;
  };
  const canAcquire = (o: KObject): boolean => {
    switch (o.type) {
      case "event": return o.signaled;
      case "mutex": return o.owner === 0 || o.owner === p.curThread.id;
      case "semaphore": return o.count > 0;
      case "thread": return o.thread.state === "done";
      case "timer": return !!o.signaled || (o.fireAt !== undefined && performance.now() >= o.fireAt);
      default: return true;
    }
  };
  k.fn("WaitForSingleObject", (c) => waitMultiple([c.arg(0)], false, c.arg(1)));
  k.fn("WaitForSingleObjectEx", (c) => waitMultiple([c.arg(0)], false, c.arg(1)));
  const wfm = (c: any) => {
    const n = c.arg(0), arr = c.arg(1);
    const hs: number[] = [];
    for (let i = 0; i < n; i++) hs.push(mem.r32(arr + i * 8));
    return waitMultiple(hs, c.arg(2) !== 0, c.arg(3));
  };
  k.fn("WaitForMultipleObjects", wfm);
  k.fn("WaitForMultipleObjectsEx", wfm);
  k.fn("SignalObjectAndWait", (c) => {
    const s = p.handles.get(c.arg(0));
    if (s?.type === "event") s.signaled = true;
    else if (s?.type === "semaphore") s.count++;
    else if (s?.type === "mutex") { if (--s.count === 0) s.owner = 0; }
    return waitMultiple([c.arg(1)], false, c.arg(2));
  });
  k.fn("WaitOnAddress", (c) => {
    const a = c.arg(0), cmp = c.arg(1), sz = c.arg(2);
    const read = () => (sz === 1 ? mem.r8(a) === mem.r8(cmp) : sz === 2 ? mem.r16(a) === mem.r16(cmp) : sz === 4 ? mem.r32(a) === mem.r32(cmp) : mem.r64(a) === mem.r64(cmp));
    if (!read()) return 1;
    return p.waitUntil(() => !read(), c.arg(3), "WaitOnAddress") ? 1 : 0;
  });
  k.fn("WakeByAddressSingle", () => {});
  k.fn("WakeByAddressAll", () => {});

  // ---- sleeping ----
  k.fn("Sleep", (c) => { p.sleep(c.arg(0)); });
  k.fn("SleepEx", (c) => { p.sleep(c.arg(0)); return 0; });
  k.fn("SwitchToThread", () => { p.runOthers(); return 1; });
  void CS_SPIN;
}
