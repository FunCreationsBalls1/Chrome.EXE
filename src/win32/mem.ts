// Typed access to guest memory for HLE code.
import type { Machine } from "../jit/machine.ts";

const td = new TextDecoder("utf-8");
const te = new TextEncoder();

export class GuestMem {
  readonly m: Machine;
  constructor(m: Machine) {
    this.m = m;
  }
  get u8a(): Uint8Array { return this.m.u8; }
  get dv(): DataView { return this.m.dv; }
  r8(a: number) { return this.m.u8[a >>> 0]; }
  r16(a: number) { return this.m.dv.getUint16(a >>> 0, true); }
  r32(a: number) { return this.m.dv.getUint32(a >>> 0, true); }
  ri32(a: number) { return this.m.dv.getInt32(a >>> 0, true); }
  r64(a: number) { return this.m.dv.getBigUint64(a >>> 0, true); }
  /** read a 64-bit value as a JS number (exact up to 2^53) */
  r64n(a: number) {
    const lo = this.m.dv.getUint32(a >>> 0, true), hi = this.m.dv.getUint32((a >>> 0) + 4, true);
    return hi * 4294967296 + lo;
  }
  rf32(a: number) { return this.m.dv.getFloat32(a >>> 0, true); }
  rf64(a: number) { return this.m.dv.getFloat64(a >>> 0, true); }
  w8(a: number, v: number) { this.m.u8[a >>> 0] = v; }
  w16(a: number, v: number) { this.m.dv.setUint16(a >>> 0, v & 0xffff, true); }
  w32(a: number, v: number) { this.m.dv.setUint32(a >>> 0, v >>> 0, true); }
  w64(a: number, v: bigint | number) { this.m.dv.setBigUint64(a >>> 0, BigInt.asUintN(64, BigInt(v)), true); }
  /** write a number as a 64-bit unsigned value (pointer sized, < 2^53) */
  wptr(a: number, v: number) {
    this.m.dv.setUint32(a >>> 0, v >>> 0, true);
    this.m.dv.setUint32((a >>> 0) + 4, Math.floor(v / 4294967296) >>> 0, true);
  }
  wf32(a: number, v: number) { this.m.dv.setFloat32(a >>> 0, v, true); }
  wf64(a: number, v: number) { this.m.dv.setFloat64(a >>> 0, v, true); }
  /** NUL-terminated byte string decoded as latin1 (ANSI code page approximation) */
  cstr(a: number, max = 1 << 20): string {
    if (!a) return "";
    const u = this.m.u8;
    let e = a >>> 0;
    const lim = Math.min(u.length, e + max);
    while (e < lim && u[e]) e++;
    let s = "";
    for (let i = a >>> 0; i < e; i++) s += String.fromCharCode(u[i]);
    return s;
  }
  /** NUL-terminated UTF-16LE string */
  wstr(a: number, maxChars = 1 << 20): string {
    if (!a) return "";
    const u = this.m.u8;
    let e = a >>> 0;
    const lim = Math.min(u.length - 1, e + maxChars * 2);
    while (e < lim && (u[e] | u[e + 1])) e += 2;
    return new TextDecoder("utf-16le").decode(u.subarray(a >>> 0, e));
  }
  wstrn(a: number, nChars: number): string {
    return new TextDecoder("utf-16le").decode(this.m.u8.subarray(a >>> 0, (a >>> 0) + nChars * 2));
  }
  bytes(a: number, n: number): Uint8Array {
    return this.m.u8.subarray(a >>> 0, (a >>> 0) + n);
  }
  write(a: number, data: ArrayLike<number>) {
    this.m.u8.set(data as ArrayLike<number>, a >>> 0);
  }
  fill(a: number, v: number, n: number) {
    this.m.u8.fill(v, a >>> 0, (a >>> 0) + n);
  }
  copy(dst: number, src: number, n: number) {
    this.m.u8.copyWithin(dst >>> 0, src >>> 0, (src >>> 0) + n);
  }
  /** write ANSI string with NUL; returns bytes written (incl. NUL). Truncates to cap bytes (including NUL) if cap >= 0. */
  wcstr(a: number, s: string, cap = -1): number {
    let n = s.length + 1;
    if (cap >= 0 && n > cap) n = cap;
    for (let i = 0; i < n - 1; i++) this.m.u8[(a >>> 0) + i] = s.charCodeAt(i) & 0xff;
    if (n > 0) this.m.u8[(a >>> 0) + n - 1] = 0;
    return n;
  }
  /** write UTF-16 string with NUL; cap in chars (including NUL) */
  wwstr(a: number, s: string, cap = -1): number {
    let n = s.length + 1;
    if (cap >= 0 && n > cap) n = cap;
    for (let i = 0; i < n - 1; i++) this.m.dv.setUint16((a >>> 0) + i * 2, s.charCodeAt(i), true);
    if (n > 0) this.m.dv.setUint16((a >>> 0) + (n - 1) * 2, 0, true);
    return n;
  }
}
export { td, te };
