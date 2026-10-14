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
