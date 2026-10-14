// Machine: owns guest memory, the shared code table, the C runtime instance and the translator; runs guest code.
import { ModuleBuilder } from "../wasm/builder.ts";
import { O, VT } from "../wasm/opcodes.ts";
import * as L from "./layout.ts";
import { Translator, isThunk } from "./translator.ts";
import type { TranslatorHost } from "./translator.ts";
import { RUNTIME_WASM_B64 } from "../gen/runtime-wasm.ts";

const { i32: I32 } = VT;

export type HleFn = (m: Machine) => number | void;

function b64decode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface MachineOptions {
  /** initial memory in 64 KiB pages */
  pages?: number;
  smc?: boolean;
  host?: (kind: number, arg: number) => number;
  log?: (s: string) => void;
}

export class Machine implements TranslatorHost {
  readonly memory: WebAssembly.Memory;
  readonly table: WebAssembly.Table;
  readonly smc: boolean;
  rt!: {
    cc_getflags(): number;
    cc_setflags(f: number): void;
    lookup_insert(pc: number, slot: number): void;
    lookup_flush(): void;
  } & Record<string, Function>;
  translator: Translator;
  private enterFn!: (pc: number, slot: number) => number;
  private stubFn!: WebAssembly.ExportValue;
  private _buf: ArrayBufferLike | null = null;
  private _u8!: Uint8Array;
  private _dv!: DataView;
  private slotMap = new Map<number, number>();
  private compiled = new Set<number>();
  private traceRanges = new Map<number, [number, number][]>();
  private pageTraces = new Map<number, Set<number>>();
  private tableSize = 0;
  private nextSlot = 1;
  private pending: number[] = [];
  thunks: HleFn[] = [];
  hostFn: (kind: number, arg: number) => number;
  log: (s: string) => void;
  moduleCount = 0;
  exitHandlers: ((m: Machine, status: number) => boolean)[] = [];

  constructor(opts: MachineOptions = {}) {
    this.smc = opts.smc ?? true;
    this.log = opts.log ?? (() => {});
    this.hostFn = opts.host ?? ((k, a) => this.defaultHost(k, a));
    this.memory = new WebAssembly.Memory({ initial: opts.pages ?? 256, maximum: 65536 });
    this.tableSize = 4096;
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: this.tableSize });
    this.translator = new Translator(this);
    this.initRuntime();
  }

  // --- views ---
  private refresh() {
    if (this._buf !== this.memory.buffer) {
      this._buf = this.memory.buffer;
      this._u8 = new Uint8Array(this._buf);
      this._dv = new DataView(this._buf);
    }
  }
  get u8(): Uint8Array {
    this.refresh();
    return this._u8;
  }
  get dv(): DataView {
    this.refresh();
    return this._dv;
  }
  mem(): Uint8Array {
    return this.u8;
  }

  private initRuntime() {
    // runtime C helpers
    const rtMod = new WebAssembly.Module(b64decode(RUNTIME_WASM_B64) as BufferSource);
    const rtInst = new WebAssembly.Instance(rtMod, { env: { memory: this.memory } });
    this.rt = rtInst.exports as any;

    // bootstrap: miss stub + enter
    const mb = new ModuleBuilder();
    mb.importMemory("env", "mem", 1);
    mb.importTable("env", "tbl", 1);
    const stub = mb.func([I32], [I32]);
    stub.f.i32(0).get(0).mem(O.i32_store, L.STATE + L.S_MISS_PC, 2).i32(L.ST_MISS).end();
    mb.exportFunc("stub", stub.index);
    const enter = mb.func([I32, I32], [I32]);
    const bt = mb.type([I32], [I32]);
    enter.f.get(0).get(1).callIndirect(bt).end();
    mb.exportFunc("enter", enter.index);
    const inst = new WebAssembly.Instance(new WebAssembly.Module(mb.encode() as BufferSource), {
      env: { mem: this.memory, tbl: this.table },
    });
    this.enterFn = (inst.exports as any).enter;
    this.stubFn = (inst.exports as any).stub;
    for (let i = 0; i < this.tableSize; i++) this.table.set(i, this.stubFn as any);
    // initial CPU state
    this.dv.setUint32(L.STATE + L.S_BUDGET, 1 << 30, true);
    this.dv.setUint32(L.STATE + L.S_MXCSR, 0x1f80, true);
    this.dv.setUint16(L.STATE + L.S_FCW, 0x37f, true);
    this.dv.setUint16(L.STATE + L.S_FTAG, 0xffff, true);
    this.rt.cc_setflags(0);
  }

  // --- slots / compilation ---
  slotFor(pc: number): number {
    let s = this.slotMap.get(pc);
    if (s === undefined) {
      s = this.nextSlot++;
      if (s >= this.tableSize) {
        const old = this.tableSize;
        this.table.grow(old, this.stubFn as any);
        this.tableSize = old * 2;
      }
      this.slotMap.set(pc, s);
      if (!this.compiled.has(pc)) this.pending.push(pc);
    }
    return s;
  }

  private rtImports() {
    const rt = this.rt as any;
    return {
      cc_eval: rt.cc_eval, cc_getflags: rt.cc_getflags, lookup: rt.lookup, mulhi_u64: rt.mulhi_u64, mulhi_s64: rt.mulhi_s64,
      div128: rt.div128, rep_movs: rt.rep_movs, rep_stos: rt.rep_stos, rep_cmps: rt.rep_cmps, rep_scas: rt.rep_scas,
    };
  }

  /** Translate and install the trace starting at pc. */
  compile(pc: number) {
    const batch = [pc];
    this.slotFor(pc);
    this.pending = this.pending.filter((p) => p !== pc);
    const { bytes, traces } = this.translator.buildModule(batch);
    const mod = new WebAssembly.Module(bytes as BufferSource);
    new WebAssembly.Instance(mod, {
      env: {
        mem: this.memory,
        tbl: this.table,
        host: (k: number, a: number) => this.hostFn(k, a),
        hle: (id: number) => this.callHle(id),
        smc: (addr: number, size: number) => this.onSmc(addr, size),
      },
      rt: this.rtImports(),
    });
    this.moduleCount++;
    for (const t of traces) {
      this.compiled.add(t.pc);
      this.rt.lookup_insert(t.pc, t.slot);
      this.traceRanges.set(t.pc, t.ranges);
      for (const [a, b] of t.ranges) {
        for (let p = a >>> 12; p <= (b - 1) >>> 12; p++) {
          let set = this.pageTraces.get(p);
          if (!set) this.pageTraces.set(p, (set = new Set()));
          set.add(t.pc);
          if (!isThunk(t.pc)) this.u8[L.CODEPAGE + p] = 1;
        }
      }
    }
  }

  private callHle(id: number): number {
    const fn = this.thunks[id];
    if (!fn) throw new Error("call to unregistered thunk " + id);
    const r = fn(this);
    return r === undefined ? 0 : r;
  }

  /** Register a JS function as a guest-callable thunk; returns its guest address. */
  registerThunk(fn: HleFn): number {
    const id = this.thunks.length;
    if ((id + 1) * L.THUNK_STRIDE > L.THUNK_SIZE) throw new Error("out of thunks");
    this.thunks.push(fn);
    return L.THUNK_BASE + id * L.THUNK_STRIDE;
  }

  // --- self-modifying code ---
  private smcHits = 0;
  private onSmc(addr: number, size: number) {
    this.smcHits++;
    this.invalidate(addr, size);
  }
  /** Drop translated code overlapping [addr, addr+size). */
  invalidate(addr: number, size: number) {
    const first = addr >>> 12, last = (addr + size - 1) >>> 12;
    for (let p = first; p <= last; p++) {
      const set = this.pageTraces.get(p);
      if (!set) {
        this.u8[L.CODEPAGE + p] = 0;
        continue;
      }
      for (const pc of [...set]) this.dropTrace(pc);
      this.pageTraces.delete(p);
      this.u8[L.CODEPAGE + p] = 0;
    }
    this.rt.lookup_flush();
    this.translator.flushCaches();
  }
  private dropTrace(pc: number) {
    const slot = this.slotMap.get(pc);
    if (slot !== undefined) this.table.set(slot, this.stubFn as any);
    this.compiled.delete(pc);
    const ranges = this.traceRanges.get(pc);
    this.traceRanges.delete(pc);
    if (ranges)
      for (const [a, b] of ranges)
        for (let p = a >>> 12; p <= (b - 1) >>> 12; p++) this.pageTraces.get(p)?.delete(pc);
  }

  // --- CPU state access ---
  gpr(i: number): bigint {
    return this.dv.getBigUint64(L.gprOff(i), true);
  }
  setGpr(i: number, v: bigint | number) {
    this.dv.setBigUint64(L.gprOff(i), BigInt.asUintN(64, BigInt(v)), true);
  }
  gpr32(i: number): number {
    return this.dv.getUint32(L.gprOff(i), true);
  }
  setGpr32(i: number, v: number) {
    this.dv.setBigUint64(L.gprOff(i), BigInt(v >>> 0), true);
  }
  get rip(): number {
    return this.dv.getUint32(L.STATE + L.S_RIP, true);
  }
  set rip(v: number) {
    this.dv.setBigUint64(L.STATE + L.S_RIP, BigInt(v >>> 0), true);
  }
  xmm(i: number): Uint8Array {
    return this.u8.subarray(L.xmmOff(i), L.xmmOff(i) + 16);
  }
  /** Arithmetic flags (CF PF AF ZF SF OF) in EFLAGS bit positions plus DF. */
  get eflags(): number {
    return (this.rt.cc_getflags() | (this.dv.getUint32(L.STATE + L.S_DF, true) << 10) | 0x202) >>> 0;
  }
  set eflags(v: number) {
    this.rt.cc_setflags(v & L.F_ARITH);
    this.dv.setUint32(L.STATE + L.S_DF, (v >>> 10) & 1, true);
  }
  get faultKind(): number {
    return this.dv.getUint32(L.STATE + L.S_FAULT_KIND, true);
  }
  get faultAddr(): number {
    return this.dv.getUint32(L.STATE + L.S_FAULT_ADDR, true);
  }

  // --- execution ---
  /**
   * Run guest code from `pc` until it exits to the host with a status other than MISS/YIELD handled internally.
   * `onYield` is called when the budget is exhausted; return false to stop.
   */
  run(pc: number, maxSteps = Infinity): number {
    let steps = 0;
    this.dv.setUint32(L.STATE + L.S_BUDGET, 1 << 30, true);
    for (;;) {
      let slot = this.slotMap.get(pc);
      if (slot === undefined || !this.compiled.has(pc)) {
        this.compile(pc);
        slot = this.slotMap.get(pc)!;
      }
      const st = this.enterFn(pc, slot);
      switch (st) {
        case L.ST_MISS:
          pc = this.dv.getUint32(L.STATE + L.S_MISS_PC, true);
          break;
        case L.ST_YIELD:
          pc = this.rip;
          this.dv.setUint32(L.STATE + L.S_BUDGET, 1 << 30, true);
          if (++steps >= maxSteps) return st;
          break;
        case L.ST_SMC:
          pc = this.rip;
          break;
        default:
          this.dv.setUint32(L.STATE + L.S_STATUS, st, true);
          for (const h of this.exitHandlers) if (h(this, st)) return st; // handlers may redirect
          return st;
      }
    }
  }

  defaultHost(kind: number, _arg: number): number {
    switch (kind) {
      case 1: { // CPUID
        const leaf = this.gpr32(0), sub = this.gpr32(1);
        const r = cpuid(leaf, sub);
        this.setGpr32(0, r[0]);
        this.setGpr32(3, r[1]);
        this.setGpr32(1, r[2]);
        this.setGpr32(2, r[3]);
        return 0;
      }
      case 2: { // RDTSC
        const t = BigInt(Math.floor(performance.now() * 1e6));
        this.setGpr32(0, Number(t & 0xffffffffn));
        this.setGpr32(2, Number((t >> 32n) & 0xffffffffn));
        return 0;
      }
      case 3: { // XGETBV: x87 + SSE state enabled
        this.setGpr32(0, 3);
        this.setGpr32(2, 0);
        return 0;
      }
      case 4: { // RDTSCP
        const t = BigInt(Math.floor(performance.now() * 1e6));
        this.setGpr32(0, Number(t & 0xffffffffn));
        this.setGpr32(2, Number((t >> 32n) & 0xffffffffn));
        this.setGpr32(1, 0);
        return 0;
      }
      case 5: { // RDRAND
        this.setGpr32(0, (Math.random() * 0x100000000) >>> 0);
        return 0;
      }
    }
    return 0;
  }
}

/** CPUID: we advertise only what the translator implements: SSE through SSE4.2, POPCNT, CMPXCHG16B, no AVX. */
export function cpuid(leaf: number, sub: number): [number, number, number, number] {
  switch (leaf) {
    case 0: return [0x0d, 0x756e6547, 0x6c65746e, 0x49656e69]; // "GenuineIntel"
    case 1: {
      const ecx = (1 << 0) /*SSE3*/ | (1 << 9) /*SSSE3*/ | (1 << 13) /*CX16*/ | (1 << 19) /*SSE4.1*/ | (1 << 20) /*SSE4.2*/ |
        (1 << 23) /*POPCNT*/ | (1 << 31) /*hypervisor*/;
      const edx = (1 << 0) | (1 << 4) /*TSC*/ | (1 << 6) | (1 << 8) /*CX8*/ | (1 << 11) | (1 << 15) /*CMOV*/ | (1 << 23) /*MMX*/ |
        (1 << 24) /*FXSR*/ | (1 << 25) /*SSE*/ | (1 << 26) /*SSE2*/ | (1 << 13) | (1 << 3) | (1 << 5) | (1 << 9) | (1 << 12);
      return [0x000306a9, 0x00010800, ecx >>> 0, edx >>> 0];
    }
    case 7: return [0, 0, 0, 0];
    case 0x80000000: return [0x80000008, 0, 0, 0];
    case 0x80000001: return [0, 0, (1 << 0) | (1 << 5) /*LZCNT*/, (1 << 11) /*SYSCALL*/ | (1 << 20) /*NX*/ | (1 << 29) /*LM*/];
    case 0x80000002: case 0x80000003: case 0x80000004: {
      const name = "Chrome.EXE x86-64 DBT virtual CPU".padEnd(48, "\0");
      const i = (leaf - 0x80000002) * 16;
      const w = (o: number) => name.charCodeAt(i + o) | (name.charCodeAt(i + o + 1) << 8) | (name.charCodeAt(i + o + 2) << 16) | (name.charCodeAt(i + o + 3) << 24);
      return [w(0) >>> 0, w(4) >>> 0, w(8) >>> 0, w(12) >>> 0];
    }
    case 0x80000008: return [0x2030, 0, 0, 0];
    default: return [0, 0, 0, 0];
  }
}
