// Asynchronous scheduler driver for event-loop hosts (browser workers): runs the guest in short bursts and yields to the
// host event loop between them, sleeping on timers and external events instead of blocking.
import type { Process } from "./process.ts";

export interface AsyncDriverOptions {
  /** run at most this long (ms) before yielding to the event loop */
  burstMs?: number;
  /** resolves when the host has new input/events; used to wake an idle process early */
  wake?: () => Promise<void>;
  onFrame?: () => void;
  /** called when the process finishes */
  onExit?: (code: number) => void;
}

const macrotask = (() => {
  if (typeof MessageChannel !== "undefined") {
    const ch = new MessageChannel();
    const waiters: (() => void)[] = [];
    ch.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
    return () => new Promise<void>((r) => { waiters.push(r); ch.port2.postMessage(0); });
  }
  return () => new Promise<void>((r) => setTimeout(r, 0));
})();

export function sleepMs(ms: number): Promise<void> {
  return ms <= 0 ? macrotask() : new Promise((r) => setTimeout(r, ms));
}

export async function runAsync(p: Process, opts: AsyncDriverOptions = {}): Promise<number> {
  const burst = opts.burstMs ?? 6;
  p.prepareMain();
  let burstStart = performance.now();
  for (;;) {
    const r = p.sched.step();
    if (r.kind === "done") { opts.onExit?.(r.code); return r.code; }
    const now = performance.now();
    if (r.kind === "continue") {
      if (now - burstStart >= burst || p.yieldRequested) {
        p.yieldRequested = false;
        await macrotask();
        burstStart = performance.now();
      }
      continue;
    }
    // every thread is waiting: sleep until the earliest deadline or an external event
    const until = r.kind === "sleep" ? r.until : now + 8;
    const wait = Math.max(0, until - now);
    p.win.flushSurfaces();
    if (opts.wake) await Promise.race([sleepMs(wait), opts.wake()]);
    else await sleepMs(wait);
    burstStart = performance.now();
  }
}
