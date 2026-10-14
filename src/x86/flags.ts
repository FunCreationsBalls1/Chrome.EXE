// Per-instruction EFLAGS dataflow: which arithmetic flags an instruction consumes and which it definitely overwrites.
// Used for dead-flag elimination in the translator. Flags that an instruction leaves *undefined* count as overwritten.
import { Op } from "./ops.ts";
import { Insn, K_IMM, K_NONE } from "./decode.ts";
import { F_AF, F_CF, F_OF, F_PF, F_SF, F_ZF, F_ARITH } from "../jit/layout.ts";

/** Flags read by each condition code. */
export const CC_READS: number[] = [
  F_OF, F_OF, F_CF, F_CF, F_ZF, F_ZF, F_CF | F_ZF, F_CF | F_ZF,
  F_SF, F_SF, F_PF, F_PF, F_SF | F_OF, F_SF | F_OF, F_ZF | F_SF | F_OF, F_ZF | F_SF | F_OF,
];

const ALL = F_ARITH;

export interface FlagInfo {
  /** flags whose value influences the instruction's result */
  rd: number;
  /** flags unconditionally overwritten (defined or undefined) */
  kill: number;
}

const NONE: FlagInfo = { rd: 0, kill: 0 };
const KILL_ALL: FlagInfo = { rd: 0, kill: ALL };

function shiftInfo(ins: Insn, cnt = ins.b): FlagInfo {
  // count source: imm or CL. A zero (masked) count leaves flags untouched.
  if (cnt.k === K_IMM) {
    const mask = ins.osz === 8 ? 63 : 31;
    if ((cnt.imm & mask) === 0) return NONE;
    return KILL_ALL;
  }
  return NONE; // variable count: may leave all flags unchanged (nothing definitely killed)
}

function rotInfo(ins: Insn, usesCarry: boolean): FlagInfo {
  const cnt = ins.b;
  let mask = ins.osz === 8 ? 63 : 31;
  let c = -1;
  if (cnt.k === K_IMM) c = cnt.imm & mask;
  const rd = usesCarry ? F_CF : 0;
  if (c === 0) return NONE;
  // rotates only touch CF and OF
  if (c > 0) return { rd, kill: F_CF | F_OF };
  return { rd, kill: 0 };
}

export function flagInfo(ins: Insn): FlagInfo {
  switch (ins.op) {
    case Op.ADD: case Op.SUB: case Op.CMP: case Op.AND: case Op.OR: case Op.XOR: case Op.TEST:
    case Op.NEG: case Op.MUL: case Op.IMUL1: case Op.IMUL2: case Op.IMUL3: case Op.DIV: case Op.IDIV:
    case Op.XADD: case Op.CMPXCHG:
    case Op.BSF: case Op.BSR: case Op.TZCNT: case Op.LZCNT: case Op.POPCNT:
    case Op.COMISS: case Op.COMISD: case Op.UCOMISS: case Op.UCOMISD: case Op.PTEST:
    case Op.PCMPESTRI: case Op.PCMPISTRI: case Op.PCMPESTRM: case Op.PCMPISTRM:
    case Op.RDRAND: case Op.RDSEED:
      return KILL_ALL;
    case Op.ADC: case Op.SBB:
      return { rd: F_CF, kill: ALL };
    case Op.INC: case Op.DEC:
      return { rd: 0, kill: ALL & ~F_CF };
    case Op.SHL: case Op.SHR: case Op.SAR:
      return shiftInfo(ins);
    case Op.SHLD: case Op.SHRD:
      return shiftInfo(ins, ins.c);
    case Op.ROL: case Op.ROR:
      return rotInfo(ins, false);
    case Op.RCL: case Op.RCR:
      return rotInfo(ins, true);
    case Op.BT: case Op.BTS: case Op.BTR: case Op.BTC:
      return { rd: 0, kill: ALL & ~F_ZF };
    case Op.JCC: case Op.SETCC: case Op.CMOVCC:
      return { rd: CC_READS[ins.cc], kill: 0 };
    case Op.CLC: case Op.STC:
      return { rd: 0, kill: F_CF };
    case Op.CMC:
      return { rd: F_CF, kill: F_CF };
    case Op.LAHF:
      return { rd: F_SF | F_ZF | F_AF | F_PF | F_CF, kill: 0 };
    case Op.SAHF:
      return { rd: 0, kill: F_SF | F_ZF | F_AF | F_PF | F_CF };
    case Op.PUSHF:
      return { rd: ALL, kill: 0 };
    case Op.POPF:
      return KILL_ALL;
    case Op.CMPXCHG8B: case Op.CMPXCHG16B:
      return { rd: 0, kill: F_ZF };
    case Op.CMPS: case Op.SCAS:
      return ins.rep ? NONE : KILL_ALL;
    case Op.X87: {
      // FCOMI/FUCOMI/FCOMIP/FUCOMIP set ZF PF CF (and clear OF SF AF); FCMOVcc reads CF/ZF/PF.
      const esc = ins.fpu >> 8, modrm = ins.fpu & 255;
      if ((esc === 3 || esc === 7) && modrm >= 0xe8 && modrm <= 0xf7) return KILL_ALL;
      if (esc === 2 && modrm >= 0xc0 && modrm < 0xe0) return { rd: F_CF | F_ZF | F_PF, kill: 0 };
      if (esc === 3 && modrm >= 0xc0 && modrm < 0xe0) return { rd: F_CF | F_ZF | F_PF, kill: 0 };
      return NONE;
    }
    default:
      return NONE;
  }
}

/** Does this instruction end the straight-line flow (so all flags must be assumed live afterwards)? */
export function isTerminator(op: number): boolean {
  switch (op) {
    case Op.JMP: case Op.JMP_IND: case Op.CALL: case Op.CALL_IND: case Op.RET: case Op.RET_IMM:
    case Op.HLT: case Op.UD2: case Op.INT3: case Op.INT: case Op.INVALID: case Op.SYSCALL:
      return true;
  }
  return false;
}

export { K_NONE };
