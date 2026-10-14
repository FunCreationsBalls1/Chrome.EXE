// Integer (general purpose) instruction translation.
import { O, VT } from "../wasm/opcodes.ts";
import { Gen, FS, FSK, IMP, szl } from "./gen.ts";
import { Insn, Opd, K_IMM, K_MEM, K_REG } from "../x86/decode.ts";
import { Op } from "../x86/ops.ts";
import * as L from "./layout.ts";

const { i32: I32, i64: I64 } = VT;

const W = {
  add: O.i64_add, sub: O.i64_sub, and: O.i64_and, or: O.i64_or, xor: O.i64_xor, mul: O.i64_mul,
  shl: O.i64_shl, shrU: O.i64_shr_u, shrS: O.i64_shr_s, rotl: O.i64_rotl, rotr: O.i64_rotr,
  clz: O.i64_clz, ctz: O.i64_ctz, popcnt: O.i64_popcnt, eqz: O.i64_eqz, eq: O.i64_eq, ne: O.i64_ne,
  ltU: O.i64_lt_u,
};
const N = {
  add: O.i32_add, sub: O.i32_sub, and: O.i32_and, or: O.i32_or, xor: O.i32_xor, mul: O.i32_mul,
  shl: O.i32_shl, shrU: O.i32_shr_u, shrS: O.i32_shr_s, rotl: O.i32_rotl, rotr: O.i32_rotr,
  clz: O.i32_clz, ctz: O.i32_ctz, popcnt: O.i32_popcnt, eqz: O.i32_eqz, eq: O.i32_eq, ne: O.i32_ne,
  ltU: O.i32_lt_u,
};
const ty = (sz: number) => (sz === 8 ? I64 : I32);
const tab = (sz: number) => (sz === 8 ? W : N);
const maskOf = (sz: number) => (sz === 1 ? 0xff : sz === 2 ? 0xffff : 0xffffffff);

// ---------------------------------------------------------------------------------------------
// Operand helpers
// ---------------------------------------------------------------------------------------------
export function pushImm(g: Gen, o: Opd, sz: number) {
  if (sz === 8) {
    g.f.i64(o.imm64 !== 0n && o.sz === 8 ? o.imm64 : BigInt(o.imm));
  } else g.f.i32(o.imm & maskOf(sz));
}

/** Push the value of operand `o` interpreted with size `sz` (i32 masked for sz<8, i64 for sz 8). */
export function src(g: Gen, o: Opd, sz: number) {
  switch (o.k) {
    case K_REG: g.readReg(o.r, sz, o.hi8); break;
    case K_IMM: pushImm(g, o, sz); break;
    case K_MEM: {
      const off = g.emitEA(o);
      g.f.mem(g.loadOp(sz), off);
      break;
    }
    default: throw new Error("bad source operand kind " + o.k);
  }
}

export interface Place {
  o: Opd;
  sz: number;
  ea: number; // i32 local holding the dynamic effective address (memory operands), else -1
  off: number;
}
export function place(g: Gen, o: Opd, sz: number): Place {
  if (o.k === K_MEM) {
    const off = g.emitEA(o);
    const ea = g.f.temp(I32);
    g.f.set(ea);
    return { o, sz, ea, off };
  }
  return { o, sz, ea: -1, off: 0 };
}
export function freePlace(g: Gen, p: Place) {
  if (p.ea >= 0) g.f.freeTemp(I32, p.ea);
}
export function loadPlace(g: Gen, p: Place, sz = p.sz) {
  if (p.ea >= 0) g.f.get(p.ea).mem(g.loadOp(sz), p.off);
  else g.readReg(p.o.r, sz, p.o.hi8);
}
/** Store a value (produced by `produce`, typed per size) into the place. */
export function storePlace(g: Gen, p: Place, produce: () => void, sz = p.sz) {
  if (p.ea >= 0) {
    g.f.get(p.ea);
    produce();
    g.f.mem(g.storeOp(sz), p.off);
    if (g.smcNeeded(p.o)) g.emitSmcCheck(p.ea, p.off, sz);
  } else {
    produce();
    g.writeReg(p.o.r, sz, p.o.hi8);
  }
}

/** Store the i32/i64 value on the stack to operand `o` (register or memory). */
export function storeTo(g: Gen, o: Opd, sz: number, produce: () => void) {
  if (o.k === K_REG) {
    produce();
    g.writeReg(o.r, sz, o.hi8);
    return;
  }
  const p = place(g, o, sz);
  storePlace(g, p, produce, sz);
  freePlace(g, p);
}

function tmp(g: Gen, t: number) {
  return g.f.temp(t);
}

// ---------------------------------------------------------------------------------------------
// ALU
// ---------------------------------------------------------------------------------------------
function alu(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const op = ins.op;
  const noWrite = op === Op.CMP || op === Op.TEST;
  const needFlags = g.liveAfter !== 0;
  if (noWrite && !needFlags) return;

  const logic = op === Op.AND || op === Op.OR || op === Op.XOR || op === Op.TEST;
  const kind =
    logic ? FSK.LOGIC : op === Op.ADD ? FSK.ADD : op === Op.ADC ? FSK.ADC : op === Op.SBB ? FSK.SBB : FSK.SUB;
  const carry = op === Op.ADC || op === Op.SBB;

  let cin = -1;
  if (carry) {
    cin = tmp(g, I32);
    g.emitFlagBit(L.F_CF);
    f.set(cin);
  }
  const p = place(g, ins.a, sz);
  const owned: [number, number][] = [];
  let A = -1, B = -1, R = -1;
  if (needFlags) {
    R = tmp(g, ty(sz));
    owned.push([ty(sz), R]);
    if (!logic) {
      A = tmp(g, ty(sz));
      B = tmp(g, ty(sz));
      owned.push([ty(sz), A], [ty(sz), B]);
    }
  }
  const compute = () => {
    loadPlace(g, p);
    if (A >= 0) f.tee(A);
    src(g, ins.b, sz);
    if (B >= 0) f.tee(B);
    switch (op) {
      case Op.ADD: case Op.ADC: f.op(T.add); break;
      case Op.SUB: case Op.SBB: case Op.CMP: f.op(T.sub); break;
      case Op.AND: case Op.TEST: f.op(T.and); break;
      case Op.OR: f.op(T.or); break;
      case Op.XOR: f.op(T.xor); break;
    }
    if (carry) {
      f.get(cin);
      if (wide) f.op(O.i64_extend_i32_u);
      f.op(op === Op.ADC ? T.add : T.sub);
    }
    if (sz < 4 && !logic) f.i32(maskOf(sz)).op(O.i32_and);
    if (R >= 0) f.tee(R);
  };
  if (noWrite) {
    compute();
    f.op(O.drop);
  } else storePlace(g, p, compute);
  freePlace(g, p);
  if (cin >= 0) f.freeTemp(I32, cin);
  if (needFlags) g.setArithFlags(kind, sz, A, B, R, owned);
}

function incdec(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const isInc = ins.op === Op.INC;
  const needMain = (g.liveAfter & ~L.F_CF) !== 0;
  const needCF = (g.liveAfter & L.F_CF) !== 0;
  let cf = -1;
  const owned: [number, number][] = [];
  if (needMain && needCF) {
    cf = tmp(g, I32);
    owned.push([I32, cf]);
    g.emitFlagBit(L.F_CF);
    f.set(cf);
  }
  const p = place(g, ins.a, sz);
  let A = -1, B = -1, R = -1;
  if (needMain) {
    A = tmp(g, ty(sz));
    B = tmp(g, ty(sz));
    R = tmp(g, ty(sz));
    owned.push([ty(sz), A], [ty(sz), B], [ty(sz), R]);
  }
  storePlace(g, p, () => {
    loadPlace(g, p);
    if (A >= 0) f.tee(A);
    if (wide) f.i64(1);
    else f.i32(1);
    if (B >= 0) {
      f.tee(B);
    }
    f.op(isInc ? T.add : T.sub);
    if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
    if (R >= 0) f.tee(R);
  });
  freePlace(g, p);
  if (needMain) {
    if (cf < 0) {
      // CF is dead: any value will do; reuse a dedicated local set to 0 to keep the representation uniform
      cf = tmp(g, I32);
      owned.push([I32, cf]);
      f.i32(0).set(cf);
    }
    g.setArithFlags(isInc ? FSK.ADD : FSK.SUB, sz, A, B, R, owned, cf);
  }
}

function neg(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const needFlags = g.liveAfter !== 0;
  const p = place(g, ins.a, sz);
  const owned: [number, number][] = [];
  let A = -1, B = -1, R = -1;
  if (needFlags) {
    A = tmp(g, ty(sz));
    B = tmp(g, ty(sz));
    R = tmp(g, ty(sz));
    owned.push([ty(sz), A], [ty(sz), B], [ty(sz), R]);
    if (wide) f.i64(0);
    else f.i32(0);
    f.set(A);
  }
  storePlace(g, p, () => {
    if (wide) f.i64(0);
    else f.i32(0);
    loadPlace(g, p);
    if (B >= 0) f.tee(B);
    f.op(T.sub);
    if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
    if (R >= 0) f.tee(R);
  });
  freePlace(g, p);
  if (needFlags) g.setArithFlags(FSK.SUB, sz, A, B, R, owned);
}

function not(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const p = place(g, ins.a, sz);
  storePlace(g, p, () => {
    loadPlace(g, p);
    if (sz === 8) f.i64(-1n).op(O.i64_xor);
    else f.i32(maskOf(sz)).op(O.i32_xor);
  });
  freePlace(g, p);
}

// ---------------------------------------------------------------------------------------------
// MOV family
// ---------------------------------------------------------------------------------------------
function mov(g: Gen, ins: Insn) {
  const sz = ins.osz;
  const a = ins.a, b = ins.b;
  if (a.k === K_REG) {
    src(g, b, sz);
    g.writeReg(a.r, sz, a.hi8);
    return;
  }
  const p = place(g, a, sz);
  storePlace(g, p, () => src(g, b, sz));
  freePlace(g, p);
}

function movzx(g: Gen, ins: Insn) {
  const f = g.f;
  const osz = ins.a.sz, ssz = ins.b.sz;
  src(g, ins.b, ssz);
  if (osz === 8) f.op(O.i64_extend_i32_u);
  g.writeReg(ins.a.r, osz);
}
function movsx(g: Gen, ins: Insn) {
  const f = g.f;
  const osz = ins.a.sz, ssz = ins.b.sz;
  const o = ins.b;
  if (o.k === K_MEM) {
    const off = g.emitEA(o);
    f.mem(g.loadOp(ssz, true), off);
  } else {
    src(g, o, ssz);
    f.op(ssz === 1 ? O.i32_extend8_s : O.i32_extend16_s);
  }
  if (osz === 8) f.op(O.i64_extend_i32_s);
  else if (osz === 2) f.i32(0xffff).op(O.i32_and);
  g.writeReg(ins.a.r, osz);
}
function movsxd(g: Gen, ins: Insn) {
  const f = g.f;
  src(g, ins.b, 4);
  if (ins.a.sz === 8) f.op(O.i64_extend_i32_s);
  else if (ins.a.sz === 2) f.i32(0xffff).op(O.i32_and);
  g.writeReg(ins.a.r, ins.a.sz);
}

function lea(g: Gen, ins: Insn) {
  const f = g.f;
  const o = ins.b;
  const sz = ins.a.sz;
  if (sz === 8 && ins.asz === 8) {
    // full 64-bit address arithmetic
    let have = false;
    if (o.base >= 0) {
      g.getG(o.base);
      have = true;
    }
    if (o.index >= 0) {
      g.getG(o.index);
      if (o.scale > 1) f.i64(Math.log2(o.scale)).op(O.i64_shl);
      if (have) f.op(O.i64_add);
      have = true;
    }
    const disp = BigInt(o.base < 0 && o.index < 0 ? o.disp >>> 0 : o.disp | 0);
    if (!have) f.i64(disp);
    else if (disp !== 0n) f.i64(disp).op(O.i64_add);
    g.writeReg(ins.a.r, 8);
    return;
  }
  // 32-bit arithmetic (operand size 4/2 or 32-bit address size)
  let have = false;
  if (o.base >= 0) {
    g.getG(o.base);
    f.op(O.i32_wrap_i64);
    have = true;
  }
  if (o.index >= 0) {
    g.getG(o.index);
    f.op(O.i32_wrap_i64);
    if (o.scale > 1) f.i32(Math.log2(o.scale)).op(O.i32_shl);
    if (have) f.op(O.i32_add);
    have = true;
  }
  const disp = o.disp | 0;
  if (!have) f.i32(disp);
  else if (disp !== 0) f.i32(disp).op(O.i32_add);
  if (sz === 8) f.op(O.i64_extend_i32_u); // 67-prefixed lea with 64-bit operand
  else if (sz === 2) f.i32(0xffff).op(O.i32_and);
  g.writeReg(ins.a.r, sz);
}

function xchg(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const a = ins.a, b = ins.b;
  if (a.k === K_REG && b.k === K_REG) {
    const t = tmp(g, ty(sz));
    g.readReg(a.r, sz, a.hi8);
    f.set(t);
    g.readReg(b.r, sz, b.hi8);
    g.writeReg(a.r, sz, a.hi8);
    f.get(t);
    g.writeReg(b.r, sz, b.hi8);
    f.freeTemp(ty(sz), t);
    return;
  }
  // memory <-> register
  const mem = a.k === K_MEM ? a : b;
  const reg = a.k === K_MEM ? b : a;
  const p = place(g, mem, sz);
  const t = tmp(g, ty(sz));
  loadPlace(g, p);
  f.set(t);
  storePlace(g, p, () => g.readReg(reg.r, sz, reg.hi8));
  f.get(t);
  g.writeReg(reg.r, sz, reg.hi8);
  f.freeTemp(ty(sz), t);
  freePlace(g, p);
}

// ---------------------------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------------------------
const RSP = 4;
function push(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const t = tmp(g, ty(sz));
  // evaluate the source before rsp changes
  src(g, ins.a, ins.a.k === K_IMM ? sz : sz);
  if (sz === 2 && ins.a.k !== K_IMM) { /* already masked */ }
  f.set(t);
  g.getG(RSP);
  f.i64(BigInt(sz)).op(O.i64_sub);
  g.setG(RSP);
  g.getG(RSP);
  f.op(O.i32_wrap_i64);
  f.get(t);
  f.mem(g.storeOp(sz), 0);
  f.freeTemp(ty(sz), t);
}
function pop(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const t = tmp(g, ty(sz));
  g.getG(RSP);
  f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0).set(t);
  g.getG(RSP);
  f.i64(BigInt(sz)).op(O.i64_add);
  g.setG(RSP);
  storeTo(g, ins.a, sz, () => f.get(t));
  f.freeTemp(ty(sz), t);
}
function pushRaw64(g: Gen, produce: () => void) {
  // push a 64-bit value
  const f = g.f;
  const t = tmp(g, I64);
  produce();
  f.set(t);
  g.getG(RSP);
  f.i64(8).op(O.i64_sub);
  g.setG(RSP);
  g.getG(RSP);
  f.op(O.i32_wrap_i64).get(t).mem(O.i64_store, 0);
  f.freeTemp(I64, t);
}
export { pushRaw64 };

function leave(g: Gen, _ins: Insn) {
  const f = g.f;
  g.getG(5);
  g.setG(RSP);
  const t = tmp(g, I64);
  g.getG(RSP);
  f.op(O.i32_wrap_i64).mem(O.i64_load, 0).set(t);
  g.getG(RSP);
  f.i64(8).op(O.i64_add);
  g.setG(RSP);
  f.get(t);
  g.setG(5);
  f.freeTemp(I64, t);
}

// ---------------------------------------------------------------------------------------------
// Shifts and rotates
// ---------------------------------------------------------------------------------------------
/** A 32-bit register destination is zero-extended to 64 bits even when the operation has no effect. */
function zeroExtendIfReg32(g: Gen, ins: Insn) {
  if (ins.osz === 4 && ins.a.k === K_REG) {
    g.readReg(ins.a.r, 4);
    g.writeReg(ins.a.r, 4);
  }
}

function loadCount(g: Gen, cnt: number, cntIsImm: boolean, cimm: number, cmask: number) {
  const f = g.f;
  if (cntIsImm) f.i32(cimm);
  else {
    g.readReg(1, 1, false);
    f.i32(cmask).op(O.i32_and);
  }
  f.set(cnt);
}

function shift(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const op = ins.op;
  const cntIsImm = ins.b.k === K_IMM;
  const cmask = wide ? 63 : 31;
  const cimm = cntIsImm ? ins.b.imm & cmask : -1;
  if (cntIsImm && cimm === 0) {
    zeroExtendIfReg32(g, ins);
    return; // flags and (otherwise) the operand are untouched
  }
  const needFlags = g.liveAfter !== 0;

  const cnt = tmp(g, I32);
  loadCount(g, cnt, cntIsImm, cimm, cmask);
  const p = place(g, ins.a, sz);
  let A = -1, R = -1;
  if (needFlags) {
    A = tmp(g, ty(sz));
    R = tmp(g, ty(sz));
    // with a variable count the old flags survive when count == 0: make memory authoritative first
    if (!cntIsImm) g.forceFlagsToMemory();
  }
  storePlace(g, p, () => {
    loadPlace(g, p);
    if (A >= 0) f.tee(A);
    if (op === Op.SAR && sz < 4) f.op(sz === 1 ? O.i32_extend8_s : O.i32_extend16_s);
    f.get(cnt);
    if (wide) f.op(O.i64_extend_i32_u);
    f.op(op === Op.SHL ? T.shl : op === Op.SHR ? T.shrU : T.shrS);
    if (sz < 4 && op !== Op.SHR) f.i32(maskOf(sz)).op(O.i32_and);
    if (R >= 0) f.tee(R);
  });
  freePlace(g, p);
  if (needFlags) {
    if (!cntIsImm) {
      f.get(cnt).if_();
      emitShiftFlagStore(g, op, sz, A, R, cnt);
      f.end();
    } else emitShiftFlagStore(g, op, sz, A, R, cnt);
    g.setFS(null); // memory is now authoritative
    f.freeTemp(ty(sz), A);
    f.freeTemp(ty(sz), R);
  }
  f.freeTemp(I32, cnt);
}

function emitShiftFlagStore(g: Gen, op: number, sz: number, A: number, R: number, cnt: number) {
  const f = g.f;
  const S = L.STATE;
  const wide = sz === 8;
  const kind = op === Op.SHL ? L.CC_SHL : op === Op.SHR ? L.CC_SHR : L.CC_SAR;
  const ext = (l: number) => {
    f.get(l);
    if (!wide) f.op(O.i64_extend_i32_u);
  };
  f.i32(0).i32((kind << 2) | szl(sz)).mem(O.i32_store, S + L.S_CC_OP, 2);
  f.i32(0);
  ext(R);
  f.mem(O.i64_store, S + L.S_CC_DST, 3);
  f.i32(0);
  ext(A);
  f.mem(O.i64_store, S + L.S_CC_SRC1, 3);
  f.i32(0).get(cnt).op(O.i64_extend_i32_u).mem(O.i64_store, S + L.S_CC_SRC2, 3);
}

function rotate(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const isRol = ins.op === Op.ROL;
  const cntIsImm = ins.b.k === K_IMM;
  const cmask = wide ? 63 : 31;
  const cimm = cntIsImm ? ins.b.imm & cmask : -1;
  if (cntIsImm && cimm === 0) {
    zeroExtendIfReg32(g, ins);
    return;
  }
  const needFlags = g.liveAfter !== 0;

  const cnt = tmp(g, I32);
  loadCount(g, cnt, cntIsImm, cimm, cmask);
  // rotates leave all flags but CF/OF alone, and everything when count == 0: keep a merged copy
  let oldFl = -1;
  if (needFlags) {
    oldFl = tmp(g, I32);
    g.emitEflags();
    f.set(oldFl);
  }
  const p = place(g, ins.a, sz);
  const R = tmp(g, ty(sz));
  storePlace(g, p, () => {
    loadPlace(g, p);
    if (sz === 1) f.i32(0x01010101).op(O.i32_mul);
    else if (sz === 2) {
      const x = tmp(g, I32);
      f.set(x);
      f.get(x).get(x).i32(16).op(O.i32_shl).op(O.i32_or);
      f.freeTemp(I32, x);
    }
    f.get(cnt);
    if (wide) f.op(O.i64_extend_i32_u);
    f.op(isRol ? T.rotl : T.rotr);
    if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
    f.tee(R);
  });
  freePlace(g, p);
  if (needFlags) {
    const bitsM1 = sz * 8 - 1;
    const cf = tmp(g, I32), of = tmp(g, I32);
    const msb = (shiftAmt: number) => {
      f.get(R);
      if (wide) f.i64(shiftAmt).op(O.i64_shr_u).op(O.i32_wrap_i64);
      else f.i32(shiftAmt).op(O.i32_shr_u);
      f.i32(1).op(O.i32_and);
    };
    if (isRol) {
      f.get(R);
      if (wide) f.op(O.i32_wrap_i64);
      f.i32(1).op(O.i32_and).set(cf);
      msb(bitsM1);
      f.get(cf).op(O.i32_xor).set(of);
    } else {
      msb(bitsM1);
      f.set(cf);
      msb(bitsM1 - 1);
      f.get(cf).op(O.i32_xor).set(of);
    }
    // new = (old & ~(CF|OF)) | cf | of << 11
    f.get(oldFl).i32(~(L.F_CF | L.F_OF)).op(O.i32_and).get(cf).op(O.i32_or).get(of).i32(11).op(O.i32_shl).op(O.i32_or);
    if (!cntIsImm) f.get(oldFl).get(cnt).op(O.select); // count == 0 keeps the old flags
    g.setFlagsFromEflags();
    f.freeTemp(I32, cf);
    f.freeTemp(I32, of);
    f.freeTemp(I32, oldFl);
  }
  f.freeTemp(ty(sz), R);
  f.freeTemp(I32, cnt);
}

function rotCarry(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const right = ins.op === Op.RCR;
  const cntIsImm = ins.b.k === K_IMM;
  const cmask = wide ? 63 : 31;
  const cimm = cntIsImm ? ins.b.imm & cmask : -1;
  if (cntIsImm && cimm === 0) {
    zeroExtendIfReg32(g, ins);
    return;
  }
  const needFlags = g.liveAfter !== 0;
  const cnt = tmp(g, I32);
  loadCount(g, cnt, cntIsImm, cimm, cmask);
  const cf0 = tmp(g, I32);
  g.emitFlagBit(L.F_CF);
  f.set(cf0);
  let oldFl = -1;
  if (needFlags) {
    oldFl = tmp(g, I32);
    g.emitEflags();
    f.set(oldFl);
  }
  const p = place(g, ins.a, sz);
  const R = tmp(g, ty(sz));
  storePlace(g, p, () => {
    f.i32(right ? 1 : 0).i32(szl(sz));
    loadPlace(g, p);
    if (!wide) f.op(O.i64_extend_i32_u);
    f.get(cnt).get(cf0).call(IMP.rot_carry);
    if (!wide) f.op(O.i32_wrap_i64);
    f.tee(R);
  });
  freePlace(g, p);
  if (needFlags) {
    const bitsM1 = sz * 8 - 1;
    const cf = tmp(g, I32), of = tmp(g, I32);
    f.i32(0).mem(O.i32_load, L.STATE + L.S_SCRATCH, 2).set(cf);
    const bit = (n: number) => {
      f.get(R);
      if (wide) f.i64(n).op(O.i64_shr_u).op(O.i32_wrap_i64);
      else f.i32(n).op(O.i32_shr_u);
      f.i32(1).op(O.i32_and);
    };
    if (right) {
      bit(bitsM1);
      bit(bitsM1 - 1);
      f.op(O.i32_xor).set(of);
    } else {
      bit(bitsM1);
      f.get(cf).op(O.i32_xor).set(of);
    }
    f.get(oldFl).i32(~(L.F_CF | L.F_OF)).op(O.i32_and).get(cf).op(O.i32_or).get(of).i32(11).op(O.i32_shl).op(O.i32_or);
    if (!cntIsImm) f.get(oldFl).get(cnt).op(O.select);
    g.setFlagsFromEflags();
    f.freeTemp(I32, cf);
    f.freeTemp(I32, of);
    f.freeTemp(I32, oldFl);
  }
  f.freeTemp(ty(sz), R);
  f.freeTemp(I32, cf0);
  f.freeTemp(I32, cnt);
}

function shiftd(g: Gen, ins: Insn) {
  // SHLD / SHRD dst, src, count
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const isLeft = ins.op === Op.SHLD;
  const cntIsImm = ins.c.k === K_IMM;
  const cmask = wide ? 63 : 31;
  const cimm = cntIsImm ? ins.c.imm & cmask : -1;
  if (cntIsImm && cimm === 0) return;
  const needFlags = g.liveAfter !== 0;
  const cnt = tmp(g, I32);
  loadCount(g, cnt, cntIsImm, cimm, cmask);
  const p = place(g, ins.a, sz);
  const A = tmp(g, ty(sz));
  const R = tmp(g, ty(sz));
  if (needFlags && !cntIsImm) g.forceFlagsToMemory();

  const compute = () => {
    loadPlace(g, p);
    f.set(A);
    if (sz === 4 || sz === 2) {
      // 64-bit window: SHLD uses (x:src) << c and takes the high half; SHRD uses (src:x) >> c and takes the low half
      const t = tmp(g, I64);
      const bits = sz * 8;
      if (isLeft) {
        f.get(A).op(O.i64_extend_i32_u).i64(bits).op(O.i64_shl);
        src(g, ins.b, sz);
        f.op(O.i64_extend_i32_u).op(O.i64_or).set(t);
        f.get(t).get(cnt).op(O.i64_extend_i32_u).op(O.i64_shl).i64(bits).op(O.i64_shr_u).op(O.i32_wrap_i64);
      } else {
        src(g, ins.b, sz);
        f.op(O.i64_extend_i32_u).i64(bits).op(O.i64_shl);
        f.get(A).op(O.i64_extend_i32_u).op(O.i64_or).set(t);
        f.get(t).get(cnt).op(O.i64_extend_i32_u).op(O.i64_shr_u).op(O.i32_wrap_i64);
      }
      if (sz === 2) f.i32(0xffff).op(O.i32_and);
      f.freeTemp(I64, t);
    } else {
      // 64-bit, count in 0..63 (count 0 leaves the operand alone)
      const s2 = tmp(g, I64);
      src(g, ins.b, 8);
      f.set(s2);
      const c64 = tmp(g, I64);
      f.get(cnt).op(O.i64_extend_i32_u).set(c64);
      if (isLeft) {
        f.get(A).get(c64).op(O.i64_shl);
        f.get(s2).i64(64).get(c64).op(O.i64_sub).op(O.i64_shr_u).op(O.i64_or);
      } else {
        f.get(A).get(c64).op(O.i64_shr_u);
        f.get(s2).i64(64).get(c64).op(O.i64_sub).op(O.i64_shl).op(O.i64_or);
      }
      f.get(A).get(c64).i64(0).op(O.i64_ne).op(O.select); // count == 0 -> original operand
      f.freeTemp(I64, s2);
      f.freeTemp(I64, c64);
    }
    f.tee(R);
  };
  storePlace(g, p, compute);
  if (needFlags) {
    const emitFlags = () => {
      const S = L.STATE;
      const kind = isLeft ? L.CC_SHL : L.CC_SHRD;
      f.i32(0).i32((kind << 2) | szl(sz)).mem(O.i32_store, S + L.S_CC_OP, 2);
      f.i32(0).get(R);
      if (!wide) f.op(O.i64_extend_i32_u);
      f.mem(O.i64_store, S + L.S_CC_DST, 3);
      f.i32(0).get(A);
      if (!wide) f.op(O.i64_extend_i32_u);
      f.mem(O.i64_store, S + L.S_CC_SRC1, 3);
      f.i32(0).get(cnt).op(O.i64_extend_i32_u).mem(O.i64_store, S + L.S_CC_SRC2, 3);
    };
    if (!cntIsImm) {
      f.get(cnt).if_();
      emitFlags();
      f.end();
    } else emitFlags();
    g.setFS(null);
  }
  freePlace(g, p);
  f.freeTemp(ty(sz), A);
  f.freeTemp(ty(sz), R);
  f.freeTemp(I32, cnt);
}

// ---------------------------------------------------------------------------------------------
// Multiply / divide
// ---------------------------------------------------------------------------------------------
const RAX = 0, RDX = 2;

function storeMulFlags(g: Gen, sz: number, dstLocal: number, overflowLocal: number) {
  // CC_MUL: dst = low result, aux = overflow(0/1)
  const f = g.f;
  const S = L.STATE;
  f.i32(0).i32((L.CC_MUL << 2) | szl(sz)).mem(O.i32_store, S + L.S_CC_OP, 2);
  f.i32(0).get(dstLocal);
  if (sz !== 8) f.op(O.i64_extend_i32_u);
  f.mem(O.i64_store, S + L.S_CC_DST, 3);
  f.i32(0).get(overflowLocal).op(O.i64_extend_i32_u).mem(O.i64_store, S + L.S_CC_AUX, 3);
  g.setFS(null);
}

function mulWide(g: Gen, ins: Insn) {
  // one-operand MUL / IMUL
  const f = g.f;
  const sz = ins.osz;
  const signed = ins.op === Op.IMUL1;
  const needFlags = g.liveAfter !== 0;
  const lo = tmp(g, ty(sz));
  const ov = tmp(g, I32);
  if (sz === 1) {
    g.readReg(RAX, 1);
    if (signed) f.op(O.i32_extend8_s);
    src(g, ins.a, 1);
    if (signed) f.op(O.i32_extend8_s);
    f.op(O.i32_mul);
    const r = tmp(g, I32);
    f.tee(r);
    // ax = result (16 bits)
    f.i32(0xffff).op(O.i32_and);
    g.writeReg(RAX, 2);
    if (needFlags) {
      f.get(r).i32(0xff).op(O.i32_and).set(lo);
      if (signed) f.get(r).get(r).op(O.i32_extend8_s).op(O.i32_ne).set(ov);
      else f.get(r).i32(8).op(O.i32_shr_u).set(ov), f.get(ov).i32(0).op(O.i32_ne).set(ov);
    }
    f.freeTemp(I32, r);
  } else if (sz === 2) {
    g.readReg(RAX, 2);
    if (signed) f.op(O.i32_extend16_s);
    src(g, ins.a, 2);
    if (signed) f.op(O.i32_extend16_s);
    f.op(O.i32_mul);
    const r = tmp(g, I32);
    f.set(r);
    f.get(r).i32(0xffff).op(O.i32_and);
    g.writeReg(RAX, 2);
    f.get(r).i32(16).op(O.i32_shr_u);
    g.writeReg(RDX, 2);
    if (needFlags) {
      f.get(r).i32(0xffff).op(O.i32_and).set(lo);
      if (signed) f.get(r).get(r).op(O.i32_extend16_s).op(O.i32_ne).set(ov);
      else f.get(r).i32(16).op(O.i32_shr_u).i32(0).op(O.i32_ne).set(ov);
    }
    f.freeTemp(I32, r);
  } else if (sz === 4) {
    g.readReg(RAX, 4);
    f.op(signed ? O.i64_extend_i32_s : O.i64_extend_i32_u);
    src(g, ins.a, 4);
    f.op(signed ? O.i64_extend_i32_s : O.i64_extend_i32_u);
    f.op(O.i64_mul);
    const r = tmp(g, I64);
    f.set(r);
    f.get(r).op(O.i32_wrap_i64);
    g.writeReg(RAX, 4);
    f.get(r).i64(32).op(O.i64_shr_u).op(O.i32_wrap_i64);
    g.writeReg(RDX, 4);
    if (needFlags) {
      f.get(r).op(O.i32_wrap_i64).set(lo);
      if (signed) f.get(r).get(r).op(O.i32_wrap_i64).op(O.i64_extend_i32_s).op(O.i64_ne).set(ov);
      else f.get(r).i64(32).op(O.i64_shr_u).i64(0).op(O.i64_ne).set(ov);
    }
    f.freeTemp(I64, r);
  } else {
    const a = tmp(g, I64), b = tmp(g, I64);
    g.getG(RAX);
    f.set(a);
    src(g, ins.a, 8);
    f.set(b);
    f.get(a).get(b).op(O.i64_mul);
    g.setG(RAX);
    const hi = tmp(g, I64);
    f.get(a).get(b).call(signed ? IMP.mulhi_s64 : IMP.mulhi_u64);
    f.set(hi);
    f.get(hi);
    g.setG(RDX);
    if (needFlags) {
      g.getG(RAX);
      f.set(lo);
      if (signed) f.get(hi).get(lo).i64(63).op(O.i64_shr_s).op(O.i64_ne).set(ov);
      else f.get(hi).i64(0).op(O.i64_ne).set(ov);
    }
    f.freeTemp(I64, a);
    f.freeTemp(I64, b);
    f.freeTemp(I64, hi);
  }
  if (needFlags) storeMulFlags(g, sz, lo, ov);
  f.freeTemp(ty(sz), lo);
  f.freeTemp(I32, ov);
}

function imulTrunc(g: Gen, ins: Insn) {
  // IMUL r, r/m   and   IMUL r, r/m, imm
  const f = g.f;
  const sz = ins.osz;
  const needFlags = g.liveAfter !== 0;
  const x = ins.op === Op.IMUL3 ? ins.b : ins.a;
  const y = ins.op === Op.IMUL3 ? ins.c : ins.b;
  const lo = tmp(g, ty(sz));
  const ov = tmp(g, I32);
  if (sz === 8) {
    const a = tmp(g, I64), b = tmp(g, I64);
    src(g, x, 8);
    f.set(a);
    src(g, y, 8);
    f.set(b);
    f.get(a).get(b).op(O.i64_mul).tee(lo);
    g.writeReg(ins.a.r, 8);
    if (needFlags) {
      f.get(a).get(b).call(IMP.mulhi_s64).get(lo).i64(63).op(O.i64_shr_s).op(O.i64_ne).set(ov);
    }
    f.freeTemp(I64, a);
    f.freeTemp(I64, b);
  } else if (sz === 4) {
    src(g, x, 4);
    f.op(O.i64_extend_i32_s);
    src(g, y, 4);
    f.op(O.i64_extend_i32_s);
    f.op(O.i64_mul);
    const r = tmp(g, I64);
    f.tee(r);
    f.op(O.i32_wrap_i64).tee(lo);
    g.writeReg(ins.a.r, 4);
    if (needFlags) f.get(r).get(lo).op(O.i64_extend_i32_s).op(O.i64_ne).set(ov);
    f.freeTemp(I64, r);
  } else {
    src(g, x, 2);
    f.op(O.i32_extend16_s);
    src(g, y, 2);
    f.op(O.i32_extend16_s);
    f.op(O.i32_mul);
    const r = tmp(g, I32);
    f.tee(r).i32(0xffff).op(O.i32_and).tee(lo);
    g.writeReg(ins.a.r, 2);
    if (needFlags) f.get(r).get(r).op(O.i32_extend16_s).op(O.i32_ne).set(ov);
    f.freeTemp(I32, r);
  }
  if (needFlags) storeMulFlags(g, sz, lo, ov);
  f.freeTemp(ty(sz), lo);
  f.freeTemp(I32, ov);
}

function divide(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const signed = ins.op === Op.IDIV;
  // all flags undefined; leave the lazy state alone (it is simply stale, which is a valid "undefined")
  const d = tmp(g, ty(sz));
  src(g, ins.a, sz);
  f.set(d);
  const fault = () => {
    g.emitFaultHere(L.FK_DIV);
  };
  // divide by zero
  f.get(d).op(sz === 8 ? O.i64_eqz : O.i32_eqz).if_();
  g.depth++;
  fault();
  g.depth--;
  f.end();
  if (sz === 8) {
    g.getG(RDX);
    g.getG(RAX);
    f.get(d).i32(signed ? 1 : 0).call(IMP.div128);
    f.if_();
    g.depth++;
    fault();
    g.depth--;
    f.end();
    f.i32(0).mem(O.i64_load, L.STATE + L.S_SCRATCH, 3);
    g.setG(RAX);
    f.i32(0).mem(O.i64_load, L.STATE + L.S_SCRATCH + 8, 3);
    g.setG(RDX);
  } else if (sz === 4) {
    const n = tmp(g, I64), q = tmp(g, I64);
    g.readReg(RDX, 4);
    f.op(O.i64_extend_i32_u).i64(32).op(O.i64_shl);
    g.readReg(RAX, 4);
    f.op(O.i64_extend_i32_u).op(O.i64_or).set(n);
    if (!signed) {
      f.get(n).get(d).op(O.i64_extend_i32_u).op(O.i64_div_u).set(q);
      f.get(q).i64(32).op(O.i64_shr_u).op(O.i64_eqz).op(O.i32_eqz).if_();
      g.depth++;
      fault();
      g.depth--;
      f.end();
      f.get(q).op(O.i32_wrap_i64);
      g.writeReg(RAX, 4);
      f.get(n).get(d).op(O.i64_extend_i32_u).op(O.i64_rem_u).op(O.i32_wrap_i64);
      g.writeReg(RDX, 4);
    } else {
      // signed: guard against INT64_MIN / -1 (traps in wasm; also overflows the 32-bit quotient => #DE)
      const dd = tmp(g, I64);
      f.get(d).op(O.i64_extend_i32_s).set(dd);
      f.get(dd).i64(-1).op(O.i64_eq).get(n).i64(-0x8000000000000000n).op(O.i64_eq).op(O.i32_and).if_();
      g.depth++;
      fault();
      g.depth--;
      f.end();
      f.get(n).get(dd).op(O.i64_div_s).set(q);
      // quotient must fit in int32
      f.get(q).get(q).op(O.i32_wrap_i64).op(O.i64_extend_i32_s).op(O.i64_ne).if_();
      g.depth++;
      fault();
      g.depth--;
      f.end();
      f.get(q).op(O.i32_wrap_i64);
      g.writeReg(RAX, 4);
      f.get(n).get(dd).op(O.i64_rem_s).op(O.i32_wrap_i64);
      g.writeReg(RDX, 4);
      f.freeTemp(I64, dd);
    }
    f.freeTemp(I64, n);
    f.freeTemp(I64, q);
  } else if (sz === 2) {
    const n = tmp(g, I32);
    g.readReg(RDX, 2);
    f.i32(16).op(O.i32_shl);
    g.readReg(RAX, 2);
    f.op(O.i32_or).set(n);
    const q = tmp(g, I32);
    if (!signed) {
      f.get(n).get(d).op(O.i32_div_u).set(q);
      f.get(q).i32(16).op(O.i32_shr_u).if_();
    } else {
      const dd = tmp(g, I32);
      f.get(d).op(O.i32_extend16_s).set(dd);
      f.get(n).get(dd).op(O.i32_div_s).set(q);
      f.get(q).get(q).op(O.i32_extend16_s).op(O.i32_ne).if_();
      f.freeTemp(I32, dd);
    }
    g.depth++;
    fault();
    g.depth--;
    f.end();
    f.get(q).i32(0xffff).op(O.i32_and);
    g.writeReg(RAX, 2);
    if (!signed) f.get(n).get(d).op(O.i32_rem_u);
    else f.get(n).get(d).op(O.i32_extend16_s).op(O.i32_rem_s);
    f.i32(0xffff).op(O.i32_and);
    g.writeReg(RDX, 2);
    f.freeTemp(I32, n);
    f.freeTemp(I32, q);
  } else {
    const n = tmp(g, I32), q = tmp(g, I32);
    g.readReg(RAX, 2);
    f.set(n);
    if (!signed) {
      f.get(n).get(d).op(O.i32_div_u).set(q);
      f.get(q).i32(8).op(O.i32_shr_u).if_();
    } else {
      const dd = tmp(g, I32);
      f.get(n).op(O.i32_extend16_s).set(n);
      f.get(d).op(O.i32_extend8_s).set(dd);
      f.get(n).get(dd).op(O.i32_div_s).set(q);
      f.get(q).get(q).op(O.i32_extend8_s).op(O.i32_ne).if_();
      f.freeTemp(I32, dd);
    }
    g.depth++;
    fault();
    g.depth--;
    f.end();
    // al = quotient, ah = remainder
    f.get(q).i32(0xff).op(O.i32_and);
    if (!signed) f.get(n).get(d).op(O.i32_rem_u);
    else f.get(n).get(d).op(O.i32_extend8_s).op(O.i32_rem_s);
    f.i32(0xff).op(O.i32_and).i32(8).op(O.i32_shl).op(O.i32_or);
    g.writeReg(RAX, 2);
    f.freeTemp(I32, n);
    f.freeTemp(I32, q);
  }
  f.freeTemp(ty(sz), d);
}

// ---------------------------------------------------------------------------------------------
// Bit operations
// ---------------------------------------------------------------------------------------------
function bitTest(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const op = ins.op;
  const bits = sz * 8;
  const idxImm = ins.b.k === K_IMM;
  const needCF = (g.liveAfter & L.F_CF) !== 0;
  const needOther = (g.liveAfter & ~(L.F_CF | L.F_ZF)) !== 0; // OF/SF/AF/PF are undefined after BT -> treated as killed
  const keepZF = (g.liveAfter & L.F_ZF) !== 0;
  const modifies = op !== Op.BT;
  if (!modifies && !needCF && !keepZF && !needOther) return;

  // merged flag handling: if ZF is live it must be preserved from the old flags
  let oldFl = -1;
  if (keepZF) {
    oldFl = tmp(g, I32);
    g.emitEflags();
    f.set(oldFl);
  }

  // bit index (as typed value, masked to operand width), plus for memory + register index: address displacement
  const idx = tmp(g, ty(sz));
  let p: Place;
  if (ins.a.k === K_MEM) {
    if (idxImm) {
      p = place(g, ins.a, sz);
      if (wide) f.i64(ins.b.imm & 63);
      else f.i32(ins.b.imm & (bits - 1));
      f.set(idx);
    } else {
      // bit-string addressing with a register offset
      const off = g.emitEA(ins.a);
      const ea = tmp(g, I32);
      // signed bit offset
      const isn = tmp(g, I64);
      g.readReg(ins.b.r, sz, ins.b.hi8);
      if (sz === 8) f.set(isn);
      else {
        if (sz === 2) f.op(O.i32_extend16_s);
        f.op(O.i64_extend_i32_s).set(isn);
      }
      // byte displacement = (isn >> log2(bits)) * (bits/8)  (arithmetic shift)
      f.get(isn).i64(Math.log2(bits)).op(O.i64_shr_s).i64(sz).op(O.i64_mul).op(O.i32_wrap_i64).op(O.i32_add);
      f.set(ea);
      p = { o: ins.a, sz, ea, off };
      // idx = isn & (bits-1)
      f.get(isn).i64(bits - 1).op(O.i64_and);
      if (!wide) f.op(O.i32_wrap_i64);
      f.set(idx);
      f.freeTemp(I64, isn);
    }
  } else {
    p = place(g, ins.a, sz);
    if (idxImm) {
      if (wide) f.i64(ins.b.imm & 63);
      else f.i32(ins.b.imm & (bits - 1));
    } else {
      g.readReg(ins.b.r, sz, ins.b.hi8);
      if (wide) f.i64(63).op(O.i64_and);
      else f.i32(bits - 1).op(O.i32_and);
    }
    f.set(idx);
  }

  const cf = tmp(g, I32);
  const val = tmp(g, ty(sz));
  loadPlace(g, p);
  f.set(val);
  // cf = (val >> idx) & 1
  f.get(val).get(idx).op(T.shrU);
  if (wide) f.i64(1).op(O.i64_and).op(O.i32_wrap_i64);
  else f.i32(1).op(O.i32_and);
  f.set(cf);
  if (modifies) {
    storePlace(g, p, () => {
      f.get(val);
      if (wide) f.i64(1);
      else f.i32(1);
      f.get(idx).op(T.shl);
      if (op === Op.BTS) f.op(T.or);
      else if (op === Op.BTC) f.op(T.xor);
      else {
        if (wide) f.i64(-1n);
        else f.i32(-1);
        f.op(T.xor).op(T.and);
      }
    });
  }
  freePlace(g, p);
  if (needCF || keepZF || needOther) {
    // new flags = (old & ZF) | CF
    if (keepZF) f.get(oldFl).i32(L.F_ZF).op(O.i32_and);
    else f.i32(0);
    f.get(cf).op(O.i32_or);
    g.setFlagsFromEflags();
  }
  f.freeTemp(I32, cf);
  f.freeTemp(ty(sz), val);
  f.freeTemp(ty(sz), idx);
  if (oldFl >= 0) f.freeTemp(I32, oldFl);
}

function bitScan(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const wide = sz === 8;
  const T = tab(sz);
  const op = ins.op;
  const needFlags = g.liveAfter !== 0;
  const x = tmp(g, ty(sz));
  src(g, ins.b, sz);
  f.set(x);
  const r = tmp(g, ty(sz));
  const bits = sz * 8;
  switch (op) {
    case Op.POPCNT:
      f.get(x).op(T.popcnt);
      f.set(r);
      f.get(r);
      g.writeReg(ins.a.r, sz);
      break;
    case Op.TZCNT:
      f.get(x);
      if (sz === 2) f.i32(0x10000).op(O.i32_or);
      else if (sz === 1) f.i32(0x100).op(O.i32_or);
      f.op(T.ctz).set(r);
      f.get(r);
      g.writeReg(ins.a.r, sz);
      break;
    case Op.LZCNT:
      f.get(x).op(T.clz);
      if (sz === 2) f.i32(16).op(O.i32_sub);
      f.set(r);
      f.get(r);
      g.writeReg(ins.a.r, sz);
      break;
    case Op.BSF:
    case Op.BSR: {
      // dest unchanged when src == 0
      f.get(x).op(T.eqz).op(O.i32_eqz).if_();
      g.depth++;
      if (op === Op.BSF) f.get(x).op(T.ctz);
      else {
        if (wide) f.i64(63).get(x).op(O.i64_clz).op(O.i64_sub);
        else f.i32(31).get(x).op(O.i32_clz).op(O.i32_sub);
      }
      g.writeReg(ins.a.r, sz);
      g.depth--;
      f.end();
      break;
    }
  }
  if (needFlags) {
    if (op === Op.TZCNT || op === Op.LZCNT) {
      // CF = (src == 0), ZF = (result == 0)
      f.get(x).op(T.eqz); // CF
      if (op === Op.TZCNT) f.get(r).op(T.eqz);
      else f.get(r).op(T.eqz);
      f.i32(6).op(O.i32_shl).op(O.i32_or);
      g.setFlagsFromEflags();
    } else {
      // ZF = (src == 0); everything else cleared (or undefined)
      f.get(x).op(T.eqz).i32(6).op(O.i32_shl);
      g.setFlagsFromEflags();
    }
  }
  f.freeTemp(ty(sz), x);
  f.freeTemp(ty(sz), r);
}

function bswap(g: Gen, ins: Insn) {
  const f = g.f;
  const r = ins.a.r;
  const t = tmp(g, I32);
  const bs32 = () => {
    // value on stack (i32) -> byte-swapped
    f.set(t);
    f.get(t).i32(24).op(O.i32_shl);
    f.get(t).i32(0xff00).op(O.i32_and).i32(8).op(O.i32_shl).op(O.i32_or);
    f.get(t).i32(8).op(O.i32_shr_u).i32(0xff00).op(O.i32_and).op(O.i32_or);
    f.get(t).i32(24).op(O.i32_shr_u).op(O.i32_or);
  };
  if (ins.a.sz === 4) {
    g.readReg(r, 4);
    bs32();
    g.writeReg(r, 4);
  } else {
    const q = tmp(g, I64);
    g.getG(r);
    f.set(q);
    f.get(q).op(O.i32_wrap_i64);
    bs32();
    f.op(O.i64_extend_i32_u).i64(32).op(O.i64_shl);
    f.get(q).i64(32).op(O.i64_shr_u).op(O.i32_wrap_i64);
    bs32();
    f.op(O.i64_extend_i32_u).op(O.i64_or);
    g.setG(r);
    f.freeTemp(I64, q);
  }
  f.freeTemp(I32, t);
}

// ---------------------------------------------------------------------------------------------
// Conditional ops
// ---------------------------------------------------------------------------------------------
function setcc(g: Gen, ins: Insn) {
  g.emitCond(ins.cc);
  const o = ins.a;
  if (o.k === K_REG) g.writeReg(o.r, 1, o.hi8);
  else {
    const p = place(g, o, 1);
    // stack has the value: need address below. Spill value to temp.
    const t = tmp(g, I32);
    g.f.set(t);
    storePlace(g, p, () => g.f.get(t));
    g.f.freeTemp(I32, t);
    freePlace(g, p);
  }
}

function cmovcc(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  // evaluate source (may fault, like hardware), then select between source and the old value
  src(g, ins.b, sz);
  g.readReg(ins.a.r, sz, false);
  g.emitCond(ins.cc);
  f.op(O.select);
  g.writeReg(ins.a.r, sz);
}

// ---------------------------------------------------------------------------------------------
// Exchange-and-add / compare-and-exchange
// ---------------------------------------------------------------------------------------------
function xadd(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const T = tab(sz);
  const needFlags = g.liveAfter !== 0;
  const p = place(g, ins.a, sz);
  const old = tmp(g, ty(sz));
  const B = tmp(g, ty(sz));
  const R = tmp(g, ty(sz));
  loadPlace(g, p);
  f.set(old);
  g.readReg(ins.b.r, sz, ins.b.hi8);
  f.set(B);
  storePlace(g, p, () => {
    f.get(old).get(B).op(T.add);
    if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
    f.tee(R);
  });
  f.get(old);
  g.writeReg(ins.b.r, sz, ins.b.hi8);
  freePlace(g, p);
  if (needFlags) g.setArithFlags(FSK.ADD, sz, old, B, R, [[ty(sz), old], [ty(sz), B], [ty(sz), R]]);
  else {
    f.freeTemp(ty(sz), old);
    f.freeTemp(ty(sz), B);
    f.freeTemp(ty(sz), R);
  }
}

function cmpxchg(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const T = tab(sz);
  const needFlags = g.liveAfter !== 0;
  const p = place(g, ins.a, sz);
  const dst = tmp(g, ty(sz));
  const acc = tmp(g, ty(sz));
  const R = tmp(g, ty(sz));
  loadPlace(g, p);
  f.set(dst);
  g.readReg(RAX, sz);
  f.set(acc);
  // flags are those of CMP acc, dst
  f.get(acc).get(dst).op(T.sub);
  if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
  f.set(R);
  f.get(dst).get(acc).op(T.eq).if_();
  g.depth++;
  storePlace(g, p, () => g.readReg(ins.b.r, sz, ins.b.hi8));
  g.depth--;
  f.else_();
  g.depth++;
  // write the destination back too (hardware always performs a write for memory destinations)
  f.get(dst);
  g.writeReg(RAX, sz);
  g.depth--;
  f.end();
  freePlace(g, p);
  if (needFlags) g.setArithFlags(FSK.SUB, sz, acc, dst, R, [[ty(sz), acc], [ty(sz), dst], [ty(sz), R]]);
  else {
    f.freeTemp(ty(sz), acc);
    f.freeTemp(ty(sz), dst);
    f.freeTemp(ty(sz), R);
  }
}

function cmpxchg8b(g: Gen, ins: Insn) {
  const f = g.f;
  const wide = ins.op === Op.CMPXCHG16B;
  const o = ins.a;
  const off = g.emitEA(o);
  const ea = tmp(g, I32);
  f.set(ea);
  const zf = tmp(g, I32);
  if (!wide) {
    // compare edx:eax with m64
    const cur = tmp(g, I64), exp = tmp(g, I64);
    f.get(ea).mem(O.i64_load, off).set(cur);
    g.readReg(RDX, 4);
    f.op(O.i64_extend_i32_u).i64(32).op(O.i64_shl);
    g.readReg(RAX, 4);
    f.op(O.i64_extend_i32_u).op(O.i64_or).set(exp);
    f.get(cur).get(exp).op(O.i64_eq).tee(zf).if_();
    g.depth++;
    f.get(ea);
    g.readReg(1 + 2, 4); // ebx (reg 3)
    f.op(O.i64_extend_i32_u);
    g.readReg(1, 4); // ecx
    f.op(O.i64_extend_i32_u).i64(32).op(O.i64_shl).op(O.i64_or);
    f.mem(O.i64_store, off);
    g.depth--;
    f.else_();
    g.depth++;
    f.get(cur).op(O.i32_wrap_i64);
    g.writeReg(RAX, 4);
    f.get(cur).i64(32).op(O.i64_shr_u).op(O.i32_wrap_i64);
    g.writeReg(RDX, 4);
    g.depth--;
    f.end();
    f.freeTemp(I64, cur);
    f.freeTemp(I64, exp);
  } else {
    const lo = tmp(g, I64), hi = tmp(g, I64);
    f.get(ea).mem(O.i64_load, off).set(lo);
    f.get(ea).mem(O.i64_load, off + 8).set(hi);
    g.getG(RAX);
    f.get(lo).op(O.i64_eq);
    g.getG(RDX);
    f.get(hi).op(O.i64_eq).op(O.i32_and).tee(zf).if_();
    g.depth++;
    f.get(ea);
    g.getG(3);
    f.mem(O.i64_store, off);
    f.get(ea);
    g.getG(1);
    f.mem(O.i64_store, off + 8);
    g.depth--;
    f.else_();
    g.depth++;
    f.get(lo);
    g.setG(RAX);
    f.get(hi);
    g.setG(RDX);
    g.depth--;
    f.end();
    f.freeTemp(I64, lo);
    f.freeTemp(I64, hi);
  }
  f.freeTemp(I32, ea);
  if ((g.liveAfter & L.F_ZF) !== 0 || g.liveAfter !== 0) {
    // ZF defined; other flags untouched
    const keep = g.liveAfter & ~L.F_ZF;
    if (keep) {
      g.emitEflags();
      f.i32(~L.F_ZF).op(O.i32_and);
    } else f.i32(0);
    f.get(zf).i32(6).op(O.i32_shl).op(O.i32_or);
    g.setFlagsFromEflags();
  }
  f.freeTemp(I32, zf);
}

// ---------------------------------------------------------------------------------------------
// Sign extension, flags, misc
// ---------------------------------------------------------------------------------------------
function cbw(g: Gen, ins: Insn) {
  const f = g.f;
  switch (ins.osz) {
    case 2: g.readReg(RAX, 1); f.op(O.i32_extend8_s).i32(0xffff).op(O.i32_and); g.writeReg(RAX, 2); break;
    case 4: g.readReg(RAX, 2); f.op(O.i32_extend16_s); g.writeReg(RAX, 4); break;
    default: g.readReg(RAX, 4); f.op(O.i64_extend_i32_s); g.writeReg(RAX, 8); break;
  }
}
function cwd(g: Gen, ins: Insn) {
  const f = g.f;
  switch (ins.osz) {
    case 2: g.readReg(RAX, 2); f.op(O.i32_extend16_s).i32(15).op(O.i32_shr_s).i32(0xffff).op(O.i32_and); g.writeReg(RDX, 2); break;
    case 4: g.readReg(RAX, 4); f.i32(31).op(O.i32_shr_s); g.writeReg(RDX, 4); break;
    default: g.getG(RAX); f.i64(63).op(O.i64_shr_s); g.writeReg(RDX, 8); break;
  }
}

function lahf(g: Gen) {
  const f = g.f;
  g.emitEflags();
  // AH = SF:ZF:0:AF:0:PF:1:CF
  f.i32(0xd5).op(O.i32_and).i32(2).op(O.i32_or);
  g.writeReg(RAX, 1, true);
}
function sahf(g: Gen) {
  const f = g.f;
  g.readReg(RAX, 1, true);
  f.i32(0xd5).op(O.i32_and);
  // merge with OF from the old flags
  if (g.liveAfter & L.F_OF) {
    g.emitEflags();
    f.i32(L.F_OF).op(O.i32_and).op(O.i32_or);
  }
  g.setFlagsFromEflags();
}
function pushf(g: Gen, ins: Insn) {
  const f = g.f;
  pushRaw64(g, () => {
    g.emitEflags();
    f.i32(0x202).op(O.i32_or);
    // DF
    f.i32(0).mem(O.i32_load, L.STATE + L.S_DF, 2).i32(10).op(O.i32_shl).op(O.i32_or);
    f.op(O.i64_extend_i32_u);
  });
}
function popf(g: Gen, ins: Insn) {
  const f = g.f;
  const t = tmp(g, I32);
  g.getG(RSP);
  f.op(O.i32_wrap_i64).mem(O.i32_load, 0).set(t);
  g.getG(RSP);
  f.i64(8).op(O.i64_add);
  g.setG(RSP);
  f.get(t).i32(L.F_ARITH).op(O.i32_and);
  g.setFlagsFromEflags();
  f.i32(0).get(t).i32(10).op(O.i32_shr_u).i32(1).op(O.i32_and).mem(O.i32_store, L.STATE + L.S_DF, 2);
  f.freeTemp(I32, t);
}

function setCarry(g: Gen, v: number | null) {
  // v: 0 = clear, 1 = set, null = complement
  const f = g.f;
  if ((g.liveAfter & ~L.F_CF) === 0 && v !== null) {
    // only CF matters afterwards
    f.i32(v);
    g.setFlagsFromEflags();
    return;
  }
  g.emitEflags();
  if (v === 0) f.i32(~L.F_CF).op(O.i32_and);
  else if (v === 1) f.i32(L.F_CF).op(O.i32_or);
  else f.i32(L.F_CF).op(O.i32_xor);
  g.setFlagsFromEflags();
}

function xlat(g: Gen, ins: Insn) {
  const f = g.f;
  g.getG(3);
  f.op(O.i32_wrap_i64);
  g.readReg(RAX, 1);
  f.op(O.i32_add).mem(O.i32_load8_u, 0);
  g.writeReg(RAX, 1);
}

// ---------------------------------------------------------------------------------------------
// String instructions
// ---------------------------------------------------------------------------------------------
const RCX = 1, RSI = 6, RDI = 7;

/** local (i32) = +sz or -sz depending on DF */
function dfStep(g: Gen, sz: number): number {
  const f = g.f;
  const t = tmp(g, I32);
  f.i32(0).mem(O.i32_load, L.STATE + L.S_DF, 2).i32(1).op(O.i32_shl).i32(1).op(O.i32_sub).i32(-sz).op(O.i32_mul).set(t);
  return t;
}
function advanceBy(g: Gen, reg: number, stepLocal: number) {
  g.getG(reg);
  g.f.get(stepLocal).op(O.i64_extend_i32_s).op(O.i64_add);
  g.setG(reg);
}
function pushDF(g: Gen) {
  g.f.i32(0).mem(O.i32_load, L.STATE + L.S_DF, 2);
}
/** reg += (DF ? -1 : 1) * bytes   where `bytes` is an i64 local */
function advanceTotal(g: Gen, reg: number, bytes: number) {
  const f = g.f;
  g.getG(reg);
  f.i64(0).get(bytes).op(O.i64_sub).get(bytes);
  pushDF(g);
  f.op(O.select).op(O.i64_add);
  g.setG(reg);
}

function stringOp(g: Gen, ins: Insn) {
  const f = g.f;
  const sz = ins.osz;
  const op = ins.op;
  const rep = ins.rep;
  const T = tab(sz);

  if (rep && (op === Op.MOVS || op === Op.STOS)) {
    const cnt = tmp(g, I32);
    g.getG(RCX);
    f.op(O.i32_wrap_i64).set(cnt);
    if (op === Op.MOVS) {
      g.getG(RDI);
      f.op(O.i32_wrap_i64);
      g.getG(RSI);
      f.op(O.i32_wrap_i64).get(cnt).i32(sz);
      pushDF(g);
      f.call(IMP.rep_movs);
    } else {
      g.getG(RDI);
      f.op(O.i32_wrap_i64).get(cnt);
      g.getG(RAX);
      f.i32(sz);
      pushDF(g);
      f.call(IMP.rep_stos);
    }
    const bytes = tmp(g, I64);
    f.get(cnt).op(O.i64_extend_i32_u).i64(sz).op(O.i64_mul).set(bytes);
    advanceTotal(g, RDI, bytes);
    if (op === Op.MOVS) advanceTotal(g, RSI, bytes);
    f.i64(0);
    g.setG(RCX);
    f.freeTemp(I64, bytes);
    f.freeTemp(I32, cnt);
    return;
  }
  if (rep && (op === Op.CMPS || op === Op.SCAS)) {
    g.forceFlagsToMemory();
    const left = tmp(g, I32);
    const repne = ins.rep === 2 ? 1 : 0;
    if (op === Op.CMPS) {
      g.getG(RSI);
      f.op(O.i32_wrap_i64);
      g.getG(RDI);
      f.op(O.i32_wrap_i64);
      g.getG(RCX);
      f.op(O.i32_wrap_i64).i32(sz);
      pushDF(g);
      f.i32(repne).call(IMP.rep_cmps).set(left);
      f.i32(0).mem(O.i64_load, L.STATE + L.S_SCRATCH, 3);
      g.setG(RSI);
    } else {
      g.getG(RDI);
      f.op(O.i32_wrap_i64);
      g.getG(RCX);
      f.op(O.i32_wrap_i64);
      g.getG(RAX);
      f.i32(sz);
      pushDF(g);
      f.i32(repne).call(IMP.rep_scas).set(left);
    }
    // CMPS: scratch+8 = rdi ; SCAS: scratch = rdi
    f.i32(0).mem(O.i64_load, L.STATE + L.S_SCRATCH + (op === Op.CMPS ? 8 : 0), 3);
    g.setG(RDI);
    f.get(left).op(O.i64_extend_i32_u);
    g.setG(RCX);
    f.freeTemp(I32, left);
    g.setFS(null);
    return;
  }
  if (rep && op === Op.LODS) {
    // only the final value matters
    const cnt = tmp(g, I64);
    g.getG(RCX);
    f.set(cnt);
    f.get(cnt).op(O.i64_eqz).op(O.i32_eqz).if_();
    {
      const bytes = tmp(g, I64);
      f.get(cnt).i64(sz).op(O.i64_mul).set(bytes);
      // last element address = rsi + (DF ? -(cnt-1)*sz : (cnt-1)*sz)
      g.getG(RSI);
      f.get(bytes).i64(sz).op(O.i64_sub).set(bytes);
      f.i64(0).get(bytes).op(O.i64_sub).get(bytes);
      pushDF(g);
      f.op(O.select).op(O.i64_add).op(O.i32_wrap_i64).mem(g.loadOp(sz), 0);
      g.writeReg(RAX, sz);
      f.get(bytes).i64(sz).op(O.i64_add).set(bytes);
      advanceTotal(g, RSI, bytes);
      f.i64(0);
      g.setG(RCX);
      f.freeTemp(I64, bytes);
    }
    f.end();
    f.freeTemp(I64, cnt);
    return;
  }

  // single iteration forms
  const step = dfStep(g, sz);
  const needFlags = g.liveAfter !== 0;
  switch (op) {
    case Op.MOVS: {
      g.getG(RDI);
      f.op(O.i32_wrap_i64);
      g.getG(RSI);
      f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0);
      f.mem(g.storeOp(sz), 0);
      advanceBy(g, RSI, step);
      advanceBy(g, RDI, step);
      break;
    }
    case Op.STOS: {
      g.getG(RDI);
      f.op(O.i32_wrap_i64);
      g.readReg(RAX, sz);
      f.mem(g.storeOp(sz), 0);
      advanceBy(g, RDI, step);
      break;
    }
    case Op.LODS: {
      g.getG(RSI);
      f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0);
      g.writeReg(RAX, sz);
      advanceBy(g, RSI, step);
      break;
    }
    case Op.SCAS: case Op.CMPS: {
      const A = tmp(g, ty(sz)), B = tmp(g, ty(sz)), R = tmp(g, ty(sz));
      if (op === Op.SCAS) {
        g.readReg(RAX, sz);
        f.set(A);
        g.getG(RDI);
        f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0).set(B);
        advanceBy(g, RDI, step);
      } else {
        g.getG(RSI);
        f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0).set(A);
        g.getG(RDI);
        f.op(O.i32_wrap_i64).mem(g.loadOp(sz), 0).set(B);
        advanceBy(g, RSI, step);
        advanceBy(g, RDI, step);
      }
      if (needFlags) {
        f.get(A).get(B).op(T.sub);
        if (sz < 4) f.i32(maskOf(sz)).op(O.i32_and);
        f.set(R);
        g.setArithFlags(FSK.SUB, sz, A, B, R, [[ty(sz), A], [ty(sz), B], [ty(sz), R]]);
      } else {
        f.freeTemp(ty(sz), A);
        f.freeTemp(ty(sz), B);
        f.freeTemp(ty(sz), R);
      }
      break;
    }
  }
  f.freeTemp(I32, step);
}

// ---------------------------------------------------------------------------------------------
// Dispatcher for straight-line integer instructions. Returns false if the opcode is not handled here.
// ---------------------------------------------------------------------------------------------
export function translateInt(g: Gen, ins: Insn): boolean {
  switch (ins.op) {
    case Op.ADD: case Op.OR: case Op.ADC: case Op.SBB: case Op.AND: case Op.SUB: case Op.XOR: case Op.CMP: case Op.TEST:
      alu(g, ins); return true;
    case Op.INC: case Op.DEC: incdec(g, ins); return true;
    case Op.NEG: neg(g, ins); return true;
    case Op.NOT: not(g, ins); return true;
    case Op.MOV: mov(g, ins); return true;
    case Op.MOVZX: movzx(g, ins); return true;
    case Op.MOVSX: movsx(g, ins); return true;
    case Op.MOVSXD: movsxd(g, ins); return true;
    case Op.LEA: lea(g, ins); return true;
    case Op.XCHG: xchg(g, ins); return true;
    case Op.PUSH: push(g, ins); return true;
    case Op.POP: pop(g, ins); return true;
    case Op.LEAVE: leave(g, ins); return true;
    case Op.SHL: case Op.SHR: case Op.SAR: shift(g, ins); return true;
    case Op.ROL: case Op.ROR: rotate(g, ins); return true;
    case Op.RCL: case Op.RCR: rotCarry(g, ins); return true;
    case Op.SHLD: case Op.SHRD: shiftd(g, ins); return true;
    case Op.MUL: case Op.IMUL1: mulWide(g, ins); return true;
    case Op.IMUL2: case Op.IMUL3: imulTrunc(g, ins); return true;
    case Op.DIV: case Op.IDIV: divide(g, ins); return true;
    case Op.BT: case Op.BTS: case Op.BTR: case Op.BTC: bitTest(g, ins); return true;
    case Op.BSF: case Op.BSR: case Op.TZCNT: case Op.LZCNT: case Op.POPCNT: bitScan(g, ins); return true;
    case Op.BSWAP: bswap(g, ins); return true;
    case Op.SETCC: setcc(g, ins); return true;
    case Op.CMOVCC: cmovcc(g, ins); return true;
    case Op.XADD: xadd(g, ins); return true;
    case Op.CMPXCHG: cmpxchg(g, ins); return true;
    case Op.CMPXCHG8B: case Op.CMPXCHG16B: cmpxchg8b(g, ins); return true;
    case Op.CBW: cbw(g, ins); return true;
    case Op.CWD: cwd(g, ins); return true;
    case Op.LAHF: lahf(g); return true;
    case Op.SAHF: sahf(g); return true;
    case Op.PUSHF: pushf(g, ins); return true;
    case Op.POPF: popf(g, ins); return true;
    case Op.CLC: setCarry(g, 0); return true;
    case Op.STC: setCarry(g, 1); return true;
    case Op.CMC: setCarry(g, null); return true;
    case Op.CLD: g.f.i32(0).i32(0).mem(O.i32_store, L.STATE + L.S_DF, 2); return true;
    case Op.STD: g.f.i32(0).i32(1).mem(O.i32_store, L.STATE + L.S_DF, 2); return true;
    case Op.XLAT: xlat(g, ins); return true;
    case Op.MOVS: case Op.STOS: case Op.LODS: case Op.SCAS: case Op.CMPS: stringOp(g, ins); return true;
    case Op.NOP: case Op.PAUSE: case Op.PREFETCH: case Op.LFENCE: case Op.MFENCE: case Op.SFENCE: case Op.FWAIT: case Op.EMMS:
    case Op.CLI: case Op.STI:
      return true;
    case Op.MOVNTI: {
      const sz = ins.b.sz;
      const p = place(g, ins.a, sz);
      storePlace(g, p, () => g.readReg(ins.b.r, sz));
      freePlace(g, p);
      return true;
    }
  }
  return false;
}
