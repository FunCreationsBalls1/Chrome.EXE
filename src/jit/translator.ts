// Trace discovery + module assembly. Turns guest code at a given pc into WebAssembly functions.
import { ModuleBuilder } from "../wasm/builder.ts";
import { O, VT } from "../wasm/opcodes.ts";
import { decode, Insn, K_IMM, K_MEM, K_REG } from "../x86/decode.ts";
import { Op } from "../x86/ops.ts";
import { CC_READS, flagInfo } from "../x86/flags.ts";
import * as L from "./layout.ts";
import { Gen, IMP, declareImports } from "./gen.ts";
import type { GenConfig } from "./gen.ts";
import { pushRaw64, src, translateInt } from "./xlat-int.ts";
import { translateSSE } from "./xlat-sse.ts";
import { translateX87 } from "./xlat-x87.ts";

const { i32: I32, i64: I64 } = VT;

export const MAX_TRACE_INSNS = 48;
const ALL = L.F_ARITH;

export interface TranslatorHost {
  /** guest memory (address == index) */
  mem(): Uint8Array;
  slotFor(pc: number): number;
  smc: boolean;
  virtHigh(addr: number): number;
}

export interface TraceResult {
  pc: number;
  slot: number;
  /** guest byte ranges covered by this trace [start, end) */
  ranges: [number, number][];
  insnCount: number;
}

export function isThunk(pc: number): boolean {
  return pc >= L.THUNK_BASE && pc < L.THUNK_BASE + L.THUNK_SIZE;
}

export class Translator {
  private host: TranslatorHost;
  private deadCache = new Map<number, boolean>();
  stats = { traces: 0, insns: 0, invalid: 0, unsupported: new Map<string, number>() };

  constructor(host: TranslatorHost) {
    this.host = host;
  }

  flushCaches() {
    this.deadCache.clear();
  }

  /** Are all arithmetic flags certainly dead on entry to `pc`? (decodes a few instructions) */
  flagsDeadAt(pc: number): boolean {
    const c = this.deadCache.get(pc);
    if (c !== undefined) return c;
    let needed = ALL;
    let a = pc;
    let result = false;
    const mem = this.host.mem();
    for (let n = 0; n < 12; n++) {
      if (isThunk(a)) { result = true; break; }
      const ins = decode(mem, a);
      if (ins.invalid) { result = false; break; }
      const fi = flagInfo(ins);
      if (fi.rd & needed) { result = false; break; }
      needed &= ~fi.kill;
      if (needed === 0) { result = true; break; }
      if (ins.op === Op.RET || ins.op === Op.RET_IMM || ins.op === Op.CALL || ins.op === Op.CALL_IND || ins.op === Op.JMP_IND) {
        result = true; // flags are not part of the calling convention
        break;
      }
      if (ins.op === Op.JMP && ins.target >= 0) { a = ins.target; continue; }
      if (ins.op === Op.JCC || ins.op === Op.LOOP || ins.op === Op.LOOPE || ins.op === Op.LOOPNE || ins.op === Op.JRCXZ ||
          ins.op === Op.HLT || ins.op === Op.UD2 || ins.op === Op.INT3 || ins.op === Op.INT) {
        result = false;
        break;
      }
      a += ins.len;
    }
    this.deadCache.set(pc, result);
    return result;
  }

  // ---------------------------------------------------------------------------------------
  decodeTrace(entry: number): Insn[] {
    const mem = this.host.mem();
    const out: Insn[] = [];
    const seen = new Set<number>();
    let pc = entry;
    for (;;) {
      if (out.length >= MAX_TRACE_INSNS) break;
      if (out.length && isThunk(pc)) break;
      if (seen.has(pc)) break;
      seen.add(pc);
      const ins = decode(mem, pc);
      out.push(ins);
      if (ins.invalid) break;
      const op = ins.op;
      if (op === Op.JMP && ins.target >= 0) {
        // follow unconditional direct jumps (forward or backward) unless we would revisit
        if (!seen.has(ins.target) && !isThunk(ins.target) && out.length < MAX_TRACE_INSNS - 1) {
          pc = ins.target;
          continue;
        }
        break;
      }
      if (op === Op.JMP || op === Op.JMP_IND || op === Op.CALL || op === Op.CALL_IND || op === Op.RET || op === Op.RET_IMM ||
          op === Op.HLT || op === Op.UD2 || op === Op.INT3 || op === Op.INT || op === Op.SYSCALL) break;
      pc = ins.addr + ins.len;
    }
    return out;
  }

  /** live flags *after* each instruction */
  computeLiveness(insns: Insn[]): number[] {
    const n = insns.length;
    const liveOut = new Array<number>(n).fill(0);
    let liveIn = 0; // live-in of the instruction following the trace is decided by the last instruction below
    for (let i = n - 1; i >= 0; i--) {
      const ins = insns[i];
      const fi = flagInfo(ins);
      let out: number;
      const op = ins.op;
      const nextIn = i + 1 < n ? liveIn : -1; // liveIn currently holds the value for i+1
      const exitLive = (t: number) => (this.flagsDeadAt(t) ? 0 : ALL);
      const fall = () => (nextIn >= 0 ? nextIn : exitLive(ins.addr + ins.len));
      if (op === Op.JMP) {
        // followed (continues at insns[i+1], which sits at the target) or final
        const followed = i + 1 < n && insns[i + 1].addr === ins.target;
        out = followed ? liveIn : exitLive(ins.target);
      } else if (op === Op.JCC || op === Op.LOOP || op === Op.LOOPE || op === Op.LOOPNE || op === Op.JRCXZ) {
        out = fall() | exitLive(ins.target);
      } else if (op === Op.CALL || op === Op.CALL_IND || op === Op.RET || op === Op.RET_IMM || op === Op.JMP_IND) {
        out = 0; // flags are dead across calls/returns/indirect jumps (ABI)
      } else if (op === Op.HLT || op === Op.UD2 || op === Op.INT3 || op === Op.INT || op === Op.INVALID || op === Op.SYSCALL) {
        out = ALL;
      } else {
        out = fall();
      }
      liveOut[i] = out;
      liveIn = (out & ~fi.kill) | fi.rd;
      if (op === Op.LOOPE || op === Op.LOOPNE) liveIn |= L.F_ZF;
    }
    return liveOut;
  }

  // ---------------------------------------------------------------------------------------
  /** Build a module containing translated traces for each pc. */
  buildModule(pcs: number[]): { bytes: Uint8Array; traces: TraceResult[] } {
    const mb = new ModuleBuilder();
    declareImports(mb);
    const traces: TraceResult[] = [];
    const cfg: GenConfig = {
      slotFor: (pc) => this.host.slotFor(pc),
      smc: this.host.smc,
      flagsDeadAt: (pc) => this.flagsDeadAt(pc),
      virtHigh: (a) => this.host.virtHigh(a),
    };
    const funcIdx: number[] = [];
    for (const pc of pcs) {
      const { f, index } = mb.func([I32], [I32]);
      const g = new Gen(mb, f, cfg);
      let tr: TraceResult;
      if (isThunk(pc)) tr = this.emitThunk(g, pc);
      else tr = this.emitTrace(g, pc);
      g.finish();
      tr.slot = this.host.slotFor(pc);
      traces.push(tr);
      funcIdx.push(index);
    }
    for (let i = 0; i < traces.length; i++) mb.elem(traces[i].slot, [funcIdx[i]]);
    return { bytes: mb.encode(), traces };
  }

  private emitThunk(g: Gen, pc: number): TraceResult {
    const f = g.f;
    const id = (pc - L.THUNK_BASE) / L.THUNK_STRIDE;
    const s = f.newLocal(I32);
    f.i32(id).call(IMP.hle).tee(s);
    f.if_();
    f.get(s).op(O.return);
    f.end();
    // emulate RET: rip = [rsp]; rsp += 8
    const t = f.newLocal(I32);
    f.i32(0).mem(O.i32_load, L.gprOff(4), 2).set(t); // low 32 bits of rsp
    f.i32(0).get(t).i32(8).op(O.i32_add).mem(O.i32_store, L.gprOff(4), 2);
    f.get(t).mem(O.i32_load, 0, 2).set(t); // return address (low 32 bits)
    g.emitBudgetCheck(0, t);
    f.get(t).get(t).call(IMP.lookup).returnCallIndirect(g.blockType);
    return { pc, slot: 0, ranges: [], insnCount: 0 };
  }

  private emitTrace(g: Gen, entry: number): TraceResult {
    const f = g.f;
    const insns = this.decodeTrace(entry);
    const live = this.computeLiveness(insns);
    const ranges: [number, number][] = [];
    for (const ins of insns) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === ins.addr) last[1] = ins.addr + ins.len;
      else ranges.push([ins.addr, ins.addr + ins.len]);
    }
    this.stats.traces++;
    this.stats.insns += insns.length;

    let terminated = false;
    for (let i = 0; i < insns.length; i++) {
      const ins = insns[i];
      g.ins = ins;
      g.liveAfter = live[i];
      g.nextPc = ins.addr + ins.len;
      const op = ins.op;
      const nextIsTarget = i + 1 < insns.length && insns[i + 1].addr === ins.target;
      switch (op) {
        case Op.INVALID:
          this.stats.invalid++;
          g.emitExitToHost(ins.addr, L.ST_INVALID);
          terminated = true;
          break;
        case Op.JMP:
          if (nextIsTarget) break;
          g.emitJumpStatic(ins.target, ins.target <= ins.addr);
          terminated = true;
          break;
        case Op.JCC: {
          g.emitCond(ins.cc);
          f.if_();
          g.emitJumpStatic(ins.target, ins.target <= ins.addr);
          f.end();
          break;
        }
        case Op.LOOP: case Op.LOOPE: case Op.LOOPNE: case Op.JRCXZ: {
          const addr32 = ins.asz === 4;
          if (op !== Op.JRCXZ) {
            g.getG(1);
            f.i64(1).op(O.i64_sub);
            if (addr32) {
              // ecx wraps within 32 bits and zero-extends
              f.op(O.i32_wrap_i64).op(O.i64_extend_i32_u);
            }
            g.setG(1);
          }
          g.getG(1);
          if (addr32) f.op(O.i32_wrap_i64).op(O.i32_eqz);
          else f.op(O.i64_eqz);
          if (op === Op.JRCXZ) {
            // taken when rcx == 0
          } else {
            f.i32(1).op(O.i32_xor); // rcx != 0
            if (op === Op.LOOPE) {
              g.emitCond(4);
              f.op(O.i32_and);
            } else if (op === Op.LOOPNE) {
              g.emitCond(5);
              f.op(O.i32_and);
            }
          }
          f.if_();
          g.emitJumpStatic(ins.target, ins.target <= ins.addr);
          f.end();
          break;
        }
        case Op.CALL: {
          const ret = ins.addr + ins.len;
          pushRaw64(g, () => f.i64(g.codeAddr64(ret)));
          g.emitJumpStatic(ins.target, ins.target <= ins.addr);
          terminated = true;
          break;
        }
        case Op.CALL_IND: {
          const ret = ins.addr + ins.len;
          const t = f.temp(I32);
          src(g, ins.a, 8);
          f.op(O.i32_wrap_i64).set(t);
          pushRaw64(g, () => f.i64(g.codeAddr64(ret)));
          f.get(t);
          g.emitJumpDynamic();
          f.freeTemp(I32, t);
          terminated = true;
          break;
        }
        case Op.JMP_IND: {
          src(g, ins.a, 8);
          f.op(O.i32_wrap_i64);
          g.emitJumpDynamic();
          terminated = true;
          break;
        }
        case Op.RET: case Op.RET_IMM: {
          g.getG(4);
          f.op(O.i32_wrap_i64).mem(O.i32_load, 0, 2); // return address
          g.getG(4);
          f.i64(8 + (op === Op.RET_IMM ? ins.a.imm & 0xffff : 0)).op(O.i64_add);
          g.setG(4);
          g.emitJumpDynamic();
          terminated = true;
          break;
        }
        case Op.INT3:
          g.emitExitToHostFault(ins.addr + ins.len, L.FK_INT3);
          terminated = true;
          break;
        case Op.UD2:
          g.emitExitToHostFault(ins.addr, L.FK_INVALID);
          terminated = true;
          break;
        case Op.HLT:
          g.emitExitToHostFault(ins.addr, L.FK_HLT);
          terminated = true;
          break;
        case Op.INT:
          g.emitExitToHostFault(ins.addr + ins.len, L.FK_INT, ins.a.imm & 0xff);
          terminated = true;
          break;
        case Op.SYSCALL:
          g.emitExitToHost(ins.addr, L.ST_INVALID);
          terminated = true;
          break;
        case Op.CPUID:
          g.hostCall(1, null, [0, 1, 2, 3]);
          break;
        case Op.RDTSC:
          g.hostCall(2, null, [0, 2]);
          break;
        case Op.RDTSCP:
          g.hostCall(4, null, [0, 1, 2]);
          break;
        case Op.XGETBV:
          g.hostCall(3, null, [0, 2]);
          break;
        case Op.RDRAND: case Op.RDSEED: {
          // random value into the destination register, CF = 1
          g.hostCall(5, null, [0]);
          g.getG(0);
          g.writeReg(ins.a.r, ins.a.sz);
          g.f.i32(L.F_CF);
          g.setFlagsFromEflags();
          break;
        }
        default: {
          const ok = translateInt(g, ins) || translateSSE(g, ins) || translateX87(g, ins);
          if (!ok) {
            const name = Op ? ins.op : 0;
            this.stats.unsupported.set(String(name), (this.stats.unsupported.get(String(name)) ?? 0) + 1);
            g.emitExitToHost(ins.addr, L.ST_INVALID);
            terminated = true;
          }
        }
      }
      if (terminated) break;
    }
    if (!terminated) {
      const last = insns[insns.length - 1];
      g.emitJumpStatic(last.addr + last.len, false);
    }
    return { pc: entry, slot: 0, ranges, insnCount: insns.length };
  }
}

export { CC_READS, K_IMM, K_MEM, K_REG };
