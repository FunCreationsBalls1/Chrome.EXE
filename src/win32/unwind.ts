// x64 structured exception handling: UNWIND_INFO processing, exception dispatch, RtlUnwindEx, CONTEXT conversion.
import * as L from "../jit/layout.ts";
import type { Process, Thread } from "./process.ts";
import { ProcessExit } from "./process.ts";
import { DIR_EXCEPTION } from "../pe/pe.ts";

// ---- constants ----
export const EXCEPTION_NONCONTINUABLE = 1, EXCEPTION_UNWINDING = 2, EXCEPTION_EXIT_UNWIND = 4, EXCEPTION_NESTED_CALL = 0x10,
  EXCEPTION_TARGET_UNWIND = 0x20, EXCEPTION_COLLIDED_UNWIND = 0x40;
export const STATUS_ACCESS_VIOLATION = 0xc0000005, STATUS_BREAKPOINT = 0x80000003, STATUS_ILLEGAL_INSTRUCTION = 0xc000001d,
  STATUS_INTEGER_DIVIDE_BY_ZERO = 0xc0000094, STATUS_PRIVILEGED_INSTRUCTION = 0xc0000096, STATUS_NONCONTINUABLE_EXCEPTION = 0xc0000025,
  STATUS_UNWIND = 0xc0000027, STATUS_INVALID_DISPOSITION = 0xc0000026, STATUS_STACK_OVERFLOW = 0xc00000fd, STATUS_SINGLE_STEP = 0x80000004;
export const UNW_FLAG_EHANDLER = 1, UNW_FLAG_UHANDLER = 2, UNW_FLAG_CHAININFO = 4;

// CONTEXT offsets
export const CTX = {
  SIZE: 0x4d0, FLAGS: 0x30, MXCSR: 0x34, EFLAGS: 0x44, RAX: 0x78, RCX: 0x80, RDX: 0x88, RBX: 0x90, RSP: 0x98, RBP: 0xa0, RSI: 0xa8, RDI: 0xb0,
  R8: 0xb8, RIP: 0xf8, FLT: 0x100, XMM0: 0x1a0,
} as const;
const GPR_CTX_OFF = [CTX.RAX, CTX.RCX, CTX.RDX, CTX.RBX, CTX.RSP, CTX.RBP, CTX.RSI, CTX.RDI, 0xb8, 0xc0, 0xc8, 0xd0, 0xd8, 0xe0, 0xe8, 0xf0];
export const CONTEXT_FULL = 0x10000b;

/** thrown to abandon JS/guest frames and resume the guest from a CONTEXT (RtlRestoreContext / unwind target) */
export class ContinueSignal extends Error {
  isControlFlow = true;
  ctx: Uint8Array;
  constructor(ctx: Uint8Array) {
    super("continue execution");
    this.ctx = ctx;
  }
}

export interface FuncEntry {
  ptr: number; // guest pointer to RUNTIME_FUNCTION
  base: number; // image base (virtual)
  begin: number;
  end: number;
  unwind: number;
}

declare module "./process.ts" {
  interface Process {
    dynamicTables: { table: number; count: number; base: number; callback: number }[];
    lookupFunctionEntry(pc: number): FuncEntry | null;
    captureContext(ctx: number, rip: number, rsp: number): void;
    applyContext(ctx: Uint8Array): void;
    dispatchException(rec: number, ctx: number): "continue" | "unhandled";
    raiseException(code: number, flags: number, params: bigint[], ctx: number, addr: number): void;
    handleHardwareFault(t: Thread, kind: number, faultAddr: number): void;
    describeException(code: number): string;
  }
}

export function installUnwind(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const n = p.hle.module("ntdll.dll");
  const mem = p.mem;
  const m = p.m;
  p.dynamicTables = [];

  const alias = (name: string, target: string, src = k) => {
    const a = src.lookup(target)!;
    n.exports.set(name.toLowerCase(), a);
    n.names.set(name.toLowerCase(), name);
  };

  // ---------------------------------------------------------------------------------------
  // function table lookup
  // ---------------------------------------------------------------------------------------
  const pdataCache = new Map<number, { base: number; addr: number; count: number }>();
  p.lookupFunctionEntry = (pc: number): FuncEntry | null => {
    const mod = p.moduleByAddr(pc);
    let vpc = pc;
    if (pc < 0x100000000) vpc = m.virt(pc);
    if (mod && !mod.isHle && mod.img) {
      let pd = pdataCache.get(mod.base);
      if (!pd) {
        const d = mod.img.dirs[DIR_EXCEPTION];
        pd = { base: mod.base, addr: d.rva ? mod.base + d.rva : 0, count: Math.floor(d.size / 12) };
        pdataCache.set(mod.base, pd);
      }
      if (pd.count) {
        const rva = vpc - mod.base;
        let lo = 0, hi = pd.count - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const e = pd.addr + mid * 12;
          const b = mem.r32(e), en = mem.r32(e + 4);
          if (rva < b) hi = mid - 1;
          else if (rva >= en) lo = mid + 1;
          else return { ptr: e, base: mod.base, begin: b, end: en, unwind: mem.r32(e + 8) };
        }
      }
    }
    for (const t of p.dynamicTables) {
      const rva = vpc - t.base;
      for (let i = 0; i < t.count; i++) {
        const e = t.table + i * 12;
        if (rva >= mem.r32(e) && rva < mem.r32(e + 4)) return { ptr: e, base: t.base, begin: mem.r32(e), end: mem.r32(e + 4), unwind: mem.r32(e + 8) };
      }
    }
    return null;
  };

  // ---------------------------------------------------------------------------------------
  // CONTEXT <-> CPU
  // ---------------------------------------------------------------------------------------
  p.captureContext = (ctx: number, rip: number, rsp: number) => {
    mem.fill(ctx, 0, CTX.SIZE);
    mem.w32(ctx + CTX.FLAGS, CONTEXT_FULL);
    mem.w32(ctx + CTX.MXCSR, m.dv.getUint32(L.STATE + L.S_MXCSR, true));
    for (let i = 0; i < 16; i++) mem.w64(ctx + GPR_CTX_OFF[i], m.gpr(i));
    mem.w64(ctx + CTX.RSP, rsp);
    mem.w64(ctx + CTX.RIP, rip);
    mem.w32(ctx + CTX.EFLAGS, m.eflags);
    for (let i = 0; i < 16; i++) mem.write(ctx + CTX.XMM0 + i * 16, m.xmm(i));
    mem.w16(ctx + 0x38, 0x33); mem.w16(ctx + 0x42, 0x2b);
  };
  p.applyContext = (c: Uint8Array) => {
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    for (let i = 0; i < 16; i++) m.dv.setBigUint64(L.gprOff(i), dv.getBigUint64(GPR_CTX_OFF[i], true), true);
    const rip = Number(dv.getBigUint64(CTX.RIP, true));
    m.rip = rip >>> 0;
    m.eflags = dv.getUint32(CTX.EFLAGS, true);
    m.dv.setUint32(L.STATE + L.S_MXCSR, dv.getUint32(CTX.MXCSR, true), true);
    for (let i = 0; i < 16; i++) m.xmm(i).set(c.subarray(CTX.XMM0 + i * 16, CTX.XMM0 + i * 16 + 16));
  };

  // ---------------------------------------------------------------------------------------
  // RtlVirtualUnwind
  // ---------------------------------------------------------------------------------------
  interface UnwindResult { handler: number; handlerData: number; establisher: number }
  const virtualUnwind = (handlerType: number, imageBase: number, pc: number, fe: FuncEntry, ctx: number): UnwindResult => {
    let rf = fe;
    let rspV = mem.r64n(ctx + CTX.RSP);
    let establisher = rspV;
    let prolog = pc - (imageBase + fe.begin);
    let chained = false;
    let handler = 0, handlerData = 0;
    for (let guard = 0; guard < 16; guard++) {
      const ui = imageBase + rf.unwind;
      const verFlags = mem.r8(ui);
      const flags = verFlags >> 3;
      const sizeOfProlog = mem.r8(ui + 1);
      const count = mem.r8(ui + 2);
      const frameReg = mem.r8(ui + 3) & 0xf;
      const frameOff = (mem.r8(ui + 3) >> 4) * 16;
      const codes = ui + 4;
      const regOff = (r: number) => GPR_CTX_OFF[r];
      let i = 0;
      const inProlog = !chained && prolog >= 0 && prolog < sizeOfProlog;
      // establisher frame
      if (frameReg) establisher = mem.r64n(ctx + regOff(frameReg)) - frameOff;
      while (i < count) {
        const codeOffset = mem.r8(codes + i * 2);
        const opInfo = mem.r8(codes + i * 2 + 1);
        const op = opInfo & 0xf, info = opInfo >> 4;
        let slots = 1;
        let apply = true;
        if (inProlog && codeOffset > prolog) apply = false;
        switch (op) {
          case 0: // PUSH_NONVOL
            if (apply) { mem.w64(ctx + regOff(info), mem.r64(rspV)); rspV += 8; }
            break;
          case 1: { // ALLOC_LARGE
            let size: number;
            if (info === 0) { size = mem.r16(codes + (i + 1) * 2) * 8; slots = 2; } else { size = mem.r16(codes + (i + 1) * 2) + mem.r16(codes + (i + 2) * 2) * 65536; slots = 3; }
            if (apply) rspV += size;
            break;
          }
          case 2: // ALLOC_SMALL
            if (apply) rspV += info * 8 + 8;
            break;
          case 3: // SET_FPREG
            if (apply) rspV = mem.r64n(ctx + regOff(frameReg)) - frameOff;
            break;
          case 4: { // SAVE_NONVOL
            const off = mem.r16(codes + (i + 1) * 2) * 8;
            slots = 2;
            if (apply) mem.w64(ctx + regOff(info), mem.r64(rspV + off));
            break;
          }
          case 5: { // SAVE_NONVOL_FAR
            const off = mem.r16(codes + (i + 1) * 2) + mem.r16(codes + (i + 2) * 2) * 65536;
            slots = 3;
            if (apply) mem.w64(ctx + regOff(info), mem.r64(rspV + off));
            break;
          }
          case 8: { // SAVE_XMM128
            const off = mem.r16(codes + (i + 1) * 2) * 16;
            slots = 2;
            if (apply) mem.copy(ctx + CTX.XMM0 + info * 16, rspV + off, 16);
            break;
          }
          case 9: { // SAVE_XMM128_FAR
            const off = mem.r16(codes + (i + 1) * 2) + mem.r16(codes + (i + 2) * 2) * 65536;
            slots = 3;
            if (apply) mem.copy(ctx + CTX.XMM0 + info * 16, rspV + off, 16);
            break;
          }
          case 10: { // PUSH_MACHFRAME
            if (apply) {
              if (info) rspV += 8; // error code
              mem.w64(ctx + CTX.RIP, mem.r64(rspV));
              rspV = mem.r64n(rspV + 24);
              mem.w64(ctx + CTX.RSP, rspV);
              return { handler: 0, handlerData: 0, establisher: rspV };
            }
            break;
          }
          case 6: case 7: // epilog / spare (v2): skip
            slots = 1;
            break;
          default:
            throw new Error("unknown unwind opcode " + op);
        }
        i += slots;
      }
      const afterCodes = codes + ((count + 1) & ~1) * 2;
      if (flags & UNW_FLAG_CHAININFO) {
        const cp = afterCodes;
        rf = { ptr: cp, base: imageBase, begin: mem.r32(cp), end: mem.r32(cp + 4), unwind: mem.r32(cp + 8) };
        chained = true;
        continue;
      }
      if (flags & handlerType) {
        handler = imageBase + mem.r32(afterCodes);
        handlerData = afterCodes + 4;
      }
      break;
    }
    // pop the return address
    mem.w64(ctx + CTX.RIP, mem.r64(rspV));
    rspV += 8;
    mem.w64(ctx + CTX.RSP, rspV);
    return { handler, handlerData, establisher };
  };

  /**
   * When the walk reaches the return sentinel of a nested callGuest, continue from the context that was being
   * dispatched/unwound when the handler was invoked (the host frames in between are transparent, as the real
   * RtlDispatchException/RtlUnwindEx frames would be on Windows).
   */
  const crossHostFrame = (ctx: number): boolean => {
    if (mem.r64n(ctx + CTX.RIP) !== p.sentinel) return false;
    const sp = mem.r64n(ctx + CTX.RSP);
    for (let i = p.hostFrames.length - 1; i >= 0; i--) {
      if (p.hostFrames[i].end === sp && p.hostFrames[i].ctx) { mem.copy(ctx, p.hostFrames[i].ctx, CTX.SIZE); return true; }
    }
    return false;
  };

  /** unwind a leaf function (no unwind info): return address is at [rsp] */
  const leafUnwind = (ctx: number) => {
    const rsp = mem.r64n(ctx + CTX.RSP);
    mem.w64(ctx + CTX.RIP, mem.r64(rsp));
    mem.w64(ctx + CTX.RSP, rsp + 8);
  };

  k.fn("RtlLookupFunctionEntry", (c) => {
    const pc = c.argN(0);
    const fe = p.lookupFunctionEntry(pc);
    if (!fe) return 0;
    if (c.arg(1)) mem.wptr(c.arg(1), fe.base);
    return fe.ptr;
  });
  alias("RtlLookupFunctionEntry", "RtlLookupFunctionEntry");
  k.fn("RtlVirtualUnwind", (c) => {
    const handlerType = c.arg(0), imageBase = c.argN(1), pc = c.argN(2), rfPtr = c.arg(3), ctx = c.arg(4);
    const rf: FuncEntry = { ptr: rfPtr, base: imageBase, begin: mem.r32(rfPtr), end: mem.r32(rfPtr + 4), unwind: mem.r32(rfPtr + 8) };
    const r = virtualUnwind(handlerType, imageBase, pc, rf, ctx);
    if (c.arg(5)) mem.wptr(c.arg(5), r.handlerData);
    if (c.arg(6)) mem.wptr(c.arg(6), r.establisher);
    // context pointers (arg 7) are not tracked
    return r.handler;
  });
  alias("RtlVirtualUnwind", "RtlVirtualUnwind");
  k.fn("RtlCaptureContext", (c) => {
    const ctx = c.arg(0);
    p.captureContext(ctx, c.retAddr, c.rsp + 8);
    // rax/rcx at capture time are unspecified; keep the argument registers meaningful
  });
  alias("RtlCaptureContext", "RtlCaptureContext");
  k.fn("RtlCaptureContext2", (c) => { p.captureContext(c.arg(0), c.retAddr, c.rsp + 8); });
  k.fn("RtlRestoreContext", (c) => {
    const ctx = c.arg(0);
    throw new ContinueSignal(mem.bytes(ctx, CTX.SIZE).slice());
  });
  alias("RtlRestoreContext", "RtlRestoreContext");
  k.fn("NtContinue", (c) => { throw new ContinueSignal(mem.bytes(c.arg(0), CTX.SIZE).slice()); });
  k.fn("RtlAddFunctionTable", (c) => { p.dynamicTables.push({ table: c.arg(0), count: c.arg(1), base: c.argN(2), callback: 0 }); return 1; });
  alias("RtlAddFunctionTable", "RtlAddFunctionTable");
  k.fn("RtlDeleteFunctionTable", (c) => { const i = p.dynamicTables.findIndex((t) => t.table === c.arg(0)); if (i >= 0) p.dynamicTables.splice(i, 1); return 1; });
  alias("RtlDeleteFunctionTable", "RtlDeleteFunctionTable");
  k.fn("RtlInstallFunctionTableCallback", (c) => { p.dynamicTables.push({ table: 0, count: 0, base: c.argN(1), callback: c.arg(3) }); return 1; });
  k.fn("RtlCaptureStackBackTrace", (c) => {
    const skip = c.arg(0), cnt = c.arg(1), buf = c.arg(2);
    const ctx = p.vm.alloc(0x1000, { commit: true });
    p.captureContext(ctx, c.retAddr, c.rsp + 8);
    let n2 = 0;
    for (let depth = 0; depth < 64 && n2 < cnt; depth++) {
      const rip = mem.r64n(ctx + CTX.RIP);
      if (!rip) break;
      if (depth >= skip) mem.wptr(buf + 8 * n2++, rip);
      const fe = p.lookupFunctionEntry(rip);
      if (!fe) leafUnwind(ctx); else virtualUnwind(0, fe.base, rip, fe, ctx);
    }
    p.vm.release(ctx);
    return n2;
  });
  alias("RtlCaptureStackBackTrace", "RtlCaptureStackBackTrace");
  k.fn("CaptureStackBackTrace", (c) => {
    const f = n.lookup("RtlCaptureStackBackTrace")!;
    void f;
    return 0;
  });

  // ---------------------------------------------------------------------------------------
  // EXCEPTION_RECORD helpers
  // ---------------------------------------------------------------------------------------
  const makeRecord = (code: number, flags: number, addr: number, params: bigint[]): number => {
    const rec = p.vm.alloc(0x1000, { commit: true, tag: "excrec" });
    mem.w32(rec, code); mem.w32(rec + 4, flags); mem.wptr(rec + 8, 0); mem.wptr(rec + 0x10, addr);
    mem.w32(rec + 0x18, params.length);
    params.forEach((v, i) => mem.w64(rec + 0x20 + i * 8, v));
    return rec;
  };

  // ---------------------------------------------------------------------------------------
  // dispatch (first pass)
  // ---------------------------------------------------------------------------------------
  p.dispatchException = (rec: number, ctx: number): "continue" | "unhandled" => {
    const flags = mem.r32(rec + 4);
    // vectored handlers
    if (p.vectoredHandlers.length) {
      const ep = p.vm.alloc(0x1000, { commit: true });
      mem.wptr(ep, rec); mem.wptr(ep + 8, ctx);
      for (const h of [...p.vectoredHandlers]) {
        const r = Number(p.callGuest(h.fn, [ep]) & 0xffffffffn) | 0;
        if (r === -1) { p.vm.release(ep); return "continue"; }
      }
      p.vm.release(ep);
    }
    const work = p.vm.alloc(0x2000, { commit: true, tag: "dispatch" });
    const frameCtx = work, nextCtx = work + 0x600, dctx = work + 0x1000;
    mem.copy(nextCtx, ctx, CTX.SIZE);
    try {
      for (let depth = 0; depth < 512; depth++) {
        mem.copy(frameCtx, nextCtx, CTX.SIZE);
        const pc = mem.r64n(nextCtx + CTX.RIP);
        if (!pc) break;
        const fe = p.lookupFunctionEntry(pc);
        if (process.env.SEHDEBUG) p.log(`[seh-dbg] frame pc=${pc.toString(16)} rsp=${mem.r64n(nextCtx + CTX.RSP).toString(16)} fe=${fe ? fe.begin.toString(16) + '-' + fe.end.toString(16) : 'none'}`);
        if (!fe) {
          if (crossHostFrame(nextCtx)) continue;
          // leaf: also stop if the stack pointer is nonsense
          const sp = mem.r64n(nextCtx + CTX.RSP);
          if (!sp || sp >= 0xffffff00) break;
          leafUnwind(nextCtx);
          continue;
        }
        const r = virtualUnwind(UNW_FLAG_EHANDLER, fe.base, pc, fe, nextCtx);
        if (process.env.SEHDEBUG) p.log(`[seh-dbg]   handler=${r.handler.toString(16)} est=${r.establisher.toString(16)}`);
        if (!r.handler) continue;
        // DISPATCHER_CONTEXT
        mem.fill(dctx, 0, 0x60);
        mem.wptr(dctx, pc); mem.wptr(dctx + 8, fe.base); mem.wptr(dctx + 0x10, fe.ptr); mem.wptr(dctx + 0x18, r.establisher);
        mem.wptr(dctx + 0x20, 0); mem.wptr(dctx + 0x28, frameCtx); mem.wptr(dctx + 0x30, r.handler); mem.wptr(dctx + 0x38, r.handlerData);
        mem.wptr(dctx + 0x40, 0); mem.w32(dctx + 0x48, 0);
        const disp = Number(p.callGuest(r.handler, [rec, r.establisher, ctx, dctx], [], ctx) & 0xffffffffn) | 0;
        if (disp === 0) { // ExceptionContinueExecution
          if (flags & EXCEPTION_NONCONTINUABLE) throw new Error("noncontinuable exception handler returned ExceptionContinueExecution");
          return "continue";
        }
        if (disp === 1) continue; // ContinueSearch
        // nested / collided: treat as continue-search
      }
    } finally {
      p.vm.release(work);
    }
    return "unhandled";
  };

  // ---------------------------------------------------------------------------------------
  // RtlUnwindEx (second pass)
  // ---------------------------------------------------------------------------------------
  const unwindEx = (targetFrame: number, targetIp: number, recIn: number, retVal: bigint, origCtx: number, callerCtx: number): never => {
    let rec = recIn;
    let allocRec = false;
    if (process.env.SEHDEBUG) p.log(`[seh-dbg] RtlUnwindEx target=${targetFrame.toString(16)} ip=${targetIp.toString(16)} rec=${recIn.toString(16)} rip=${mem.r64n(origCtx + CTX.RIP).toString(16)} rsp=${mem.r64n(origCtx + CTX.RSP).toString(16)}`);
    if (!rec) {
      rec = makeRecord(STATUS_UNWIND, EXCEPTION_UNWINDING | (targetFrame ? 0 : EXCEPTION_EXIT_UNWIND), mem.r64n(origCtx + CTX.RIP), []);
      allocRec = true;
    } else {
      mem.w32(rec + 4, mem.r32(rec + 4) | EXCEPTION_UNWINDING | (targetFrame ? 0 : EXCEPTION_EXIT_UNWIND));
    }
    const work = p.vm.alloc(0x2000, { commit: true, tag: "unwind" });
    const frameCtx = work, nextCtx = work + 0x600, dctx = work + 0x1000;
    // RtlUnwindEx walks from its caller's context; `origCtx` is only a scratch/result buffer
    mem.copy(nextCtx, callerCtx, CTX.SIZE);
    let finalCtx = -1;
    for (let depth = 0; depth < 1024; depth++) {
      mem.copy(frameCtx, nextCtx, CTX.SIZE);
      const pc = mem.r64n(nextCtx + CTX.RIP);
      if (!pc) break;
      const fe = p.lookupFunctionEntry(pc);
      if (!fe) {
        if (crossHostFrame(nextCtx)) continue;
        const sp = mem.r64n(nextCtx + CTX.RSP);
        if (targetFrame && sp === targetFrame) { finalCtx = frameCtx; break; }
        if (!sp || sp >= 0xffffff00) break;
        leafUnwind(nextCtx);
        continue;
      }
      const r = virtualUnwind(UNW_FLAG_UHANDLER, fe.base, pc, fe, nextCtx);
      const atTarget = targetFrame !== 0 && r.establisher === targetFrame;
      if (r.handler) {
        const flags0 = mem.r32(rec + 4);
        if (atTarget) mem.w32(rec + 4, flags0 | EXCEPTION_TARGET_UNWIND);
        mem.fill(dctx, 0, 0x60);
        mem.wptr(dctx, pc); mem.wptr(dctx + 8, fe.base); mem.wptr(dctx + 0x10, fe.ptr); mem.wptr(dctx + 0x18, r.establisher);
        mem.wptr(dctx + 0x20, atTarget ? targetIp : 0); mem.wptr(dctx + 0x28, frameCtx); mem.wptr(dctx + 0x30, r.handler); mem.wptr(dctx + 0x38, r.handlerData);
        mem.wptr(dctx + 0x40, 0); mem.w32(dctx + 0x48, 0);
        const dr = p.callGuest(r.handler, [rec, r.establisher, origCtx, dctx], [], callerCtx);
        if (process.env.SEHDEBUG) p.log(`[seh-dbg] unwind frame pc=${pc.toString(16)} handler=${r.handler.toString(16)} est=${r.establisher.toString(16)} atTarget=${atTarget} -> ${dr}`);
        mem.w32(rec + 4, flags0);
      }
      if (atTarget) { finalCtx = frameCtx; break; }
    }
    if (finalCtx < 0) {
      // no target frame found (exit unwind): continue from the last context
      finalCtx = nextCtx;
    }
    mem.copy(origCtx, finalCtx, CTX.SIZE);
    mem.w64(origCtx + CTX.RAX, retVal);
    mem.w64(origCtx + CTX.RIP, targetIp);
    const out = mem.bytes(origCtx, CTX.SIZE).slice();
    p.vm.release(work);
    if (allocRec) p.vm.release(rec);
    p.vm.release(callerCtx);
    throw new ContinueSignal(out);
  };
  k.fn("RtlUnwindEx", (c) => {
    const cc = p.vm.alloc(0x1000, { commit: true, tag: "callerctx" });
    p.captureContext(cc, c.retAddr, c.rsp + 8);
    unwindEx(c.argN(0), c.argN(1), c.arg(2), c.arg64(3), c.arg(4), cc);
  });
  alias("RtlUnwindEx", "RtlUnwindEx");
  k.fn("RtlUnwind", (c) => {
    const ctx = p.vm.alloc(0x1000, { commit: true });
    p.captureContext(ctx, c.retAddr, c.rsp + 8);
    unwindEx(c.argN(0), c.argN(1), c.arg(2), c.arg64(3), ctx, ctx);
  });
  alias("RtlUnwind", "RtlUnwind");

  // ---------------------------------------------------------------------------------------
  // __C_specific_handler: language handler for __try/__except/__finally (SCOPE_TABLE in the handler data)
  // ---------------------------------------------------------------------------------------
  n.fn("__C_specific_handler", (c) => {
    const rec = c.arg(0), frame = c.argN(1), context = c.arg(2), dctx = c.arg(3);
    const table = mem.r32(dctx + 0x38); // HandlerData
    const base = mem.r64n(dctx + 8);
    const pc = mem.r64n(dctx);
    const count = mem.r32(table);
    const flags = mem.r32(rec + 4);
    const rd = (i: number, f: number) => mem.r32(table + 4 + i * 16 + f * 4);
    const targetIp = mem.r64n(dctx + 0x20);
    let scope = mem.r32(dctx + 0x48);
    if (process.env.SEHDEBUG) p.log(`[seh-dbg] C_specific pc=${pc.toString(16)} base=${base.toString(16)} count=${count} flags=${flags} scopes=` + Array.from({ length: count }, (_, i) => [rd(i,0),rd(i,1),rd(i,2),rd(i,3)].map((v) => v.toString(16)).join(':')).join(' '));
    if (flags & (EXCEPTION_UNWINDING | EXCEPTION_EXIT_UNWIND)) {
      for (let i = scope; i < count; i++) {
        if (pc >= base + rd(i, 0) && pc < base + rd(i, 1)) {
          if (rd(i, 3)) continue; // an __except scope has no termination handler
          if ((flags & EXCEPTION_TARGET_UNWIND) && targetIp >= base + rd(i, 0) && targetIp < base + rd(i, 1)) break;
          mem.w32(dctx + 0x48, i + 1);
          p.callGuest(base + rd(i, 2), [1, frame]); // termination handler(abnormal = TRUE, frame)
        }
      }
      return 1; // ExceptionContinueSearch
    }
    for (let i = scope; i < count; i++) {
      if (pc >= base + rd(i, 0) && pc < base + rd(i, 1)) {
        if (!rd(i, 3)) continue; // __finally scope
        let ret: number;
        if (rd(i, 2) === 1) ret = 1; // EXCEPTION_EXECUTE_HANDLER constant filter
        else {
          const ep = p.vm.alloc(0x1000, { commit: true, tag: "excptrs" });
          mem.wptr(ep, rec); mem.wptr(ep + 8, context);
          ret = Number(p.callGuest(base + rd(i, 2), [ep, frame]) & 0xffffffffn) | 0;
          p.vm.release(ep);
        }
        if (ret < 0) return 0; // EXCEPTION_CONTINUE_EXECUTION -> ExceptionContinueExecution
        if (ret > 0) {
          // EXCEPTION_EXECUTE_HANDLER: unwind to this frame and run the __except block
          const cc = p.vm.alloc(0x1000, { commit: true, tag: "callerctx" });
          p.captureContext(cc, c.retAddr, c.rsp + 8);
          unwindEx(frame, base + rd(i, 3), rec, BigInt(mem.r32(rec)), mem.r32(dctx + 0x28), cc);
        }
      }
    }
    return 1;
  });
  n.fn("_GCC_specific_handler", () => 1);

  // ---------------------------------------------------------------------------------------
  // raising
  // ---------------------------------------------------------------------------------------
  p.describeException = (code: number): string => {
    const names: Record<number, string> = {
      0xc0000005: "access violation", 0x80000003: "breakpoint", 0xc000001d: "illegal instruction", 0xc0000094: "integer divide by zero",
      0xc0000096: "privileged instruction", 0xe06d7363: "C++ exception", 0xc00000fd: "stack overflow", 0xc0000025: "noncontinuable exception",
    };
    return names[code] ?? "exception";
  };
  const terminateUnhandled = (rec: number, ctxPtr: number): never => {
    const code = mem.r32(rec);
    const addr = mem.r64n(rec + 0x10);
    // user's unhandled exception filter gets one chance
    if (p.unhandledFilter) {
      const ep = p.vm.alloc(0x1000, { commit: true });
      mem.wptr(ep, rec); mem.wptr(ep + 8, ctxPtr);
      const r = Number(p.callGuest(p.unhandledFilter, [ep]) & 0xffffffffn) | 0;
      p.vm.release(ep);
      if (r === -1) throw new ContinueSignal(mem.bytes(ctxPtr, CTX.SIZE).slice());
    }
    p.log(`[seh] unhandled ${p.describeException(code)} 0x${code.toString(16)} at 0x${addr.toString(16)} (${p.describeAddr(addr)})`);
    p.exitCode = code;
    p.exited = true;
    throw new ProcessExit(code);
  };
  p.raiseException = (code, flags, params, ctx, addr) => {
    const rec = makeRecord(code, flags, addr, params);
    const res = p.dispatchException(rec, ctx);
    if (res === "unhandled") terminateUnhandled(rec, ctx);
    p.vm.release(rec);
    if (flags & EXCEPTION_NONCONTINUABLE) throw new Error("noncontinuable exception continued");
    throw new ContinueSignal(mem.bytes(ctx, CTX.SIZE).slice());
  };
  k.fn("RaiseException", (c) => {
    const code = c.arg(0), flags = c.arg(1), nargs = Math.min(c.arg(2), 15), argv = c.arg(3);
    const params: bigint[] = [];
    for (let i = 0; i < nargs; i++) params.push(mem.r64(argv + i * 8));
    const ctx = p.vm.alloc(0x1000, { commit: true, tag: "raisectx" });
    p.captureContext(ctx, c.retAddr, c.rsp + 8);
    // The context resumes after the RaiseException call: return value register (rax) is whatever the caller expects
    const rec = makeRecord(code, flags & ~(EXCEPTION_UNWINDING), c.retAddr, params);
    const res = p.dispatchException(rec, ctx);
    if (res === "unhandled") terminateUnhandled(rec, ctx);
    p.vm.release(rec);
    p.vm.release(ctx);
  });
  alias("RtlRaiseException", "RaiseException", k);
  n.fn("RtlRaiseException", (c) => {
    const rec = c.arg(0);
    const ctx = p.vm.alloc(0x1000, { commit: true, tag: "raisectx" });
    p.captureContext(ctx, c.retAddr, c.rsp + 8);
    const res = p.dispatchException(rec, ctx);
    if (res === "unhandled") terminateUnhandled(rec, ctx);
    p.vm.release(ctx);
  });
  n.fn("NtRaiseException", (c) => {
    const rec = c.arg(0), ctx = c.arg(1);
    const res = p.dispatchException(rec, ctx);
    if (res === "unhandled") terminateUnhandled(rec, ctx);
    throw new ContinueSignal(mem.bytes(ctx, CTX.SIZE).slice());
  });
  n.fn("RtlDispatchException", (c) => (p.dispatchException(c.arg(0), c.arg(1)) === "continue" ? 1 : 0));

  // ---------------------------------------------------------------------------------------
  // hardware faults reported by the JIT (called from the scheduler with the CPU state at the fault)
  // ---------------------------------------------------------------------------------------
  p.handleHardwareFault = (t: Thread, kind: number, faultAddr: number) => {
    let code: number, params: bigint[] = [];
    const rip = m.rip;
    let addr = m.virt(rip);
    switch (kind) {
      case L.FK_DIV: code = STATUS_INTEGER_DIVIDE_BY_ZERO; break;
      case L.FK_INT3: code = STATUS_BREAKPOINT; addr -= 1; break;
      case L.FK_INVALID: code = STATUS_ILLEGAL_INSTRUCTION; break;
      case L.FK_HLT: code = STATUS_PRIVILEGED_INSTRUCTION; break;
      case L.FK_READ: case L.FK_WRITE: case L.FK_EXEC:
        code = STATUS_ACCESS_VIOLATION;
        params = [BigInt(kind === L.FK_WRITE ? 1 : kind === L.FK_EXEC ? 8 : 0), BigInt(faultAddr)];
        break;
      default: code = STATUS_ILLEGAL_INSTRUCTION;
    }
    const ctx = p.vm.alloc(0x1000, { commit: true, tag: "faultctx" });
    p.captureContext(ctx, m.virt(rip), Number(m.gpr(4)));
    const rec = makeRecord(code, 0, addr, params);
    const res = p.dispatchException(rec, ctx);
    if (res === "unhandled") terminateUnhandled(rec, ctx);
    const out = mem.bytes(ctx, CTX.SIZE).slice();
    p.vm.release(rec);
    p.vm.release(ctx);
    throw new ContinueSignal(out);
  };
}
