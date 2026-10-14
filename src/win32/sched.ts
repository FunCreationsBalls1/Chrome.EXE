// Green-thread scheduler. Threads are CPU-state snapshots; the machine runs one at a time.
//
// Blocking model: an HLE handler that cannot complete throws BlockSignal. The thread's resume point is the thunk
// address of the blocking call itself, so the call is simply re-executed when the thread is woken (handlers evaluate
// their wait conditions from scratch each time). When blocking is not possible (a nested callGuest frame is active),
// waitUntil() instead runs other threads on top of the JS stack until the condition holds.
import * as L from "../jit/layout.ts";
import type { Process, Thread } from "./process.ts";
import { ProcessExit } from "./process.ts";
import { ERROR } from "./k32-core.ts";
import { INFINITE } from "./k32-sync.ts";
import { RAX, RCX, RSP } from "./cpu.ts";
import { ContinueSignal } from "./unwind.ts";

export class BlockSignal extends Error {
  isControlFlow = true;
  constructor() { super("thread blocked"); }
}
export class ThreadExitSignal extends Error {
  isControlFlow = true;
  constructor() { super("thread exit"); }
}

export interface WaitState {
  cond: (() => boolean) | null;
  deadline: number;
  what: string;
}

declare module "./process.ts" {
  interface Thread {
    wait?: WaitState | null;
    /** deadline stored across restarts of a blocking call */
    waitDeadline?: number;
    resume?: any;
    ranSlices?: number;
  }
  interface Process {
    nested: number;
    sched: Scheduler;
    waitUntil(cond: () => boolean, ms: number, what: string): boolean;
    sleep(ms: number): void;
    runOthers(): boolean;
    /** set by embedders: called while idle waiting for external events (returns true if progress is possible) */
    idleHook: ((untilMs: number) => void) | null;
    threadReturnThunk: number;
    createGuestThread(startFn: number, arg: number, stackSize: number, suspended: boolean): Thread;
  }
}

export type StepResult = { kind: "continue" } | { kind: "sleep"; until: number } | { kind: "idle" } | { kind: "done"; code: number };

export class Scheduler {
  readonly p: Process;
  private rr = 0;
  sliceBudget = 1 << 17;
  lastSliceStart = 0;
  constructor(p: Process) {
    this.p = p;
  }

  private snapshot(): Uint8Array {
    return this.p.m.u8.slice(L.STATE, L.STATE + L.S_END);
  }
  private load(ctx: Uint8Array) {
    this.p.m.u8.set(ctx, L.STATE);
  }

  /** Is thread t runnable right now? */
  runnable(t: Thread): boolean {
    if (t.state === "ready") return true;
    if (t.state !== "blocked") return false;
    const w = t.wait;
    if (!w) return true;
    const now = performance.now();
    // temporarily become that thread: wait conditions may consult the current thread (mutex ownership etc.)
    const prev = this.p.curThread;
    this.p.curThread = t;
    let ok = false;
    try { ok = (w.cond ? w.cond() : false) || now >= w.deadline; } finally { this.p.curThread = prev; }
    return ok;
  }

  /** Earliest deadline among blocked threads, or Infinity. */
  nextDeadline(): number {
    let d = Infinity;
    for (const t of this.p.threads.values()) if (t.state === "blocked" && t.wait && t.wait.deadline < d) d = t.wait.deadline;
    return d;
  }

  /**
   * Run `t` for one slice on the machine. The caller's machine state must already be saved if it matters.
   * Returns "yield" | "blocked" | "done".
   */
  runSlice(t: Thread, maxSteps = 1): "yield" | "blocked" | "done" {
    const p = this.p;
    const m = p.m;
    const prevThread = p.curThread;
    const prevNested = p.nested;
    p.curThread = t;
    p.nested = 0;
    t.state = "running";
    t.wait = null;
    try {
      let pc: number;
      if (t.ctx) {
        this.load(t.ctx);
        pc = m.rip;
      } else {
        // fresh thread: build a context from the current state but with clean registers
        this.initContext(t);
        pc = t.startFn;
      }
      m.dv.setBigUint64(L.STATE + L.S_GS_BASE, BigInt(t.teb), true);
      m.dv.setUint32(L.STATE + L.S_BUDGET, this.sliceBudget, true);
      for (;;) {
        try {
          const st = m.run(pc, maxSteps);
          if (st === L.ST_YIELD) {
            t.ctx = this.snapshot();
            t.state = "ready";
            return "yield";
          }
          if (st === L.ST_FAULT) {
            p.handleHardwareFault(t, m.faultKind, m.faultAddr); // always ends in a ContinueSignal or process exit
          }
          throw p.statusError(st);
        } catch (e) {
          if (e instanceof ContinueSignal) {
            p.applyContext(e.ctx);
            pc = m.rip;
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof BlockSignal) {
        // resume by re-executing the blocking call
        const thunk = (e as any).thunk as number;
        m.rip = thunk;
        t.ctx = this.snapshot();
        t.state = "blocked";
        return "blocked";
      }
      if (e instanceof ThreadExitSignal) {
        t.state = "done";
        t.ctx = null;
        return "done";
      }
      throw e;
    } finally {
      p.curThread = prevThread;
      p.nested = prevNested;
    }
  }

  private initContext(t: Thread) {
    const p = this.p;
    const m = p.m;
    // zero the whole state area then set what a new thread needs
    m.u8.fill(0, L.STATE, L.STATE + L.S_END);
    m.dv.setUint32(L.STATE + L.S_MXCSR, 0x1f80, true);
    m.dv.setUint16(L.STATE + L.S_FCW, 0x37f, true);
    m.dv.setUint16(L.STATE + L.S_FTAG, 0xffff, true);
    p.m.rt.cc_setflags(0);
    let sp = t.stackBase - 0x40;
    sp &= ~0xf;
    sp -= 0x28;
    m.dv.setBigUint64(sp, BigInt(p.threadReturnThunk), true);
    m.setGpr(RSP, sp);
    m.setGpr(RCX, t.startArg);
    m.dv.setUint32(L.STATE + L.S_BUDGET, this.sliceBudget, true);
  }

  /** One scheduling step: pick a runnable thread and run it for a slice. */
  step(): StepResult {
    const p = this.p;
    if (p.exited) return { kind: "done", code: p.exitCode };
    const ts = [...p.threads.values()].filter((t) => t.state !== "done" && t.state !== "suspended");
    if (!ts.length) return { kind: "done", code: p.exitCode };
    let pick: Thread | null = null;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[(this.rr + i) % ts.length];
      if (this.runnable(t)) { pick = t; this.rr = (this.rr + i + 1) % ts.length; break; }
    }
    if (!pick) {
      const d = this.nextDeadline();
      if (d === Infinity) return { kind: "idle" };
      return { kind: "sleep", until: d };
    }
    try {
      this.runSlice(pick);
    } catch (e) {
      if (e instanceof ProcessExit) { p.exited = true; p.exitCode = e.code; return { kind: "done", code: e.code }; }
      throw e;
    }
    // the main thread finishing ends the process
    if (p.mainThread.state === "done") {
      p.exited = true;
      return { kind: "done", code: p.mainThread.exitCode };
    }
    return { kind: "continue" };
  }

  /** Synchronous driver: run until the process exits. Sleeps are busy-waited (tests / non-browser use). */
  runToCompletion(maxSteps = Infinity): number {
    for (let i = 0; i < maxSteps; i++) {
      const r = this.step();
      if (r.kind === "done") return r.code;
      if (r.kind === "sleep") {
        const dt = r.until - performance.now();
        if (dt > 0) this.spinWait(dt);
      } else if (r.kind === "idle") {
        throw new Error("deadlock: all threads are blocked with no timeout\n" + this.describeBlocked());
      }
    }
    throw new Error("scheduler step limit exceeded");
  }

  describeBlocked(): string {
    const out: string[] = [];
    for (const t of this.p.threads.values()) {
      if (t.state === "blocked") out.push(`  thread ${t.id.toString(16)}: waiting on ${t.wait?.what ?? "?"}`);
    }
    return out.join("\n");
  }

  spinWait(ms: number) {
    const end = performance.now() + ms;
    // Atomics.wait is available in Node and in workers when SharedArrayBuffer exists; otherwise spin.
    try {
      const sab = new Int32Array(new SharedArrayBuffer(4));
      const left = end - performance.now();
      if (left > 0) Atomics.wait(sab, 0, 0, left);
    } catch {
      while (performance.now() < end) { /* spin */ }
    }
  }
}

export function installScheduler(p: Process) {
  p.nested = 0;
  p.idleHook = null;
  p.sched = new Scheduler(p);
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;

  const exitCurrentThread = (code: number): never => {
    const t = p.curThread;
    t.exitCode = code;
    t.state = "done";
    if (t === p.mainThread) {
      p.exitCode = code;
    }
    throw new ThreadExitSignal();
  };
  p.threadReturnThunk = p.m.registerThunk(() => {
    exitCurrentThread(Number(p.m.gpr(RAX) & 0xffffffffn));
    return 0;
  });

  /** Block the current thread (or run others when nested) until cond() holds or the timeout passes. */
  p.waitUntil = (cond, ms, what) => {
    const t = p.curThread;
    if (t.waitDeadline === undefined) t.waitDeadline = ms === INFINITE ? Infinity : performance.now() + ms;
    if (cond()) { t.waitDeadline = undefined; return true; }
    if (performance.now() >= t.waitDeadline) { t.waitDeadline = undefined; return false; }
    if (p.nested === 0) {
      t.wait = { cond, deadline: t.waitDeadline, what };
      const sig = new BlockSignal();
      (sig as any).thunk = p.hle.currentThunk();
      throw sig;
    }
    // nested: cannot unwind; make progress by running other threads here
    for (;;) {
      if (cond()) { t.waitDeadline = undefined; return true; }
      const now = performance.now();
      if (now >= t.waitDeadline) { t.waitDeadline = undefined; return false; }
      const ran = p.runOthers();
      if (!ran) {
        if (p.idleHook) p.idleHook(Math.min(t.waitDeadline, now + 5));
        else if (t.waitDeadline === Infinity) throw new Error(`deadlock in nested wait on ${what}`);
        else p.sched.spinWait(Math.min(t.waitDeadline - now, 2));
      }
    }
  };
  p.sleep = (ms) => {
    if (ms === 0) {
      // yield the processor
      if (p.nested === 0 && [...p.threads.values()].filter((t) => t.state !== "done").length > 1) {
        // restartable yield: mark ready and unwind
        const t = p.curThread;
        if (t.resume === "yielded") { t.resume = undefined; return; }
        t.resume = "yielded";
        t.wait = { cond: null, deadline: 0, what: "Sleep(0)" };
        const sig = new BlockSignal();
        (sig as any).thunk = p.hle.currentThunk();
        throw sig;
      }
      return;
    }
    const t = p.curThread;
    if (t.waitDeadline === undefined) t.waitDeadline = performance.now() + ms;
    p.waitUntil(() => false, ms === INFINITE ? INFINITE : ms, "Sleep");
  };
  p.runOthers = (): boolean => {
    const t0 = p.curThread;
    const saved = p.m.u8.slice(L.STATE, L.STATE + L.S_END);
    const savedState = t0.state;
    let ran = false;
    t0.state = "running";
    try {
      for (const t of [...p.threads.values()]) {
        if (t === t0 || t.state === "done" || t.state === "suspended" || t.state === "running") continue;
        if (!p.sched.runnable(t)) continue;
        p.sched.runSlice(t);
        ran = true;
      }
    } finally {
      p.m.u8.set(saved, L.STATE);
      p.curThread = t0;
      t0.state = savedState;
    }
    return ran;
  };

  p.createGuestThread = (startFn, arg, stackSize, suspended) => {
    const t = p.createThreadObject(startFn, arg, stackSize, suspended ? 1 : 0);
    t.handle = p.handles.alloc({ type: "thread", thread: t });
    return t;
  };

  // ---- thread API ----
  k.fn("CreateThread", (c) => {
    const t = p.createGuestThread(c.arg(2), c.arg(3), Number(c.arg64(1)), (c.arg(4) & 4) !== 0);
    if (c.arg(5)) mem.w32(c.arg(5), t.id);
    return t.handle;
  });
  k.fn("CreateRemoteThread", (c) => {
    const t = p.createGuestThread(c.arg(3), c.arg(4), Number(c.arg64(2)), (c.arg(5) & 4) !== 0);
    if (c.arg(6)) mem.w32(c.arg(6), t.id);
    return t.handle;
  });
  k.fn("CreateRemoteThreadEx", (c) => {
    const t = p.createGuestThread(c.arg(3), c.arg(4), Number(c.arg64(2)), (c.arg(5) & 4) !== 0);
    if (c.arg(7)) mem.w32(c.arg(7), t.id);
    return t.handle;
  });
  k.fn("ExitThread", (c) => { exitCurrentThread(c.arg(0)); });
  const thr = (h: number): Thread | null => {
    if (h === 0xfffffffe || h === 0xffffffff) return p.curThread;
    const o = p.handles.get(h);
    return o && o.type === "thread" ? (o.thread as Thread) : null;
  };
  k.fn("ResumeThread", (c) => {
    const t = thr(c.arg(0));
    if (!t) { p.setLastError(ERROR.INVALID_HANDLE); return 0xffffffff; }
    const prev = t.suspendCount;
    if (t.suspendCount > 0) t.suspendCount--;
    if (t.suspendCount === 0 && t.state === "suspended") t.state = "ready";
    return prev;
  });
  k.fn("SuspendThread", (c) => {
    const t = thr(c.arg(0));
    if (!t) { p.setLastError(ERROR.INVALID_HANDLE); return 0xffffffff; }
    const prev = t.suspendCount++;
    if (t !== p.curThread && t.state === "ready") t.state = "suspended";
    return prev;
  });
  k.fn("GetExitCodeThread", (c) => {
    const t = thr(c.arg(0));
    if (!t) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    mem.w32(c.arg(1), t.state === "done" ? t.exitCode : 259);
    return 1;
  });
  k.fn("TerminateThread", (c) => {
    const t = thr(c.arg(0));
    if (!t) return 0;
    t.exitCode = c.arg(1);
    t.state = "done";
    if (t === p.curThread) throw new ThreadExitSignal();
    return 1;
  });
  k.fn("SetThreadPriority", (c) => { const t = thr(c.arg(0)); if (t) t.priority = c.argI(1); return 1; });
  k.fn("GetThreadPriority", (c) => thr(c.arg(0))?.priority ?? 0);
  k.fn("SetThreadPriorityBoost", () => 1);
  k.fn("SetThreadAffinityMask", () => 1);
  k.fn("SetThreadIdealProcessor", () => 0);
  k.fn("SetThreadGroupAffinity", () => 1);
  k.fn("SetThreadDescription", () => 0);
  k.fn("GetThreadDescription", (c) => { mem.w64(c.arg(1), 0n); return 0; });
  k.fn("SetThreadStackGuarantee", () => 1);
  k.fn("GetThreadContext", () => 0);
  k.fn("SetThreadContext", () => 0);
  k.fn("OpenThread", (c) => {
    const id = c.arg(2);
    const t = p.threads.get(id);
    if (!t) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    return p.handles.alloc({ type: "thread", thread: t });
  });
  k.fn("GetCurrentThreadStackLimits", (c) => { mem.wptr(c.arg(0), p.curThread.stackLimit); mem.wptr(c.arg(1), p.curThread.stackBase); });
  k.fn("QueueUserWorkItem", (c) => {
    p.createGuestThread(c.arg(0), c.arg(1), 0, false);
    return 1;
  });
  k.fn("QueueUserAPC", () => 0);
  void RCX;
}
