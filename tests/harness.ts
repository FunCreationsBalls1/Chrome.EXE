// Differential test harness: run x86-64 machine code natively (oracle) and through the JIT, compare architectural state.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "../src/jit/machine.ts";
import * as L from "../src/jit/layout.ts";
import { decode, fmtInsn } from "../src/x86/decode.ts";

export const SCRATCH = 0x01000000;
export const STACK_TOP = SCRATCH + 0x2000;
export const CODE = 0x01010000;
export const SCR_N = 1024;
export const STK_N = 256;
export const FLAGS_ARITH = 0x8d5;
export const RET_SLOT = 72; // bytes below STACK_TOP where the return address of the `call` lives

export interface Case {
  code: Uint8Array;
  gpr: bigint[]; // 16
  flags: number;
  xmm: Uint8Array[]; // 16 x 16 bytes
  scratch: Uint8Array;
  stack: Uint8Array;
}
export interface Result {
  sig: number;
  gpr: bigint[];
  flags: number;
  xmm: Uint8Array[];
  scratch: Uint8Array;
  stack: Uint8Array;
}

// ---- deterministic RNG ----
export class Rng {
  s: bigint;
  constructor(seed = 12345n) {
    this.s = BigInt.asUintN(64, seed * 0x9e3779b97f4a7c15n + 1n);
  }
  next64(): bigint {
    let x = this.s;
    x ^= x << 13n; x = BigInt.asUintN(64, x);
    x ^= x >> 7n;
    x ^= x << 17n; x = BigInt.asUintN(64, x);
    this.s = x;
    return x;
  }
  u32(): number { return Number(this.next64() >> 32n); }
  int(n: number): number { return this.u32() % n; }
}

const EDGE = [0n, 1n, 2n, 3n, 4n, 7n, 8n, 15n, 16n, 31n, 32n, 63n, 64n, 0x7fn, 0x80n, 0xffn, 0x100n, 0x7fffn, 0x8000n, 0xffffn, 0x10000n,
  0x7fffffffn, 0x80000000n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
  0xfffffffffffffffen, 0xffffffffffffff80n, 0xffffffff80000000n, 0x00000000deadbeefn, 0x123456789abcdef0n];
export function randVal(r: Rng): bigint {
  const k = r.int(10);
  if (k < 5) return EDGE[r.int(EDGE.length)];
  if (k < 6) return BigInt.asUintN(64, EDGE[r.int(EDGE.length)] + BigInt(r.int(5)) - 2n);
  if (k < 8) return BigInt(r.u32());
  return r.next64();
}

export function randCase(r: Rng, code: Uint8Array, opts: { fixed?: Record<number, bigint>; flagsAny?: boolean } = {}): Case {
  const gpr: bigint[] = [];
  for (let i = 0; i < 16; i++) gpr.push(randVal(r));
  gpr[3] = BigInt(SCRATCH + 256); // rbx -> scratch
  gpr[4] = BigInt(STACK_TOP - 64);
  if (opts.fixed) for (const [k, v] of Object.entries(opts.fixed)) gpr[Number(k)] = v;
  let flags = 0x202 | (r.u32() & FLAGS_ARITH);
  flags |= (r.int(8) === 0 ? 0x400 : 0) ;
  const xmm: Uint8Array[] = [];
  for (let i = 0; i < 16; i++) {
    const x = new Uint8Array(16);
    const kind = r.int(4);
    for (let j = 0; j < 16; j += 4) {
      let v: number;
      if (kind === 0) v = r.u32();
      else if (kind === 1) v = [0, 0x3f800000, 0xbf800000, 0x40490fdb, 0x7f800000, 0xff800000, 0x80000000, 0x00800000, 0x7fc00000, 0x4b800000, 0xc2c80000][r.int(11)];
      else if (kind === 2) v = Number(randVal(r) & 0xffffffffn);
      else v = (r.u32() & 0xff) * 0x01010101;
      new DataView(x.buffer).setUint32(j, v >>> 0, true);
    }
    xmm.push(x);
  }
  const scratch = new Uint8Array(SCR_N);
  for (let i = 0; i < FLAGSLOT; i += 4) new DataView(scratch.buffer).setUint32(i, r.int(3) === 0 ? 0 : r.u32(), true);
  const stack = new Uint8Array(STK_N);
  for (let i = 0; i < STK_N; i++) stack[i] = r.int(256);
  return { code, gpr, flags, xmm, scratch, stack };
}

// ---- assembling with nasm ----
export const FLAGSLOT = 1000; // scratch offset where captured EFLAGS are stored
const CAPTURE = `\nlea rsp, [rsp-192]\npushfq\npop qword [abs ${SCRATCH + FLAGSLOT}]\nlea rsp, [rsp+192]\n`;
export function assemble(snippets: string[], capture = true): Uint8Array[] {
  const dir = mkdtempSync(join(tmpdir(), "asm-"));
  const build = (list: string[]) => {
    let src = "bits 64\n";
    list.forEach((s, i) => {
      src += `dw end${i} - body${i}\nbody${i}:\n${s}${capture ? CAPTURE : ""}\nend${i}:\n`;
    });
    writeFileSync(join(dir, "t.asm"), src);
    return spawnSync("nasm", ["-f", "bin", "-o", join(dir, "t.bin"), join(dir, "t.asm")], { encoding: "utf8" });
  };
  let r = build(snippets);
  if (r.status !== 0) {
    // find the culprit
    for (const s of snippets) {
      const rr = build([s]);
      if (rr.status !== 0) throw new Error(`nasm failed for snippet:\n${s}\n${rr.stderr}`);
    }
    throw new Error("nasm failed: " + r.stderr);
  }
  const bin = readFileSync(join(dir, "t.bin"));
  const out: Uint8Array[] = [];
  let p = 0;
  for (let i = 0; i < snippets.length; i++) {
    const len = bin[p] | (bin[p + 1] << 8);
    p += 2;
    out.push(new Uint8Array(bin.subarray(p, p + len)));
    p += len;
  }
  return out;
}

// ---- native oracle ----
const CTX_N = 128 + 8 + 8 + 256;
export function runNative(cases: Case[]): Result[] {
  const parts: Buffer[] = [];
  for (const c of cases) {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(c.code.length, 0);
    const ctx = Buffer.alloc(CTX_N);
    for (let i = 0; i < 16; i++) ctx.writeBigUInt64LE(c.gpr[i], i * 8);
    ctx.writeBigUInt64LE(BigInt(c.flags), 128);
    for (let i = 0; i < 16; i++) ctx.set(c.xmm[i], 144 + i * 16);
    parts.push(hdr, Buffer.from(c.code), ctx, Buffer.from(c.scratch), Buffer.from(c.stack));
  }
  const input = Buffer.concat(parts);
  const res = spawnSync(join(import.meta.dirname, "../build/runner"), [], { input, maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error("runner failed: " + res.status + " " + res.stderr?.toString());
  const out = res.stdout;
  const per = 4 + CTX_N + SCR_N + STK_N;
  if (out.length !== per * cases.length) throw new Error(`runner output size ${out.length} != ${per * cases.length}`);
  const results: Result[] = [];
  for (let k = 0; k < cases.length; k++) {
    const o = out.subarray(k * per, (k + 1) * per);
    const sig = o.readUInt32LE(0);
    const gpr: bigint[] = [];
    for (let i = 0; i < 16; i++) gpr.push(o.readBigUInt64LE(4 + i * 8));
    const xmm: Uint8Array[] = [];
    for (let i = 0; i < 16; i++) xmm.push(new Uint8Array(o.subarray(4 + 144 + i * 16, 4 + 160 + i * 16)));
    const scratch = new Uint8Array(o.subarray(4 + CTX_N, 4 + CTX_N + SCR_N));
    const flags = Number(new DataView(scratch.buffer, scratch.byteOffset).getBigUint64(FLAGSLOT, true) & 0xffffffffn);
    scratch.fill(0, FLAGSLOT, FLAGSLOT + 8);
    const stack = new Uint8Array(o.subarray(4 + CTX_N + SCR_N, per));
    results.push({ sig, gpr, flags, xmm, scratch, stack });
  }
  return results;
}

// ---- JIT side ----
export class JitRunner {
  m: Machine;
  sentinel: number;
  lastCode: Uint8Array | null = null;
  constructor(opts: { smc?: boolean } = {}) {
    this.m = new Machine({ pages: 512, smc: opts.smc });
    this.sentinel = this.m.registerThunk(() => L.ST_HOSTCALL_RETURN);
  }
  run(c: Case): Result & { status: number; fault: number } {
    const m = this.m;
    const u8 = m.u8;
    u8.fill(0, SCRATCH, SCRATCH + 0x2000);
    u8.set(c.scratch, SCRATCH);
    u8.set(c.stack, STACK_TOP - STK_N);
    const same = this.lastCode && this.lastCode.length === c.code.length && this.lastCode.every((b, i) => b === c.code[i]);
    if (!same) {
      u8.set(c.code, CODE);
      u8[CODE + c.code.length] = 0xc3;
      m.invalidate(CODE, 0x10000);
      this.lastCode = c.code;
    }
    for (let i = 0; i < 16; i++) m.setGpr(i, c.gpr[i]);
    m.eflags = c.flags;
    for (let i = 0; i < 16; i++) m.xmm(i).set(c.xmm[i]);
    // push the return sentinel like `call` would
    const rsp = c.gpr[4] - 8n;
    m.setGpr(4, rsp);
    m.dv.setBigUint64(Number(rsp), BigInt(this.sentinel), true);
    const status = m.run(CODE);
    const gpr: bigint[] = [];
    for (let i = 0; i < 16; i++) gpr.push(m.gpr(i));
    const xmm: Uint8Array[] = [];
    for (let i = 0; i < 16; i++) xmm.push(new Uint8Array(m.xmm(i)));
    const scratch = new Uint8Array(m.u8.subarray(SCRATCH, SCRATCH + SCR_N));
    const flags = Number(new DataView(scratch.buffer, scratch.byteOffset).getBigUint64(FLAGSLOT, true) & 0xffffffffn);
    scratch.fill(0, FLAGSLOT, FLAGSLOT + 8);
    return {
      sig: 0, status, fault: m.faultKind,
      gpr, flags, xmm,
      scratch,
      stack: new Uint8Array(m.u8.subarray(STACK_TOP - STK_N, STACK_TOP)),
    };
  }
}

export function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}
export function disasm(code: Uint8Array): string {
  const mem = new Uint8Array(code.length + 16);
  mem.set(code);
  let out: string[] = [];
  for (let p = 0; p < code.length;) {
    const i = decode(mem, p);
    out.push(fmtInsn(i));
    p += i.len;
  }
  return out.join("; ");
}

export interface Compare {
  flagMask?: number; // flags to compare (default all arithmetic + DF)
  gprMask?: bigint[]; // optional per-register mask
  skipGpr?: number[];
  skipXmm?: boolean;
  /** how XMM registers are compared: exact bits (default), NaN-insensitive float lanes, or approximate (rcp/rsqrt) */
  xmm?: "exact" | "f32" | "f64" | "approx32";
  skipMem?: boolean;
}
function xmmEqual(a: Uint8Array, b: Uint8Array, mode: string): boolean {
  if (mode === "exact") return hex(a) === hex(b);
  const da = new DataView(a.buffer, a.byteOffset, 16), db = new DataView(b.buffer, b.byteOffset, 16);
  if (mode === "f64") {
    for (let i = 0; i < 16; i += 8) {
      const x = da.getFloat64(i, true), y = db.getFloat64(i, true);
      if (Number.isNaN(x) && Number.isNaN(y)) continue;
      if (da.getBigUint64(i, true) !== db.getBigUint64(i, true)) return false;
    }
    return true;
  }
  for (let i = 0; i < 16; i += 4) {
    const x = da.getFloat32(i, true), y = db.getFloat32(i, true);
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (mode === "approx32") {
      if (x === y) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) {
        // allow tiny/huge disagreement at the edges: both must be same class
        if (Object.is(x, y)) continue;
        if ((x === 0 || Math.abs(x) < 1e-30) && (y === 0 || Math.abs(y) < 1e-30)) continue;
        if (Math.abs(x) > 1e30 && Math.abs(y) > 1e30 && Math.sign(x) === Math.sign(y)) continue;
        return false;
      }
      if (Math.abs(x - y) <= Math.abs(y) * 3e-4) continue;
      return false;
    }
    if (da.getUint32(i, true) !== db.getUint32(i, true)) return false;
  }
  return true;
}

export function compare(c: Case, nat: Result, jit: Result, opt: Compare = {}): string[] {
  const diffs: string[] = [];
  const names = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
  for (let i = 0; i < 16; i++) {
    if (opt.skipGpr?.includes(i)) continue;
    const mk = opt.gprMask?.[i] ?? 0xffffffffffffffffn;
    if ((nat.gpr[i] & mk) !== (jit.gpr[i] & mk)) diffs.push(`${names[i]}: native=${nat.gpr[i].toString(16)} jit=${jit.gpr[i].toString(16)}`);
  }
  const fm = (opt.flagMask ?? (FLAGS_ARITH | 0x400));
  if ((nat.flags & fm) !== (jit.flags & fm)) {
    diffs.push(`flags: native=${(nat.flags & fm).toString(16)} jit=${(jit.flags & fm).toString(16)} (xor ${((nat.flags ^ jit.flags) & fm).toString(16)})`);
  }
  if (!opt.skipXmm) {
    for (let i = 0; i < 16; i++) {
      if (!xmmEqual(nat.xmm[i], jit.xmm[i], opt.xmm ?? "exact")) diffs.push(`xmm${i}: native=${hex(nat.xmm[i])} jit=${hex(jit.xmm[i])}`);
    }
  }
  if (!opt.skipMem) {
    for (let i = 0; i < SCR_N; i++) if (nat.scratch[i] !== jit.scratch[i]) { diffs.push(`scratch[${i}]: native=${nat.scratch[i].toString(16)} jit=${jit.scratch[i].toString(16)}`); break; }
    for (let i = 0; i < STK_N; i++) {
      const fromTop = STK_N - i;
      if (fromTop <= RET_SLOT && fromTop > RET_SLOT - 8) continue; // return address slot differs by design
      if (nat.stack[i] !== jit.stack[i]) { diffs.push(`stack[-${fromTop}]: native=${nat.stack[i].toString(16)} jit=${jit.stack[i].toString(16)}`); break; }
    }
  }
  return diffs;
}

export function dumpCase(c: Case): string {
  const names = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
  return names.map((n, i) => `${n}=${c.gpr[i].toString(16)}`).join(" ") + ` flags=${c.flags.toString(16)}`;
}
export { execFileSync };
