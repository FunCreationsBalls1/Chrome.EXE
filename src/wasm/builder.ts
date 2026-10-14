// Minimal, fast WebAssembly binary encoder used by the JIT.
import { O, VT } from "./opcodes.ts";
import type { ValType } from "./opcodes.ts";

export class Writer {
  buf: Uint8Array;
  len = 0;
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
  }
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v;
  }
  /** unsigned LEB128 (value must be < 2^53) */
  uleb(v: number) {
    this.ensure(10);
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }
  /** signed LEB128 for 32-bit-range (or up to ±2^53) integers */
  sleb(v: number) {
    this.ensure(10);
    if (v >= -0x80000000 && v <= 0x7fffffff) {
      v |= 0;
      for (;;) {
        const b = v & 0x7f;
        v >>= 7;
        if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
          this.buf[this.len++] = b;
          return;
        }
        this.buf[this.len++] = b | 0x80;
      }
    }
    this.sleb64(BigInt(v));
  }
  sleb64(v: bigint) {
    this.ensure(12);
    v = BigInt.asIntN(64, v);
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
        this.buf[this.len++] = b;
        return;
      }
      this.buf[this.len++] = b | 0x80;
    }
  }
  f32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
  }
  raw(b: ArrayLike<number>) {
    this.ensure(b.length);
    for (let i = 0; i < b.length; i++) this.buf[this.len++] = b[i];
  }
  str(s: string) {
    const e = new TextEncoder().encode(s);
    this.uleb(e.length);
    this.raw(e);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

export interface FuncType {
  params: number[];
  results: number[];
}

export class FuncBuilder {
  w = new Writer(1024);
  readonly nparams: number;
  readonly mod: ModuleBuilder;
  readonly typeIdx: number;
  readonly type: FuncType;
  private localTypes: number[] = [];
  private freeTemps: Map<number, number[]> = new Map();
  constructor(mod: ModuleBuilder, typeIdx: number, type: FuncType) {
    this.mod = mod;
    this.typeIdx = typeIdx;
    this.type = type;
    this.nparams = type.params.length;
  }

  newLocal(t: number): number {
    this.localTypes.push(t);
    return this.nparams + this.localTypes.length - 1;
  }
  /** Get a scratch local; release with freeTemp(). */
  temp(t: number): number {
    const l = this.freeTemps.get(t);
    if (l && l.length) return l.pop()!;
    return this.newLocal(t);
  }
  freeTemp(t: number, idx: number) {
    let l = this.freeTemps.get(t);
    if (!l) this.freeTemps.set(t, (l = []));
    l.push(idx);
  }

  // --- raw emission ---
  op(code: number): this {
    if (code < 0x100) this.w.u8(code);
    else {
      this.w.u8(code >>> 16);
      this.w.uleb(code & 0xffff);
    }
    return this;
  }
  i32(v: number): this {
    this.w.u8(O.i32_const);
    this.w.sleb(v | 0);
    return this;
  }
  i64(v: bigint | number): this {
    this.w.u8(O.i64_const);
    if (typeof v === "number") {
      // Numbers up to 2^53 are exact. Negative numbers are interpreted as signed.
      this.w.sleb64(BigInt(v));
    } else this.w.sleb64(v);
    return this;
  }
  f32(v: number): this {
    this.w.u8(O.f32_const);
    this.w.f32(v);
    return this;
  }
  f64(v: number): this {
    this.w.u8(O.f64_const);
    this.w.f64(v);
    return this;
  }
  v128(bytes: ArrayLike<number>): this {
    this.op(O.v128_const);
    this.w.raw(bytes);
    return this;
  }
  get(i: number): this {
    this.w.u8(O.local_get);
    this.w.uleb(i);
    return this;
  }
  set(i: number): this {
    this.w.u8(O.local_set);
    this.w.uleb(i);
    return this;
  }
  tee(i: number): this {
    this.w.u8(O.local_tee);
    this.w.uleb(i);
    return this;
  }
  call(fn: number): this {
    this.w.u8(O.call);
    this.w.uleb(fn);
    return this;
  }
  callIndirect(typeIdx: number, table = 0): this {
    this.w.u8(O.call_indirect);
    this.w.uleb(typeIdx);
    this.w.uleb(table);
    return this;
  }
  returnCallIndirect(typeIdx: number, table = 0): this {
    this.w.u8(O.return_call_indirect);
    this.w.uleb(typeIdx);
    this.w.uleb(table);
    return this;
  }
  block(bt: number = VT.void): this {
    this.w.u8(O.block);
    this.w.sleb(bt === VT.void ? -64 : bt >= 0x70 ? bt - 128 : bt);
    return this;
  }
  loop(bt: number = VT.void): this {
    this.w.u8(O.loop);
    this.w.sleb(bt === VT.void ? -64 : bt >= 0x70 ? bt - 128 : bt);
    return this;
  }
  if_(bt: number = VT.void): this {
    this.w.u8(O.if);
    this.w.sleb(bt === VT.void ? -64 : bt >= 0x70 ? bt - 128 : bt);
    return this;
  }
  else_(): this {
    this.w.u8(O.else);
    return this;
  }
  end(): this {
    this.w.u8(O.end);
    return this;
  }
  br(depth: number): this {
    this.w.u8(O.br);
    this.w.uleb(depth);
    return this;
  }
  brIf(depth: number): this {
    this.w.u8(O.br_if);
    this.w.uleb(depth);
    return this;
  }
  brTable(depths: number[], dflt: number): this {
    this.w.u8(O.br_table);
    this.w.uleb(depths.length);
    for (const d of depths) this.w.uleb(d);
    this.w.uleb(dflt);
    return this;
  }
  // memory access with static offset. align is log2.
  mem(code: number, offset = 0, align = 0): this {
    this.op(code);
    this.w.uleb(align);
    this.w.uleb(offset);
    return this;
  }
  /** lane-index instruction (extract/replace lane), shuffle uses `shuffle` */
  lane(code: number, lane: number): this {
    this.op(code);
    this.w.u8(lane);
    return this;
  }
  shuffle(lanes: ArrayLike<number>): this {
    this.op(O.i8x16_shuffle);
    for (let i = 0; i < 16; i++) this.w.u8(lanes[i]);
    return this;
  }
  /** v128 lane load/store: memarg + lane */
  memLane(code: number, offset: number, align: number, lane: number): this {
    this.op(code);
    this.w.uleb(align);
    this.w.uleb(offset);
    this.w.u8(lane);
    return this;
  }
  memoryCopy(): this {
    this.op(O.memory_copy);
    this.w.u8(0);
    this.w.u8(0);
    return this;
  }
  memoryFill(): this {
    this.op(O.memory_fill);
    this.w.u8(0);
    return this;
  }
  memoryGrow(): this {
    this.w.u8(O.memory_grow);
    this.w.u8(0);
    return this;
  }
  memorySize(): this {
    this.w.u8(O.memory_size);
    this.w.u8(0);
    return this;
  }

  /** Serialised body: locals vector + code (code must already be terminated by `end`). */
  encode(): Uint8Array {
    const head = new Writer(32);
    // run-length encode consecutive local types
    const groups: [number, number][] = [];
    for (const t of this.localTypes) {
      const g = groups[groups.length - 1];
      if (g && g[1] === t) g[0]++;
      else groups.push([1, t]);
    }
    head.uleb(groups.length);
    for (const [n, t] of groups) {
      head.uleb(n);
      head.u8(t);
    }
    const hb = head.bytes();
    const code = this.w.bytes();
    const out = new Writer(hb.length + code.length + 8);
    out.uleb(hb.length + code.length);
    out.raw(hb);
    out.raw(code);
    return out.bytes();
  }
}

interface ImportEntry {
  module: string;
  name: string;
  kind: "func" | "memory" | "table" | "global";
  typeIdx?: number;
  min?: number;
  max?: number;
  shared?: boolean;
  elemType?: number;
  valType?: number;
  mutable?: boolean;
}

export class ModuleBuilder {
  private types: FuncType[] = [];
  private typeKeys = new Map<string, number>();
  private imports: ImportEntry[] = [];
  private nImportedFuncs = 0;
  private funcs: FuncBuilder[] = [];
  private exports: { name: string; kind: number; index: number }[] = [];
  private elems: { offset: number; funcs: number[] }[] = [];
  private declaredFuncRefs = new Set<number>();

  type(params: number[], results: number[]): number {
    const key = params.join(",") + ">" + results.join(",");
    let idx = this.typeKeys.get(key);
    if (idx === undefined) {
      idx = this.types.length;
      this.types.push({ params, results });
      this.typeKeys.set(key, idx);
    }
    return idx;
  }

  importFunc(module: string, name: string, params: number[], results: number[]): number {
    if (this.funcs.length) throw new Error("imports must be declared before functions");
    const typeIdx = this.type(params, results);
    this.imports.push({ module, name, kind: "func", typeIdx });
    return this.nImportedFuncs++;
  }
  importMemory(module: string, name: string, min: number, max?: number, shared = false) {
    this.imports.push({ module, name, kind: "memory", min, max, shared });
  }
  importTable(module: string, name: string, min: number, max?: number) {
    this.imports.push({ module, name, kind: "table", min, max, elemType: VT.funcref });
  }
  importGlobal(module: string, name: string, valType: number, mutable: boolean) {
    this.imports.push({ module, name, kind: "global", valType, mutable });
  }

  /** Begin a function; returns the builder and its function index. */
  func(params: number[], results: number[]): { f: FuncBuilder; index: number } {
    const typeIdx = this.type(params, results);
    const f = new FuncBuilder(this, typeIdx, { params, results });
    this.funcs.push(f);
    return { f, index: this.nImportedFuncs + this.funcs.length - 1 };
  }
  exportFunc(name: string, index: number) {
    this.exports.push({ name, kind: 0, index });
  }
  /** Active element segment: place functions at table[offset...] */
  elem(offset: number, funcs: number[]) {
    this.elems.push({ offset, funcs });
    for (const f of funcs) this.declaredFuncRefs.add(f);
  }

  encode(): Uint8Array {
    const out = new Writer(4096);
    out.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const section = (id: number, body: Writer) => {
      out.u8(id);
      out.uleb(body.len);
      out.raw(body.bytes());
    };
    // types
    {
      const s = new Writer();
      s.uleb(this.types.length);
      for (const t of this.types) {
        s.u8(0x60);
        s.uleb(t.params.length);
        for (const p of t.params) s.u8(p);
        s.uleb(t.results.length);
        for (const r of t.results) s.u8(r);
      }
      section(1, s);
    }
    if (this.imports.length) {
      const s = new Writer();
      s.uleb(this.imports.length);
      for (const im of this.imports) {
        s.str(im.module);
        s.str(im.name);
        switch (im.kind) {
          case "func":
            s.u8(0);
            s.uleb(im.typeIdx!);
            break;
          case "table":
            s.u8(1);
            s.u8(im.elemType!);
            if (im.max !== undefined) {
              s.u8(1);
              s.uleb(im.min!);
              s.uleb(im.max);
            } else {
              s.u8(0);
              s.uleb(im.min!);
            }
            break;
          case "memory": {
            s.u8(2);
            const flags = (im.max !== undefined ? 1 : 0) | (im.shared ? 2 : 0);
            s.u8(flags);
            s.uleb(im.min!);
            if (im.max !== undefined) s.uleb(im.max);
            break;
          }
          case "global":
            s.u8(3);
            s.u8(im.valType!);
            s.u8(im.mutable ? 1 : 0);
            break;
        }
      }
      section(2, s);
    }
    {
      const s = new Writer();
      s.uleb(this.funcs.length);
      for (const f of this.funcs) s.uleb(f.typeIdx);
      section(3, s);
    }
    if (this.exports.length) {
      const s = new Writer();
      s.uleb(this.exports.length);
      for (const e of this.exports) {
        s.str(e.name);
        s.u8(e.kind);
        s.uleb(e.index);
      }
      section(7, s);
    }
    if (this.elems.length) {
      const s = new Writer();
      s.uleb(this.elems.length);
      for (const e of this.elems) {
        s.u8(0); // active, table 0, expr
        s.u8(O.i32_const);
        s.sleb(e.offset);
        s.u8(O.end);
        s.uleb(e.funcs.length);
        for (const f of e.funcs) s.uleb(f);
      }
      section(9, s);
    }
    {
      const s = new Writer(4096);
      s.uleb(this.funcs.length);
      for (const f of this.funcs) s.raw(f.encode());
      section(10, s);
    }
    return out.bytes();
  }
}

export type { ValType };
