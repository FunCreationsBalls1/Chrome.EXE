// Structured exception handling API surface. The x64 unwinder / dispatcher lives in unwind.ts (installed on top of this).
import type { Process } from "./process.ts";

declare module "./process.ts" {
  interface Process {
    unhandledFilter: number;
    vectoredHandlers: { id: number; first: boolean; fn: number }[];
  }
}

export function installKernel32Seh(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const n = p.hle.module("ntdll.dll");
  p.unhandledFilter = 0;
  p.vectoredHandlers = [];

  k.fn("SetUnhandledExceptionFilter", (c) => { const old = p.unhandledFilter; p.unhandledFilter = c.arg(0); return old; });
  k.fn("UnhandledExceptionFilter", () => 0); // EXCEPTION_CONTINUE_SEARCH -> caller terminates
  let vecId = 1;
  const addVeh = (c: any) => {
    const id = vecId++;
    const e = { id, first: c.arg(0) !== 0, fn: c.arg(1) };
    if (e.first) p.vectoredHandlers.unshift(e); else p.vectoredHandlers.push(e);
    return id;
  };
  k.fn("AddVectoredExceptionHandler", addVeh);
  k.fn("RemoveVectoredExceptionHandler", (c) => { const i = p.vectoredHandlers.findIndex((e) => e.id === c.arg(0)); if (i >= 0) p.vectoredHandlers.splice(i, 1); return i >= 0 ? 1 : 0; });
  k.fn("AddVectoredContinueHandler", addVeh);
  k.fn("RemoveVectoredContinueHandler", () => 1);
  n.exports.set("rtladdvectoredexceptionhandler", k.lookup("AddVectoredExceptionHandler")!);
  n.names.set("rtladdvectoredexceptionhandler", "RtlAddVectoredExceptionHandler");
  n.exports.set("rtlremovevectoredexceptionhandler", k.lookup("RemoveVectoredExceptionHandler")!);
  n.names.set("rtlremovevectoredexceptionhandler", "RtlRemoveVectoredExceptionHandler");
}
