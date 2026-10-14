// x87 FPU and FXSAVE/FXRSTOR: dispatched to the C runtime (double-precision FPU model operating on the CPU state).
import { O, VT } from "../wasm/opcodes.ts";
import { Gen, IMP } from "./gen.ts";
import { Insn } from "../x86/decode.ts";
import { Op } from "../x86/ops.ts";

const { i32: I32 } = VT;

export function translateX87(g: Gen, ins: Insn): boolean {
  const f = g.f;
  if (ins.op === Op.FXSAVE || ins.op === Op.FXRSTOR) {
    g.writebackAll();
    const off = g.emitEA(ins.a);
    if (off) f.i32(off).op(O.i32_add);
    f.call(ins.op === Op.FXSAVE ? IMP.fxsave : IMP.fxrstor);
    if (ins.op === Op.FXRSTOR) for (let r = 0; r < 16; r++) if (g.xmm[r] >= 0) g.reloadXmm(r);
    return true;
  }
  if (ins.op !== Op.X87) return false;
  const esc = ins.fpu >> 8;
  const modrm = ins.fpu & 255;
  const mem = modrm >> 6 !== 3;
  f.i32(esc).i32(modrm);
  if (mem) {
    const off = g.emitEA(ins.a);
    if (off) f.i32(off).op(O.i32_add);
  } else if ((esc === 2 || esc === 3) && modrm >= 0xc0 && modrm < 0xe0) {
    // FCMOVcc: pass the evaluated condition
    const kind = (modrm >> 3) & 3; // B, E, BE, U
    const base = [2, 4, 6, 10][kind];
    g.emitCond(esc === 3 ? base + 1 : base);
  } else f.i32(0);
  f.call(IMP.x87);
  if (esc === 7 && modrm === 0xe0) {
    g.writeReg(0, 2); // FNSTSW AX
  } else if ((esc === 3 || esc === 7) && !mem && modrm >= 0xe8 && modrm <= 0xf7) {
    // FCOMI / FUCOMI(P): CF/ZF/PF from the result
    f.i32(0x45).op(O.i32_and);
    g.setFlagsFromEflags();
  } else f.op(O.drop);
  return true;
}

export { I32 };
