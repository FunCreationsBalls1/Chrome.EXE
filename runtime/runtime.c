// Runtime helpers called from JIT-generated WebAssembly. Built with clang --target=wasm32 (see scripts/build-runtime.mjs).
// Operates on the shared guest memory (imported); the CPU state lives at a fixed address.
#include "layout.h"

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long s64;
typedef int s32;
typedef short s16;
typedef signed char s8;

#define EXPORT __attribute__((used, visibility("default")))

#define ST8(off)  (*(volatile u8 *)(STATE_BASE + (off)))
#define ST32(off) (*(volatile u32 *)(STATE_BASE + (off)))
#define ST64(off) (*(volatile u64 *)(STATE_BASE + (off)))

static inline u64 szmask(u32 szl) { return szl == 3 ? ~0ull : ((1ull << (8u << szl)) - 1); }

static inline u32 parity8(u32 v) {
  v &= 0xff;
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return (~v) & 1; // PF=1 when even number of set bits
}

EXPORT u32 cc_getflags(void) {
  u32 op = ST32(S_CC_OP);
  u32 kind = op >> 2, szl = op & 3;
  u32 bits = 8u << szl;
  u64 m = szmask(szl);
  u64 msb = 1ull << (bits - 1);
  u64 dst = ST64(S_CC_DST) & m, a = ST64(S_CC_SRC1) & m, b = ST64(S_CC_SRC2) & m;
  u32 cf = 0, of = 0, af = 0;
  switch (kind) {
    case CC_EFLAGS: return (u32)ST64(S_CC_SRC1) & F_ARITH;
    case CC_ADD:
      cf = (((a & b) | ((a | b) & ~dst)) & msb) != 0;
      of = (((~(a ^ b)) & (a ^ dst)) & msb) != 0;
      af = ((a ^ b ^ dst) & 0x10) != 0;
      break;
    case CC_SUB:
      cf = (((~a & b) | ((~a | b) & dst)) & msb) != 0;
      of = (((a ^ b) & (a ^ dst)) & msb) != 0;
      af = ((a ^ b ^ dst) & 0x10) != 0;
      break;
    case CC_LOGIC: break;
    case CC_INC:
      cf = (u32)(ST64(S_CC_AUX) & 1);
      of = dst == msb;
      af = ((dst ^ (dst - 1) ^ 1) & 0x10) != 0;
      break;
    case CC_DEC:
      cf = (u32)(ST64(S_CC_AUX) & 1);
      of = dst == msb - 1;
      af = ((dst ^ (dst + 1) ^ 1) & 0x10) != 0;
      break;
    case CC_SHL: {
      u64 cnt = b;
      cf = cnt <= bits ? (u32)((a >> (bits - cnt)) & 1) : 0;
      if (cnt == bits && bits == 64) cf = (u32)(a & 1);
      of = ((dst & msb) != 0) ^ cf;
      break;
    }
    case CC_SHR: {
      u64 cnt = b;
      cf = (u32)((a >> (cnt - 1)) & 1);
      of = (a & msb) != 0;
      break;
    }
    case CC_SAR: {
      u64 cnt = b;
      s64 sa = szl == 3 ? (s64)a : szl == 2 ? (s64)(s32)a : szl == 1 ? (s64)(s16)a : (s64)(s8)a;
      cf = (u32)(((u64)(sa >> (cnt - 1))) & 1);
      of = 0;
      break;
    }
    case CC_MUL:
      cf = of = (u32)(ST64(S_CC_AUX) & 1);
      break;
    case CC_SHRD: {
      u64 cnt = b;
      cf = (u32)((a >> (cnt - 1)) & 1);
      of = ((dst ^ a) & msb) != 0;
      break;
    }
  }
  u32 zf = dst == 0, sf = (dst & msb) != 0;
  return cf | (parity8((u32)dst) << 2) | (af << 4) | (zf << 6) | (sf << 7) | (of << 11);
}

EXPORT void cc_setflags(u32 f) {
  ST32(S_CC_OP) = CC_EFLAGS << 2;
  ST64(S_CC_SRC1) = f & F_ARITH;
}

EXPORT u32 cc_cf(void) { return cc_getflags() & 1; }

// Evaluate x86 condition code (0..15) against the current lazy flags.
static inline u32 eval_cond(u32 f, u32 cond) {
  u32 cf = f & 1, pf = (f >> 2) & 1, zf = (f >> 6) & 1, sf = (f >> 7) & 1, of = (f >> 11) & 1;
  u32 r;
  switch (cond >> 1) {
    case 0: r = of; break;
    case 1: r = cf; break;
    case 2: r = zf; break;
    case 3: r = cf | zf; break;
    case 4: r = sf; break;
    case 5: r = pf; break;
    case 6: r = sf != of; break;
    default: r = zf | (sf != of); break;
  }
  return r ^ (cond & 1);
}
EXPORT u32 cc_eval(u32 cond) { return eval_cond(cc_getflags(), cond); }

// ---------------------------------------------------------------------------------------------
// Block lookup: direct mapped {pc, slot}. Returns the table slot, or 0 (the miss stub) when absent.
// ---------------------------------------------------------------------------------------------
EXPORT u32 lookup(u32 pc) {
  u32 h = (pc ^ (pc >> LOOKUP_BITS) ^ (pc >> 3)) & ((1u << LOOKUP_BITS) - 1);
  volatile u32 *e = (volatile u32 *)(LOOKUP_BASE + h * 8);
  return e[0] == pc ? e[1] : 0;
}
EXPORT void lookup_insert(u32 pc, u32 slot) {
  u32 h = (pc ^ (pc >> LOOKUP_BITS) ^ (pc >> 3)) & ((1u << LOOKUP_BITS) - 1);
  volatile u32 *e = (volatile u32 *)(LOOKUP_BASE + h * 8);
  e[0] = pc;
  e[1] = slot;
}
EXPORT void lookup_flush(void) {
  volatile u32 *e = (volatile u32 *)LOOKUP_BASE;
  for (u32 i = 0; i < (1u << LOOKUP_BITS) * 2; i++) e[i] = 0;
}

// ---------------------------------------------------------------------------------------------
// Wide arithmetic
// ---------------------------------------------------------------------------------------------
EXPORT u64 mulhi_u64(u64 a, u64 b) {
  u64 a0 = (u32)a, a1 = a >> 32, b0 = (u32)b, b1 = b >> 32;
  u64 p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  u64 mid = (p00 >> 32) + (u32)p01 + (u32)p10;
  return p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
}
EXPORT s64 mulhi_s64(s64 a, s64 b) {
  u64 hi = mulhi_u64((u64)a, (u64)b);
  if (a < 0) hi -= (u64)b;
  if (b < 0) hi -= (u64)a;
  return (s64)hi;
}

// 128/64 unsigned division: (hi:lo) / d. Caller guarantees d != 0 && hi < d. Returns quotient, remainder in scratch.
static u64 udiv128_core(u64 hi, u64 lo, u64 d, u64 *rem) {
  if (hi == 0) {
    *rem = lo % d;
    return lo / d;
  }
  // shift-subtract (restoring) division; 64 iterations
  u64 q = 0, r = hi;
  for (int i = 63; i >= 0; i--) {
    u64 carry = r >> 63;
    r = (r << 1) | ((lo >> i) & 1);
    if (carry || r >= d) {
      r -= d;
      q |= 1ull << i;
    }
  }
  *rem = r;
  return q;
}
// Returns 0 on success (quotient/remainder stored to S_SCRATCH / S_SCRATCH+8), 1 for #DE.
EXPORT u32 div128(u64 hi, u64 lo, u64 d, u32 is_signed) {
  u64 rem, q;
  if (d == 0) return 1;
  if (!is_signed) {
    if (hi >= d) return 1;
    q = udiv128_core(hi, lo, d, &rem);
  } else {
    int neg_n = (s64)hi < 0, neg_d = (s64)d < 0;
    u64 nl = lo, nh = hi;
    if (neg_n) { // negate 128
      nl = ~nl + 1;
      nh = ~nh + (nl == 0);
    }
    u64 ud = neg_d ? (~d + 1) : d;
    if (nh >= ud) return 1;
    q = udiv128_core(nh, nl, ud, &rem);
    int neg_q = neg_n ^ neg_d;
    if (neg_q) {
      if (q > 0x8000000000000000ull) return 1;
      q = ~q + 1;
    } else if (q > 0x7fffffffffffffffull) return 1;
    if (neg_n) rem = ~rem + 1;
  }
  ST64(S_SCRATCH) = q;
  ST64(S_SCRATCH + 8) = rem;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// String instructions. Return values are counts remaining etc. State registers are updated by the caller.
// ---------------------------------------------------------------------------------------------
// forward/backward copy with x86 semantics (byte-granular, overlapping allowed)
EXPORT void rep_movs(u32 dst, u32 src, u32 count, u32 size, u32 df) {
  u32 bytes = count * size;
  if (!df) {
    // forward. memmove semantics are equivalent unless the destination overlaps the source ahead of it.
    if (bytes == 0) return;
    if ((u32)(dst - src) >= bytes) {
      __builtin_memmove((void *)dst, (void *)src, bytes);
      return;
    }
    volatile u8 *d = (volatile u8 *)dst, *s = (volatile u8 *)src;
    for (u32 i = 0; i < bytes; i++) d[i] = s[i];
  } else {
    // backward: dst/src point at the *first* element processed (highest address)
    volatile u8 *d = (volatile u8 *)dst, *s = (volatile u8 *)src;
    for (u32 i = 0; i < count; i++) {
      for (u32 k = 0; k < size; k++) d[-(s32)(i * size) + k] = s[-(s32)(i * size) + k];
    }
  }
}
EXPORT void rep_stos(u32 dst, u32 count, u64 val, u32 size, u32 df) {
  if (!count) return;
  if (!df) {
    if (size == 1) {
      __builtin_memset((void *)dst, (int)(val & 0xff), count);
      return;
    }
    volatile u8 *p = (volatile u8 *)dst;
    for (u32 i = 0; i < count; i++)
      for (u32 k = 0; k < size; k++) p[i * size + k] = (u8)(val >> (8 * k));
  } else {
    volatile u8 *p = (volatile u8 *)dst;
    for (u32 i = 0; i < count; i++)
      for (u32 k = 0; k < size; k++) p[-(s32)(i * size) + k] = (u8)(val >> (8 * k));
  }
}

// REPE/REPNE CMPS / SCAS. Performs up to `count` iterations; returns the number of iterations *not* executed
// (so rcx = result). Updates the lazy flags with the last comparison (CC_SUB) and writes the new rsi/rdi to scratch.
static inline u64 rd(u32 addr, u32 size) {
  switch (size) {
    case 1: return *(volatile u8 *)addr;
    case 2: return *(volatile u16 *)addr;
    case 4: return *(volatile u32 *)addr;
    default: return *(volatile u64 *)addr;
  }
}
EXPORT u32 rep_cmps(u32 rsi, u32 rdi, u32 count, u32 size, u32 df, u32 repne) {
  u32 szl = size == 1 ? 0 : size == 2 ? 1 : size == 4 ? 2 : 3;
  s32 step = df ? -(s32)size : (s32)size;
  u64 a = 0, b = 0, res = 0;
  u32 done = 0;
  while (count) {
    a = rd(rsi, size);
    b = rd(rdi, size);
    res = a - b;
    rsi += step;
    rdi += step;
    count--;
    done = 1;
    int eq = (a == b);
    if (repne ? eq : !eq) break;
  }
  if (done) {
    ST32(S_CC_OP) = (CC_SUB << 2) | szl;
    ST64(S_CC_DST) = res;
    ST64(S_CC_SRC1) = a;
    ST64(S_CC_SRC2) = b;
  }
  ST64(S_SCRATCH) = rsi;
  ST64(S_SCRATCH + 8) = rdi;
  return count;
}
EXPORT u32 rep_scas(u32 rdi, u32 count, u64 val, u32 size, u32 df, u32 repne) {
  u32 szl = size == 1 ? 0 : size == 2 ? 1 : size == 4 ? 2 : 3;
  s32 step = df ? -(s32)size : (s32)size;
  u64 mask = szmask(szl);
  u64 a = val & mask, b = 0, res = 0;
  u32 done = 0;
  while (count) {
    b = rd(rdi, size);
    res = (a - b) & mask;
    rdi += step;
    count--;
    done = 1;
    int eq = (a == b);
    if (repne ? eq : !eq) break;
  }
  if (done) {
    ST32(S_CC_OP) = (CC_SUB << 2) | szl;
    ST64(S_CC_DST) = res;
    ST64(S_CC_SRC1) = a;
    ST64(S_CC_SRC2) = b;
  }
  ST64(S_SCRATCH) = rdi;
  return count;
}

// RCL / RCR: rotate through carry. `count` is already masked to 5/6 bits. New carry is stored in the first scratch word.
EXPORT u64 rot_carry(u32 right, u32 szl, u64 val, u32 count, u32 cf) {
  u32 bits = 8u << szl;
  u64 m = szmask(szl);
  val &= m;
  if (bits < 32) count %= (bits + 1);
  for (u32 i = 0; i < count; i++) {
    if (!right) {
      u32 out = (u32)((val >> (bits - 1)) & 1);
      val = ((val << 1) | cf) & m;
      cf = out;
    } else {
      u32 out = (u32)(val & 1);
      val = (val >> 1) | ((u64)cf << (bits - 1));
      cf = out;
    }
  }
  ST32(S_SCRATCH) = cf;
  return val;
}

// =============================================================================================
// x87 FPU (double precision internally) and FXSAVE/FXRSTOR
// =============================================================================================
typedef double f64;
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))
IMPORT("sin") f64 js_sin(f64);
IMPORT("cos") f64 js_cos(f64);
IMPORT("tan") f64 js_tan(f64);
IMPORT("atan2") f64 js_atan2(f64, f64);
IMPORT("log2") f64 js_log2(f64);
IMPORT("pow") f64 js_pow(f64, f64);
IMPORT("fmod") f64 js_fmod(f64, f64);

#define ST16(off) (*(volatile u16 *)(STATE_BASE + (off)))
#define FCW ST16(S_FCW)
#define FSW ST16(S_FSW)
#define FTAG ST16(S_FTAG)
#define FTOP (ST32(S_FTOP) & 7)

#define SW_IE 0x0001
#define SW_ZE 0x0004
#define SW_SF 0x0040
#define SW_C0 0x0100
#define SW_C1 0x0200
#define SW_C2 0x0400
#define SW_C3 0x4000
#define SW_CC (SW_C0 | SW_C1 | SW_C2 | SW_C3)

static inline volatile f64 *phys(u32 p) { return (volatile f64 *)(STATE_BASE + S_ST + (p & 7) * 16); }
static inline volatile f64 *stx(u32 i) { return phys(FTOP + i); }
static inline int tag_empty(u32 p) { return ((FTAG >> ((p & 7) * 2)) & 3) == 3; }
static inline void set_tag(u32 p, int empty) {
  u32 sh = (p & 7) * 2;
  FTAG = (u16)((FTAG & ~(3u << sh)) | ((empty ? 3u : 0u) << sh));
}
static inline int st_empty(u32 i) { return tag_empty(FTOP + i); }

static f64 qnan(void) {
  union { u64 u; f64 d; } v = {0xfff8000000000000ull};
  return v.d;
}
static f64 st_get(u32 i) {
  if (st_empty(i)) {
    FSW = (u16)((FSW | SW_IE | SW_SF) & ~SW_C1);
    return qnan();
  }
  return *stx(i);
}
static void st_set(u32 i, f64 v) {
  *stx(i) = v;
  set_tag(FTOP + i, 0);
}
static void push(f64 v) {
  u32 t = (FTOP - 1) & 7;
  if (!tag_empty(t)) {
    FSW = (u16)(FSW | SW_IE | SW_SF | SW_C1);
    v = qnan();
  } else FSW = (u16)(FSW & ~SW_C1);
  ST32(S_FTOP) = t;
  *phys(t) = v;
  set_tag(t, 0);
}
static f64 pop(void) {
  f64 v = st_get(0);
  set_tag(FTOP, 1);
  ST32(S_FTOP) = (FTOP + 1) & 7;
  return v;
}

static f64 round_rc_raw(f64 x, u32 rc);
static f64 round_rc(f64 x, u32 rc) {
  f64 r = round_rc_raw(x, rc);
  if (r == 0) {
    union { f64 d; u64 u; } sx = {x}, sr = {r};
    sr.u = (sr.u & ~(1ull << 63)) | (sx.u & (1ull << 63));
    return sr.d;
  }
  return r;
}
static f64 round_rc_raw(f64 x, u32 rc) {
  if (x != x || x == (f64)1e300 * 10 || x == -(f64)1e300 * 10) return x;
  if (x >= 4503599627370496.0 || x <= -4503599627370496.0) return x;
  f64 big = 4503599627370496.0;
  switch (rc) {
    case 0: { // nearest even
      f64 r = x >= 0 ? (x + big) - big : (x - big) + big;
      return r;
    }
    case 1: { // floor
      f64 r = x >= 0 ? (x + big) - big : (x - big) + big;
      if (r > x) r -= 1.0;
      return r;
    }
    case 2: { // ceil
      f64 r = x >= 0 ? (x + big) - big : (x - big) + big;
      if (r < x) r += 1.0;
      return r;
    }
    default: {
      f64 r = x >= 0 ? (x + big) - big : (x - big) + big;
      if (x >= 0 ? r > x : r < x) r += x >= 0 ? -1.0 : 1.0;
      return r;
    }
  }
}
static inline u32 rc_mode(void) { return (FCW >> 10) & 3; }

static u64 f2i64(f64 x, u32 rc, int bits, int *bad) {
  f64 r = round_rc(x, rc);
  f64 lim = bits == 16 ? 32768.0 : bits == 32 ? 2147483648.0 : 9223372036854775808.0;
  if (r != r || r >= lim || r < -lim) {
    *bad = 1;
    return bits == 16 ? 0x8000 : bits == 32 ? 0x80000000ull : 0x8000000000000000ull;
  }
  *bad = 0;
  return (u64)(s64)r;
}

// ---- 80-bit extended <-> double ----
static void store80(u32 ea, f64 v) {
  union { f64 d; u64 u; } x = {v};
  u32 sign = (u32)(x.u >> 63);
  u32 e = (u32)((x.u >> 52) & 0x7ff);
  u64 m = x.u & 0xfffffffffffffull;
  u64 mant;
  u32 exp;
  if (e == 0 && m == 0) { mant = 0; exp = 0; }
  else if (e == 0x7ff) { exp = 0x7fff; mant = 0x8000000000000000ull | (m << 11); }
  else if (e == 0) {
    // denormal double -> normalised extended
    int sh = __builtin_clzll(m);
    mant = m << sh;
    exp = (u32)(1 - 1023 + 16383 - (sh - 11));
  } else { exp = e - 1023 + 16383; mant = 0x8000000000000000ull | (m << 11); }
  *(volatile u64 *)ea = mant;
  *(volatile u16 *)(ea + 8) = (u16)(exp | (sign << 15));
}
static f64 load80(u32 ea) {
  u64 mant = *(volatile u64 *)ea;
  u16 se = *(volatile u16 *)(ea + 8);
  u32 sign = se >> 15, exp = se & 0x7fff;
  union { f64 d; u64 u; } x;
  if (exp == 0 && mant == 0) x.u = (u64)sign << 63;
  else if (exp == 0x7fff) x.u = ((u64)sign << 63) | 0x7ff0000000000000ull | ((mant << 1) >> 12) | ((mant << 1) ? 0 : 0);
  else {
    int e = (int)exp - 16383 + 1023;
    if (e >= 0x7ff) x.u = ((u64)sign << 63) | 0x7ff0000000000000ull;
    else if (e <= 0) {
      int sh = 1 - e;
      if (sh > 63) x.u = (u64)sign << 63;
      else x.u = ((u64)sign << 63) | (mant >> (11 + sh));
    } else x.u = ((u64)sign << 63) | ((u64)e << 52) | ((mant >> 11) & 0xfffffffffffffull);
  }
  return x.d;
}

static u32 sw_value(void) { return (FSW & ~0x3800u) | (FTOP << 11); }

static void fcom_flags(f64 a, f64 b) {
  u32 sw = FSW & ~SW_CC;
  if (a != a || b != b) sw |= SW_C0 | SW_C2 | SW_C3;
  else if (a > b) {}
  else if (a < b) sw |= SW_C0;
  else sw |= SW_C3;
  FSW = (u16)sw;
}
static u32 fcomi_flags(f64 a, f64 b) {
  if (a != a || b != b) return 0x45;
  if (a > b) return 0;
  if (a < b) return 1;
  return 0x40;
}

static f64 arith(u32 op, f64 a, f64 b) {
  switch (op) {
    case 0: return a + b;
    case 1: return a * b;
    case 4: return a - b;
    case 5: return b - a;
    case 6:
      if (b == 0) FSW = (u16)(FSW | SW_ZE);
      return a / b;
    default:
      if (a == 0) FSW = (u16)(FSW | SW_ZE);
      return b / a;
  }
}

static void fnstenv(u32 ea) {
  *(volatile u16 *)(ea + 0) = FCW;
  *(volatile u16 *)(ea + 4) = (u16)sw_value();
  u32 tw = 0;
  for (u32 i = 0; i < 8; i++) tw |= (tag_empty(i) ? 3u : 0u) << (i * 2);
  *(volatile u16 *)(ea + 8) = (u16)tw;
}
static void fldenv(u32 ea) {
  FCW = *(volatile u16 *)(ea + 0);
  u16 sw = *(volatile u16 *)(ea + 4);
  FSW = sw & ~0x3800u;
  ST32(S_FTOP) = (sw >> 11) & 7;
  FTAG = *(volatile u16 *)(ea + 8);
}

// Returns a value whose meaning depends on the instruction (FNSTSW AX -> AX, FCOMI -> eflags bits). `ea` is the memory
// address, or for FCMOVcc the evaluated condition (0/1).
EXPORT u32 x87(u32 esc, u32 modrm, u32 ea) {
  u32 reg = (modrm >> 3) & 7, rm = modrm & 7;
  int mem = (modrm >> 6) != 3;
  int bad;
  switch (esc) {
    case 0: case 4: case 2: case 6: { // D8, DC, DA, DE
      if (mem) {
        f64 b;
        if (esc == 0) b = *(volatile float *)ea;
        else if (esc == 4) b = *(volatile f64 *)ea;
        else if (esc == 2) b = (f64) * (volatile int *)ea;
        else b = (f64) * (volatile short *)ea;
        f64 a = st_get(0);
        if (reg == 2 || reg == 3) {
          fcom_flags(a, b);
          if (reg == 3) pop();
        } else st_set(0, arith(reg, a, b));
        return 0;
      }
      if (esc == 0) { // D8: st0 = st0 op sti
        f64 a = st_get(0), b = st_get(rm);
        if (reg == 2 || reg == 3) {
          fcom_flags(a, b);
          if (reg == 3) pop();
        } else st_set(0, arith(reg, a, b));
        return 0;
      }
      if (esc == 4) { // DC: sti = sti op st0 (sub/div reversed)
        f64 a = st_get(rm), b = st_get(0);
        u32 op = reg;
        if (op == 4) op = 5; else if (op == 5) op = 4; else if (op == 6) op = 7; else if (op == 7) op = 6;
        if (reg == 2 || reg == 3) return 0; // DC D0/D8 are aliases of FCOM; treated as nop
        st_set(rm, arith(op, a, b));
        return 0;
      }
      if (esc == 2) { // DA: FCMOVcc / FUCOMPP
        if (reg < 4) {
          if (ea) st_set(0, st_get(rm));
          return 0;
        }
        if (modrm == 0xe9) {
          fcom_flags(st_get(0), st_get(1));
          pop();
          pop();
        }
        return 0;
      }
      // DE: arithmetic with pop, or FCOMPP
      if (modrm == 0xd9) {
        fcom_flags(st_get(0), st_get(1));
        pop();
        pop();
        return 0;
      }
      {
        f64 a = st_get(rm), b = st_get(0);
        u32 op = reg;
        if (op == 4) op = 5; else if (op == 5) op = 4; else if (op == 6) op = 7; else if (op == 7) op = 6;
        st_set(rm, arith(op, a, b));
        pop();
      }
      return 0;
    }
    case 1: { // D9
      if (mem) {
        switch (reg) {
          case 0: push(*(volatile float *)ea); return 0;
          case 2: *(volatile float *)ea = (float)st_get(0); return 0;
          case 3: *(volatile float *)ea = (float)st_get(0); pop(); return 0;
          case 4: fldenv(ea); return 0;
          case 5: FCW = *(volatile u16 *)ea; return 0;
          case 6: fnstenv(ea); return 0;
          case 7: *(volatile u16 *)ea = FCW; return 0;
        }
        return 0;
      }
      switch (modrm) {
        case 0xd0: return 0;
        case 0xe0: st_set(0, -st_get(0)); return 0;
        case 0xe1: { f64 v = st_get(0); union { f64 d; u64 u; } x = {v}; x.u &= ~(1ull << 63); st_set(0, x.d); return 0; }
        case 0xe4: { FSW = (u16)(FSW & ~SW_C1); fcom_flags(st_get(0), 0.0); return 0; }
        case 0xe5: { // FXAM
          u32 sw = FSW & ~SW_CC;
          union { f64 d; u64 u; } x = {*stx(0)};
          if (x.u >> 63) sw |= SW_C1;
          if (st_empty(0)) sw |= SW_C3 | SW_C0;
          else {
            u32 e = (u32)((x.u >> 52) & 0x7ff);
            u64 m = x.u & 0xfffffffffffffull;
            if (e == 0x7ff) sw |= m ? SW_C0 : (SW_C2 | SW_C0);
            else if (e == 0) sw |= m ? (SW_C2 | SW_C3) : SW_C3;
            else sw |= SW_C2;
          }
          FSW = (u16)sw;
          return 0;
        }
        case 0xe8: push(1.0); return 0;
        case 0xe9: push(3.321928094887362347870319429489390175865); return 0;
        case 0xea: push(1.442695040888963407359924681001892137427); return 0;
        case 0xeb: push(3.141592653589793238462643383279502884197); return 0;
        case 0xec: push(0.301029995663981195213738894724493026768); return 0;
        case 0xed: push(0.693147180559945309417232121458176568076); return 0;
        case 0xee: push(0.0); return 0;
        case 0xf0: st_set(0, js_pow(2.0, st_get(0)) - 1.0); return 0; // F2XM1
        case 0xf1: { f64 x = st_get(1), y = st_get(0); pop(); st_set(0, x * js_log2(y)); return 0; } // FYL2X
        case 0xf2: { f64 v = st_get(0); st_set(0, js_tan(v)); push(1.0); FSW = (u16)(FSW & ~SW_C2); return 0; } // FPTAN
        case 0xf3: { f64 x = st_get(1), y = st_get(0); pop(); st_set(0, js_atan2(x, y)); return 0; } // FPATAN
        case 0xf4: { // FXTRACT
          f64 v = st_get(0);
          union { f64 d; u64 u; } x = {v};
          s32 e = (s32)((x.u >> 52) & 0x7ff) - 1023;
          x.u = (x.u & ~(0x7ffull << 52)) | (1023ull << 52);
          st_set(0, (f64)e);
          push(x.d);
          return 0;
        }
        case 0xf5: case 0xf8: { // FPREM1 / FPREM
          f64 a = st_get(0), b = st_get(1);
          f64 r, q;
          if (b == 0 || a != a || b != b || (a - a) != 0) { // invalid operation
            st_set(0, qnan());
            FSW = (u16)((FSW & ~SW_CC) | SW_IE);
            return 0;
          }
          if (modrm == 0xf5) {
            q = round_rc(a / b, 0);
            r = a - q * b;
          } else {
            r = js_fmod(a, b);
            q = round_rc((a - r) / b, 0);
          }
          st_set(0, r);
          u64 qi = (u64)(q < 0 ? -q : q);
          u32 sw = FSW & ~SW_CC; // complete reduction: C2 = 0, C0/C3/C1 = Q2/Q1/Q0
          if (qi & 4) sw |= SW_C0;
          if (qi & 2) sw |= SW_C3;
          if (qi & 1) sw |= SW_C1;
          FSW = (u16)sw;
          return 0;
        }
        case 0xf6: ST32(S_FTOP) = (FTOP - 1) & 7; return 0;
        case 0xf7: ST32(S_FTOP) = (FTOP + 1) & 7; return 0;
        case 0xf9: { f64 x = st_get(1), y = st_get(0); pop(); st_set(0, x * js_log2(y + 1.0)); return 0; } // FYL2XP1
        case 0xfa: { f64 v = st_get(0); union { f64 d; u64 u; } z = {v}; (void)z; st_set(0, __builtin_sqrt(v)); return 0; }
        case 0xfb: { f64 v = st_get(0); st_set(0, js_sin(v)); push(js_cos(v)); FSW = (u16)(FSW & ~SW_C2); return 0; } // FSINCOS
        case 0xfc: st_set(0, round_rc(st_get(0), rc_mode())); return 0;
        case 0xfd: { // FSCALE: st0 * 2^trunc(st1) by exponent adjustment
          f64 v = st_get(0), n = round_rc(st_get(1), 3);
          if (n > 70000) n = 70000;
          if (n < -70000) n = -70000;
          s32 k = (s32)n;
          while (k > 1000) { v *= 8.98846567431158e307; k -= 1023; }
          while (k < -1000) { v *= 1.1125369292536007e-308; k += 1022; }
          st_set(0, v * js_pow(2.0, (f64)k));
          return 0;
        }
        case 0xfe: st_set(0, js_sin(st_get(0))); FSW = (u16)(FSW & ~SW_C2); return 0;
        case 0xff: st_set(0, js_cos(st_get(0))); FSW = (u16)(FSW & ~SW_C2); return 0;
      }
      if (modrm >= 0xc0 && modrm <= 0xc7) { push(st_get(rm)); return 0; } // FLD sti
      if (modrm >= 0xc8 && modrm <= 0xcf) { // FXCH
        f64 a = st_get(0), b = st_get(rm);
        st_set(0, b);
        st_set(rm, a);
        return 0;
      }
      return 0;
    }
    case 3: { // DB
      if (mem) {
        switch (reg) {
          case 0: push((f64)*(volatile int *)ea); return 0;
          case 1: { int b2; u64 v = f2i64(st_get(0), 3, 32, &b2); *(volatile u32 *)ea = (u32)v; pop(); return 0; }
          case 2: case 3: {
            u64 v = f2i64(st_get(0), rc_mode(), 32, &bad);
            if (bad) FSW = (u16)(FSW | SW_IE);
            *(volatile u32 *)ea = (u32)v;
            if (reg == 3) pop();
            return 0;
          }
          case 5: push(load80(ea)); return 0;
          case 7: store80(ea, st_get(0)); pop(); return 0;
        }
        return 0;
      }
      if (modrm >= 0xc0 && modrm < 0xe0) { if (ea) st_set(0, st_get(rm)); return 0; } // FCMOVNcc
      if (modrm == 0xe2) { FSW = (u16)(FSW & 0x7f00); return 0; } // FNCLEX
      if (modrm == 0xe3) { FCW = 0x37f; FSW = 0; ST32(S_FTOP) = 0; FTAG = 0xffff; return 0; } // FNINIT
      if (modrm >= 0xe8 && modrm <= 0xf7) { // FUCOMI / FCOMI
        return fcomi_flags(st_get(0), st_get(rm));
      }
      return 0;
    }
    case 5: { // DD
      if (mem) {
        switch (reg) {
          case 0: push(*(volatile f64 *)ea); return 0;
          case 1: { int b2; u64 v = f2i64(st_get(0), 3, 64, &b2); *(volatile u64 *)ea = v; pop(); return 0; }
          case 2: *(volatile f64 *)ea = st_get(0); return 0;
          case 3: *(volatile f64 *)ea = st_get(0); pop(); return 0;
          case 4: { // FRSTOR
            fldenv(ea);
            for (u32 i = 0; i < 8; i++) *phys(FTOP + i) = load80(ea + 28 + i * 10);
            return 0;
          }
          case 6: { // FNSAVE
            fnstenv(ea);
            for (u32 i = 0; i < 8; i++) store80(ea + 28 + i * 10, *phys(FTOP + i));
            FCW = 0x37f; FSW = 0; ST32(S_FTOP) = 0; FTAG = 0xffff;
            return 0;
          }
          case 7: *(volatile u16 *)ea = (u16)sw_value(); return 0;
        }
        return 0;
      }
      switch (reg) {
        case 0: set_tag(FTOP + rm, 1); return 0; // FFREE
        case 2: st_set(rm, st_get(0)); return 0; // FST sti
        case 3: st_set(rm, st_get(0)); pop(); return 0; // FSTP sti
        case 4: fcom_flags(st_get(0), st_get(rm)); return 0; // FUCOM
        case 5: fcom_flags(st_get(0), st_get(rm)); pop(); return 0; // FUCOMP
      }
      return 0;
    }
    case 7: { // DF
      if (mem) {
        switch (reg) {
          case 0: push((f64)*(volatile short *)ea); return 0;
          case 1: { int b2; u64 v = f2i64(st_get(0), 3, 16, &b2); *(volatile u16 *)ea = (u16)v; pop(); return 0; }
          case 2: case 3: {
            u64 v = f2i64(st_get(0), rc_mode(), 16, &bad);
            if (bad) FSW = (u16)(FSW | SW_IE);
            *(volatile u16 *)ea = (u16)v;
            if (reg == 3) pop();
            return 0;
          }
          case 5: push((f64)*(volatile s64 *)ea); return 0;
          case 7: {
            u64 v = f2i64(st_get(0), rc_mode(), 64, &bad);
            if (bad) FSW = (u16)(FSW | SW_IE);
            *(volatile u64 *)ea = v;
            pop();
            return 0;
          }
        }
        return 0;
      }
      if (modrm == 0xe0) return sw_value(); // FNSTSW AX
      if (modrm >= 0xe8 && modrm <= 0xf7) { // FUCOMIP / FCOMIP
        u32 fl = fcomi_flags(st_get(0), st_get(rm));
        pop();
        return fl;
      }
      return 0;
    }
  }
  return 0;
}

// FXSAVE / FXRSTOR (512-byte legacy area)
EXPORT void fxsave(u32 ea) {
  *(volatile u16 *)(ea + 0) = FCW;
  *(volatile u16 *)(ea + 2) = (u16)sw_value();
  u8 abr = 0;
  for (u32 i = 0; i < 8; i++) if (!tag_empty(i)) abr |= (u8)(1u << i);
  *(volatile u8 *)(ea + 4) = abr;
  *(volatile u32 *)(ea + 24) = ST32(S_MXCSR);
  *(volatile u32 *)(ea + 28) = 0xffff;
  for (u32 i = 0; i < 8; i++) {
    store80(ea + 32 + i * 16, *stx(i));
    *(volatile u16 *)(ea + 32 + i * 16 + 10) = 0;
    *(volatile u32 *)(ea + 32 + i * 16 + 12) = 0;
  }
  for (u32 i = 0; i < 16; i++)
    for (u32 k = 0; k < 4; k++) *(volatile u32 *)(ea + 160 + i * 16 + k * 4) = *(volatile u32 *)(STATE_BASE + S_XMM + i * 16 + k * 4);
}
EXPORT void fxrstor(u32 ea) {
  FCW = *(volatile u16 *)(ea + 0);
  u16 sw = *(volatile u16 *)(ea + 2);
  FSW = sw & ~0x3800u;
  ST32(S_FTOP) = (sw >> 11) & 7;
  u8 abr = *(volatile u8 *)(ea + 4);
  u16 tags = 0;
  for (u32 i = 0; i < 8; i++) tags |= (u16)(((abr >> i) & 1) ? 0 : 3) << (i * 2);
  FTAG = tags;
  ST32(S_MXCSR) = *(volatile u32 *)(ea + 24);
  for (u32 i = 0; i < 8; i++) *stx(i) = load80(ea + 32 + i * 16);
  for (u32 i = 0; i < 16; i++)
    for (u32 k = 0; k < 4; k++) *(volatile u32 *)(STATE_BASE + S_XMM + i * 16 + k * 4) = *(volatile u32 *)(ea + 160 + i * 16 + k * 4);
}
