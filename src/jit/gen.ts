// Code generation core for one translated trace: register cache, address computation, lazy flags, exits.
import { FuncBuilder, ModuleBuilder, Writer } from "../wasm/builder.ts";
import { O, VT } from "../wasm/opcodes.ts";
import * as L from "./layout.ts";
import { Insn, Opd, K_MEM } from "../x86/decode.ts";

const { i32: I32, i64: I64, v128: V128 } = VT;

/** Indices of imported functions, fixed for every generated module. */
export const IMP = {
  cc_eval: 0, cc_getflags: 1, lookup: 2, mulhi_u64: 3, mulhi_s64: 4, div128: 5,
  rep_movs: 6, rep_stos: 7, rep_cmps: 8, rep_scas: 9, host: 10, hle: 11, smc: 12,
} as const;

export function declareImports(mb: ModuleBuilder) {
  mb.importMemory("env", "mem", 1);
  mb.importTable("env", "tbl", 1);
  mb.importFunc("rt", "cc_eval", [I32], [I32]);
  mb.importFunc("rt", "cc_getflags", [], [I32]);
  mb.importFunc("rt", "lookup", [I32], [I32]);
  mb.importFunc("rt", "mulhi_u64", [I64, I64], [I64]);
  mb.importFunc("rt", "mulhi_s64", [I64, I64], [I64]);
  mb.importFunc("rt", "div128", [I64, I64, I64, I32], [I32]);
  mb.importFunc("rt", "rep_movs", [I32, I32, I32, I32, I32], []);
  mb.importFunc("rt", "rep_stos", [I32, I32, I64, I32, I32], []);
  mb.importFunc("rt", "rep_cmps", [I32, I32, I32, I32, I32, I32], [I32]);
  mb.importFunc("rt", "rep_scas", [I32, I32, I64, I32, I32, I32], [I32]);
  mb.importFunc("env", "host", [I32, I32], [I32]);
  mb.importFunc("env", "hle", [I32], [I32]);
  mb.importFunc("env", "smc", [I32, I32], []);
}

export interface GenConfig {
  /** returns the table slot for a guest pc (allocating if necessary) */
  slotFor(pc: number): number;
  /** instrument stores with self-modifying-code checks */
  smc: boolean;
  /** true if flags are known dead on entry to this guest address (for exit spill elision) */
  flagsDeadAt(pc: number): boolean;
}

// lazy flag source kinds (translator-local)
export const FSK = { ADD: 1, ADC: 2, SUB: 3, SBB: 4, LOGIC: 5, EFLAGS: 6 } as const;

export class FS {
  kind = 0;
  szl = 0;
  res = -1;
  a = -1;
  b = -1;
  /** local (i32 0/1) overriding CF (INC/DEC) */
  cf = -1;
  /** local (i32) holding arithmetic flag bits for EFLAGS kind */
  v = -1;
  owned: [number, number][] = [];
}

export const szl = (sz: number) => (sz === 1 ? 0 : sz === 2 ? 1 : sz === 4 ? 2 : 3);
const maskOf = (sz: number) => (sz === 1 ? 0xff : sz === 2 ? 0xffff : 0xffffffff);

export class Gen {
  readonly f: FuncBuilder;
  readonly mb: ModuleBuilder;
  readonly cfg: GenConfig;
  readonly blockType: number;
  private bodyW: Writer;

  gpr = new Int32Array(16).fill(-1);
  gprDirty = new Uint8Array(16);
  xmm = new Int32Array(16).fill(-1);
  xmmDirty = new Uint8Array(16);
  fs: FS | null = null;

  // per-instruction context (set by the trace driver)
  ins!: Insn;
  liveAfter = 0;
  nextPc = 0;
  /** nesting depth of structured control at the current emission point (used for `br` to function-level blocks) */
  depth = 0;

  constructor(mb: ModuleBuilder, f: FuncBuilder, cfg: GenConfig) {
    this.mb = mb;
    this.f = f;
    this.cfg = cfg;
    this.blockType = mb.type([I32], [I32]);
    this.bodyW = new Writer(4096);
    f.w = this.bodyW;
  }

  // ---------------------------------------------------------------------------------------
  // Registers
  // ---------------------------------------------------------------------------------------
  g(r: number): number {
    let l = this.gpr[r];
    if (l < 0) l = this.gpr[r] = this.f.newLocal(I64);
    return l;
  }
  x(r: number): number {
    let l = this.xmm[r];
    if (l < 0) l = this.xmm[r] = this.f.newLocal(V128);
    return l;
  }
  /** push full 64-bit register */
  getG(r: number) {
    this.f.get(this.g(r));
  }
  /** pop i64 into full register */
  setG(r: number) {
    this.f.set(this.g(r));
    this.gprDirty[r] = 1;
  }
  teeG(r: number) {
    this.f.tee(this.g(r));
    this.gprDirty[r] = 1;
  }
  getX(r: number) {
    this.f.get(this.x(r));
  }
  setX(r: number) {
    this.f.set(this.x(r));
    this.xmmDirty[r] = 1;
  }

  /** Push register value of size sz (i32 masked for sz<8, i64 for 8). */
  readReg(r: number, sz: number, hi8 = false) {
    const f = this.f;
    this.getG(r);
    if (sz === 8) return;
    if (hi8) {
      f.i64(8).op(O.i64_shr_u).op(O.i32_wrap_i64).i32(0xff).op(O.i32_and);
      return;
    }
    f.op(O.i32_wrap_i64);
    if (sz === 2) f.i32(0xffff).op(O.i32_and);
    else if (sz === 1) f.i32(0xff).op(O.i32_and);
  }
  /** Pop a value of size sz (i32 for sz<8, i64 for 8) into register r with x86 partial-register semantics. */
  writeReg(r: number, sz: number, hi8 = false) {
    const f = this.f;
    if (sz === 8) {
      this.setG(r);
    } else if (sz === 4) {
      f.op(O.i64_extend_i32_u);
      this.setG(r);
    } else if (hi8) {
      f.op(O.i64_extend_i32_u).i64(8).op(O.i64_shl);
      this.getG(r);
      f.i64(~0xff00n).op(O.i64_and).op(O.i64_or);
      this.setG(r);
    } else {
      const m = sz === 2 ? 0xffffn : 0xffn;
      f.op(O.i64_extend_i32_u);
      this.getG(r);
      f.i64(~m).op(O.i64_and).op(O.i64_or);
      this.setG(r);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Effective addresses and memory access
  // ---------------------------------------------------------------------------------------
  /** Pushes the (dynamic part of the) effective address as i32 and returns the static memarg offset to use. */
  emitEA(o: Opd, seg = this.ins.seg): number {
    const f = this.f;
    let have = false;
    if (o.base >= 0) {
      this.getG(o.base);
      f.op(O.i32_wrap_i64);
      have = true;
    }
    if (o.index >= 0) {
      this.getG(o.index);
      f.op(O.i32_wrap_i64);
      if (o.scale > 1) f.i32(Math.log2(o.scale)).op(O.i32_shl);
      if (have) f.op(O.i32_add);
      have = true;
    }
    if (seg) {
      f.i32(0).mem(O.i32_load, L.STATE + (seg === 5 ? L.S_GS_BASE : L.S_FS_BASE), 2);
      if (have) f.op(O.i32_add);
      have = true;
    }
    const disp = o.disp | 0;
    if (!have) {
      // absolute address
      f.i32(0);
      return o.disp >>> 0;
    }
    if (disp >= 0) return disp;
    f.i32(disp).op(O.i32_add);
    return 0;
  }

  loadOp(sz: number, signed = false) {
    switch (sz) {
      case 1: return signed ? O.i32_load8_s : O.i32_load8_u;
      case 2: return signed ? O.i32_load16_s : O.i32_load16_u;
      case 4: return O.i32_load;
      default: return O.i64_load;
    }
  }
  storeOp(sz: number) {
    switch (sz) {
      case 1: return O.i32_store8;
      case 2: return O.i32_store16;
      case 4: return O.i32_store;
      default: return O.i64_store;
    }
  }

  /** Does a store through this operand need a self-modifying-code check? */
  smcNeeded(o: Opd): boolean {
    if (!this.cfg.smc) return false;
    if (o.base === 4 || o.base === 5) return false; // stack-relative
    if (o.base < 0 && o.index < 0 && !this.ins.seg) return true; // absolute (could be anything)
    return true;
  }

  /** After a store of `sz` bytes whose address is in local `ea` (+off): invalidate translated code if needed. */
  emitSmcCheck(ea: number, off: number, sz: number) {
    const f = this.f;
    // if (codepage[(ea+off) >> 12]) { smc(ea+off, sz); exit }
    f.get(ea);
    if (off) f.i32(off).op(O.i32_add);
    f.i32(12).op(O.i32_shr_u).mem(O.i32_load8_u, L.CODEPAGE, 0);
    f.if_();
    this.depth++;
    f.get(ea);
    if (off) f.i32(off).op(O.i32_add);
    f.i32(sz).call(IMP.smc);
    this.emitExitToHost(this.nextPc, L.ST_SMC);
    this.depth--;
    f.end();
  }

  // ---------------------------------------------------------------------------------------
  // Exits
  // ---------------------------------------------------------------------------------------
  writebackAll() {
    const f = this.f;
    for (let r = 0; r < 16; r++) {
      if (this.gprDirty[r]) {
        f.i32(0).get(this.gpr[r]).mem(O.i64_store, L.gprOff(r), 3);
      }
      if (this.xmmDirty[r]) {
        f.i32(0).get(this.xmm[r]).mem(O.v128_store, L.xmmOff(r), 4);
      }
    }
  }
  /** Reload cached registers from the state memory (after a host call changed them). */
  reloadReg(r: number) {
    const f = this.f;
    f.i32(0).mem(O.i64_load, L.gprOff(r), 3).set(this.g(r));
    this.gprDirty[r] = 0;
  }
  reloadXmm(r: number) {
    const f = this.f;
    f.i32(0).mem(O.v128_load, L.xmmOff(r), 4).set(this.x(r));
    this.xmmDirty[r] = 0;
  }
  /** Write back registers that were modified so far (without clearing dirty bits, so code after a side exit is unaffected). */
  spillFlagsFor(fs: FS | null) {
    if (!fs) return;
    const f = this.f;
    const S = L.STATE;
    if (fs.kind === FSK.EFLAGS) {
      f.i32(0).i32(L.CC_EFLAGS << 2).mem(O.i32_store, S + L.S_CC_OP, 2);
      f.i32(0).get(fs.v).op(O.i64_extend_i32_u).mem(O.i64_store, S + L.S_CC_SRC1, 3);
      return;
    }
    const ccKind = fs.kind === FSK.ADD || fs.kind === FSK.ADC ? L.CC_ADD : fs.kind === FSK.LOGIC ? L.CC_LOGIC : L.CC_SUB;
    const wide = fs.szl === 3;
    const ext = (l: number) => {
      f.get(l);
      if (!wide) f.op(O.i64_extend_i32_u);
    };
    f.i32(0).i32((ccKind << 2) | fs.szl).mem(O.i32_store, S + L.S_CC_OP, 2);
    f.i32(0);
    ext(fs.res);
    f.mem(O.i64_store, S + L.S_CC_DST, 3);
    if (fs.kind !== FSK.LOGIC) {
      f.i32(0);
      ext(fs.a);
      f.mem(O.i64_store, S + L.S_CC_SRC1, 3);
      f.i32(0);
      ext(fs.b);
      f.mem(O.i64_store, S + L.S_CC_SRC2, 3);
    }
    if (fs.cf >= 0) {
      // INC/DEC: encode as CC_INC/CC_DEC so the C helper uses aux as CF
      const k = fs.kind === FSK.ADD ? L.CC_INC : L.CC_DEC;
      f.i32(0).i32((k << 2) | fs.szl).mem(O.i32_store, S + L.S_CC_OP, 2);
      f.i32(0).get(fs.cf).op(O.i64_extend_i32_u).mem(O.i64_store, S + L.S_CC_AUX, 3);
    }
  }

  /** Common epilogue before leaving the trace: registers and (live) flags go back to memory. */
  emitLeave(targetPc: number | -1) {
    this.writebackAll();
    if (this.fs && !(targetPc >= 0 && this.cfg.flagsDeadAt(targetPc))) this.spillFlagsFor(this.fs);
  }

  /** Raise a guest exception (precise: registers as of the start of the current instruction). */
  emitFaultHere(kind: number, addr = 0) {
    const f = this.f;
    this.emitLeave(-1);
    this.setRip(this.ins.addr);
    f.i32(0).i32(kind).mem(O.i32_store, L.STATE + L.S_FAULT_KIND, 2);
    f.i32(0).i32(addr).mem(O.i32_store, L.STATE + L.S_FAULT_ADDR, 2);
    f.i32(L.ST_FAULT).op(O.return);
  }

  /** Exit with ST_FAULT and the given resume pc / fault kind (registers and flags are flushed). */
  emitExitToHostFault(resumePc: number, kind: number, addr = 0) {
    const f = this.f;
    this.emitLeave(-1);
    this.setRip(resumePc);
    f.i32(0).i32(kind).mem(O.i32_store, L.STATE + L.S_FAULT_KIND, 2);
    f.i32(0).i32(addr).mem(O.i32_store, L.STATE + L.S_FAULT_ADDR, 2);
    f.i32(L.ST_FAULT).op(O.return);
  }

  /** Call back into the host with all registers flushed; `reload` lists registers the host may have changed. */
  hostCall(kind: number, pushArg: (() => void) | null, reload: number[], reloadXmm: number[] = []) {
    const f = this.f;
    this.writebackAll();
    this.gprDirty.fill(0);
    this.xmmDirty.fill(0);
    f.i32(kind);
    if (pushArg) pushArg();
    else f.i32(0);
    f.call(IMP.host).op(O.drop);
    for (const r of reload) this.reloadReg(r);
    for (const r of reloadXmm) this.reloadXmm(r);
  }

  setRip(pc: number) {
    this.f.i32(0).i64(BigInt(pc >>> 0)).mem(O.i64_store, L.STATE + L.S_RIP, 3);
  }

  /** Leave to the host driver with a status code; resume pc is `pc`. */
  emitExitToHost(pc: number, status: number) {
    this.emitLeave(-1);
    this.setRip(pc);
    this.f.i32(status).op(O.return);
  }

  /** Decrement the yield budget; if exhausted, exit with ST_YIELD at pcLocal (i32 local) or static pc. Registers must already be written back. */
  emitBudgetCheck(staticPc: number, pcLocal = -1) {
    const f = this.f;
    const t = f.temp(I32);
    f.i32(0).i32(0).mem(O.i32_load, L.STATE + L.S_BUDGET, 2).i32(1).op(O.i32_sub).tee(t).mem(O.i32_store, L.STATE + L.S_BUDGET, 2);
    f.get(t).i32(0).op(O.i32_le_s).if_();
    if (pcLocal >= 0) {
      f.i32(0).get(pcLocal).op(O.i64_extend_i32_u).mem(O.i64_store, L.STATE + L.S_RIP, 3);
    } else this.setRip(staticPc);
    f.i32(L.ST_YIELD).op(O.return);
    f.end();
    f.freeTemp(I32, t);
  }

  /** Direct jump/call to a known guest address (end of trace or side exit). `from` is the current insn address. */
  emitJumpStatic(target: number, backward: boolean) {
    const f = this.f;
    this.emitLeave(target);
    if (backward) this.emitBudgetCheck(target);
    f.i32(target).i32(this.cfg.slotFor(target)).returnCallIndirect(this.blockType);
  }

  /** Indirect jump: target pc (i32) is on the stack. */
  emitJumpDynamic() {
    const f = this.f;
    const t = f.temp(I32);
    f.set(t);
    this.emitLeave(-1);
    this.emitBudgetCheck(0, t);
    f.get(t).get(t).call(IMP.lookup).returnCallIndirect(this.blockType);
    f.freeTemp(I32, t);
  }

  // ---------------------------------------------------------------------------------------
  // Lazy flags
  // ---------------------------------------------------------------------------------------
  private freeFS(fs: FS | null) {
    if (!fs) return;
    for (const [t, l] of fs.owned) this.f.freeTemp(t, l);
  }
  setFS(fs: FS | null) {
    this.freeFS(this.fs);
    this.fs = fs;
  }
  /** allocate a fresh typed local owned by a flag source */
  fsLocal(fs: FS, wide: boolean): number {
    const t = wide ? I64 : I32;
    const l = this.f.temp(t);
    fs.owned.push([t, l]);
    return l;
  }

  private tyOps(szl_: number) {
    return szl_ === 3
      ? { and: O.i64_and, or: O.i64_or, xor: O.i64_xor, ltu: O.i64_lt_u, leu: O.i64_le_u, gtu: O.i64_gt_u, geu: O.i64_ge_u,
          lts: O.i64_lt_s, les: O.i64_le_s, gts: O.i64_gt_s, ges: O.i64_ge_s, eqz: O.i64_eqz, eq: O.i64_eq, ne: O.i64_ne }
      : { and: O.i32_and, or: O.i32_or, xor: O.i32_xor, ltu: O.i32_lt_u, leu: O.i32_le_u, gtu: O.i32_gt_u, geu: O.i32_ge_u,
          lts: O.i32_lt_s, les: O.i32_le_s, gts: O.i32_gt_s, ges: O.i32_ge_s, eqz: O.i32_eqz, eq: O.i32_eq, ne: O.i32_ne };
  }
  private cnst(szl_: number, v: number) {
    if (szl_ === 3) this.f.i64(BigInt(v));
    else this.f.i32(v);
  }
  /** Top-of-stack typed value -> its MSB as i32 0/1 */
  private msbStack(szl_: number) {
    const f = this.f;
    if (szl_ === 3) f.i64(63).op(O.i64_shr_u).op(O.i32_wrap_i64);
    else f.i32((8 << szl_) - 1).op(O.i32_shr_u);
  }
  /** signed-compare helper: sign-extend a masked small value on stack */
  private sx(szl_: number) {
    if (szl_ === 0) this.f.op(O.i32_extend8_s);
    else if (szl_ === 1) this.f.op(O.i32_extend16_s);
  }

  private flagZF(fs: FS) {
    this.f.get(fs.res).op(this.tyOps(fs.szl).eqz);
  }
  private flagSF(fs: FS) {
    this.f.get(fs.res);
    this.msbStack(fs.szl);
  }
  private flagPF(fs: FS) {
    const f = this.f;
    f.get(fs.res);
    if (fs.szl === 3) f.op(O.i32_wrap_i64);
    f.i32(0xff).op(O.i32_and).op(O.i32_popcnt).i32(1).op(O.i32_and).i32(1).op(O.i32_xor);
  }
  private flagAF(fs: FS) {
    const f = this.f;
    if (fs.kind === FSK.LOGIC) {
      f.i32(0);
      return;
    }
    const t = this.tyOps(fs.szl);
    f.get(fs.a).get(fs.b).op(t.xor).get(fs.res).op(t.xor);
    if (fs.szl === 3) f.op(O.i32_wrap_i64);
    f.i32(4).op(O.i32_shr_u).i32(1).op(O.i32_and);
  }
  private flagCF(fs: FS) {
    const f = this.f;
    if (fs.cf >= 0) {
      f.get(fs.cf);
      return;
    }
    const t = this.tyOps(fs.szl);
    switch (fs.kind) {
      case FSK.ADD:
        f.get(fs.res).get(fs.a).op(t.ltu);
        return;
      case FSK.ADC:
        // ((a&b) | ((a|b) & ~res)) >> msb
        f.get(fs.a).get(fs.b).op(t.and);
        f.get(fs.a).get(fs.b).op(t.or).get(fs.res);
        this.cnst(fs.szl, -1);
        f.op(t.xor).op(t.and).op(t.or);
        this.msbStack(fs.szl);
        return;
      case FSK.SUB:
        f.get(fs.a).get(fs.b).op(t.ltu);
        return;
      case FSK.SBB:
        // ((~a & b) | ((~a | b) & res)) >> msb
        f.get(fs.a);
        this.cnst(fs.szl, -1);
        f.op(t.xor).get(fs.b).op(t.and);
        f.get(fs.a);
        this.cnst(fs.szl, -1);
        f.op(t.xor).get(fs.b).op(t.or).get(fs.res).op(t.and).op(t.or);
        this.msbStack(fs.szl);
        return;
      case FSK.LOGIC:
        f.i32(0);
        return;
    }
  }
  private flagOF(fs: FS) {
    const f = this.f;
    const t = this.tyOps(fs.szl);
    switch (fs.kind) {
      case FSK.ADD: case FSK.ADC:
        f.get(fs.a).get(fs.res).op(t.xor).get(fs.b).get(fs.res).op(t.xor).op(t.and);
        this.msbStack(fs.szl);
        return;
      case FSK.SUB: case FSK.SBB:
        f.get(fs.a).get(fs.b).op(t.xor).get(fs.a).get(fs.res).op(t.xor).op(t.and);
        this.msbStack(fs.szl);
        return;
      default:
        f.i32(0);
    }
  }

  /** Push i32 0/1 for a single flag bit (F_CF etc.). */
  emitFlagBit(bit: number) {
    const f = this.f;
    const fs = this.fs;
    if (!fs) {
      f.call(IMP.cc_getflags);
      // note: evaluates all flags; fine for the fallback path
      const sh = Math.log2(bit);
      f.i32(sh).op(O.i32_shr_u).i32(1).op(O.i32_and);
      return;
    }
    if (fs.kind === FSK.EFLAGS) {
      f.get(fs.v).i32(Math.log2(bit)).op(O.i32_shr_u).i32(1).op(O.i32_and);
      return;
    }
    switch (bit) {
      case L.F_CF: return this.flagCF(fs);
      case L.F_PF: return this.flagPF(fs);
      case L.F_AF: return this.flagAF(fs);
      case L.F_ZF: return this.flagZF(fs);
      case L.F_SF: return this.flagSF(fs);
      case L.F_OF: return this.flagOF(fs);
    }
    throw new Error("bad flag bit");
  }

  /** Push i32 0/1 for condition code cc evaluated against the current flag state. */
  emitCond(cc: number) {
    const f = this.f;
    const fs = this.fs;
    if (!fs) {
      f.i32(cc).call(IMP.cc_eval);
      return;
    }
    const neg = cc & 1;
    const base = cc >> 1;
    // fast paths ---------------------------------------------------------------------
    if (fs.kind !== FSK.EFLAGS && fs.cf < 0) {
      const t = this.tyOps(fs.szl);
      const sub = fs.kind === FSK.SUB;
      const logic = fs.kind === FSK.LOGIC;
      if (base === 2) { // E / NE
        this.flagZF(fs);
        if (neg) f.i32(1).op(O.i32_xor);
        return;
      }
      if (base === 4) { // S / NS
        this.flagSF(fs);
        if (neg) f.i32(1).op(O.i32_xor);
        return;
      }
      if (sub && (base === 1 || base === 3 || base === 6 || base === 7)) {
        // B/AE, BE/A, L/GE, LE/G straight from the operands
        const signed = base >= 6;
        f.get(fs.a);
        if (signed) this.sx(fs.szl);
        f.get(fs.b);
        if (signed) this.sx(fs.szl);
        let op: number;
        // true-condition ops; negation flips to the complement op
        if (base === 1) op = neg ? t.geu : t.ltu;
        else if (base === 3) op = neg ? t.gtu : t.leu;
        else if (base === 6) op = neg ? t.ges : t.lts;
        else op = neg ? t.gts : t.les;
        f.op(op);
        return;
      }
      if (logic) {
        switch (base) {
          case 0: f.i32(neg ? 1 : 0); return; // O / NO
          case 1: f.i32(neg ? 1 : 0); return; // B / AE
          case 3: // BE (= ZF) / A
            this.flagZF(fs);
            if (neg) f.i32(1).op(O.i32_xor);
            return;
          case 6: // L (= SF) / GE
            this.flagSF(fs);
            if (neg) f.i32(1).op(O.i32_xor);
            return;
          case 7: // LE (= ZF|SF) / G
            this.flagZF(fs);
            this.flagSF(fs);
            f.op(O.i32_or);
            if (neg) f.i32(1).op(O.i32_xor);
            return;
        }
      }
      if (fs.kind === FSK.ADD && base === 1) { // B / AE
        this.flagCF(fs);
        if (neg) f.i32(1).op(O.i32_xor);
        return;
      }
    }
    // generic composition ---------------------------------------------------------------
    switch (base) {
      case 0: this.emitFlagBit(L.F_OF); break;
      case 1: this.emitFlagBit(L.F_CF); break;
      case 2: this.emitFlagBit(L.F_ZF); break;
      case 3: this.emitFlagBit(L.F_CF); this.emitFlagBit(L.F_ZF); f.op(O.i32_or); break;
      case 4: this.emitFlagBit(L.F_SF); break;
      case 5: this.emitFlagBit(L.F_PF); break;
      case 6: this.emitFlagBit(L.F_SF); this.emitFlagBit(L.F_OF); f.op(O.i32_xor); break;
      default:
        this.emitFlagBit(L.F_SF);
        this.emitFlagBit(L.F_OF);
        f.op(O.i32_xor);
        this.emitFlagBit(L.F_ZF);
        f.op(O.i32_or);
        break;
    }
    if (neg) f.i32(1).op(O.i32_xor);
  }

  /** Push the 6 arithmetic flags as an i32 in EFLAGS bit positions. */
  emitEflags() {
    const f = this.f;
    const fs = this.fs;
    if (!fs) {
      f.call(IMP.cc_getflags);
      return;
    }
    if (fs.kind === FSK.EFLAGS) {
      f.get(fs.v);
      return;
    }
    this.emitFlagBit(L.F_CF);
    this.emitFlagBit(L.F_PF);
    f.i32(2).op(O.i32_shl).op(O.i32_or);
    this.emitFlagBit(L.F_AF);
    f.i32(4).op(O.i32_shl).op(O.i32_or);
    this.emitFlagBit(L.F_ZF);
    f.i32(6).op(O.i32_shl).op(O.i32_or);
    this.emitFlagBit(L.F_SF);
    f.i32(7).op(O.i32_shl).op(O.i32_or);
    this.emitFlagBit(L.F_OF);
    f.i32(11).op(O.i32_shl).op(O.i32_or);
  }

  /** Pop an i32 holding arithmetic flag bits and make it the current flag state. */
  setFlagsFromEflags() {
    const fs = new FS();
    fs.kind = FSK.EFLAGS;
    fs.v = this.fsLocal(fs, false);
    this.f.set(fs.v);
    this.setFS(fs);
  }

  /** Make the in-memory lazy flag state authoritative (spill any local flag source), after a host/C call updated it. */
  flagsInMemory() {
    this.setFS(null);
  }

  /** Spill the current flag source to memory and switch to the memory representation (used before helper-based paths). */
  forceFlagsToMemory() {
    if (!this.fs) return;
    this.spillFlagsFor(this.fs);
    this.setFS(null);
  }

  /**
   * Record flags produced by an arithmetic/logic op. `a`/`b`/`res` are already-allocated locals holding masked values of
   * the operation size (i64 locals when sz == 8, i32 otherwise).
   */
  setArithFlags(kind: number, sz: number, a: number, b: number, res: number, owned: [number, number][], cf = -1) {
    const fs = new FS();
    fs.kind = kind;
    fs.szl = szl(sz);
    fs.a = a;
    fs.b = b;
    fs.res = res;
    fs.cf = cf;
    fs.owned = owned;
    this.setFS(fs);
  }

  /** Finalise the function: prologue loads for every cached register, then the body. Returns nothing; use encode via mb. */
  finish() {
    const f = this.f;
    const body = this.bodyW.bytes().slice();
    f.w = new Writer(body.length + 256);
    for (let r = 0; r < 16; r++) {
      if (this.gpr[r] >= 0) f.i32(0).mem(O.i64_load, L.gprOff(r), 3).set(this.gpr[r]);
      if (this.xmm[r] >= 0) f.i32(0).mem(O.v128_load, L.xmmOff(r), 4).set(this.xmm[r]);
    }
    f.w.raw(body);
    f.op(O.unreachable);
    f.end();
  }
}

export { maskOf, K_MEM };
