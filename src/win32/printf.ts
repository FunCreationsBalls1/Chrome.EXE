// printf-style formatting with Win64 va_list semantics (used by ntdll!_vsnprintf, user32!wsprintf, ...).
import type { GuestMem } from "./mem.ts";

export interface ArgSource {
  /** next 64-bit integer argument */
  int(): bigint;
  /** next double argument */
  dbl(): number;
}

/** Win64 va_list: a pointer to consecutive 8-byte slots (floats are passed as doubles in the same slots). */
export class VaList implements ArgSource {
  mem: GuestMem;
  ptr: number;
  constructor(mem: GuestMem, ptr: number) { this.mem = mem; this.ptr = ptr; }
  int(): bigint { const v = this.mem.r64(this.ptr); this.ptr += 8; return v; }
  dbl(): number { const v = this.mem.rf64(this.ptr); this.ptr += 8; return v; }
}
/** Variadic args supplied directly (already extracted by the caller). */
export class ArrayArgs implements ArgSource {
  i = 0;
  vals: bigint[];
  constructor(vals: bigint[]) { this.vals = vals; }
  int(): bigint { return this.vals[this.i++] ?? 0n; }
  dbl(): number { const b = this.vals[this.i++] ?? 0n; const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, b, true); return dv.getFloat64(0, true); }
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + " ".repeat(width - s.length);
  if (zero) {
    const m = /^([+\- ]?(?:0[xX])?)(.*)$/.exec(s)!;
    return m[1] + "0".repeat(width - s.length) + m[2];
  }
  return " ".repeat(width - s.length) + s;
}

export function formatPrintf(mem: GuestMem, fmt: string, args: ArgSource, wideFmt = false): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== "%") { out += ch; continue; }
    i++;
    if (fmt[i] === "%") { out += "%"; continue; }
    let left = false, plus = false, space = false, alt = false, zero = false;
    for (;; i++) {
      const f = fmt[i];
      if (f === "-") left = true; else if (f === "+") plus = true; else if (f === " ") space = true; else if (f === "#") alt = true; else if (f === "0") zero = true; else break;
    }
    let width = 0;
    if (fmt[i] === "*") { width = Number(BigInt.asIntN(32, args.int())); if (width < 0) { left = true; width = -width; } i++; } else while (fmt[i] >= "0" && fmt[i] <= "9") width = width * 10 + (fmt.charCodeAt(i++) - 48);
    let prec = -1;
    if (fmt[i] === ".") {
      i++;
      prec = 0;
      if (fmt[i] === "*") { prec = Number(BigInt.asIntN(32, args.int())); i++; } else while (fmt[i] >= "0" && fmt[i] <= "9") prec = prec * 10 + (fmt.charCodeAt(i++) - 48);
    }
    let size = "";
    for (;; i++) {
      const f = fmt[i];
      if (f === "l" || f === "h" || f === "w" || f === "z" || f === "t" || f === "j" || f === "L") size += f;
      else if (f === "I") {
        if (fmt.startsWith("I64", i)) { size += "ll"; i += 2; } else if (fmt.startsWith("I32", i)) { i += 2; } else size += "z";
      } else break;
    }
    const conv = fmt[i];
    let s = "";
    const sgn = (neg: boolean) => (neg ? "-" : plus ? "+" : space ? " " : "");
    switch (conv) {
      case "d": case "i": {
        let v = args.int();
        v = size.includes("ll") || size === "z" || size === "j" || size === "t" ? BigInt.asIntN(64, v) : size === "h" ? BigInt.asIntN(16, v) : size === "hh" ? BigInt.asIntN(8, v) : BigInt.asIntN(32, v);
        const neg = v < 0n;
        let digits = (neg ? -v : v).toString();
        if (prec >= 0) { digits = digits.padStart(prec, "0"); zero = false; }
        s = sgn(neg) + digits;
        break;
      }
      case "u": case "x": case "X": case "o": {
        let v = args.int();
        v = size.includes("ll") || size === "z" || size === "j" || size === "t" ? BigInt.asUintN(64, v) : size === "h" ? BigInt.asUintN(16, v) : size === "hh" ? BigInt.asUintN(8, v) : BigInt.asUintN(32, v);
        let digits = v.toString(conv === "u" ? 10 : conv === "o" ? 8 : 16);
        if (conv === "X") digits = digits.toUpperCase();
        if (prec >= 0) { digits = digits.padStart(prec, "0"); zero = false; }
        s = (alt && v !== 0n ? (conv === "x" ? "0x" : conv === "X" ? "0X" : conv === "o" ? "0" : "") : "") + digits;
        break;
      }
      case "p": {
        const v = BigInt.asUintN(64, args.int());
        s = v.toString(16).toUpperCase().padStart(16, "0");
        break;
      }
      case "c": case "C": {
        const v = Number(args.int() & 0xffffn);
        const lw = size.includes("l") || size === "w", hh = size.includes("h");
        const wideArg = !wideFmt ? (conv === "c" ? lw : !hh) : conv === "c" ? !hh : lw;
        s = String.fromCharCode(wideArg ? v : v & 0xff);
        break;
      }
      case "s": case "S": {
        const ptr = Number(args.int() & 0xffffffffn);
        const lw = size.includes("l") || size === "w", hh = size.includes("h");
        // narrow format: %s narrow (wide with l/w), %S wide (narrow with h); wide format: the reverse
        const wideArg = !wideFmt ? (conv === "s" ? lw : !hh) : conv === "s" ? !hh : lw;
        if (!ptr) s = "(null)";
        else s = wideArg ? mem.wstr(ptr, prec >= 0 ? prec : 1 << 20) : mem.cstr(ptr, prec >= 0 ? prec : 1 << 20);
        if (prec >= 0 && s.length > prec) s = s.slice(0, prec);
        zero = false;
        break;
      }
      case "f": case "F": case "e": case "E": case "g": case "G": case "a": case "A": {
        const v = args.dbl();
        const neg = v < 0 || Object.is(v, -0);
        const a = Math.abs(v);
        let body: string;
        if (!Number.isFinite(a)) body = Number.isNaN(a) ? "nan" : "inf";
        else if (conv === "f" || conv === "F") body = a.toFixed(prec < 0 ? 6 : prec);
        else if (conv === "e" || conv === "E") body = expFmt(a, prec < 0 ? 6 : prec);
        else {
          let P = prec < 0 ? 6 : prec === 0 ? 1 : prec;
          const e = a === 0 ? 0 : Math.floor(Math.log10(a));
          const x = Number(a.toExponential(P - 1).split("e")[1]);
          if (x < -4 || x >= P) body = expFmt(a, P - 1);
          else body = a.toFixed(Math.max(0, P - 1 - x));
          if (!alt && body.includes(".") && !body.includes("e")) body = body.replace(/\.?0+$/, "");
          else if (!alt && body.includes("e")) body = body.replace(/\.?0+e/, "e");
          void e;
        }
        if (conv === "E" || conv === "G" || conv === "F") body = body.toUpperCase();
        s = sgn(neg) + body;
        if (!Number.isFinite(a)) zero = false;
        break;
      }
      case "n": args.int(); break;
      default: s = "%" + (conv ?? "");
    }
    out += pad(s, width, left, zero && !left);
  }
  return out;
}

function expFmt(a: number, prec: number): string {
  const [m, e] = a.toExponential(prec).split("e");
  const ev = Number(e);
  return `${m}e${ev < 0 ? "-" : "+"}${Math.abs(ev).toString().padStart(2, "0")}`;
}
