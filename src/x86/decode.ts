// x86-64 instruction decoder (long mode). Produces Insn records consumed by the translator.
import { Op, opName } from "./ops.ts";

// Operand kinds
export const K_NONE = 0;
export const K_REG = 1; // general purpose register
export const K_XMM = 2;
export const K_MEM = 3;
export const K_IMM = 4;
export const K_MM = 5; // MMX register
export const K_ST = 6; // x87 stack register (r = index)

export class Opd {
  k = K_NONE;
  /** register number (0-15) for K_REG/K_XMM */
  r = 0;
  /** size in bytes (1,2,4,8,16) */
  sz = 0;
  /** true when this is AH/CH/DH/BH (r is the underlying register 0..3 and bits 15:8 are selected) */
  hi8 = false;
  // memory: ea = base + index*scale + disp (base/index = -1 when absent). For RIP-relative the final
  // absolute address is folded into disp (and base=-1).
  base = -1;
  index = -1;
  scale = 1;
  disp = 0;
  /** immediate (sign-extended). For 8-byte immediates (mov r64, imm64) see imm64. */
  imm = 0;
  imm64 = 0n;
  ripRel = false;
}

export class Insn {
  addr = 0;
  len = 0;
  op = 0;
  /** operand size in bytes for the integer operation */
  osz = 4;
  /** address size in bytes (8 or 4) */
  asz = 8;
  /** 0 none, 1 = F3 (REP/REPE), 2 = F2 (REPNE) */
  rep = 0;
  lock = false;
  /** segment override: 0 none, 4 = FS, 5 = GS */
  seg = 0;
  /** condition code for Jcc / SETcc / CMOVcc (0-15) */
  cc = 0;
  /** direct branch / call target absolute address, else -1 */
  target = -1;
  /** mandatory prefix in effect for SSE (0, 0x66, 0xF3, 0xF2) */
  pfx = 0;
  rex = 0;
  /** x87: (escape opcode - 0xD8) << 8 | modrm */
  fpu = 0;
  a: Opd = NOOPD;
  b: Opd = NOOPD;
  c: Opd = NOOPD;
  /** raw opcode info (map<<8|opcode) for diagnostics */
  opc = 0;
  /** true if decoding failed or the instruction is unsupported */
  invalid = false;
}

const NOOPD = new Opd();

class DecodeError extends Error {}

const CC_NAMES = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];

/**
 * Decode one instruction at `addr`. `mem` is the guest memory (addr indexes mem directly).
 */
export function decode(mem: Uint8Array, addr: number): Insn {
  const ins = new Insn();
  ins.addr = addr;
  try {
    decodeInner(mem, addr, ins);
  } catch (e) {
    if (!(e instanceof DecodeError) && !(e instanceof RangeError)) throw e;
    ins.op = Op.INVALID;
    ins.invalid = true;
    if (ins.len === 0) ins.len = 1;
  }
  return ins;
}

function mkReg(r: number, sz: number, rex: number): Opd {
  const o = new Opd();
  o.k = K_REG;
  o.r = r;
  o.sz = sz;
  if (sz === 1 && rex === 0 && r >= 4 && r < 8) {
    // AH/CH/DH/BH: r holds the underlying register (0-3), hi8 selects bits 15:8
    o.hi8 = true;
    o.r = r - 4;
  }
  return o;
}
function mkXmm(r: number, sz = 16): Opd {
  const o = new Opd();
  o.k = K_XMM;
  o.r = r;
  o.sz = sz;
  return o;
}
function mkImm(v: number, sz: number): Opd {
  const o = new Opd();
  o.k = K_IMM;
  o.imm = v;
  o.sz = sz;
  return o;
}

interface Ctx {
  mem: Uint8Array;
  p: number; // cursor
  ins: Insn;
  rex: number;
  rexW: boolean;
  rexR: number;
  rexX: number;
  rexB: number;
  osz16: boolean; // 0x66 prefix present
  modrm: number;
  mod: number;
  reg: number; // includes rex.R
  rm: number; // includes rex.B (for register operands)
  rmMem: Opd | null;
}

function u8(c: Ctx): number {
  if (c.p >= c.mem.length) throw new DecodeError();
  return c.mem[c.p++];
}
function s8(c: Ctx): number {
  return (u8(c) << 24) >> 24;
}
function u16(c: Ctx): number {
  const v = u8(c);
  return v | (u8(c) << 8);
}
function s32(c: Ctx): number {
  const a = u8(c), b = u8(c), d = u8(c), e = u8(c);
  return a | (b << 8) | (d << 16) | (e << 24);
}

function readModRM(c: Ctx, memSize: number) {
  const m = u8(c);
  c.modrm = m;
  c.mod = m >> 6;
  c.reg = ((m >> 3) & 7) | c.rexR;
  const rm = m & 7;
  if (c.mod === 3) {
    c.rm = rm | c.rexB;
    c.rmMem = null;
    return;
  }
  const o = new Opd();
  o.k = K_MEM;
  o.sz = memSize;
  o.scale = 1;
  if (rm === 4) {
    const sib = u8(c);
    const sc = sib >> 6;
    const idx = ((sib >> 3) & 7) | c.rexX;
    const base = (sib & 7);
    o.scale = 1 << sc;
    if (idx !== 4) o.index = idx;
    if (base === 5 && c.mod === 0) {
      o.disp = s32(c);
    } else {
      o.base = base | c.rexB;
    }
  } else if (rm === 5 && c.mod === 0) {
    o.ripRel = true;
    o.base = 16;
    o.disp = s32(c);
  } else {
    o.base = rm | c.rexB;
  }
  if (c.mod === 1) o.disp = s8(c);
  else if (c.mod === 2) o.disp = s32(c);
  c.rmMem = o;
  c.rm = 0;
}

/** Returns the r/m operand as register (size sz) or memory */
function rmOpd(c: Ctx, sz: number): Opd {
  if (c.rmMem) {
    c.rmMem.sz = sz;
    return c.rmMem;
  }
  return mkReg(c.rm, sz, c.rex);
}
function rmXmm(c: Ctx, sz: number): Opd {
  if (c.rmMem) {
    c.rmMem.sz = sz;
    return c.rmMem;
  }
  return mkXmm(c.rm, sz);
}
function regOpd(c: Ctx, sz: number): Opd {
  return mkReg(c.reg, sz, c.rex);
}

function immZ(c: Ctx, osz: number): Opd {
  if (osz === 2) return mkImm((u16(c) << 16) >> 16, 2);
  return mkImm(s32(c), osz);
}

function decodeInner(mem: Uint8Array, addr: number, ins: Insn) {
  const c: Ctx = {
    mem, p: addr, ins, rex: 0, rexW: false, rexR: 0, rexX: 0, rexB: 0, osz16: false,
    modrm: 0, mod: 0, reg: 0, rm: 0, rmMem: null,
  };
  let lastSimdPfx = 0; // last of 66/F3/F2 seen (determines mandatory prefix)
  // ---- prefixes ----
  for (;;) {
    const b = u8(c);
    switch (b) {
      case 0x66: c.osz16 = true; lastSimdPfx = 0x66; continue;
      case 0xf3: ins.rep = 1; lastSimdPfx = 0xf3; continue;
      case 0xf2: ins.rep = 2; lastSimdPfx = 0xf2; continue;
      case 0xf0: ins.lock = true; continue;
      case 0x67: ins.asz = 4; continue;
      case 0x64: ins.seg = 4; continue;
      case 0x65: ins.seg = 5; continue;
      case 0x26: case 0x2e: case 0x36: case 0x3e: continue;
      default:
        c.p--;
    }
    break;
  }
  let b = u8(c);
  if (b >= 0x40 && b <= 0x4f) {
    c.rex = b;
    c.rexW = (b & 8) !== 0;
    c.rexR = (b & 4) << 1;
    c.rexX = (b & 2) << 2;
    c.rexB = (b & 1) << 3;
    b = u8(c);
  }
  ins.rex = c.rex;
  ins.pfx = lastSimdPfx;
  let osz = c.rexW ? 8 : c.osz16 ? 2 : 4;
  ins.osz = osz;
  ins.opc = b;

  const finish = () => {
    ins.len = c.p - addr;
    // fold RIP-relative displacement into absolute address now that we know the length
    for (const o of [ins.a, ins.b, ins.c]) {
      if (o.k === K_MEM && o.ripRel) {
        o.disp = (addr + ins.len + o.disp) >>> 0;
        o.base = -1;
        o.ripRel = false;
      }
    }
    if (ins.target === -2) ins.target = -1;
  };
  const rel = (n: number) => {
    const d = n === 1 ? s8(c) : s32(c);
    ins.target = (addr + (c.p - addr) + d) >>> 0;
    // note: c.p already advanced past the displacement => end of instruction
    const o = new Opd();
    o.k = K_IMM;
    o.imm = ins.target;
    o.sz = 8;
    return o;
  };

  // ALU group 00-3F
  if (b < 0x40 && (b & 7) < 6 && b !== 0x0f) {
    const aluOps = [Op.ADD, Op.OR, Op.ADC, Op.SBB, Op.AND, Op.SUB, Op.XOR, Op.CMP];
    ins.op = aluOps[b >> 3];
    switch (b & 7) {
      case 0: readModRM(c, 1); ins.a = rmOpd(c, 1); ins.b = regOpd(c, 1); ins.osz = 1; break;
      case 1: readModRM(c, osz); ins.a = rmOpd(c, osz); ins.b = regOpd(c, osz); break;
      case 2: readModRM(c, 1); ins.a = regOpd(c, 1); ins.b = rmOpd(c, 1); ins.osz = 1; break;
      case 3: readModRM(c, osz); ins.a = regOpd(c, osz); ins.b = rmOpd(c, osz); break;
      case 4: ins.a = mkReg(0, 1, c.rex); ins.b = mkImm(s8(c), 1); ins.osz = 1; break;
      case 5: ins.a = mkReg(0, osz, c.rex); ins.b = immZ(c, osz); break;
    }
    return finish();
  }

  switch (b) {
    case 0x0f:
      decode0F(c, ins, osz, lastSimdPfx);
      return finish();
    case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: {
      ins.op = Op.PUSH;
      ins.osz = c.osz16 ? 2 : 8;
      ins.a = mkReg((b & 7) | c.rexB, ins.osz, c.rex);
      return finish();
    }
    case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
      ins.op = Op.POP;
      ins.osz = c.osz16 ? 2 : 8;
      ins.a = mkReg((b & 7) | c.rexB, ins.osz, c.rex);
      return finish();
    }
    case 0x63: {
      readModRM(c, 4);
      ins.op = Op.MOVSXD;
      ins.a = regOpd(c, osz);
      ins.b = rmOpd(c, 4);
      return finish();
    }
    case 0x68:
      ins.op = Op.PUSH;
      ins.osz = c.osz16 ? 2 : 8;
      ins.a = c.osz16 ? mkImm((u16(c) << 16) >> 16, 2) : mkImm(s32(c), 8);
      return finish();
    case 0x6a:
      ins.op = Op.PUSH;
      ins.osz = c.osz16 ? 2 : 8;
      ins.a = mkImm(s8(c), ins.osz);
      return finish();
    case 0x69: case 0x6b: {
      readModRM(c, osz);
      ins.op = Op.IMUL3;
      ins.a = regOpd(c, osz);
      ins.b = rmOpd(c, osz);
      ins.c = b === 0x69 ? immZ(c, osz) : mkImm(s8(c), osz);
      return finish();
    }
    case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f:
      ins.op = Op.JCC;
      ins.cc = b & 15;
      ins.a = rel(1);
      return finish();
    case 0x80: case 0x81: case 0x83: {
      const sz = b === 0x80 ? 1 : osz;
      readModRM(c, sz);
      const aluOps = [Op.ADD, Op.OR, Op.ADC, Op.SBB, Op.AND, Op.SUB, Op.XOR, Op.CMP];
      ins.op = aluOps[c.reg & 7];
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = b === 0x81 ? immZ(c, sz) : mkImm(s8(c), sz);
      return finish();
    }
    case 0x84: case 0x85: {
      const sz = b === 0x84 ? 1 : osz;
      readModRM(c, sz);
      ins.op = Op.TEST;
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = regOpd(c, sz);
      return finish();
    }
    case 0x86: case 0x87: {
      const sz = b === 0x86 ? 1 : osz;
      readModRM(c, sz);
      ins.op = Op.XCHG;
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = regOpd(c, sz);
      return finish();
    }
    case 0x88: case 0x89: {
      const sz = b === 0x88 ? 1 : osz;
      readModRM(c, sz);
      ins.op = Op.MOV;
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = regOpd(c, sz);
      return finish();
    }
    case 0x8a: case 0x8b: {
      const sz = b === 0x8a ? 1 : osz;
      readModRM(c, sz);
      ins.op = Op.MOV;
      ins.osz = sz;
      ins.a = regOpd(c, sz);
      ins.b = rmOpd(c, sz);
      return finish();
    }
    case 0x8d: {
      readModRM(c, osz);
      if (!c.rmMem) throw new DecodeError();
      ins.op = Op.LEA;
      ins.a = regOpd(c, osz);
      ins.b = c.rmMem;
      return finish();
    }
    case 0x8f: {
      readModRM(c, 8);
      if ((c.reg & 7) !== 0) throw new DecodeError();
      ins.op = Op.POP;
      ins.osz = c.osz16 ? 2 : 8;
      ins.a = rmOpd(c, ins.osz);
      return finish();
    }
    case 0x90:
      if (c.rexB) {
        ins.op = Op.XCHG;
        ins.a = mkReg(8, osz, c.rex);
        ins.b = mkReg(0, osz, c.rex);
      } else if (ins.rep === 1) {
        ins.op = Op.PAUSE;
      } else ins.op = Op.NOP;
      return finish();
    case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
      ins.op = Op.XCHG;
      ins.a = mkReg((b & 7) | c.rexB, osz, c.rex);
      ins.b = mkReg(0, osz, c.rex);
      return finish();
    case 0x98: ins.op = Op.CBW; ins.osz = osz; return finish(); // CBW/CWDE/CDQE by osz
    case 0x99: ins.op = Op.CWD; ins.osz = osz; return finish(); // CWD/CDQ/CQO by osz
    case 0x9b: ins.op = Op.FWAIT; return finish();
    case 0x9c: ins.op = Op.PUSHF; ins.osz = c.osz16 ? 2 : 8; return finish();
    case 0x9d: ins.op = Op.POPF; ins.osz = c.osz16 ? 2 : 8; return finish();
    case 0x9e: ins.op = Op.SAHF; return finish();
    case 0x9f: ins.op = Op.LAHF; return finish();
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
      // MOV AL/eAX, moffs64 (64-bit absolute address; we only support addresses < 4GB)
      const sz = (b & 1) ? osz : 1;
      const lo = s32(c) >>> 0;
      const hi = s32(c) >>> 0;
      if (ins.asz === 4) {
        // 67 prefix: moffs32 -- we've over-read; back up
        c.p -= 4;
      }
      const m = new Opd();
      m.k = K_MEM;
      m.sz = sz;
      m.disp = lo;
      if (hi !== 0 && ins.asz === 8) throw new DecodeError();
      const r = mkReg(0, sz, c.rex);
      ins.op = Op.MOV;
      ins.osz = sz;
      if (b < 0xa2) { ins.a = r; ins.b = m; } else { ins.a = m; ins.b = r; }
      return finish();
    }
    case 0xa4: case 0xa5: ins.op = Op.MOVS; ins.osz = b === 0xa4 ? 1 : osz; return finish();
    case 0xa6: case 0xa7: ins.op = Op.CMPS; ins.osz = b === 0xa6 ? 1 : osz; return finish();
    case 0xa8: ins.op = Op.TEST; ins.osz = 1; ins.a = mkReg(0, 1, c.rex); ins.b = mkImm(s8(c), 1); return finish();
    case 0xa9: ins.op = Op.TEST; ins.a = mkReg(0, osz, c.rex); ins.b = immZ(c, osz); return finish();
    case 0xaa: case 0xab: ins.op = Op.STOS; ins.osz = b === 0xaa ? 1 : osz; return finish();
    case 0xac: case 0xad: ins.op = Op.LODS; ins.osz = b === 0xac ? 1 : osz; return finish();
    case 0xae: case 0xaf: ins.op = Op.SCAS; ins.osz = b === 0xae ? 1 : osz; return finish();
    case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
      ins.op = Op.MOV;
      ins.osz = 1;
      ins.a = mkReg((b & 7) | c.rexB, 1, c.rex);
      ins.b = mkImm(s8(c), 1);
      return finish();
    case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf: {
      ins.op = Op.MOV;
      ins.a = mkReg((b & 7) | c.rexB, osz, c.rex);
      if (osz === 8) {
        const lo = BigInt(s32(c) >>> 0);
        const hi = BigInt(s32(c) >>> 0);
        const o = mkImm(0, 8);
        o.imm64 = (hi << 32n) | lo;
        o.imm = Number(BigInt.asIntN(53, o.imm64)); // not exact for large values; use imm64
        ins.b = o;
      } else if (osz === 2) ins.b = mkImm((u16(c) << 16) >> 16, 2);
      else ins.b = mkImm(s32(c), 4);
      return finish();
    }
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const sz = (b & 1) ? osz : 1;
      readModRM(c, sz);
      const ops = [Op.ROL, Op.ROR, Op.RCL, Op.RCR, Op.SHL, Op.SHR, Op.SHL, Op.SAR];
      ins.op = ops[c.reg & 7];
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      if (b < 0xd0) ins.b = mkImm(u8(c), 1);
      else if (b < 0xd2) ins.b = mkImm(1, 1);
      else {
        const cl = mkReg(1, 1, 1); // CL (rex=1 forces non-hi8 encoding)
        ins.b = cl;
      }
      return finish();
    }
    case 0xc2: ins.op = Op.RET_IMM; ins.a = mkImm(u16(c), 2); return finish();
    case 0xc3: ins.op = Op.RET; return finish();
    case 0xc6: case 0xc7: {
      const sz = b === 0xc6 ? 1 : osz;
      readModRM(c, sz);
      if ((c.reg & 7) !== 0) throw new DecodeError();
      ins.op = Op.MOV;
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = sz === 1 ? mkImm(s8(c), 1) : immZ(c, sz);
      return finish();
    }
    case 0xc8: ins.op = Op.ENTER; ins.a = mkImm(u16(c), 2); ins.b = mkImm(u8(c), 1); return finish();
    case 0xc9: ins.op = Op.LEAVE; ins.osz = c.osz16 ? 2 : 8; return finish();
    case 0xcc: ins.op = Op.INT3; return finish();
    case 0xcd: ins.op = Op.INT; ins.a = mkImm(u8(c), 1); return finish();
    case 0xd7: ins.op = Op.XLAT; return finish();
    case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf: {
      readModRM(c, 0);
      ins.op = Op.X87;
      ins.fpu = ((b - 0xd8) << 8) | c.modrm;
      if (c.rmMem) {
        ins.a = c.rmMem;
        // memory operand size by escape/reg-field
        ins.a.sz = fpuMemSize(b, c.modrm);
      }
      return finish();
    }
    case 0xe0: ins.op = Op.LOOPNE; ins.a = rel(1); return finish();
    case 0xe1: ins.op = Op.LOOPE; ins.a = rel(1); return finish();
    case 0xe2: ins.op = Op.LOOP; ins.a = rel(1); return finish();
    case 0xe3: ins.op = Op.JRCXZ; ins.a = rel(1); return finish();
    case 0xe8: ins.op = Op.CALL; ins.a = rel(4); return finish();
    case 0xe9: ins.op = Op.JMP; ins.a = rel(4); return finish();
    case 0xeb: ins.op = Op.JMP; ins.a = rel(1); return finish();
    case 0xf4: ins.op = Op.HLT; return finish();
    case 0xf5: ins.op = Op.CMC; return finish();
    case 0xf6: case 0xf7: {
      const sz = b === 0xf6 ? 1 : osz;
      readModRM(c, sz);
      ins.osz = sz;
      const r = c.reg & 7;
      switch (r) {
        case 0: case 1:
          ins.op = Op.TEST;
          ins.a = rmOpd(c, sz);
          ins.b = sz === 1 ? mkImm(s8(c), 1) : immZ(c, sz);
          break;
        case 2: ins.op = Op.NOT; ins.a = rmOpd(c, sz); break;
        case 3: ins.op = Op.NEG; ins.a = rmOpd(c, sz); break;
        case 4: ins.op = Op.MUL; ins.a = rmOpd(c, sz); break;
        case 5: ins.op = Op.IMUL1; ins.a = rmOpd(c, sz); break;
        case 6: ins.op = Op.DIV; ins.a = rmOpd(c, sz); break;
        case 7: ins.op = Op.IDIV; ins.a = rmOpd(c, sz); break;
      }
      return finish();
    }
    case 0xf8: ins.op = Op.CLC; return finish();
    case 0xf9: ins.op = Op.STC; return finish();
    case 0xfa: ins.op = Op.CLI; return finish();
    case 0xfb: ins.op = Op.STI; return finish();
    case 0xfc: ins.op = Op.CLD; return finish();
    case 0xfd: ins.op = Op.STD; return finish();
    case 0xfe: {
      readModRM(c, 1);
      ins.osz = 1;
      const r = c.reg & 7;
      if (r > 1) throw new DecodeError();
      ins.op = r === 0 ? Op.INC : Op.DEC;
      ins.a = rmOpd(c, 1);
      return finish();
    }
    case 0xff: {
      readModRM(c, osz);
      const r = c.reg & 7;
      switch (r) {
        case 0: ins.op = Op.INC; ins.a = rmOpd(c, osz); break;
        case 1: ins.op = Op.DEC; ins.a = rmOpd(c, osz); break;
        case 2: ins.op = Op.CALL_IND; ins.osz = 8; ins.a = rmOpd(c, 8); break;
        case 4: ins.op = Op.JMP_IND; ins.osz = 8; ins.a = rmOpd(c, 8); break;
        case 6: ins.op = Op.PUSH; ins.osz = c.osz16 ? 2 : 8; ins.a = rmOpd(c, ins.osz); break;
        default: throw new DecodeError();
      }
      return finish();
    }
    case 0xc4: case 0xc5:
      decodeVEX(c, ins, b);
      return finish();
    default:
      throw new DecodeError();
  }
}

function fpuMemSize(esc: number, modrm: number): number {
  const reg = (modrm >> 3) & 7;
  switch (esc) {
    case 0xd8: return 4;
    case 0xd9:
      return reg === 5 || reg === 7 ? 2 : reg === 4 || reg === 6 ? 28 : 4;
    case 0xda: return 4;
    case 0xdb: return reg === 5 || reg === 7 ? 10 : 4;
    case 0xdc: return 8;
    case 0xdd: return reg === 4 || reg === 6 ? 108 : reg === 7 ? 2 : 8;
    case 0xde: return 2;
    case 0xdf: return reg === 4 || reg === 6 ? 10 : reg === 5 || reg === 7 ? 8 : 2;
  }
  return 0;
}

// ---- 0F two-byte opcode map ----
function decode0F(c: Ctx, ins: Insn, osz: number, pfx: number) {
  const b = u8(c);
  ins.opc = 0x100 | b;
  const o = (op: number) => (ins.op = op);

  // --- conditional ops ---
  if (b >= 0x80 && b <= 0x8f) {
    o(Op.JCC);
    ins.cc = b & 15;
    const d = s32(c);
    ins.target = (c.p + d) >>> 0;
    const t = mkImm(ins.target, 8);
    ins.a = t;
    return;
  }
  if (b >= 0x90 && b <= 0x9f) {
    readModRM(c, 1);
    o(Op.SETCC);
    ins.cc = b & 15;
    ins.osz = 1;
    ins.a = rmOpd(c, 1);
    return;
  }
  if (b >= 0x40 && b <= 0x4f) {
    readModRM(c, osz);
    o(Op.CMOVCC);
    ins.cc = b & 15;
    ins.a = regOpd(c, osz);
    ins.b = rmOpd(c, osz);
    return;
  }
  if (b >= 0xc8 && b <= 0xcf) {
    o(Op.BSWAP);
    ins.a = mkReg((b & 7) | c.rexB, osz === 8 ? 8 : 4, c.rex);
    ins.osz = osz === 8 ? 8 : 4;
    return;
  }

  switch (b) {
    case 0x05: o(Op.SYSCALL); return;
    case 0x0b: o(Op.UD2); return;
    case 0x0d: readModRM(c, 1); o(Op.PREFETCH); ins.a = rmOpd(c, 1); return;
    case 0x18: readModRM(c, 1); o(Op.PREFETCH); ins.a = rmOpd(c, 1); return;
    case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f:
      readModRM(c, osz);
      o(Op.NOP);
      return;
    case 0x31: o(Op.RDTSC); return;
    case 0xa2: o(Op.CPUID); return;
    case 0x01: {
      const m = u8(c);
      if (m === 0xd0) { o(Op.XGETBV); return; }
      if (m === 0xd1) { o(Op.XSETBV); return; }
      if (m === 0xf9) { o(Op.RDTSCP); return; }
      throw new DecodeError();
    }
    case 0x77: o(Op.EMMS); return;
    case 0xa3: case 0xab: case 0xb3: case 0xbb: {
      readModRM(c, osz);
      o(b === 0xa3 ? Op.BT : b === 0xab ? Op.BTS : b === 0xb3 ? Op.BTR : Op.BTC);
      ins.a = rmOpd(c, osz);
      ins.b = regOpd(c, osz);
      return;
    }
    case 0xa4: case 0xa5: case 0xac: case 0xad: {
      readModRM(c, osz);
      o(b < 0xa8 ? Op.SHLD : Op.SHRD);
      ins.a = rmOpd(c, osz);
      ins.b = regOpd(c, osz);
      ins.c = (b & 1) ? mkReg(1, 1, 1) : mkImm(u8(c), 1);
      return;
    }
    case 0xae: {
      readModRM(c, 4);
      if (c.mod === 3) {
        const r = c.reg & 7;
        if (r === 5) o(Op.LFENCE);
        else if (r === 6) o(Op.MFENCE);
        else if (r === 7) o(Op.SFENCE);
        else throw new DecodeError();
        return;
      }
      const r = c.reg & 7;
      ins.a = c.rmMem!;
      ins.a.sz = 4;
      switch (r) {
        case 0: o(Op.FXSAVE); ins.a.sz = 512; break;
        case 1: o(Op.FXRSTOR); ins.a.sz = 512; break;
        case 2: o(Op.LDMXCSR); break;
        case 3: o(Op.STMXCSR); break;
        case 4: o(Op.XSAVE); break;
        case 5: o(Op.XRSTOR); break;
        case 7: o(Op.PREFETCH); break; // clflush
        default: throw new DecodeError();
      }
      return;
    }
    case 0xaf: readModRM(c, osz); o(Op.IMUL2); ins.a = regOpd(c, osz); ins.b = rmOpd(c, osz); return;
    case 0xb0: case 0xb1: {
      const sz = b === 0xb0 ? 1 : osz;
      readModRM(c, sz);
      o(Op.CMPXCHG);
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = regOpd(c, sz);
      return;
    }
    case 0xb6: case 0xb7: case 0xbe: case 0xbf: {
      const ssz = (b & 1) ? 2 : 1;
      readModRM(c, ssz);
      o(b < 0xb8 ? Op.MOVZX : Op.MOVSX);
      ins.a = regOpd(c, osz);
      ins.b = rmOpd(c, ssz);
      return;
    }
    case 0xb8: {
      if (pfx !== 0xf3) throw new DecodeError();
      readModRM(c, osz);
      o(Op.POPCNT);
      ins.rep = 0;
      ins.a = regOpd(c, osz);
      ins.b = rmOpd(c, osz);
      return;
    }
    case 0xba: {
      readModRM(c, osz);
      const r = c.reg & 7;
      if (r < 4) throw new DecodeError();
      o([Op.BT, Op.BTS, Op.BTR, Op.BTC][r - 4]);
      ins.a = rmOpd(c, osz);
      ins.b = mkImm(u8(c), 1);
      return;
    }
    case 0xbc: case 0xbd: {
      readModRM(c, osz);
      if (pfx === 0xf3) { o(b === 0xbc ? Op.TZCNT : Op.LZCNT); ins.rep = 0; }
      else o(b === 0xbc ? Op.BSF : Op.BSR);
      ins.a = regOpd(c, osz);
      ins.b = rmOpd(c, osz);
      return;
    }
    case 0xc0: case 0xc1: {
      const sz = b === 0xc0 ? 1 : osz;
      readModRM(c, sz);
      o(Op.XADD);
      ins.osz = sz;
      ins.a = rmOpd(c, sz);
      ins.b = regOpd(c, sz);
      return;
    }
    case 0xc3: {
      readModRM(c, osz);
      o(Op.MOVNTI);
      ins.a = c.rmMem!;
      ins.b = regOpd(c, osz);
      return;
    }
    case 0xc7: {
      readModRM(c, 8);
      const r = c.reg & 7;
      if (c.mod !== 3 && r === 1) {
        o(c.rexW ? Op.CMPXCHG16B : Op.CMPXCHG8B);
        ins.a = c.rmMem!;
        ins.a.sz = c.rexW ? 16 : 8;
        return;
      }
      if (c.mod === 3 && (r === 6 || r === 7)) {
        o(r === 6 ? Op.RDRAND : Op.RDSEED);
        ins.a = mkReg(c.rm, osz, c.rex);
        return;
      }
      throw new DecodeError();
    }
    case 0x38: return decode0F38(c, ins, osz, pfx);
    case 0x3a: return decode0F3A(c, ins, osz, pfx);
  }
  // SSE/SSE2 main table
  decodeSSE(c, ins, b, pfx, osz);
}

type SseEntry = [number, string] | null; // [Op, pattern]

// pattern tokens (comma separated) for operands a,b,c:
//  V    xmm reg (modrm.reg)           W16/W8/W4/W2/W1  xmm-or-mem r/m with given mem size
//  U    xmm reg only (modrm.rm)       M16/M8/M4  memory only
//  Gd   32-bit gpr (modrm.reg)        Gy   gpr (4 or 8 by REX.W)    Ey  gpr/mem 4 or 8 by REX.W
//  Ed   gpr/mem 32                    Eq 64   Ew 16   Eb  8
//  I8   imm8
//  Ud   gpr 32 (modrm.rm)
interface SseSpec {
  [pfx: number]: [string, string] | undefined;
}
const SSE: Record<number, SseSpec> = {
  0x10: { 0: ["MOVUPS", "V,W16"], 0x66: ["MOVUPD", "V,W16"], 0xf3: ["MOVSS", "V,W4"], 0xf2: ["MOVSD_X", "V,W8"] },
  0x11: { 0: ["MOVUPS", "W16,V"], 0x66: ["MOVUPD", "W16,V"], 0xf3: ["MOVSS", "W4,V"], 0xf2: ["MOVSD_X", "W8,V"] },
  0x14: { 0: ["UNPCKLPS", "V,W16"], 0x66: ["UNPCKLPD", "V,W16"] },
  0x15: { 0: ["UNPCKHPS", "V,W16"], 0x66: ["UNPCKHPD", "V,W16"] },
  0x13: { 0: ["MOVLPS", "M8,V"], 0x66: ["MOVLPD", "M8,V"] },
  0x17: { 0: ["MOVHPS", "M8,V"], 0x66: ["MOVHPD", "M8,V"] },
  0x28: { 0: ["MOVAPS", "V,W16"], 0x66: ["MOVAPD", "V,W16"] },
  0x29: { 0: ["MOVAPS", "W16,V"], 0x66: ["MOVAPD", "W16,V"] },
  0x2a: { 0xf3: ["CVTSI2SS", "V,Ey"], 0xf2: ["CVTSI2SD", "V,Ey"] },
  0x2b: { 0: ["MOVNTPS", "M16,V"], 0x66: ["MOVNTPD", "M16,V"] },
  0x2c: { 0xf3: ["CVTTSS2SI", "Gy,W4"], 0xf2: ["CVTTSD2SI", "Gy,W8"] },
  0x2d: { 0xf3: ["CVTSS2SI", "Gy,W4"], 0xf2: ["CVTSD2SI", "Gy,W8"] },
  0x2e: { 0: ["UCOMISS", "V,W4"], 0x66: ["UCOMISD", "V,W8"] },
  0x2f: { 0: ["COMISS", "V,W4"], 0x66: ["COMISD", "V,W8"] },
  0x50: { 0: ["MOVMSKPS", "Gd,U"], 0x66: ["MOVMSKPD", "Gd,U"] },
  0x51: { 0: ["SQRTPS", "V,W16"], 0x66: ["SQRTPD", "V,W16"], 0xf3: ["SQRTSS", "V,W4"], 0xf2: ["SQRTSD", "V,W8"] },
  0x52: { 0: ["RSQRTPS", "V,W16"], 0xf3: ["RSQRTSS", "V,W4"] },
  0x53: { 0: ["RCPPS", "V,W16"], 0xf3: ["RCPSS", "V,W4"] },
  0x54: { 0: ["ANDPS", "V,W16"], 0x66: ["ANDPD", "V,W16"] },
  0x55: { 0: ["ANDNPS", "V,W16"], 0x66: ["ANDNPD", "V,W16"] },
  0x56: { 0: ["ORPS", "V,W16"], 0x66: ["ORPD", "V,W16"] },
  0x57: { 0: ["XORPS", "V,W16"], 0x66: ["XORPD", "V,W16"] },
  0x58: { 0: ["ADDPS", "V,W16"], 0x66: ["ADDPD", "V,W16"], 0xf3: ["ADDSS", "V,W4"], 0xf2: ["ADDSD", "V,W8"] },
  0x59: { 0: ["MULPS", "V,W16"], 0x66: ["MULPD", "V,W16"], 0xf3: ["MULSS", "V,W4"], 0xf2: ["MULSD", "V,W8"] },
  0x5a: { 0: ["CVTPS2PD", "V,W8"], 0x66: ["CVTPD2PS", "V,W16"], 0xf3: ["CVTSS2SD", "V,W4"], 0xf2: ["CVTSD2SS", "V,W8"] },
  0x5b: { 0: ["CVTDQ2PS", "V,W16"], 0x66: ["CVTPS2DQ", "V,W16"], 0xf3: ["CVTTPS2DQ", "V,W16"] },
  0x5c: { 0: ["SUBPS", "V,W16"], 0x66: ["SUBPD", "V,W16"], 0xf3: ["SUBSS", "V,W4"], 0xf2: ["SUBSD", "V,W8"] },
  0x5d: { 0: ["MINPS", "V,W16"], 0x66: ["MINPD", "V,W16"], 0xf3: ["MINSS", "V,W4"], 0xf2: ["MINSD", "V,W8"] },
  0x5e: { 0: ["DIVPS", "V,W16"], 0x66: ["DIVPD", "V,W16"], 0xf3: ["DIVSS", "V,W4"], 0xf2: ["DIVSD", "V,W8"] },
  0x5f: { 0: ["MAXPS", "V,W16"], 0x66: ["MAXPD", "V,W16"], 0xf3: ["MAXSS", "V,W4"], 0xf2: ["MAXSD", "V,W8"] },
  0x60: { 0x66: ["PUNPCKLBW", "V,W16"] },
  0x61: { 0x66: ["PUNPCKLWD", "V,W16"] },
  0x62: { 0x66: ["PUNPCKLDQ", "V,W16"] },
  0x63: { 0x66: ["PACKSSWB", "V,W16"] },
  0x64: { 0x66: ["PCMPGTB", "V,W16"] },
  0x65: { 0x66: ["PCMPGTW", "V,W16"] },
  0x66: { 0x66: ["PCMPGTD", "V,W16"] },
  0x67: { 0x66: ["PACKUSWB", "V,W16"] },
  0x68: { 0x66: ["PUNPCKHBW", "V,W16"] },
  0x69: { 0x66: ["PUNPCKHWD", "V,W16"] },
  0x6a: { 0x66: ["PUNPCKHDQ", "V,W16"] },
  0x6b: { 0x66: ["PACKSSDW", "V,W16"] },
  0x6c: { 0x66: ["PUNPCKLQDQ", "V,W16"] },
  0x6d: { 0x66: ["PUNPCKHQDQ", "V,W16"] },
  0x6e: { 0x66: ["MOVD", "V,Ey"] },
  0x6f: { 0x66: ["MOVDQA", "V,W16"], 0xf3: ["MOVDQU", "V,W16"] },
  0x70: { 0x66: ["PSHUFD", "V,W16,I8"], 0xf3: ["PSHUFHW", "V,W16,I8"], 0xf2: ["PSHUFLW", "V,W16,I8"] },
  0x74: { 0x66: ["PCMPEQB", "V,W16"] },
  0x75: { 0x66: ["PCMPEQW", "V,W16"] },
  0x76: { 0x66: ["PCMPEQD", "V,W16"] },
  0x7c: { 0x66: ["HADDPD", "V,W16"], 0xf2: ["HADDPS", "V,W16"] },
  0x7d: { 0x66: ["HSUBPD", "V,W16"], 0xf2: ["HSUBPS", "V,W16"] },
  0x7e: { 0x66: ["MOVD", "Ey,V"], 0xf3: ["MOVQ", "V,W8"] },
  0x7f: { 0x66: ["MOVDQA", "W16,V"], 0xf3: ["MOVDQU", "W16,V"] },
  0xc2: { 0: ["CMPPS", "V,W16,I8"], 0x66: ["CMPPD", "V,W16,I8"], 0xf3: ["CMPSS", "V,W4,I8"], 0xf2: ["CMPSD_X", "V,W8,I8"] },
  0xc4: { 0x66: ["PINSRW", "V,Ed,I8"] },
  0xc5: { 0x66: ["PEXTRW", "Gd,U,I8"] },
  0xc6: { 0: ["SHUFPS", "V,W16,I8"], 0x66: ["SHUFPD", "V,W16,I8"] },
  0xd0: { 0x66: ["ADDSUBPD", "V,W16"], 0xf2: ["ADDSUBPS", "V,W16"] },
  0xd1: { 0x66: ["PSRLW", "V,W16"] },
  0xd2: { 0x66: ["PSRLD", "V,W16"] },
  0xd3: { 0x66: ["PSRLQ", "V,W16"] },
  0xd4: { 0x66: ["PADDQ", "V,W16"] },
  0xd5: { 0x66: ["PMULLW", "V,W16"] },
  0xd6: { 0x66: ["MOVQ", "W8,V"], 0xf3: ["MOVQ2DQ", "V,Um"] },
  0xd7: { 0x66: ["PMOVMSKB", "Gd,U"] },
  0xd8: { 0x66: ["PSUBUSB", "V,W16"] },
  0xd9: { 0x66: ["PSUBUSW", "V,W16"] },
  0xda: { 0x66: ["PMINUB", "V,W16"] },
  0xdb: { 0x66: ["PAND", "V,W16"] },
  0xdc: { 0x66: ["PADDUSB", "V,W16"] },
  0xdd: { 0x66: ["PADDUSW", "V,W16"] },
  0xde: { 0x66: ["PMAXUB", "V,W16"] },
  0xdf: { 0x66: ["PANDN", "V,W16"] },
  0xe0: { 0x66: ["PAVGB", "V,W16"] },
  0xe1: { 0x66: ["PSRAW", "V,W16"] },
  0xe2: { 0x66: ["PSRAD", "V,W16"] },
  0xe3: { 0x66: ["PAVGW", "V,W16"] },
  0xe4: { 0x66: ["PMULHUW", "V,W16"] },
  0xe5: { 0x66: ["PMULHW", "V,W16"] },
  0xe6: { 0x66: ["CVTTPD2DQ", "V,W16"], 0xf3: ["CVTDQ2PD", "V,W8"], 0xf2: ["CVTPD2DQ", "V,W16"] },
  0xe7: { 0x66: ["MOVNTDQ", "M16,V"] },
  0xe8: { 0x66: ["PSUBSB", "V,W16"] },
  0xe9: { 0x66: ["PSUBSW", "V,W16"] },
  0xea: { 0x66: ["PMINSW", "V,W16"] },
  0xeb: { 0x66: ["POR", "V,W16"] },
  0xec: { 0x66: ["PADDSB", "V,W16"] },
  0xed: { 0x66: ["PADDSW", "V,W16"] },
  0xee: { 0x66: ["PMAXSW", "V,W16"] },
  0xef: { 0x66: ["PXOR", "V,W16"] },
  0xf0: { 0xf2: ["LDDQU", "V,M16"] },
  0xf1: { 0x66: ["PSLLW", "V,W16"] },
  0xf2: { 0x66: ["PSLLD", "V,W16"] },
  0xf3: { 0x66: ["PSLLQ", "V,W16"] },
  0xf4: { 0x66: ["PMULUDQ", "V,W16"] },
  0xf5: { 0x66: ["PMADDWD", "V,W16"] },
  0xf6: { 0x66: ["PSADBW", "V,W16"] },
  0xf7: { 0x66: ["MASKMOVDQU", "V,U"] },
  0xf8: { 0x66: ["PSUBB", "V,W16"] },
  0xf9: { 0x66: ["PSUBW", "V,W16"] },
  0xfa: { 0x66: ["PSUBD", "V,W16"] },
  0xfb: { 0x66: ["PSUBQ", "V,W16"] },
  0xfc: { 0x66: ["PADDB", "V,W16"] },
  0xfd: { 0x66: ["PADDW", "V,W16"] },
  0xfe: { 0x66: ["PADDD", "V,W16"] },
};

// 0F 38 xx map (66-prefixed SSSE3/SSE4)
const SSE38: Record<number, [string, string]> = {
  0x00: ["PSHUFB", "V,W16"], 0x01: ["PHADDW", "V,W16"], 0x02: ["PHADDD", "V,W16"], 0x03: ["PHADDSW", "V,W16"],
  0x04: ["PMADDUBSW", "V,W16"], 0x05: ["PHSUBW", "V,W16"], 0x06: ["PHSUBD", "V,W16"], 0x07: ["PHSUBSW", "V,W16"],
  0x08: ["PSIGNB", "V,W16"], 0x09: ["PSIGNW", "V,W16"], 0x0a: ["PSIGND", "V,W16"], 0x0b: ["PMULHRSW", "V,W16"],
  0x10: ["PBLENDVB", "V,W16"], 0x14: ["BLENDVPS", "V,W16"], 0x15: ["BLENDVPD", "V,W16"], 0x17: ["PTEST", "V,W16"],
  0x1c: ["PABSB", "V,W16"], 0x1d: ["PABSW", "V,W16"], 0x1e: ["PABSD", "V,W16"],
  0x20: ["PMOVSXBW", "V,W8"], 0x21: ["PMOVSXBD", "V,W4"], 0x22: ["PMOVSXBQ", "V,W2"],
  0x23: ["PMOVSXWD", "V,W8"], 0x24: ["PMOVSXWQ", "V,W4"], 0x25: ["PMOVSXDQ", "V,W8"],
  0x28: ["PMULDQ", "V,W16"], 0x29: ["PCMPEQQ", "V,W16"], 0x2a: ["MOVNTDQA", "V,M16"], 0x2b: ["PACKUSDW", "V,W16"],
  0x30: ["PMOVZXBW", "V,W8"], 0x31: ["PMOVZXBD", "V,W4"], 0x32: ["PMOVZXBQ", "V,W2"],
  0x33: ["PMOVZXWD", "V,W8"], 0x34: ["PMOVZXWQ", "V,W4"], 0x35: ["PMOVZXDQ", "V,W8"],
  0x37: ["PCMPGTQ", "V,W16"], 0x38: ["PMINSB", "V,W16"], 0x39: ["PMINSD", "V,W16"], 0x3a: ["PMINUW", "V,W16"],
  0x3b: ["PMINUD", "V,W16"], 0x3c: ["PMAXSB", "V,W16"], 0x3d: ["PMAXSD", "V,W16"], 0x3e: ["PMAXUW", "V,W16"],
  0x3f: ["PMAXUD", "V,W16"], 0x40: ["PMULLD", "V,W16"], 0x41: ["PHMINPOSUW", "V,W16"],
  0xdb: ["AESIMC", "V,W16"], 0xdc: ["AESENC", "V,W16"], 0xdd: ["AESENCLAST", "V,W16"],
  0xde: ["AESDEC", "V,W16"], 0xdf: ["AESDECLAST", "V,W16"],
};
const SSE3A: Record<number, [string, string]> = {
  0x08: ["ROUNDPS", "V,W16,I8"], 0x09: ["ROUNDPD", "V,W16,I8"], 0x0a: ["ROUNDSS", "V,W4,I8"], 0x0b: ["ROUNDSD", "V,W8,I8"],
  0x0c: ["BLENDPS", "V,W16,I8"], 0x0d: ["BLENDPD", "V,W16,I8"], 0x0e: ["PBLENDW", "V,W16,I8"], 0x0f: ["PALIGNR", "V,W16,I8"],
  0x14: ["PEXTRB", "Ed,V,I8"], 0x15: ["PEXTRW", "Ed,V,I8"], 0x16: ["PEXTRD", "Ey,V,I8"], 0x17: ["EXTRACTPS", "Ed,V,I8"],
  0x20: ["PINSRB", "V,Ed,I8"], 0x21: ["INSERTPS", "V,W4,I8"], 0x22: ["PINSRD", "V,Ey,I8"],
  0x40: ["DPPS", "V,W16,I8"], 0x41: ["DPPD", "V,W16,I8"], 0x42: ["MPSADBW", "V,W16,I8"], 0x44: ["PCLMULQDQ", "V,W16,I8"],
  0x60: ["PCMPESTRM", "V,W16,I8"], 0x61: ["PCMPESTRI", "V,W16,I8"], 0x62: ["PCMPISTRM", "V,W16,I8"], 0x63: ["PCMPISTRI", "V,W16,I8"],
  0xdf: ["AESKEYGENASSIST", "V,W16,I8"],
};

function applyPattern(c: Ctx, ins: Insn, pattern: string, osz: number) {
  const toks = pattern.split(",");
  const slots: Opd[] = [];
  // determine whether we need modrm: always for these tables
  readModRM(c, 16);
  for (const t of toks) {
    let o: Opd;
    switch (t) {
      case "V": o = mkXmm(c.reg); break;
      case "U": o = mkXmm(c.rm); if (c.rmMem) throw new DecodeError(); break;
      case "Um": o = mkXmm(c.rm, 8); if (c.rmMem) throw new DecodeError(); break; // MMX source in MOVQ2DQ; unsupported
      case "W16": o = rmXmm(c, 16); break;
      case "W8": o = rmXmm(c, 8); break;
      case "W4": o = rmXmm(c, 4); break;
      case "W2": o = rmXmm(c, 2); break;
      case "M16": if (!c.rmMem) throw new DecodeError(); o = rmXmm(c, 16); break;
      case "M8": if (!c.rmMem) throw new DecodeError(); o = rmXmm(c, 8); break;
      case "Gd": o = mkReg(c.reg, 4, c.rex); break;
      case "Gy": o = mkReg(c.reg, c.rexW ? 8 : 4, c.rex); break;
      case "Ey": o = rmOpd(c, c.rexW ? 8 : 4); break;
      case "Ed": o = rmOpd(c, 4); break;
      case "I8": o = mkImm(u8(c), 1); break;
      default: throw new Error("bad SSE pattern " + t);
    }
    slots.push(o);
  }
  ins.a = slots[0];
  if (slots[1]) ins.b = slots[1];
  if (slots[2]) ins.c = slots[2];
}

function decodeSSE(c: Ctx, ins: Insn, b: number, pfx: number, osz: number) {
  // group shifts with immediate
  if (b === 0x71 || b === 0x72 || b === 0x73) {
    if (pfx !== 0x66) throw new DecodeError(); // MMX forms unsupported
    readModRM(c, 16);
    if (c.mod !== 3) throw new DecodeError();
    const r = c.reg & 7;
    let name: string | null = null;
    if (b === 0x71) name = r === 2 ? "PSRLW_I" : r === 4 ? "PSRAW_I" : r === 6 ? "PSLLW_I" : null;
    else if (b === 0x72) name = r === 2 ? "PSRLD_I" : r === 4 ? "PSRAD_I" : r === 6 ? "PSLLD_I" : null;
    else name = r === 2 ? "PSRLQ_I" : r === 3 ? "PSRLDQ" : r === 6 ? "PSLLQ_I" : r === 7 ? "PSLLDQ" : null;
    if (!name) throw new DecodeError();
    ins.op = Op[name];
    ins.a = mkXmm(c.rm);
    ins.b = mkImm(u8(c), 1);
    return;
  }
  // 0F 12 / 0F 16 have register/memory dependent forms
  if (b === 0x12 || b === 0x16) {
    readModRM(c, 8);
    if (b === 0x12) {
      if (pfx === 0xf2) { ins.op = Op.MOVDDUP; ins.a = mkXmm(c.reg); ins.b = rmXmm(c, 8); return; }
      if (pfx === 0xf3) { ins.op = Op.MOVSLDUP; ins.a = mkXmm(c.reg); ins.b = rmXmm(c, 16); return; }
      if (pfx === 0x66) { if (!c.rmMem) throw new DecodeError(); ins.op = Op.MOVLPD; ins.a = mkXmm(c.reg); ins.b = rmXmm(c, 8); return; }
      ins.op = c.rmMem ? Op.MOVLPS : Op.MOVHLPS;
    } else {
      if (pfx === 0xf3) { ins.op = Op.MOVSHDUP; ins.a = mkXmm(c.reg); ins.b = rmXmm(c, 16); return; }
      if (pfx === 0x66) { if (!c.rmMem) throw new DecodeError(); ins.op = Op.MOVHPD; ins.a = mkXmm(c.reg); ins.b = rmXmm(c, 8); return; }
      ins.op = c.rmMem ? Op.MOVHPS : Op.MOVLHPS;
    }
    ins.a = mkXmm(c.reg);
    ins.b = rmXmm(c, 8);
    return;
  }
  const spec = SSE[b];
  if (!spec) throw new DecodeError();
  const ent = spec[pfx] ?? (pfx !== 0 && b !== 0x6f ? undefined : undefined);
  if (!ent) throw new DecodeError();
  const [name, pat] = ent;
  ins.op = Op[name];
  if (ins.op === undefined) throw new Error("unknown op " + name);
  // prefix bytes 66/F3/F2 were consumed as mandatory prefixes; clear rep so string handling is not confused
  if (pfx === 0xf3 || pfx === 0xf2) ins.rep = 0;
  applyPattern(c, ins, pat, ins.osz);
  // MOVD/MOVQ with REX.W is MOVQ between gpr and xmm
  if (ins.op === Op.MOVD && c.rexW) ins.op = Op.MOVD; // size is carried in the Ey operand
}

function decode0F38(c: Ctx, ins: Insn, osz: number, pfx: number) {
  const b = u8(c);
  ins.opc = 0x20000 | b;
  if (b === 0xf0 || b === 0xf1) {
    if (pfx === 0xf2) {
      // CRC32 r, r/m
      const ssz = b === 0xf0 ? 1 : (c.osz16 ? 2 : c.rexW ? 8 : 4);
      readModRM(c, ssz);
      ins.op = Op.CRC32;
      ins.rep = 0;
      ins.a = mkReg(c.reg, c.rexW ? 8 : 4, c.rex);
      ins.b = rmOpd(c, ssz);
      ins.osz = ssz;
      return;
    }
    readModRM(c, osz);
    if (!c.rmMem) throw new DecodeError();
    ins.op = Op.MOVBE;
    if (b === 0xf0) { ins.a = regOpd(c, osz); ins.b = c.rmMem; } else { ins.a = c.rmMem; ins.b = regOpd(c, osz); }
    return;
  }
  if (pfx !== 0x66) throw new DecodeError();
  const ent = SSE38[b];
  if (!ent) throw new DecodeError();
  ins.op = Op[ent[0]];
  applyPattern(c, ins, ent[1], osz);
}

function decode0F3A(c: Ctx, ins: Insn, osz: number, pfx: number) {
  const b = u8(c);
  ins.opc = 0x30000 | b;
  if (pfx !== 0x66) throw new DecodeError();
  const ent = SSE3A[b];
  if (!ent) throw new DecodeError();
  ins.op = Op[ent[0]];
  applyPattern(c, ins, ent[1], osz);
  if (ins.op === Op.PEXTRQ || ins.op === Op.PINSRQ) return;
  if (ins.op === Op.PEXTRD && c.rexW) ins.op = Op.PEXTRQ;
  else if (ins.op === Op.PINSRD && c.rexW) ins.op = Op.PINSRQ;
}

function decodeVEX(_c: Ctx, _ins: Insn, _b: number) {
  // VEX-encoded (AVX/BMI) instructions are not advertised through CPUID; treat as invalid.
  throw new DecodeError();
}

// ---------------------------------------------------------------------------------------------
// Disassembly (diagnostics only)
// ---------------------------------------------------------------------------------------------
const R64 = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const R32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi", "r8d", "r9d", "r10d", "r11d", "r12d", "r13d", "r14d", "r15d"];
const R16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di", "r8w", "r9w", "r10w", "r11w", "r12w", "r13w", "r14w", "r15w"];
const R8 = ["al", "cl", "dl", "bl", "spl", "bpl", "sil", "dil", "r8b", "r9b", "r10b", "r11b", "r12b", "r13b", "r14b", "r15b"];
const R8H = ["ah", "ch", "dh", "bh"];

export function regName(r: number, sz: number, hi8 = false): string {
  if (sz === 8) return R64[r];
  if (sz === 4) return R32[r];
  if (sz === 2) return R16[r];
  return hi8 ? R8H[r] : R8[r];
}

export function fmtOpd(o: Opd): string {
  switch (o.k) {
    case K_REG: return regName(o.r, o.sz, o.hi8);
    case K_XMM: return "xmm" + o.r;
    case K_IMM: return "0x" + (o.sz === 8 && o.imm64 ? o.imm64.toString(16) : (o.imm >>> 0).toString(16));
    case K_MEM: {
      let s = `${{ 1: "byte", 2: "word", 4: "dword", 8: "qword", 16: "xmmword" }[o.sz as 1] ?? "ptr"} [`;
      const parts: string[] = [];
      if (o.base >= 0) parts.push(R64[o.base]);
      if (o.index >= 0) parts.push(R64[o.index] + (o.scale > 1 ? "*" + o.scale : ""));
      if (o.disp || !parts.length) parts.push((o.disp < 0 ? "-0x" + (-o.disp).toString(16) : "0x" + (o.disp >>> 0).toString(16)));
      return s + parts.join("+") + "]";
    }
  }
  return "?";
}

export function fmtInsn(i: Insn): string {
  let s = opName(i.op).toLowerCase();
  if (i.op === Op.JCC || i.op === Op.SETCC || i.op === Op.CMOVCC) s = s.replace("cc", CC_NAMES[i.cc]);
  const ops = [i.a, i.b, i.c].filter((o) => o.k !== K_NONE).map(fmtOpd);
  if (i.rep) s = (i.rep === 1 ? "rep " : "repne ") + s;
  if (i.op === Op.X87) s += ` esc=${(i.fpu >> 8) + 0xd8}/${(i.fpu & 255).toString(16)}`;
  return s + (ops.length ? " " + ops.join(", ") : "") + (i.osz !== 4 ? ` ;osz${i.osz}` : "");
}
