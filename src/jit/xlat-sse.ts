// SSE / SSE2 / SSE3 / SSSE3 / SSE4.1 translation onto WebAssembly SIMD.
import { O, VT } from "../wasm/opcodes.ts";
import { Gen } from "./gen.ts";
import { Insn, Opd, K_IMM, K_MEM, K_REG, K_XMM } from "../x86/decode.ts";
import { Op } from "../x86/ops.ts";
import * as L from "./layout.ts";
import { place, freePlace, storeTo } from "./xlat-int.ts";

const { i32: I32, i64: I64, f32: F32, f64: F64, v128: V128 } = VT;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const ZERO = new Uint8Array(16);
function constLanes32(a: number, b: number, c: number, d: number): Uint8Array {
  const u = new Uint8Array(16);
  const dv = new DataView(u.buffer);
  dv.setUint32(0, a >>> 0, true);
  dv.setUint32(4, b >>> 0, true);
  dv.setUint32(8, c >>> 0, true);
  dv.setUint32(12, d >>> 0, true);
  return u;
}
function splat32(v: number) {
  return constLanes32(v, v, v, v);
}

/** Push a 128-bit value for source operand `o`. For memory operands, `size` bytes are loaded (zero extended to 128). */
function ld(g: Gen, o: Opd, size = 16) {
  const f = g.f;
  if (o.k === K_XMM) {
    g.getX(o.r);
    return;
  }
  const off = g.emitEA(o);
  if (size >= 16) f.mem(O.v128_load, off);
  else if (size === 8) f.mem(O.v128_load64_zero, off);
  else if (size === 4) f.mem(O.v128_load32_zero, off);
  else if (size === 2) {
    // zero vector with a 16-bit load into lane 0 (via i32 lane)
    const ea = f.temp(I32);
    f.set(ea);
    f.v128(ZERO).get(ea).mem(O.i32_load16_u, off).lane(O.i32x4_replace_lane, 0);
    f.freeTemp(I32, ea);
  } else if (size === 1) {
    const ea = f.temp(I32);
    f.set(ea);
    f.v128(ZERO).get(ea).mem(O.i32_load8_u, off).lane(O.i32x4_replace_lane, 0);
    f.freeTemp(I32, ea);
  }
}
/** Push scalar f32 from low lane of register or from memory. */
function ldF32(g: Gen, o: Opd) {
  if (o.k === K_XMM) g.getX(o.r), g.f.lane(O.f32x4_extract_lane, 0);
  else {
    const off = g.emitEA(o);
    g.f.mem(O.f32_load, off);
  }
}
function ldF64(g: Gen, o: Opd) {
  if (o.k === K_XMM) g.getX(o.r), g.f.lane(O.f64x2_extract_lane, 0);
  else {
    const off = g.emitEA(o);
    g.f.mem(O.f64_load, off);
  }
}
function ldI64(g: Gen, o: Opd) {
  if (o.k === K_XMM) g.getX(o.r), g.f.lane(O.i64x2_extract_lane, 0);
  else {
    const off = g.emitEA(o);
    g.f.mem(O.i64_load, off);
  }
}

/** Store the v128 on top of the stack... (we use closures instead): store `lanes` bytes of register `src` to memory operand `m`. */
function storeVec(g: Gen, m: Opd, src: number, bytes: number, lane = 0) {
  const f = g.f;
  const p = place(g, m, bytes);
  f.get(p.ea);
  g.getX(src);
  if (bytes === 16) f.mem(O.v128_store, p.off);
  else if (bytes === 8) f.memLane(O.v128_store64_lane, p.off, 0, lane);
  else if (bytes === 4) f.memLane(O.v128_store32_lane, p.off, 0, lane);
  else if (bytes === 2) f.memLane(O.v128_store16_lane, p.off, 0, lane);
  else f.memLane(O.v128_store8_lane, p.off, 0, lane);
  if (g.smcNeeded(m)) g.emitSmcCheck(p.ea, p.off, bytes);
  freePlace(g, p);
}

const SIMD_BIN: Record<number, number> = {
  [Op.ADDPS]: O.f32x4_add, [Op.ADDPD]: O.f64x2_add, [Op.SUBPS]: O.f32x4_sub, [Op.SUBPD]: O.f64x2_sub,
  [Op.MULPS]: O.f32x4_mul, [Op.MULPD]: O.f64x2_mul, [Op.DIVPS]: O.f32x4_div, [Op.DIVPD]: O.f64x2_div,
  [Op.ANDPS]: O.v128_and, [Op.ANDPD]: O.v128_and, [Op.PAND]: O.v128_and,
  [Op.ORPS]: O.v128_or, [Op.ORPD]: O.v128_or, [Op.POR]: O.v128_or,
  [Op.XORPS]: O.v128_xor, [Op.XORPD]: O.v128_xor, [Op.PXOR]: O.v128_xor,
  [Op.PADDB]: O.i8x16_add, [Op.PADDW]: O.i16x8_add, [Op.PADDD]: O.i32x4_add, [Op.PADDQ]: O.i64x2_add,
  [Op.PSUBB]: O.i8x16_sub, [Op.PSUBW]: O.i16x8_sub, [Op.PSUBD]: O.i32x4_sub, [Op.PSUBQ]: O.i64x2_sub,
  [Op.PADDSB]: O.i8x16_add_sat_s, [Op.PADDSW]: O.i16x8_add_sat_s, [Op.PADDUSB]: O.i8x16_add_sat_u, [Op.PADDUSW]: O.i16x8_add_sat_u,
  [Op.PSUBSB]: O.i8x16_sub_sat_s, [Op.PSUBSW]: O.i16x8_sub_sat_s, [Op.PSUBUSB]: O.i8x16_sub_sat_u, [Op.PSUBUSW]: O.i16x8_sub_sat_u,
  [Op.PMULLW]: O.i16x8_mul, [Op.PMULLD]: O.i32x4_mul, [Op.PMADDWD]: O.i32x4_dot_i16x8_s,
  [Op.PAVGB]: O.i8x16_avgr_u, [Op.PAVGW]: O.i16x8_avgr_u,
  [Op.PMINUB]: O.i8x16_min_u, [Op.PMAXUB]: O.i8x16_max_u, [Op.PMINSW]: O.i16x8_min_s, [Op.PMAXSW]: O.i16x8_max_s,
  [Op.PMINSB]: O.i8x16_min_s, [Op.PMAXSB]: O.i8x16_max_s, [Op.PMINUW]: O.i16x8_min_u, [Op.PMAXUW]: O.i16x8_max_u,
  [Op.PMINSD]: O.i32x4_min_s, [Op.PMAXSD]: O.i32x4_max_s, [Op.PMINUD]: O.i32x4_min_u, [Op.PMAXUD]: O.i32x4_max_u,
  [Op.PCMPEQB]: O.i8x16_eq, [Op.PCMPEQW]: O.i16x8_eq, [Op.PCMPEQD]: O.i32x4_eq, [Op.PCMPEQQ]: O.i64x2_eq,
  [Op.PCMPGTB]: O.i8x16_gt_s, [Op.PCMPGTW]: O.i16x8_gt_s, [Op.PCMPGTD]: O.i32x4_gt_s, [Op.PCMPGTQ]: O.i64x2_gt_s,
  [Op.PACKSSWB]: O.i8x16_narrow_i16x8_s, [Op.PACKUSWB]: O.i8x16_narrow_i16x8_u,
  [Op.PACKSSDW]: O.i16x8_narrow_i32x4_s, [Op.PACKUSDW]: O.i16x8_narrow_i32x4_u,
};
const SIMD_UN: Record<number, number> = {
  [Op.SQRTPS]: O.f32x4_sqrt, [Op.SQRTPD]: O.f64x2_sqrt,
  [Op.PABSB]: O.i8x16_abs, [Op.PABSW]: O.i16x8_abs, [Op.PABSD]: O.i32x4_abs,
  [Op.CVTDQ2PS]: O.f32x4_convert_i32x4_s,
  [Op.CVTDQ2PD]: O.f64x2_convert_low_i32x4_s,
  [Op.CVTPS2PD]: O.f64x2_promote_low_f32x4,
  [Op.PMOVSXBW]: O.i16x8_extend_low_i8x16_s, [Op.PMOVZXBW]: O.i16x8_extend_low_i8x16_u,
  [Op.PMOVSXWD]: O.i32x4_extend_low_i16x8_s, [Op.PMOVZXWD]: O.i32x4_extend_low_i16x8_u,
  [Op.PMOVSXDQ]: O.i64x2_extend_low_i32x4_s, [Op.PMOVZXDQ]: O.i64x2_extend_low_i32x4_u,
};

// shuffle index tables. a = destination value (first operand, lanes 0..15), b = source (16..31)
function shufLanes(bytesPerLane: number, pick: (n: number) => number[]): number[] {
  // pick returns lane-indices (0..N-1 => a, N..2N-1 => b); expanded to byte indices
  const nlanes = 16 / bytesPerLane;
  const lanes = pick(nlanes);
  const out: number[] = [];
  for (const l of lanes) for (let k = 0; k < bytesPerLane; k++) out.push(l * bytesPerLane + k);
  return out;
}
const UNPCKL = (bpl: number) => shufLanes(bpl, (n) => Array.from({ length: n }, (_, i) => (i & 1 ? n + (i >> 1) : i >> 1)));
const UNPCKH = (bpl: number) => shufLanes(bpl, (n) => Array.from({ length: n }, (_, i) => (i & 1 ? n + n / 2 + (i >> 1) : n / 2 + (i >> 1))));

/** dst = shuffle(dst, src) */
function shuf2(g: Gen, ins: Insn, idx: number[], srcSize = 16) {
  g.getX(ins.a.r);
  ld(g, ins.b, srcSize);
  g.f.shuffle(idx);
  g.setX(ins.a.r);
}

/** Scalar float -> int conversion with x86 semantics: NaN / out-of-range give the "integer indefinite" value. */
function cvtSel(g: Gen, wide: boolean, srcF64: boolean, truncate: boolean) {
  const f = g.f;
  const t = srcF64 ? F64 : F32;
  const x = f.temp(t);
  const r = f.temp(wide ? I64 : I32);
  f.set(x);
  f.get(x);
  if (!truncate) f.op(srcF64 ? O.f64_nearest : O.f32_nearest);
  if (srcF64) f.op(wide ? O.i64_trunc_sat_f64_s : O.i32_trunc_sat_f64_s);
  else f.op(wide ? O.i64_trunc_sat_f32_s : O.i32_trunc_sat_f32_s);
  f.set(r);
  // bad = isnan(x) | x >= 2^31 (2^63)
  if (wide) f.i64(-0x8000000000000000n);
  else f.i32(-0x80000000);
  f.get(r);
  f.get(x).get(x).op(srcF64 ? O.f64_ne : O.f32_ne);
  f.get(x);
  const lim = wide ? 9223372036854775808 : 2147483648;
  if (srcF64) f.f64(lim).op(O.f64_ge);
  else f.f32(lim).op(O.f32_ge);
  f.op(O.i32_or);
  f.op(O.select);
  f.freeTemp(t, x);
  f.freeTemp(wide ? I64 : I32, r);
}

/** per-lane fix for packed float->int32: lanes that are NaN or >= 2^31 become 0x80000000. Stack: v128 floats -> v128 ints */
function cvtPackedF32(g: Gen, truncate: boolean) {
  const f = g.f;
  const x = f.temp(V128);
  f.set(x);
  f.get(x);
  if (!truncate) f.op(O.f32x4_nearest);
  f.op(O.i32x4_trunc_sat_f32x4_s);
  // result with fix: bitselect(indef, res, mask)
  const res = f.temp(V128);
  f.set(res);
  f.v128(splat32(0x80000000)).get(res);
  // mask = !(x < 2^31) as float compare: not-less-than is true for NaN and for x >= 2^31
  f.get(x).v128(splat32(0x4f000000)).op(O.f32x4_lt).op(O.v128_not);
  f.op(O.v128_bitselect); // (indef & mask) | (res & ~mask)
  f.freeTemp(V128, x);
  f.freeTemp(V128, res);
}

function setFlagsFromCompare(g: Gen, a: number, b: number, isF64: boolean) {
  // a, b: float locals. EFLAGS: unordered -> ZF=PF=CF=1; a<b -> CF; a==b -> ZF
  const f = g.f;
  const lt = isF64 ? O.f64_lt : O.f32_lt;
  const eq = isF64 ? O.f64_eq : O.f32_eq;
  const gt = isF64 ? O.f64_gt : O.f32_gt;
  const un = f.temp(I32);
  // unordered = !(a<b | a==b | a>b)
  f.get(a).get(b).op(lt).get(a).get(b).op(eq).op(O.i32_or).get(a).get(b).op(gt).op(O.i32_or).i32(1).op(O.i32_xor).set(un);
  // CF = a<b | un
  f.get(a).get(b).op(lt).get(un).op(O.i32_or);
  // PF = un << 2
  f.get(un).i32(2).op(O.i32_shl).op(O.i32_or);
  // ZF = (a==b | un) << 6
  f.get(a).get(b).op(eq).get(un).op(O.i32_or).i32(6).op(O.i32_shl).op(O.i32_or);
  g.setFlagsFromEflags();
  f.freeTemp(I32, un);
}

// scalar math helpers
function scalarF32(g: Gen, ins: Insn, op: (f: Gen["f"]) => void, unary = false) {
  const f = g.f;
  g.getX(ins.a.r);
  if (!unary) g.getX(ins.a.r), f.lane(O.f32x4_extract_lane, 0);
  ldF32(g, ins.b);
  op(f);
  f.lane(O.f32x4_replace_lane, 0);
  g.setX(ins.a.r);
}
function scalarF64(g: Gen, ins: Insn, op: (f: Gen["f"]) => void, unary = false) {
  const f = g.f;
  g.getX(ins.a.r);
  if (!unary) g.getX(ins.a.r), f.lane(O.f64x2_extract_lane, 0);
  ldF64(g, ins.b);
  op(f);
  f.lane(O.f64x2_replace_lane, 0);
  g.setX(ins.a.r);
}

/** x86 MIN/MAX (second operand returned on NaN / equal): result = a < b ? a : b (min) ; a > b ? a : b (max) */
function sMinMax(f: Gen["f"], t: number, isMax: boolean) {
  // stack: a b  (floats of type t)
  const a = f.temp(t), b = f.temp(t);
  f.set(b);
  f.set(a);
  f.get(a).get(b).get(a).get(b);
  if (t === F32) f.op(isMax ? O.f32_gt : O.f32_lt);
  else f.op(isMax ? O.f64_gt : O.f64_lt);
  f.op(O.select);
  f.freeTemp(t, a);
  f.freeTemp(t, b);
}

// CMPPS predicate on two v128 values on the stack (a, b): returns mask
function packedCmp(g: Gen, pred: number, isF64: boolean) {
  const f = g.f;
  const eq = isF64 ? O.f64x2_eq : O.f32x4_eq, lt = isF64 ? O.f64x2_lt : O.f32x4_lt, le = isF64 ? O.f64x2_le : O.f32x4_le, ne = isF64 ? O.f64x2_ne : O.f32x4_ne;
  switch (pred & 7) {
    case 0: f.op(eq); break;
    case 1: f.op(lt); break;
    case 2: f.op(le); break;
    case 3: case 7: {
      // unordered / ordered: (a==a) & (b==b)
      const a = f.temp(V128), b = f.temp(V128);
      f.set(b);
      f.set(a);
      f.get(a).get(a).op(eq).get(b).get(b).op(eq).op(O.v128_and);
      if ((pred & 7) === 3) f.op(O.v128_not);
      f.freeTemp(V128, a);
      f.freeTemp(V128, b);
      break;
    }
    case 4: f.op(ne); break;
    case 5: f.op(lt).op(O.v128_not); break;
    case 6: f.op(le).op(O.v128_not); break;
  }
}

/** 1/x or 1/sqrt(x) on the v128 at the top of the stack. Like the hardware estimate instructions, denormal inputs are treated as zero. */
function recip(g: Gen, isSqrt: boolean) {
  const f = g.f;
  const x = f.temp(V128);
  f.set(x);
  f.v128(splat32(0x3f800000));
  // dazMask: |x| < smallest normal -> replace with a zero of the same sign
  f.get(x).v128(splat32(0x80000000)).op(O.v128_and);
  f.get(x);
  f.get(x).op(O.f32x4_abs).v128(splat32(0x00800000)).op(O.f32x4_lt);
  f.op(O.v128_bitselect);
  if (isSqrt) f.op(O.f32x4_sqrt);
  f.op(O.f32x4_div);
  f.freeTemp(V128, x);
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
export function translateSSE(g: Gen, ins: Insn): boolean {
  const f = g.f;
  const op = ins.op;
  const a = ins.a, b = ins.b;

  const bin = SIMD_BIN[op];
  if (bin !== undefined) {
    g.getX(a.r);
    ld(g, b);
    f.op(bin);
    g.setX(a.r);
    return true;
  }
  const un = SIMD_UN[op];
  if (un !== undefined) {
    ld(g, b, b.k === K_MEM ? b.sz : 16);
    f.op(un);
    g.setX(a.r);
    return true;
  }

  switch (op) {
    // ---------------- moves ----------------
    case Op.MOVAPS: case Op.MOVAPD: case Op.MOVUPS: case Op.MOVUPD: case Op.MOVDQA: case Op.MOVDQU: case Op.LDDQU: case Op.MOVNTDQA:
      if (a.k === K_XMM) {
        ld(g, b);
        g.setX(a.r);
      } else storeVec(g, a, b.r, 16);
      return true;
    case Op.MOVNTPS: case Op.MOVNTPD: case Op.MOVNTDQ:
      storeVec(g, a, b.r, 16);
      return true;
    case Op.MOVSS: case Op.MOVSD_X: {
      const w = op === Op.MOVSS ? 4 : 8;
      if (a.k === K_XMM) {
        if (b.k === K_XMM) {
          // merge low element
          g.getX(a.r);
          g.getX(b.r);
          if (w === 4) f.shuffle([16, 17, 18, 19, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
          else f.shuffle([16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11, 12, 13, 14, 15]);
          g.setX(a.r);
        } else {
          ld(g, b, w); // memory load zeroes the upper elements
          g.setX(a.r);
        }
      } else storeVec(g, a, b.r, w);
      return true;
    }
    case Op.MOVD: case Op.MOVQ: {
      // MOVD/MOVQ xmm<-gpr/mem, gpr/mem<-xmm, and MOVQ xmm<-xmm/m64, m64<-xmm
      if (a.k === K_XMM) {
        if (b.k === K_REG) {
          f.v128(ZERO);
          g.readReg(b.r, b.sz);
          f.lane(b.sz === 8 ? O.i64x2_replace_lane : O.i32x4_replace_lane, 0);
          g.setX(a.r);
        } else if (b.k === K_XMM) {
          // MOVQ xmm, xmm: zero upper
          g.getX(b.r);
          f.v128(ZERO).shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
          g.setX(a.r);
        } else {
          ld(g, b, op === Op.MOVD && b.sz === 4 ? 4 : 8);
          g.setX(a.r);
        }
      } else if (a.k === K_REG) {
        g.getX(b.r);
        if (a.sz === 8) f.lane(O.i64x2_extract_lane, 0);
        else f.lane(O.i32x4_extract_lane, 0);
        g.writeReg(a.r, a.sz);
      } else {
        storeVec(g, a, b.r, op === Op.MOVD && a.sz === 4 ? 4 : 8);
      }
      return true;
    }
    case Op.MOVLPS: case Op.MOVLPD:
      if (a.k === K_XMM) {
        // load 64 bits into the low half, keep the high half
        const p = place(g, b, 8);
        f.get(p.ea);
        g.getX(a.r);
        f.memLane(O.v128_load64_lane, p.off, 0, 0);
        g.setX(a.r);
        freePlace(g, p);
      } else storeVec(g, a, b.r, 8, 0);
      return true;
    case Op.MOVHPS: case Op.MOVHPD:
      if (a.k === K_XMM) {
        const p = place(g, b, 8);
        f.get(p.ea);
        g.getX(a.r);
        f.memLane(O.v128_load64_lane, p.off, 0, 1);
        g.setX(a.r);
        freePlace(g, p);
      } else storeVec(g, a, b.r, 8, 1);
      return true;
    case Op.MOVHLPS:
      g.getX(a.r);
      g.getX(b.r);
      f.shuffle([24, 25, 26, 27, 28, 29, 30, 31, 8, 9, 10, 11, 12, 13, 14, 15]);
      g.setX(a.r);
      return true;
    case Op.MOVLHPS:
      g.getX(a.r);
      g.getX(b.r);
      f.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
      g.setX(a.r);
      return true;
    case Op.MOVDDUP:
      ld(g, b, 8);
      g.f.v128(ZERO);
      f.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
      g.setX(a.r);
      return true;
    case Op.MOVSLDUP:
      ld(g, b);
      f.v128(ZERO).shuffle([0, 1, 2, 3, 0, 1, 2, 3, 8, 9, 10, 11, 8, 9, 10, 11]);
      g.setX(a.r);
      return true;
    case Op.MOVSHDUP:
      ld(g, b);
      f.v128(ZERO).shuffle([4, 5, 6, 7, 4, 5, 6, 7, 12, 13, 14, 15, 12, 13, 14, 15]);
      g.setX(a.r);
      return true;
    case Op.MOVMSKPS: g.getX(b.r); f.op(O.i32x4_bitmask); g.writeReg(a.r, 4); return true;
    case Op.MOVMSKPD: g.getX(b.r); f.op(O.i64x2_bitmask); g.writeReg(a.r, 4); return true;
    case Op.PMOVMSKB: g.getX(b.r); f.op(O.i8x16_bitmask); g.writeReg(a.r, 4); return true;

    // ---------------- float arithmetic needing special handling ----------------
    case Op.MINPS: case Op.MAXPS: case Op.MINPD: case Op.MAXPD: {
      // x86 min(a,b)=a<b?a:b == wasm pmin(b,a)
      ld(g, b);
      g.getX(a.r);
      const isMax = op === Op.MAXPS || op === Op.MAXPD;
      const dbl = op === Op.MINPD || op === Op.MAXPD;
      f.op(dbl ? (isMax ? O.f64x2_pmax : O.f64x2_pmin) : (isMax ? O.f32x4_pmax : O.f32x4_pmin));
      g.setX(a.r);
      return true;
    }
    case Op.ADDSS: scalarF32(g, ins, (f) => f.op(O.f32_add)); return true;
    case Op.SUBSS: scalarF32(g, ins, (f) => f.op(O.f32_sub)); return true;
    case Op.MULSS: scalarF32(g, ins, (f) => f.op(O.f32_mul)); return true;
    case Op.DIVSS: scalarF32(g, ins, (f) => f.op(O.f32_div)); return true;
    case Op.SQRTSS: scalarF32(g, ins, (f) => f.op(O.f32_sqrt), true); return true;
    case Op.MINSS: scalarF32(g, ins, (f) => sMinMax(f, F32, false)); return true;
    case Op.MAXSS: scalarF32(g, ins, (f) => sMinMax(f, F32, true)); return true;
    case Op.ADDSD: scalarF64(g, ins, (f) => f.op(O.f64_add)); return true;
    case Op.SUBSD: scalarF64(g, ins, (f) => f.op(O.f64_sub)); return true;
    case Op.MULSD: scalarF64(g, ins, (f) => f.op(O.f64_mul)); return true;
    case Op.DIVSD: scalarF64(g, ins, (f) => f.op(O.f64_div)); return true;
    case Op.SQRTSD: scalarF64(g, ins, (f) => f.op(O.f64_sqrt), true); return true;
    case Op.MINSD: scalarF64(g, ins, (f) => sMinMax(f, F64, false)); return true;
    case Op.MAXSD: scalarF64(g, ins, (f) => sMinMax(f, F64, true)); return true;
    case Op.RCPPS: case Op.RSQRTPS:
      ld(g, b);
      recip(g, op === Op.RSQRTPS);
      g.setX(a.r);
      return true;
    case Op.RCPSS: case Op.RSQRTSS:
      g.getX(a.r);
      ld(g, b, 4);
      recip(g, op === Op.RSQRTSS);
      // keep only the low element of the result
      f.shuffle([16, 17, 18, 19, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      g.setX(a.r);
      return true;

    // ---------------- logic with complement ----------------
    case Op.ANDNPS: case Op.ANDNPD: case Op.PANDN:
      ld(g, b);
      g.getX(a.r);
      f.op(O.v128_andnot);
      g.setX(a.r);
      return true;

    // ---------------- compares ----------------
    case Op.CMPPS: case Op.CMPPD:
      g.getX(a.r);
      ld(g, b);
      packedCmp(g, ins.c.imm, op === Op.CMPPD);
      g.setX(a.r);
      return true;
    case Op.CMPSS: case Op.CMPSD_X: {
      const dbl = op === Op.CMPSD_X;
      // compare the low element as a packed compare, then merge only the low element of the mask
      g.getX(a.r);
      g.getX(a.r);
      ld(g, b, dbl ? 8 : 4);
      packedCmp(g, ins.c.imm, dbl);
      if (dbl) f.shuffle([16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11, 12, 13, 14, 15]);
      else f.shuffle([16, 17, 18, 19, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      g.setX(a.r);
      return true;
    }
    case Op.COMISS: case Op.UCOMISS: case Op.COMISD: case Op.UCOMISD: {
      if (g.liveAfter === 0) return true;
      const dbl = op === Op.COMISD || op === Op.UCOMISD;
      const x = f.temp(dbl ? F64 : F32), y = f.temp(dbl ? F64 : F32);
      if (dbl) ldF64(g, a), f.set(x), ldF64(g, b), f.set(y);
      else ldF32(g, a), f.set(x), ldF32(g, b), f.set(y);
      setFlagsFromCompare(g, x, y, dbl);
      f.freeTemp(dbl ? F64 : F32, x);
      f.freeTemp(dbl ? F64 : F32, y);
      return true;
    }
    case Op.PTEST: {
      if (g.liveAfter === 0) return true;
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      // ZF = (x & y) == 0 ; CF = (~x & y) == 0
      f.get(x).get(y).op(O.v128_and).op(O.v128_any_true).i32(1).op(O.i32_xor).i32(6).op(O.i32_shl);
      f.get(y).get(x).op(O.v128_andnot).op(O.v128_any_true).i32(1).op(O.i32_xor).op(O.i32_or);
      g.setFlagsFromEflags();
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }

    // ---------------- conversions ----------------
    case Op.CVTSI2SS: case Op.CVTSI2SD: {
      const dbl = op === Op.CVTSI2SD;
      g.getX(a.r);
      if (b.k === K_REG) g.readReg(b.r, b.sz);
      else {
        const off = g.emitEA(b);
        f.mem(b.sz === 8 ? O.i64_load : O.i32_load, off);
      }
      if (dbl) f.op(b.sz === 8 ? O.f64_convert_i64_s : O.f64_convert_i32_s).lane(O.f64x2_replace_lane, 0);
      else f.op(b.sz === 8 ? O.f32_convert_i64_s : O.f32_convert_i32_s).lane(O.f32x4_replace_lane, 0);
      g.setX(a.r);
      return true;
    }
    case Op.CVTTSS2SI: case Op.CVTSS2SI: case Op.CVTTSD2SI: case Op.CVTSD2SI: {
      const dbl = op === Op.CVTTSD2SI || op === Op.CVTSD2SI;
      const trunc = op === Op.CVTTSS2SI || op === Op.CVTTSD2SI;
      if (dbl) ldF64(g, b);
      else ldF32(g, b);
      cvtSel(g, a.sz === 8, dbl, trunc);
      g.writeReg(a.r, a.sz);
      return true;
    }
    case Op.CVTSS2SD:
      g.getX(a.r);
      ldF32(g, b);
      f.op(O.f64_promote_f32).lane(O.f64x2_replace_lane, 0);
      g.setX(a.r);
      return true;
    case Op.CVTSD2SS:
      g.getX(a.r);
      ldF64(g, b);
      f.op(O.f32_demote_f64).lane(O.f32x4_replace_lane, 0);
      g.setX(a.r);
      return true;
    case Op.CVTPD2PS:
      ld(g, b);
      f.op(O.f32x4_demote_f64x2_zero);
      g.setX(a.r);
      return true;
    case Op.CVTPS2DQ: ld(g, b); cvtPackedF32(g, false); g.setX(a.r); return true;
    case Op.CVTTPS2DQ: ld(g, b); cvtPackedF32(g, true); g.setX(a.r); return true;
    case Op.CVTPD2DQ: case Op.CVTTPD2DQ: {
      // two doubles -> two int32 (upper two lanes zero), indefinite on overflow
      ld(g, b);
      const x = f.temp(V128);
      f.set(x);
      f.get(x);
      if (op === Op.CVTPD2DQ) f.op(O.f64x2_nearest);
      f.op(O.i32x4_trunc_sat_f64x2_s_zero);
      const r = f.temp(V128);
      f.set(r);
      f.v128(splat32(0x80000000)).get(r);
      // mask lanes: !(x < 2^31) -> as 64-bit mask, then narrow to the low two 32-bit lanes
      f.get(x).v128(new Uint8Array(new Float64Array([2147483648, 2147483648]).buffer)).op(O.f64x2_lt).op(O.v128_not);
      f.v128(ZERO).shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 16, 17, 18, 19]);
      f.op(O.v128_bitselect);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, r);
      return true;
    }

    // ---------------- shuffles and unpacks ----------------
    case Op.SHUFPS: {
      const imm = ins.c.imm;
      const lane = (i: number, fromB: boolean) => [0, 1, 2, 3].map((k) => (fromB ? 16 : 0) + i * 4 + k);
      shuf2(g, ins, [...lane(imm & 3, false), ...lane((imm >> 2) & 3, false), ...lane((imm >> 4) & 3, true), ...lane((imm >> 6) & 3, true)]);
      return true;
    }
    case Op.SHUFPD: {
      const imm = ins.c.imm;
      const q = (i: number, fromB: boolean) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (fromB ? 16 : 0) + i * 8 + k);
      shuf2(g, ins, [...q(imm & 1, false), ...q((imm >> 1) & 1, true)]);
      return true;
    }
    case Op.UNPCKLPS: case Op.PUNPCKLDQ: shuf2(g, ins, UNPCKL(4)); return true;
    case Op.UNPCKHPS: case Op.PUNPCKHDQ: shuf2(g, ins, UNPCKH(4)); return true;
    case Op.UNPCKLPD: case Op.PUNPCKLQDQ: shuf2(g, ins, UNPCKL(8)); return true;
    case Op.UNPCKHPD: case Op.PUNPCKHQDQ: shuf2(g, ins, UNPCKH(8)); return true;
    case Op.PUNPCKLBW: shuf2(g, ins, UNPCKL(1)); return true;
    case Op.PUNPCKHBW: shuf2(g, ins, UNPCKH(1)); return true;
    case Op.PUNPCKLWD: shuf2(g, ins, UNPCKL(2)); return true;
    case Op.PUNPCKHWD: shuf2(g, ins, UNPCKH(2)); return true;
    case Op.PSHUFD: {
      const imm = ins.c.imm;
      ld(g, b);
      f.v128(ZERO);
      const idx: number[] = [];
      for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) idx.push(((imm >> (i * 2)) & 3) * 4 + k);
      f.shuffle(idx);
      g.setX(a.r);
      return true;
    }
    case Op.PSHUFLW: case Op.PSHUFHW: {
      const imm = ins.c.imm;
      ld(g, b);
      f.v128(ZERO);
      const idx: number[] = [];
      const hi = op === Op.PSHUFHW;
      for (let i = 0; i < 8; i++) {
        let lane = i;
        if (hi ? i >= 4 : i < 4) lane = (hi ? 4 : 0) + ((imm >> ((i & 3) * 2)) & 3);
        idx.push(lane * 2, lane * 2 + 1);
      }
      f.shuffle(idx);
      g.setX(a.r);
      return true;
    }
    case Op.PSHUFB: {
      // idx' = idx & 0x8f ; swizzle yields 0 for idx >= 16
      g.getX(a.r);
      ld(g, b);
      f.v128(new Uint8Array(16).fill(0x8f)).op(O.v128_and);
      f.op(O.i8x16_swizzle);
      g.setX(a.r);
      return true;
    }
    case Op.PALIGNR: {
      const n = ins.c.imm;
      // result = ((dst:src) >> n bytes); src (b) = low half
      if (n >= 32) {
        f.v128(ZERO);
      } else {
        ld(g, b); // low
        g.getX(a.r); // high
        const idx = Array.from({ length: 16 }, (_, i) => n + i);
        if (n >= 16) {
          // only dst and zero participate
          f.op(O.drop);
          f.op(O.drop);
          g.getX(a.r);
          f.v128(ZERO);
          f.shuffle(idx.map((v) => v - 16));
        } else f.shuffle(idx);
      }
      g.setX(a.r);
      return true;
    }
    case Op.PSLLDQ: case Op.PSRLDQ: {
      const n = Math.min(ins.b.imm, 16);
      g.getX(a.r);
      f.v128(ZERO);
      const idx = op === Op.PSLLDQ ? Array.from({ length: 16 }, (_, i) => (i - n >= 0 ? i - n : 16)) : Array.from({ length: 16 }, (_, i) => (i + n < 16 ? i + n : 16));
      f.shuffle(idx);
      g.setX(a.r);
      return true;
    }

    // ---------------- shifts ----------------
    case Op.PSLLW_I: case Op.PSRLW_I: case Op.PSRAW_I: case Op.PSLLD_I: case Op.PSRLD_I: case Op.PSRAD_I: case Op.PSLLQ_I: case Op.PSRLQ_I:
      shiftImm(g, ins);
      return true;
    case Op.PSLLW: case Op.PSRLW: case Op.PSRAW: case Op.PSLLD: case Op.PSRLD: case Op.PSRAD: case Op.PSLLQ: case Op.PSRLQ:
      shiftReg(g, ins);
      return true;

    // ---------------- integer special ops ----------------
    case Op.PMULHW: case Op.PMULHUW: {
      const s = op === Op.PMULHW;
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      f.get(x).get(y).op(s ? O.i32x4_extmul_low_i16x8_s : O.i32x4_extmul_low_i16x8_u);
      f.get(x).get(y).op(s ? O.i32x4_extmul_high_i16x8_s : O.i32x4_extmul_high_i16x8_u);
      f.shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }
    case Op.PMULUDQ: case Op.PMULDQ: {
      // multiply lanes 0 and 2
      const sgn = op === Op.PMULDQ;
      g.getX(a.r);
      f.v128(ZERO).shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 16, 17, 18, 19]);
      ld(g, b);
      f.v128(ZERO).shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 16, 17, 18, 19]);
      f.op(sgn ? O.i64x2_extmul_low_i32x4_s : O.i64x2_extmul_low_i32x4_u);
      g.setX(a.r);
      return true;
    }
    case Op.PSADBW: {
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      // |x-y| = max_u - min_u
      f.get(x).get(y).op(O.i8x16_max_u).get(x).get(y).op(O.i8x16_min_u).op(O.i8x16_sub);
      f.op(O.i16x8_extadd_pairwise_i8x16_u).op(O.i32x4_extadd_pairwise_i16x8_u);
      const s = f.temp(V128);
      f.set(s);
      f.get(s).v128(ZERO).shuffle([0, 1, 2, 3, 16, 16, 16, 16, 8, 9, 10, 11, 16, 16, 16, 16]);
      f.get(s).v128(ZERO).shuffle([4, 5, 6, 7, 16, 16, 16, 16, 12, 13, 14, 15, 16, 16, 16, 16]);
      f.op(O.i64x2_add);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      f.freeTemp(V128, s);
      return true;
    }
    case Op.PMADDUBSW: {
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      // products (u8 * s8) as i16 lanes, then saturating add of adjacent pairs
      const prod = (lo: boolean) => {
        f.get(x).op(lo ? O.i16x8_extend_low_i8x16_u : O.i16x8_extend_high_i8x16_u);
        f.get(y).op(lo ? O.i16x8_extend_low_i8x16_s : O.i16x8_extend_high_i8x16_s);
        f.op(O.i16x8_mul);
      };
      prod(true);
      prod(false);
      const hi = f.temp(V128), lo = f.temp(V128);
      f.set(hi);
      f.set(lo);
      // evens: lo0 lo2 lo4 lo6 hi0 hi2 hi4 hi6 ; odds likewise
      f.get(lo).get(hi).shuffle([0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 28, 29]);
      f.get(lo).get(hi).shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
      f.op(O.i16x8_add_sat_s);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      f.freeTemp(V128, hi);
      f.freeTemp(V128, lo);
      return true;
    }
    case Op.PMULHRSW: {
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      const min16 = new Uint8Array(16).map((_, i) => (i & 1 ? 0x80 : 0));
      f.get(x).get(y).op(O.i16x8_q15mulr_sat_s);
      // x86 does not saturate 0x8000 * 0x8000: it yields 0x8000 (wasm gives 0x7fff)
      f.get(x).v128(min16).op(O.i16x8_eq).get(y).v128(min16).op(O.i16x8_eq).op(O.v128_and);
      f.op(O.v128_xor);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }
    case Op.PHADDW: case Op.PHADDD: case Op.PHADDSW: case Op.PHSUBW: case Op.PHSUBD: case Op.PHSUBSW: {
      const w = op === Op.PHADDD || op === Op.PHSUBD;
      const sub = op === Op.PHSUBW || op === Op.PHSUBD || op === Op.PHSUBSW;
      const sat = op === Op.PHADDSW || op === Op.PHSUBSW;
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      const esz = w ? 4 : 2;
      const ev: number[] = [], od: number[] = [];
      for (let src = 0; src < 2; src++) {
        for (let e = 0; e < 16 / esz; e += 2) {
          for (let k = 0; k < esz; k++) {
            ev.push(src * 16 + e * esz + k);
            od.push(src * 16 + (e + 1) * esz + k);
          }
        }
      }
      f.get(x).get(y).shuffle(ev);
      f.get(x).get(y).shuffle(od);
      if (sub) f.op(w ? O.i32x4_sub : sat ? O.i16x8_sub_sat_s : O.i16x8_sub);
      else f.op(w ? O.i32x4_add : sat ? O.i16x8_add_sat_s : O.i16x8_add);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }
    case Op.PSIGNB: case Op.PSIGNW: case Op.PSIGND: {
      const o = op === Op.PSIGNB ? { neg: O.i8x16_neg, gt: O.i8x16_gt_s, lt: O.i8x16_lt_s } : op === Op.PSIGNW ? { neg: O.i16x8_neg, gt: O.i16x8_gt_s, lt: O.i16x8_lt_s } : { neg: O.i32x4_neg, gt: O.i32x4_gt_s, lt: O.i32x4_lt_s };
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      // result = (x & (y>0)) | (-x & (y<0))
      f.get(x).get(y).v128(ZERO).op(o.gt).op(O.v128_and);
      f.get(x).op(o.neg).get(y).v128(ZERO).op(o.lt).op(O.v128_and);
      f.op(O.v128_or);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }

    // ---------------- float horizontal ----------------
    case Op.HADDPS: case Op.HSUBPS: {
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      f.get(x).get(y).shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 24, 25, 26, 27]);
      f.get(x).get(y).shuffle([4, 5, 6, 7, 12, 13, 14, 15, 20, 21, 22, 23, 28, 29, 30, 31]);
      f.op(op === Op.HADDPS ? O.f32x4_add : O.f32x4_sub);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }
    case Op.HADDPD: case Op.HSUBPD: {
      const x = f.temp(V128), y = f.temp(V128);
      g.getX(a.r);
      f.set(x);
      ld(g, b);
      f.set(y);
      f.get(x).get(y).shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
      f.get(x).get(y).shuffle([8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31]);
      f.op(op === Op.HADDPD ? O.f64x2_add : O.f64x2_sub);
      g.setX(a.r);
      f.freeTemp(V128, x);
      f.freeTemp(V128, y);
      return true;
    }
    case Op.ADDSUBPS: case Op.ADDSUBPD: {
      g.getX(a.r);
      ld(g, b);
      if (op === Op.ADDSUBPS) f.v128(constLanes32(0x80000000, 0, 0x80000000, 0)).op(O.v128_xor).op(O.f32x4_add);
      else f.v128(constLanes32(0, 0x80000000, 0, 0)).op(O.v128_xor).op(O.f64x2_add);
      g.setX(a.r);
      return true;
    }

    // ---------------- SSE4.1 ----------------
    case Op.PBLENDVB: case Op.BLENDVPS: case Op.BLENDVPD: {
      // mask = sign of each element of xmm0
      const sh = op === Op.PBLENDVB ? [O.i8x16_shr_s, 7] : op === Op.BLENDVPS ? [O.i32x4_shr_s, 31] : [O.i64x2_shr_s, 63];
      ld(g, b); // when mask set pick source
      g.getX(a.r);
      g.getX(0);
      f.i32(sh[1]).op(sh[0]);
      f.op(O.v128_bitselect);
      g.setX(a.r);
      return true;
    }
    case Op.PBLENDW: {
      const imm = ins.c.imm;
      g.getX(a.r);
      ld(g, b);
      const idx: number[] = [];
      for (let i = 0; i < 8; i++) idx.push((imm >> i) & 1 ? 16 + i * 2 : i * 2, (imm >> i) & 1 ? 17 + i * 2 : i * 2 + 1);
      f.shuffle(idx);
      g.setX(a.r);
      return true;
    }
    case Op.BLENDPS: case Op.BLENDPD: {
      const imm = ins.c.imm;
      const esz = op === Op.BLENDPS ? 4 : 8;
      const n = 16 / esz;
      g.getX(a.r);
      ld(g, b);
      const idx: number[] = [];
      for (let i = 0; i < n; i++) for (let k = 0; k < esz; k++) idx.push(((imm >> i) & 1 ? 16 : 0) + i * esz + k);
      f.shuffle(idx);
      g.setX(a.r);
      return true;
    }
    case Op.PMOVSXBD: case Op.PMOVZXBD: {
      const s = op === Op.PMOVSXBD;
      ld(g, b, 4);
      f.op(s ? O.i16x8_extend_low_i8x16_s : O.i16x8_extend_low_i8x16_u).op(s ? O.i32x4_extend_low_i16x8_s : O.i32x4_extend_low_i16x8_u);
      g.setX(a.r);
      return true;
    }
    case Op.PMOVSXBQ: case Op.PMOVZXBQ: {
      const s = op === Op.PMOVSXBQ;
      ld(g, b, 2);
      f.op(s ? O.i16x8_extend_low_i8x16_s : O.i16x8_extend_low_i8x16_u).op(s ? O.i32x4_extend_low_i16x8_s : O.i32x4_extend_low_i16x8_u).op(s ? O.i64x2_extend_low_i32x4_s : O.i64x2_extend_low_i32x4_u);
      g.setX(a.r);
      return true;
    }
    case Op.PMOVSXWQ: case Op.PMOVZXWQ: {
      const s = op === Op.PMOVSXWQ;
      ld(g, b, 4);
      f.op(s ? O.i32x4_extend_low_i16x8_s : O.i32x4_extend_low_i16x8_u).op(s ? O.i64x2_extend_low_i32x4_s : O.i64x2_extend_low_i32x4_u);
      g.setX(a.r);
      return true;
    }
    case Op.ROUNDPS: case Op.ROUNDPD: case Op.ROUNDSS: case Op.ROUNDSD: {
      const mode = (ins.c.imm & 4) ? 0 : ins.c.imm & 3;
      const scalar = op === Op.ROUNDSS || op === Op.ROUNDSD;
      const dbl = op === Op.ROUNDPD || op === Op.ROUNDSD;
      if (!scalar) {
        ld(g, b);
        f.op(dbl ? [O.f64x2_nearest, O.f64x2_floor, O.f64x2_ceil, O.f64x2_trunc][mode] : [O.f32x4_nearest, O.f32x4_floor, O.f32x4_ceil, O.f32x4_trunc][mode]);
        g.setX(a.r);
      } else if (dbl) {
        g.getX(a.r);
        ldF64(g, b);
        f.op([O.f64_nearest, O.f64_floor, O.f64_ceil, O.f64_trunc][mode]).lane(O.f64x2_replace_lane, 0);
        g.setX(a.r);
      } else {
        g.getX(a.r);
        ldF32(g, b);
        f.op([O.f32_nearest, O.f32_floor, O.f32_ceil, O.f32_trunc][mode]).lane(O.f32x4_replace_lane, 0);
        g.setX(a.r);
      }
      return true;
    }
    case Op.DPPS: {
      const imm = ins.c.imm;
      const x = f.temp(V128);
      g.getX(a.r);
      ld(g, b);
      f.op(O.f32x4_mul);
      f.v128(constLanes32(imm & 0x10 ? ~0 : 0, imm & 0x20 ? ~0 : 0, imm & 0x40 ? ~0 : 0, imm & 0x80 ? ~0 : 0)).op(O.v128_and);
      f.set(x);
      const e = (i: number) => { f.get(x).lane(O.f32x4_extract_lane, i); };
      e(0); e(1); f.op(O.f32_add);
      e(2); e(3); f.op(O.f32_add);
      f.op(O.f32_add).op(O.f32x4_splat);
      f.v128(constLanes32(imm & 1 ? ~0 : 0, imm & 2 ? ~0 : 0, imm & 4 ? ~0 : 0, imm & 8 ? ~0 : 0)).op(O.v128_and);
      g.setX(a.r);
      f.freeTemp(V128, x);
      return true;
    }
    case Op.INSERTPS: {
      const imm = ins.c.imm;
      const cd = (imm >> 4) & 3, zmask = imm & 15;
      let cs = (imm >> 6) & 3;
      g.getX(a.r);
      if (b.k === K_XMM) {
        g.getX(b.r);
        f.lane(O.f32x4_extract_lane, cs);
      } else {
        const off = g.emitEA(b);
        f.mem(O.f32_load, off);
      }
      f.lane(O.f32x4_replace_lane, cd);
      f.v128(constLanes32(zmask & 1 ? 0 : ~0, zmask & 2 ? 0 : ~0, zmask & 4 ? 0 : ~0, zmask & 8 ? 0 : ~0)).op(O.v128_and);
      g.setX(a.r);
      return true;
    }
    case Op.PHMINPOSUW:
      return false;

    // ---------------- extract / insert ----------------
    case Op.PEXTRW: case Op.PEXTRB: case Op.PEXTRD: case Op.PEXTRQ: case Op.EXTRACTPS: {
      const lane = ins.c.imm;
      const x = b;
      const w = op === Op.PEXTRB ? 1 : op === Op.PEXTRW ? 2 : op === Op.PEXTRQ ? 8 : 4;
      const lanes = 16 / w;
      const ln = lane & (lanes - 1);
      const emitVal = () => {
        g.getX(x.r);
        if (w === 1) f.lane(O.i8x16_extract_lane_u, ln);
        else if (w === 2) f.lane(O.i16x8_extract_lane_u, ln);
        else if (w === 4) f.lane(O.i32x4_extract_lane, ln);
        else f.lane(O.i64x2_extract_lane, ln);
      };
      if (a.k === K_REG) {
        emitVal();
        g.writeReg(a.r, w === 8 ? 8 : 4);
      } else {
        storeTo(g, a, w, () => emitVal());
      }
      return true;
    }
    case Op.PINSRW: case Op.PINSRB: case Op.PINSRD: case Op.PINSRQ: {
      const lane = ins.c.imm;
      const w = op === Op.PINSRB ? 1 : op === Op.PINSRW ? 2 : op === Op.PINSRQ ? 8 : 4;
      const ln = lane & (16 / w - 1);
      g.getX(a.r);
      if (b.k === K_REG) g.readReg(b.r, w === 8 ? 8 : 4);
      else {
        const off = g.emitEA(b);
        f.mem(w === 1 ? O.i32_load8_u : w === 2 ? O.i32_load16_u : w === 4 ? O.i32_load : O.i64_load, off);
      }
      if (w === 1) f.lane(O.i8x16_replace_lane, ln);
      else if (w === 2) f.lane(O.i16x8_replace_lane, ln);
      else if (w === 4) f.lane(O.i32x4_replace_lane, ln);
      else f.lane(O.i64x2_replace_lane, ln);
      g.setX(a.r);
      return true;
    }

    // ---------------- control / state ----------------
    case Op.LDMXCSR: {
      const off = g.emitEA(a);
      const t = f.temp(I32);
      f.mem(O.i32_load, off).set(t);
      f.i32(0).get(t).mem(O.i32_store, L.STATE + L.S_MXCSR, 2);
      f.freeTemp(I32, t);
      return true;
    }
    case Op.STMXCSR:
      storeTo(g, a, 4, () => f.i32(0).mem(O.i32_load, L.STATE + L.S_MXCSR, 2));
      return true;
  }
  return false;
}

function shiftImm(g: Gen, ins: Insn) {
  const f = g.f;
  const a = ins.a;
  const imm = ins.b.imm & 0xff;
  const op = ins.op;
  const tab: Record<number, [number, number, number]> = {
    // [wasm op, bits, kind(0 sll,1 srl,2 sra)]
    [Op.PSLLW_I]: [O.i16x8_shl, 16, 0], [Op.PSRLW_I]: [O.i16x8_shr_u, 16, 1], [Op.PSRAW_I]: [O.i16x8_shr_s, 16, 2],
    [Op.PSLLD_I]: [O.i32x4_shl, 32, 0], [Op.PSRLD_I]: [O.i32x4_shr_u, 32, 1], [Op.PSRAD_I]: [O.i32x4_shr_s, 32, 2],
    [Op.PSLLQ_I]: [O.i64x2_shl, 64, 0], [Op.PSRLQ_I]: [O.i64x2_shr_u, 64, 1],
  };
  const [wop, bits, kind] = tab[op];
  g.getX(a.r);
  if (imm >= bits) {
    if (kind === 2) f.i32(bits - 1).op(wop);
    else {
      f.op(O.drop);
      f.v128(ZERO);
    }
  } else f.i32(imm).op(wop);
  g.setX(a.r);
}

function shiftReg(g: Gen, ins: Insn) {
  const f = g.f;
  const a = ins.a, b = ins.b;
  const op = ins.op;
  const tab: Record<number, [number, number, number]> = {
    [Op.PSLLW]: [O.i16x8_shl, 16, 0], [Op.PSRLW]: [O.i16x8_shr_u, 16, 1], [Op.PSRAW]: [O.i16x8_shr_s, 16, 2],
    [Op.PSLLD]: [O.i32x4_shl, 32, 0], [Op.PSRLD]: [O.i32x4_shr_u, 32, 1], [Op.PSRAD]: [O.i32x4_shr_s, 32, 2],
    [Op.PSLLQ]: [O.i64x2_shl, 64, 0], [Op.PSRLQ]: [O.i64x2_shr_u, 64, 1],
  };
  const [wop, bits, kind] = tab[op];
  const c = f.temp(I64);
  ldI64(g, b);
  f.set(c);
  g.getX(a.r);
  if (kind === 2) {
    // arithmetic right shift: counts >= bits behave like bits-1
    f.i64(bits - 1).get(c).get(c).i64(bits - 1).op(O.i64_gt_u).op(O.select).op(O.i32_wrap_i64).op(wop);
  } else {
    // logical shifts: counts >= bits give zero
    f.get(c).op(O.i32_wrap_i64).op(wop);
    f.v128(ZERO).get(c).i64(bits - 1).op(O.i64_le_u).op(O.select);
  }
  g.setX(a.r);
  f.freeTemp(I64, c);
}

export { K_IMM, K_REG };
