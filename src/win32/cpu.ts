// Win64 calling-convention view of the CPU state for HLE handlers (called when a guest `call` lands on a thunk).
import type { Machine } from "../jit/machine.ts";
import * as L from "../jit/layout.ts";

export const RAX = 0, RCX = 1, RDX = 2, RBX = 3, RSP = 4, RBP = 5, RSI = 6, RDI = 7, R8 = 8, R9 = 9;

export class Cpu {
  readonly m: Machine;
  constructor(m: Machine) {
    this.m = m;
  }
  get rsp(): number { return this.m.dv.getUint32(L.gprOff(RSP), true); }
  set rsp(v: number) { this.m.dv.setBigUint64(L.gprOff(RSP), BigInt(v >>> 0), true); }
  /** address of the return address on the stack (at thunk entry rsp points to it) */
  get retAddr(): number { return this.m.dv.getUint32(this.rsp, true); }

  private argAddr(i: number): number {
    return this.rsp + 8 + 8 * i; // shadow space occupies args 0-3's home slots, stack args follow
  }
  /** low 32 bits of integer argument i */
  arg(i: number): number {
    if (i < 4) return this.m.dv.getUint32(L.gprOff([RCX, RDX, R8, R9][i]), true);
    return this.m.dv.getUint32(this.argAddr(i), true);
  }
  /** signed 32-bit */
  argI(i: number): number {
    return this.arg(i) | 0;
  }
  argHi(i: number): number {
    if (i < 4) return this.m.dv.getUint32(L.gprOff([RCX, RDX, R8, R9][i]) + 4, true);
    return this.m.dv.getUint32(this.argAddr(i) + 4, true);
  }
  /** full 64-bit argument */
  arg64(i: number): bigint {
    return (BigInt(this.argHi(i)) << 32n) | BigInt(this.arg(i));
  }
  /** 64-bit as a JS number (exact up to 2^53) */
  argN(i: number): number {
    return this.argHi(i) * 4294967296 + this.arg(i);
  }
  argF32(i: number): number {
    return this.m.dv.getFloat32(L.xmmOff(i), true);
  }
  argF64(i: number): number {
    return this.m.dv.getFloat64(L.xmmOff(i), true);
  }

  /** set the integer return value (rax) */
  ret(v: number | bigint | boolean): void {
    const dv = this.m.dv;
    if (typeof v === "bigint") dv.setBigUint64(L.gprOff(RAX), BigInt.asUintN(64, v), true);
    else if (typeof v === "boolean") dv.setBigUint64(L.gprOff(RAX), v ? 1n : 0n, true);
    else {
      // numbers are interpreted as signed 32-bit if negative, else as unsigned up to 2^53
      if (v < 0) dv.setBigUint64(L.gprOff(RAX), BigInt.asUintN(64, BigInt(Math.trunc(v))), true);
      else {
        dv.setUint32(L.gprOff(RAX), v >>> 0, true);
        dv.setUint32(L.gprOff(RAX) + 4, Math.floor(v / 4294967296) >>> 0, true);
      }
    }
  }
  retF64(v: number): void {
    this.m.dv.setFloat64(L.xmmOff(0), v, true);
  }
  retF32(v: number): void {
    this.m.dv.setFloat32(L.xmmOff(0), v, true);
  }
  gpr(i: number): bigint { return this.m.gpr(i); }
  setGpr(i: number, v: bigint | number): void { this.m.setGpr(i, v); }
}
