// Direct3D shader model 4.0 / 5.0 (DXBC) -> WGSL.
//
// parseDxbc() decodes a container (signatures + SHDR/SHEX token stream); emitSm5() produces the WGSL module for a link context.
// Registers are stored as vec4<f32> bit patterns; integer instructions bitcast around the operation.

export interface SigElement { name: string; index: number; sysVal: number; compType: number; reg: number; mask: number; rwMask: number; stream: number; minPrec: number }

export interface Sm5Operand {
  type: number;
  numComps: number;
  selMode: number;
  /** resolved swizzle (4 components) for 4-component operands */
  swz: [number, number, number, number];
  mask: number;
  neg: boolean;
  abs: boolean;
  idx: { imm: number; rel: Sm5Operand | null }[];
  imm: number[] | null;
}
export interface Sm5Ins {
  op: number;
  ctrl: number;
  ops: Sm5Operand[];
  /** extended opcode data: texel offsets for sample instructions */
  offset: [number, number, number] | null;
  /** payload of declaration-like instructions (counts, system values, resource info) */
  data: number[];
  custom: number[] | null;
  /** index into the token stream, for diagnostics */
  at: number;
}
export interface Sm5Shader {
  type: number; // 0 ps, 1 vs, 2 gs, 3 hs, 4 ds, 5 cs
  major: number;
  minor: number;
  ins: Sm5Ins[];
  inputs: SigElement[];
  outputs: SigElement[];
  patch: SigElement[];
  /** resource declarations */
  cbs: Map<number, { size: number; dynamic: boolean }>;
  srvs: Map<number, { dim: number; ret: number[]; stride: number; raw: boolean; structured: boolean }>;
  samplers: Map<number, { comparison: boolean }>;
  uavs: Map<number, { dim: number; ret: number[]; stride: number; raw: boolean; structured: boolean; typed: boolean; globallyCoherent: boolean }>;
  tgsm: Map<number, { stride: number; count: number; raw: boolean }>;
  temps: number;
  indexableTemps: Map<number, { size: number; comps: number }>;
  icb: number[] | null;
  threadGroup: [number, number, number];
  flags: number;
  /** for geometry/hull/domain: unsupported stages are flagged */
  unsupported: string[];
  /** texture slots used with comparison sampling */
  cmpTextures: Set<number>;
  atomicUavs: Set<number>;
  /** typed UAV slots the shader loads from (others are write-only storage textures) */
  uavReads: Set<number>;
  atomicTgsm: Set<number>;
  usesDiscard: boolean;
  /** input registers declared by the instruction stream: reg -> {mask, kind} */
  declIn: Map<number, { mask: number; interp: number; sv: number; kind: "plain" | "sgv" | "siv" }>;
  declOut: Map<number, { mask: number; sv: number; kind: "plain" | "sgv" | "siv" }>;
  outDepth: boolean;
  outMask: boolean;
  inputSpecials: Set<number>;
}

export const OPC = {
  ADD: 0, AND: 1, BREAK: 2, BREAKC: 3, CALL: 4, CALLC: 5, CASE: 6, CONTINUE: 7, CONTINUEC: 8, CUT: 9, DEFAULT: 10, DERIV_RTX: 11, DERIV_RTY: 12, DISCARD: 13, DIV: 14, DP2: 15, DP3: 16, DP4: 17,
  ELSE: 18, EMIT: 19, EMITTHENCUT: 20, ENDIF: 21, ENDLOOP: 22, ENDSWITCH: 23, EQ: 24, EXP: 25, FRC: 26, FTOI: 27, FTOU: 28, GE: 29, IADD: 30, IF: 31, IEQ: 32, IGE: 33, ILT: 34, IMAD: 35, IMAX: 36,
  IMIN: 37, IMUL: 38, INE: 39, INEG: 40, ISHL: 41, ISHR: 42, ITOF: 43, LABEL: 44, LD: 45, LD_MS: 46, LOG: 47, LOOP: 48, LT: 49, MAD: 50, MIN: 51, MAX: 52, CUSTOMDATA: 53, MOV: 54, MOVC: 55,
  MUL: 56, NE: 57, NOP: 58, NOT: 59, OR: 60, RESINFO: 61, RET: 62, RETC: 63, ROUND_NE: 64, ROUND_NI: 65, ROUND_PI: 66, ROUND_Z: 67, RSQ: 68, SAMPLE: 69, SAMPLE_C: 70, SAMPLE_C_LZ: 71, SAMPLE_L: 72,
  SAMPLE_D: 73, SAMPLE_B: 74, SQRT: 75, SWITCH: 76, SINCOS: 77, UDIV: 78, ULT: 79, UGE: 80, UMUL: 81, UMAD: 82, UMAX: 83, UMIN: 84, USHR: 85, UTOF: 86, XOR: 87, DCL_RESOURCE: 88,
  DCL_CONSTANT_BUFFER: 89, DCL_SAMPLER: 90, DCL_INDEX_RANGE: 91, DCL_GS_OUTPUT_TOPOLOGY: 92, DCL_GS_INPUT_PRIMITIVE: 93, DCL_MAX_OUTPUT_VERTEX_COUNT: 94, DCL_INPUT: 95, DCL_INPUT_SGV: 96,
  DCL_INPUT_SIV: 97, DCL_INPUT_PS: 98, DCL_INPUT_PS_SGV: 99, DCL_INPUT_PS_SIV: 100, DCL_OUTPUT: 101, DCL_OUTPUT_SGV: 102, DCL_OUTPUT_SIV: 103, DCL_TEMPS: 104, DCL_INDEXABLE_TEMP: 105,
  DCL_GLOBAL_FLAGS: 106, LOD: 108, GATHER4: 109, SAMPLEPOS: 110, SAMPLEINFO: 111, HS_DECLS: 113, HS_CONTROL_POINT_PHASE: 114, HS_FORK_PHASE: 115, HS_JOIN_PHASE: 116, EMIT_STREAM: 117, CUT_STREAM: 118,
  EMITTHENCUT_STREAM: 119, INTERFACE_CALL: 120, BUFINFO: 121, DERIV_RTX_COARSE: 122, DERIV_RTX_FINE: 123, DERIV_RTY_COARSE: 124, DERIV_RTY_FINE: 125, GATHER4_C: 126, GATHER4_PO: 127, GATHER4_PO_C: 128,
  RCP: 129, F32TOF16: 130, F16TOF32: 131, UADDC: 132, USUBB: 133, COUNTBITS: 134, FIRSTBIT_HI: 135, FIRSTBIT_LO: 136, FIRSTBIT_SHI: 137, UBFE: 138, IBFE: 139, BFI: 140, BFREV: 141, SWAPC: 142,
  DCL_STREAM: 143, DCL_FUNCTION_BODY: 144, DCL_FUNCTION_TABLE: 145, DCL_INTERFACE: 146, DCL_INPUT_CONTROL_POINT_COUNT: 147, DCL_OUTPUT_CONTROL_POINT_COUNT: 148, DCL_TESS_DOMAIN: 149,
  DCL_TESS_PARTITIONING: 150, DCL_TESS_OUTPUT_PRIMITIVE: 151, DCL_HS_MAX_TESSFACTOR: 152, DCL_HS_FORK_PHASE_INSTANCE_COUNT: 153, DCL_HS_JOIN_PHASE_INSTANCE_COUNT: 154, DCL_THREAD_GROUP: 155,
  DCL_UAV_TYPED: 156, DCL_UAV_RAW: 157, DCL_UAV_STRUCTURED: 158, DCL_TGSM_RAW: 159, DCL_TGSM_STRUCTURED: 160, DCL_RESOURCE_RAW: 161, DCL_RESOURCE_STRUCTURED: 162, LD_UAV_TYPED: 163,
  STORE_UAV_TYPED: 164, LD_RAW: 165, STORE_RAW: 166, LD_STRUCTURED: 167, STORE_STRUCTURED: 168, ATOMIC_AND: 169, ATOMIC_OR: 170, ATOMIC_XOR: 171, ATOMIC_CMP_STORE: 172, ATOMIC_IADD: 173,
  ATOMIC_IMAX: 174, ATOMIC_IMIN: 175, ATOMIC_UMAX: 176, ATOMIC_UMIN: 177, IMM_ATOMIC_ALLOC: 178, IMM_ATOMIC_CONSUME: 179, IMM_ATOMIC_IADD: 180, IMM_ATOMIC_AND: 181, IMM_ATOMIC_OR: 182,
  IMM_ATOMIC_XOR: 183, IMM_ATOMIC_EXCH: 184, IMM_ATOMIC_CMP_EXCH: 185, IMM_ATOMIC_IMAX: 186, IMM_ATOMIC_IMIN: 187, IMM_ATOMIC_UMAX: 188, IMM_ATOMIC_UMIN: 189, SYNC: 190,
  DADD: 191, DMAX: 192, DMIN: 193, DMUL: 194, DEQ: 195, DGE: 196, DLT: 197, DNE: 198, DMOV: 199, DMOVC: 200, DTOF: 201, FTOD: 202, EVAL_SNAPPED: 203, EVAL_SAMPLE_INDEX: 204, EVAL_CENTROID: 205,
  DCL_GS_INSTANCE_COUNT: 206, ABORT: 207, DEBUG_BREAK: 208,
} as const;
const OPNAME: Record<number, string> = Object.fromEntries(Object.entries(OPC).map(([k, v]) => [v, k.toLowerCase()]));

export const OT = {
  TEMP: 0, INPUT: 1, OUTPUT: 2, INDEXABLE_TEMP: 3, IMMEDIATE32: 4, IMMEDIATE64: 5, SAMPLER: 6, RESOURCE: 7, CONSTANT_BUFFER: 8, IMMEDIATE_CONSTANT_BUFFER: 9, LABEL: 10, INPUT_PRIMITIVEID: 11,
  OUTPUT_DEPTH: 12, NULL: 13, RASTERIZER: 14, OUTPUT_COVERAGE_MASK: 15, STREAM: 16, FUNCTION_BODY: 17, FUNCTION_TABLE: 18, INTERFACE: 19, FUNCTION_INPUT: 20, FUNCTION_OUTPUT: 21,
  OUTPUT_CONTROL_POINT_ID: 22, INPUT_FORK_INSTANCE_ID: 23, INPUT_JOIN_INSTANCE_ID: 24, INPUT_CONTROL_POINT: 25, OUTPUT_CONTROL_POINT: 26, INPUT_PATCH_CONSTANT: 27, INPUT_DOMAIN_POINT: 28,
  THIS_POINTER: 29, UAV: 30, THREAD_GROUP_SHARED_MEMORY: 31, INPUT_THREAD_ID: 32, INPUT_THREAD_GROUP_ID: 33, INPUT_THREAD_ID_IN_GROUP: 34, INPUT_COVERAGE_MASK: 35,
  INPUT_THREAD_ID_IN_GROUP_FLATTENED: 36, INPUT_GS_INSTANCE_ID: 37, OUTPUT_DEPTH_GE: 38, OUTPUT_DEPTH_LE: 39, CYCLE_COUNTER: 40, OUTPUT_STENCIL_REF: 41, INNER_COVERAGE: 42,
} as const;

// system values (D3D_NAME)
export const SV = { UNDEFINED: 0, POSITION: 1, CLIP_DISTANCE: 2, CULL_DISTANCE: 3, RENDER_TARGET_ARRAY_INDEX: 4, VIEWPORT_ARRAY_INDEX: 5, VERTEX_ID: 6, PRIMITIVE_ID: 7, INSTANCE_ID: 8, IS_FRONT_FACE: 9, SAMPLE_INDEX: 10, TARGET: 64, DEPTH: 65, COVERAGE: 66 } as const;

const u32 = (a: Uint8Array, o: number) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;

function readSig(c: Uint8Array, off: number, size: number, kind: "ISGN" | "ISG1" | "OSGN" | "OSG1" | "OSG5" | "PCSG"): SigElement[] {
  const n = u32(c, off);
  const stride = kind === "OSG5" ? 32 : kind === "ISG1" || kind === "OSG1" ? 32 : 24;
  const out: SigElement[] = [];
  const cstr = (o: number) => { let s = ""; for (let i = off + o; c[i]; i++) s += String.fromCharCode(c[i]); return s; };
  void size;
  for (let i = 0; i < n; i++) {
    let p = off + 8 + i * stride;
    let stream = 0;
    if (kind === "OSG5") { stream = u32(c, p); p += 4; }
    const nameOff = u32(c, p);
    const e: SigElement = { name: cstr(nameOff), index: u32(c, p + 4), sysVal: u32(c, p + 8), compType: u32(c, p + 12), reg: u32(c, p + 16), mask: c[p + 20], rwMask: c[p + 21], stream, minPrec: kind === "ISG1" || kind === "OSG1" ? u32(c, p + 24) : 0 };
    out.push(e);
  }
  return out;
}

export function parseDxbc(data: Uint8Array): Sm5Shader {
  if (data.length < 32 || u32(data, 0) !== 0x43425844) throw new Error("not a DXBC container");
  const count = u32(data, 28);
  let code: Uint8Array | null = null;
  const sh: Sm5Shader = {
    type: 0, major: 5, minor: 0, ins: [], inputs: [], outputs: [], patch: [], cbs: new Map(), srvs: new Map(), samplers: new Map(), uavs: new Map(), tgsm: new Map(), temps: 0, indexableTemps: new Map(),
    icb: null, threadGroup: [1, 1, 1], flags: 0, unsupported: [], cmpTextures: new Set(), atomicUavs: new Set(), uavReads: new Set(), atomicTgsm: new Set(), usesDiscard: false, declIn: new Map(), declOut: new Map(),
    outDepth: false, outMask: false, inputSpecials: new Set(),
  };
  for (let i = 0; i < count; i++) {
    const off = u32(data, 32 + i * 4);
    const tag = String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
    const size = u32(data, off + 4);
    const body = data.subarray(off + 8, off + 8 + size);
    switch (tag) {
      case "SHDR": case "SHEX": code = body; break;
      case "ISGN": case "ISG1": sh.inputs = readSig(body, 0, size, tag); break;
      case "OSGN": case "OSG1": case "OSG5": sh.outputs = readSig(body, 0, size, tag); break;
      case "PCSG": sh.patch = readSig(body, 0, size, "PCSG"); break;
    }
  }
  if (!code) throw new Error("DXBC container has no shader code chunk");
  decodeTokens(sh, code);
  return sh;
}

function decodeTokens(sh: Sm5Shader, code: Uint8Array) {
  const w = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + (code.length & ~3)));
  const ver = w[0];
  sh.type = ver >>> 16; sh.major = (ver >>> 4) & 0xf; sh.minor = ver & 0xf;
  const total = w[1];
  let pc = 2;
  const readOperand = (): Sm5Operand => {
    const tok = w[pc++];
    const numComps = tok & 3;
    const o: Sm5Operand = { type: (tok >>> 12) & 0xff, numComps: numComps === 0 ? 0 : numComps === 1 ? 1 : 4, selMode: 0, swz: [0, 1, 2, 3], mask: 0xf, neg: false, abs: false, idx: [], imm: null };
    if (numComps === 2) {
      o.selMode = (tok >>> 2) & 3;
      const sel = (tok >>> 4) & 0xff;
      if (o.selMode === 0) { o.mask = sel & 0xf; }
      else if (o.selMode === 1) { o.swz = [sel & 3, (sel >>> 2) & 3, (sel >>> 4) & 3, (sel >>> 6) & 3]; }
      else { const c = sel & 3; o.swz = [c, c, c, c]; o.mask = 1 << c; }
    }
    const dim = (tok >>> 20) & 3;
    // extended operand tokens
    let ext = (tok >>> 31) !== 0;
    while (ext) {
      const et = w[pc++];
      if ((et & 0x3f) === 1) { const m = (et >>> 6) & 0xff; if (m & 1) o.neg = true; if (m & 2) o.abs = true; }
      ext = (et >>> 31) !== 0;
    }
    if (o.type === OT.IMMEDIATE32) {
      o.imm = o.numComps === 1 ? [w[pc++]] : [w[pc++], w[pc++], w[pc++], w[pc++]];
    } else if (o.type === OT.IMMEDIATE64) {
      o.imm = o.numComps === 1 ? [w[pc++], w[pc++]] : [w[pc++], w[pc++], w[pc++], w[pc++], w[pc++], w[pc++], w[pc++], w[pc++]];
    }
    for (let d = 0; d < dim; d++) {
      const rep = (tok >>> (22 + 3 * d)) & 7;
      let imm = 0;
      let rel: Sm5Operand | null = null;
      if (rep === 0) imm = w[pc++];
      else if (rep === 1) { imm = w[pc++]; pc++; }
      else if (rep === 2) rel = readOperand();
      else if (rep === 3) { imm = w[pc++]; rel = readOperand(); }
      else if (rep === 4) { imm = w[pc++]; pc++; rel = readOperand(); }
      o.idx.push({ imm, rel });
    }
    return o;
  };
  while (pc < total && pc < w.length) {
    const start = pc;
    const tok = w[pc++];
    const op = tok & 0x7ff;
    let len = (tok >>> 24) & 0x7f;
    const ins: Sm5Ins = { op, ctrl: (tok >>> 11) & 0x1fff, ops: [], offset: null, data: [], custom: null, at: start };
    if (op === OPC.CUSTOMDATA) {
      len = w[pc];
      const cls = tok >>> 11;
      ins.ctrl = cls;
      ins.custom = Array.from(w.subarray(pc + 1, start + len));
      if (cls === 3) sh.icb = ins.custom.slice(1); // immediate constant buffer: first dword is the vec4 count
      if (cls === 3) sh.icb = ins.custom;
      pc = start + len;
      sh.ins.push(ins);
      continue;
    }
    const end = start + len;
    let ext = (tok >>> 31) !== 0;
    while (ext) {
      const et = w[pc++];
      const t = et & 0x3f;
      if (t === 1) { const sx = (et >>> 9) & 0xf, sy = (et >>> 13) & 0xf, sz = (et >>> 17) & 0xf; ins.offset = [sx > 7 ? sx - 16 : sx, sy > 7 ? sy - 16 : sy, sz > 7 ? sz - 16 : sz]; }
      else if (t === 2) ins.data.push(0x1000 | ((et >>> 6) & 0x1f));
      else if (t === 3) ins.data.push(0x2000 | ((et >>> 6) & 0xffff));
      ext = (et >>> 31) !== 0;
    }
    switch (op) {
      case OPC.DCL_GLOBAL_FLAGS: sh.flags = ins.ctrl & 0xfff; break;
      case OPC.DCL_TEMPS: sh.temps = w[pc]; pc++; break;
      case OPC.DCL_INDEXABLE_TEMP: { const reg = w[pc], size = w[pc + 1], comps = w[pc + 2]; sh.indexableTemps.set(reg, { size, comps }); pc += 3; break; }
      case OPC.DCL_THREAD_GROUP: sh.threadGroup = [w[pc], w[pc + 1], w[pc + 2]]; pc += 3; break;
      case OPC.DCL_CONSTANT_BUFFER: { const o = readOperand(); const sz = o.idx.length > 1 ? o.idx[1].imm : 0; sh.cbs.set(o.idx[0].imm, { size: sz, dynamic: ((ins.ctrl) & 1) !== 0 }); ins.ops.push(o); break; }
      case OPC.DCL_SAMPLER: { const o = readOperand(); sh.samplers.set(o.idx[0].imm, { comparison: (ins.ctrl & 0xf) === 1 }); ins.ops.push(o); break; }
      case OPC.DCL_RESOURCE: case OPC.DCL_RESOURCE_RAW: case OPC.DCL_RESOURCE_STRUCTURED: {
        const o = readOperand();
        const slot = o.idx[0].imm;
        let ret = [5, 5, 5, 5], stride = 0;
        if (op === OPC.DCL_RESOURCE) { const rt = w[pc++]; ret = [rt & 15, (rt >>> 4) & 15, (rt >>> 8) & 15, (rt >>> 12) & 15]; }
        else if (op === OPC.DCL_RESOURCE_STRUCTURED) stride = w[pc++];
        sh.srvs.set(slot, { dim: op === OPC.DCL_RESOURCE ? ins.ctrl & 0x1f : op === OPC.DCL_RESOURCE_RAW ? 11 : 12, ret, stride, raw: op === OPC.DCL_RESOURCE_RAW, structured: op === OPC.DCL_RESOURCE_STRUCTURED });
        ins.ops.push(o);
        break;
      }
      case OPC.DCL_UAV_TYPED: case OPC.DCL_UAV_RAW: case OPC.DCL_UAV_STRUCTURED: {
        const o = readOperand();
        const slot = o.idx[0].imm;
        let ret = [5, 5, 5, 5], stride = 0;
        if (op === OPC.DCL_UAV_TYPED) { const rt = w[pc++]; ret = [rt & 15, (rt >>> 4) & 15, (rt >>> 8) & 15, (rt >>> 12) & 15]; }
        else if (op === OPC.DCL_UAV_STRUCTURED) stride = w[pc++];
        sh.uavs.set(slot, { dim: op === OPC.DCL_UAV_TYPED ? ins.ctrl & 0x1f : op === OPC.DCL_UAV_RAW ? 11 : 12, ret, stride, raw: op === OPC.DCL_UAV_RAW, structured: op === OPC.DCL_UAV_STRUCTURED, typed: op === OPC.DCL_UAV_TYPED, globallyCoherent: (ins.ctrl & 0x10000) !== 0 });
        ins.ops.push(o);
        break;
      }
      case OPC.DCL_TGSM_RAW: case OPC.DCL_TGSM_STRUCTURED: {
        const o = readOperand();
        if (op === OPC.DCL_TGSM_RAW) sh.tgsm.set(o.idx[0].imm, { stride: 4, count: w[pc++] / 4, raw: true });
        else { const stride = w[pc++], count = w[pc++]; sh.tgsm.set(o.idx[0].imm, { stride, count, raw: false }); }
        ins.ops.push(o);
        break;
      }
      case OPC.DCL_INPUT: case OPC.DCL_OUTPUT: case OPC.DCL_INPUT_PS: case OPC.DCL_INPUT_SGV: case OPC.DCL_INPUT_SIV: case OPC.DCL_INPUT_PS_SGV: case OPC.DCL_INPUT_PS_SIV:
      case OPC.DCL_OUTPUT_SGV: case OPC.DCL_OUTPUT_SIV: {
        const o = readOperand();
        ins.ops.push(o);
        let sv = 0;
        if (op === OPC.DCL_INPUT_SGV || op === OPC.DCL_INPUT_SIV || op === OPC.DCL_INPUT_PS_SGV || op === OPC.DCL_INPUT_PS_SIV || op === OPC.DCL_OUTPUT_SGV || op === OPC.DCL_OUTPUT_SIV) { sv = w[pc++]; ins.data.push(sv); }
        const reg = o.idx.length ? o.idx[o.idx.length - 1].imm : 0;
        const isOut = op === OPC.DCL_OUTPUT || op === OPC.DCL_OUTPUT_SGV || op === OPC.DCL_OUTPUT_SIV;
        const kind = op === OPC.DCL_INPUT_SGV || op === OPC.DCL_INPUT_PS_SGV || op === OPC.DCL_OUTPUT_SGV ? "sgv" : op === OPC.DCL_INPUT_SIV || op === OPC.DCL_INPUT_PS_SIV || op === OPC.DCL_OUTPUT_SIV ? "siv" : "plain";
        if (isOut) {
          if (o.type === OT.OUTPUT_DEPTH || o.type === OT.OUTPUT_DEPTH_GE || o.type === OT.OUTPUT_DEPTH_LE) sh.outDepth = true;
          else if (o.type === OT.OUTPUT_COVERAGE_MASK) sh.outMask = true;
          else sh.declOut.set(reg, { mask: o.mask, sv, kind });
        } else if (o.type === OT.INPUT) {
          sh.declIn.set(reg, { mask: o.mask, interp: op === OPC.DCL_INPUT_PS || op === OPC.DCL_INPUT_PS_SGV || op === OPC.DCL_INPUT_PS_SIV ? ins.ctrl & 0xf : 0, sv, kind });
        } else sh.inputSpecials.add(o.type);
        break;
      }
      default: {
        while (pc < end) ins.ops.push(readOperand());
      }
    }
    pc = end;
    sh.ins.push(ins);
  }
  // usage scan
  for (const i of sh.ins) {
    switch (i.op) {
      case OPC.SAMPLE_C: case OPC.SAMPLE_C_LZ: case OPC.GATHER4_C: case OPC.GATHER4_PO_C: sh.cmpTextures.add(i.ops[2].idx[0].imm); break;
      case OPC.DISCARD: sh.usesDiscard = true; break;
      case OPC.LD_UAV_TYPED: sh.uavReads.add(i.ops[2].idx[0].imm); break;
      case OPC.ATOMIC_AND: case OPC.ATOMIC_OR: case OPC.ATOMIC_XOR: case OPC.ATOMIC_CMP_STORE: case OPC.ATOMIC_IADD: case OPC.ATOMIC_IMAX: case OPC.ATOMIC_IMIN: case OPC.ATOMIC_UMAX: case OPC.ATOMIC_UMIN: {
        const o = i.ops[0];
        if (o.type === OT.UAV) sh.atomicUavs.add(o.idx[0].imm); else if (o.type === OT.THREAD_GROUP_SHARED_MEMORY) sh.atomicTgsm.add(o.idx[0].imm);
        break;
      }
      case OPC.IMM_ATOMIC_ALLOC: case OPC.IMM_ATOMIC_CONSUME: case OPC.IMM_ATOMIC_IADD: case OPC.IMM_ATOMIC_AND: case OPC.IMM_ATOMIC_OR: case OPC.IMM_ATOMIC_XOR: case OPC.IMM_ATOMIC_EXCH:
      case OPC.IMM_ATOMIC_CMP_EXCH: case OPC.IMM_ATOMIC_IMAX: case OPC.IMM_ATOMIC_IMIN: case OPC.IMM_ATOMIC_UMAX: case OPC.IMM_ATOMIC_UMIN: {
        const o = i.ops[1];
        if (o.type === OT.UAV) sh.atomicUavs.add(o.idx[0].imm); else if (o.type === OT.THREAD_GROUP_SHARED_MEMORY) sh.atomicTgsm.add(o.idx[0].imm);
        break;
      }
      case OPC.EMIT: case OPC.CUT: case OPC.EMITTHENCUT: case OPC.EMIT_STREAM: case OPC.CUT_STREAM: case OPC.HS_DECLS: case OPC.HS_CONTROL_POINT_PHASE: case OPC.HS_FORK_PHASE: case OPC.HS_JOIN_PHASE:
        sh.unsupported.push(OPNAME[i.op]); break;
    }
  }
  if (sh.type === 2 || sh.type === 3 || sh.type === 4) sh.unsupported.push(["ps", "vs", "geometry shader", "hull shader", "domain shader", "cs"][sh.type]);
}

// ----------------------------------------------------------------------------------------------------------------------
// disassembly (for debugging)
// ----------------------------------------------------------------------------------------------------------------------
export function disasm(sh: Sm5Shader): string {
  const regName = (o: Sm5Operand): string => {
    const names: Record<number, string> = { [OT.TEMP]: "r", [OT.INPUT]: "v", [OT.OUTPUT]: "o", [OT.INDEXABLE_TEMP]: "x", [OT.SAMPLER]: "s", [OT.RESOURCE]: "t", [OT.CONSTANT_BUFFER]: "cb", [OT.IMMEDIATE_CONSTANT_BUFFER]: "icb", [OT.UAV]: "u", [OT.THREAD_GROUP_SHARED_MEMORY]: "g" };
    if (o.type === OT.IMMEDIATE32) return "l(" + o.imm!.map((v) => "0x" + v.toString(16)).join(",") + ")";
    let s = (names[o.type] ?? `type${o.type}_`) + o.idx.map((i) => `[${i.rel ? "rel+" : ""}${i.imm}]`).join("");
    if (o.numComps === 4) s += "." + (o.selMode === 1 ? o.swz.map((c) => "xyzw"[c]).join("") : [0, 1, 2, 3].filter((c) => o.mask & (1 << c)).map((c) => "xyzw"[c]).join(""));
    if (o.neg) s = "-" + s;
    if (o.abs) s = `abs(${s})`;
    return s;
  };
  return sh.ins.map((i) => `${OPNAME[i.op] ?? i.op}${i.ctrl ? "(" + i.ctrl.toString(16) + ")" : ""} ${i.ops.map(regName).join(", ")}${i.data.length ? " data=" + i.data.join(",") : ""}`).join("\n");
}

// ----------------------------------------------------------------------------------------------------------------------
// emission
// ----------------------------------------------------------------------------------------------------------------------
export interface Sm5Link {
  stage: "vs" | "ps" | "cs";
  /** varying (semantic name + index) -> location slot and interpolation attribute */
  slots: Map<string, { slot: number; interp: string; kind: "f" | "u" | "i" }>;
  /** vertex shader: attribute kinds by input register: f/u/i */
  inputKinds?: Map<number, string>;
  /** extra pixel-shader inputs the vertex shader must output as zeros */
  extraSlots?: { slot: number; interp: string; kind: "f" | "u" | "i" }[];
  /** per SRV slot: sampled view dimension override and sample type ("float" | "depth" | "uint" | "sint" | "unfilterable") */
  srvTypes?: Map<number, { dim: string; sample: string }>;
  /** per UAV slot: storage texture format for typed UAVs */
  uavFormats?: Map<number, string>;
  /** typed SRV buffers: format class per slot */
  bufferFormats?: Map<number, string>;
  /** render target count */
  targets?: number;
  /** vertex shader output clamp for D3D clip space differences: none needed */
  flipY?: boolean;
}

/** WGSL interpolation attribute for a D3D10_SB_INTERPOLATION_MODE value declared by a pixel shader input */
export function interpAttr(mode: number): string {
  switch (mode) {
    case 1: return "@interpolate(flat)";
    case 3: return "@interpolate(perspective, centroid)";
    case 4: return "@interpolate(linear)";
    case 5: return "@interpolate(linear, centroid)";
    case 6: return "@interpolate(perspective, sample)";
    case 7: return "@interpolate(linear, sample)";
    default: return "";
  }
}

type Kind = "f" | "i" | "u";
const COMP = ["x", "y", "z", "w"];

export function emitSm5(sh: Sm5Shader, link: Sm5Link): { wgsl: string; vsOutputs: string[]; psInputs: string[] } {
  return new Emitter5(sh, link).emit();
}

const f32lit = (bits: number): string => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits >>> 0);
  const v = dv.getFloat32(0);
  if (Number.isNaN(v) || !Number.isFinite(v)) return `bitcast<f32>(zbits | ${bits >>> 0}u)`;
  let s = Math.fround(v).toPrecision(9);
  if (!/[.e]/.test(s)) s += ".0";
  else if (/e/.test(s) && !/\./.test(s.split("e")[0])) s = s.replace("e", ".0e");
  return s;
};

class Emitter5 {
  sh: Sm5Shader;
  link: Sm5Link;
  out: string[] = [];
  ind = 1;
  tmpN = 0;
  stage: "vs" | "ps" | "cs";
  labels = new Set<number>();
  switchStack: { pendingCases: string[]; open: boolean; hasDefault: boolean }[] = [];
  vsOutputs: string[] = [];
  psInputs: string[] = [];
  curLabel = -1;

  constructor(sh: Sm5Shader, link: Sm5Link) {
    this.sh = sh; this.link = link;
    this.stage = sh.type === 1 ? "vs" : sh.type === 0 ? "ps" : "cs";
  }
  w(s: string) {
    // the first statement after one or more case labels opens the WGSL clause
    const sw = this.switchStack[this.switchStack.length - 1];
    if (sw && sw.pendingCases.length && !sw.open && !this.closing) {
      this.out.push("  ".repeat(this.ind) + this.caseLabel(sw.pendingCases) + " {");
      sw.pendingCases = [];
      sw.open = true;
      this.ind++;
    }
    this.out.push("  ".repeat(this.ind) + s);
  }
  private closing = false;
  tmp(): string { return "_t" + this.tmpN++; }

  // ---- operand access ----------------------------------------------------------------------------------------------
  private swz(o: Sm5Operand): string {
    if (o.numComps !== 4) return "";
    if (o.selMode === 1 || o.selMode === 2) {
      const [a, b, c, d] = o.swz;
      return a === 0 && b === 1 && c === 2 && d === 3 ? "" : `.${COMP[a]}${COMP[b]}${COMP[c]}${COMP[d]}`;
    }
    return ""; // mask mode: components keep their positions
  }
  private idxExpr(i: { imm: number; rel: Sm5Operand | null }): string {
    if (!i.rel) return String(i.imm) + "u";
    const r = this.readRaw(i.rel);
    const rv = `bitcast<vec4<u32>>(${r})`;
    const comp = i.rel.numComps === 4 ? COMP[i.rel.selMode === 1 || i.rel.selMode === 2 ? i.rel.swz[0] : [0, 1, 2, 3].find((c) => i.rel!.mask & (1 << c)) ?? 0] : "x";
    return i.imm ? `(${rv}.${comp} + ${i.imm}u)` : `${rv}.${comp}`;
  }
  /** raw vec4<f32> bit-container expression of the operand before swizzle/modifiers */
  private readRaw(o: Sm5Operand): string {
    switch (o.type) {
      case OT.TEMP: return `r${o.idx[0].imm}`;
      case OT.INPUT: return o.idx.length > 1 ? `vin${o.idx[0].imm}_${o.idx[1].imm}` : `v${o.idx[0].imm}`;
      case OT.OUTPUT: return `o${o.idx[0].imm}`;
      case OT.INDEXABLE_TEMP: return `x${o.idx[0].imm}[${this.idxExpr(o.idx[1])}]`;
      case OT.CONSTANT_BUFFER: return `cb${o.idx[0].imm}.d[${this.idxExpr(o.idx[1])}]`;
      case OT.IMMEDIATE_CONSTANT_BUFFER: return `icb[${this.idxExpr(o.idx[0])}]`;
      case OT.IMMEDIATE32: {
        const v = o.imm!;
        if (o.numComps === 1) return `vec4<f32>(${f32lit(v[0])})`;
        return `vec4<f32>(${v.map(f32lit).join(", ")})`;
      }
      case OT.INPUT_THREAD_ID: return "bitcast<vec4<f32>>(vec4<u32>(gtid.x, gtid.y, gtid.z, 0u))";
      case OT.INPUT_THREAD_GROUP_ID: return "bitcast<vec4<f32>>(vec4<u32>(gid.x, gid.y, gid.z, 0u))";
      case OT.INPUT_THREAD_ID_IN_GROUP: return "bitcast<vec4<f32>>(vec4<u32>(ltid.x, ltid.y, ltid.z, 0u))";
      case OT.INPUT_THREAD_ID_IN_GROUP_FLATTENED: return "bitcast<vec4<f32>>(vec4<u32>(lidx, 0u, 0u, 0u))";
      case OT.INPUT_PRIMITIVEID: return "vec4<f32>(0.0)";
      case OT.INPUT_COVERAGE_MASK: return "bitcast<vec4<f32>>(vec4<u32>(sample_mask_in, 0u, 0u, 0u))";
      case OT.OUTPUT_DEPTH: case OT.OUTPUT_DEPTH_GE: case OT.OUTPUT_DEPTH_LE: return "vec4<f32>(oDepth)";
      case OT.NULL: return "vec4<f32>(0.0)";
      default: return `vec4<f32>(0.0) /* operand type ${o.type} */`;
    }
  }
  /** typed read of an operand as vec4<kind> after swizzle and modifiers */
  src(o: Sm5Operand, kind: Kind): string {
    let e: string;
    if (o.type === OT.IMMEDIATE32 && kind !== "f") {
      const v = o.numComps === 1 ? [o.imm![0], o.imm![0], o.imm![0], o.imm![0]] : o.imm!;
      e = kind === "u" ? `vec4<u32>(${v.map((x) => (x >>> 0) + "u").join(", ")})` : "";
      if (kind === "i") e = `vec4<i32>(${v.map((x) => ((x | 0) === -2147483648 ? "-2147483647 - 1" : String(x | 0))).join(", ")})`;
      const swz = this.swz(o);
      if (swz) e = `(${e})${swz}`;
    } else {
      e = this.readRaw(o);
      const swz = this.swz(o);
      if (swz) e = `(${e})${swz}`;
      if (kind === "i") e = `bitcast<vec4<i32>>(${e})`;
      else if (kind === "u") e = `bitcast<vec4<u32>>(${e})`;
      if (o.numComps === 1 && o.type !== OT.IMMEDIATE32) e = `vec4<${kind === "f" ? "f32" : kind === "i" ? "i32" : "u32"}>((${e}).x)`;
    }
    if (o.abs) e = kind === "f" ? `abs(${e})` : kind === "i" ? `abs(${e})` : e;
    if (o.neg) e = kind === "f" ? `(-${e})` : kind === "i" ? `(-${e})` : `(vec4<u32>(0u) - ${e})`;
    return e;
  }
  /** scalar: first selected component */
  scalar(o: Sm5Operand, kind: Kind): string { return `${this.src(o, kind)}.x`; }

  private lvalue(o: Sm5Operand): string {
    switch (o.type) {
      case OT.TEMP: return `r${o.idx[0].imm}`;
      case OT.OUTPUT: return `o${o.idx[0].imm}`;
      case OT.INDEXABLE_TEMP: return `x${o.idx[0].imm}[${this.idxExpr(o.idx[1])}]`;
      case OT.OUTPUT_DEPTH: case OT.OUTPUT_DEPTH_GE: case OT.OUTPUT_DEPTH_LE: return "oDepth";
      case OT.OUTPUT_COVERAGE_MASK: return "oMaskBits";
      case OT.NULL: return "";
      default: return `/*dst type ${o.type}*/ nulldst`;
    }
  }
  /** store a typed vec4 expression into a destination register honoring the write mask */
  store(o: Sm5Operand, expr: string, kind: Kind, sat = false) {
    if (o.type === OT.NULL) return;
    const lv = this.lvalue(o);
    let e = expr;
    if (sat && kind === "f") e = `clamp(${e}, vec4<f32>(0.0), vec4<f32>(1.0))`;
    if (kind === "i") e = `bitcast<vec4<f32>>(${e})`;
    else if (kind === "u") e = `bitcast<vec4<f32>>(${e})`;
    if (lv === "oDepth") { this.w(`oDepth = (${e}).x;`); return; }
    if (lv === "oMaskBits") { this.w(`oMaskBits = bitcast<vec4<u32>>(${e}).x;`); return; }
    const mask = o.mask & 0xf;
    if (mask === 0xf) { this.w(`${lv} = ${e};`); return; }
    if (!mask) return;
    const t = this.tmp();
    this.w(`{ let ${t} = ${e};`);
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) this.w(`  ${lv}.${COMP[i]} = ${t}.${COMP[i]};`);
    this.w("}");
  }
  /** shorthand: float ALU op with saturate flag from opcode bit 13 */
  private sat(ins: Sm5Ins): boolean { return (ins.ctrl & 0x2) !== 0; }
  private cond(ins: Sm5Ins, o: Sm5Operand): string {
    // opcode bit 18 (ctrl bit 7): nonzero test when set
    const nz = (ins.ctrl & 0x80) !== 0;
    const v = `bitcast<vec4<u32>>(${this.readRaw(o)}${this.swz(o)}).x`;
    return nz ? `${v} != 0u` : `${v} == 0u`;
  }
  private maskBool(e: string): string { return `select(vec4<u32>(0u), vec4<u32>(0xffffffffu), ${e})`; }

  // ---- resources -----------------------------------------------------------------------------------------------------
  private resDim(slot: number): { dim: number } {
    const r = this.sh.srvs.get(slot);
    return { dim: r ? r.dim : 3 };
  }
  private texTypeName(slot: number): { ty: string; sample: string; dim: number; ms: boolean; arr: boolean } {
    const r = this.sh.srvs.get(slot);
    const dim = r ? r.dim : 3;
    const ret = r ? r.ret[0] : 5;
    const cmp = this.sh.cmpTextures.has(slot);
    const stype = cmp ? "depth" : ret === 4 ? "u32" : ret === 3 ? "i32" : "f32";
    return { ty: "", sample: stype, dim, ms: dim === 4 || dim === 9, arr: dim === 7 || dim === 8 || dim === 9 || dim === 10 };
  }
  private texDecl(slot: number, group: number): string {
    const r = this.sh.srvs.get(slot)!;
    const info = this.texTypeName(slot);
    const dim = r.dim;
    if (r.raw || r.structured || dim === 11 || dim === 12) return `@group(${group}) @binding(${16 + slot}) var<storage, read> t${slot}: array<u32>;`;
    if (dim === 1) return this.bufferDecl(slot, group);
    const st = info.sample;
    const s = st === "depth" ? "" : `<${st}>`;
    let kind: string;
    switch (dim) {
      case 2: kind = st === "depth" ? "texture_depth_2d" : `texture_1d${s}`; break; // 1D depth is not expressible; fallback
      case 3: kind = st === "depth" ? "texture_depth_2d" : `texture_2d${s}`; break;
      case 4: kind = st === "depth" ? "texture_depth_multisampled_2d" : `texture_multisampled_2d${s}`; break;
      case 5: kind = `texture_3d${s}`; break;
      case 6: kind = st === "depth" ? "texture_depth_cube" : `texture_cube${s}`; break;
      case 7: kind = `texture_1d${s}`; break;
      case 8: kind = st === "depth" ? "texture_depth_2d_array" : `texture_2d_array${s}`; break;
      case 10: kind = st === "depth" ? "texture_depth_cube_array" : `texture_cube_array${s}`; break;
      default: kind = `texture_2d${s}`;
    }
    return `@group(${group}) @binding(${16 + slot}) var t${slot}: ${kind};`;
  }
  private bufferDecl(slot: number, group: number): string {
    // typed Buffer<T>: read through a storage buffer of raw words; the element format is applied by the load code
    return `@group(${group}) @binding(${16 + slot}) var<storage, read> t${slot}: array<u32>;`;
  }

  // ---- instruction emission ------------------------------------------------------------------------------------------
  private f2(ins: Sm5Ins, f: (a: string, b: string) => string) { this.store(ins.ops[0], f(this.src(ins.ops[1], "f"), this.src(ins.ops[2], "f")), "f", this.sat(ins)); }
  private f1(ins: Sm5Ins, f: (a: string) => string) { this.store(ins.ops[0], f(this.src(ins.ops[1], "f")), "f", this.sat(ins)); }
  private i2(ins: Sm5Ins, k: Kind, f: (a: string, b: string) => string) { this.store(ins.ops[0], f(this.src(ins.ops[1], k), this.src(ins.ops[2], k)), k); }
  private cmp(ins: Sm5Ins, k: Kind, op: string) { this.store(ins.ops[0], this.maskBool(`${this.src(ins.ops[1], k)} ${op} ${this.src(ins.ops[2], k)}`), "u"); }

  private coords(addr: string, dim: number): { c: string; level?: string; layer?: string } {
    switch (dim) {
      case 2: case 7: return { c: `${addr}.x` };
      case 3: case 4: return { c: `${addr}.xy` };
      case 5: case 6: return { c: `${addr}.xyz` };
      case 8: case 9: return { c: `${addr}.xy`, layer: `${addr}.z` };
      case 10: return { c: `${addr}.xyz`, layer: `${addr}.w` };
      default: return { c: `${addr}.xy` };
    }
  }
  private offsetArg(ins: Sm5Ins, dim: number): string {
    if (!ins.offset) return "";
    const [x, y, z] = ins.offset;
    if (dim === 3 || dim === 8) return `, vec2<i32>(${x}, ${y})`;
    if (dim === 5) return `, vec3<i32>(${x}, ${y}, ${z})`;
    return "";
  }
  private resultSwz(resOp: Sm5Operand, expr: string): string {
    const s = this.swz(resOp);
    return s ? `(${expr})${s}` : expr;
  }

  private inst(ins: Sm5Ins) {
    const o = ins.ops;
    switch (ins.op) {
      case OPC.NOP: case OPC.CUSTOMDATA: return;
      case OPC.MOV: this.store(o[0], this.src(o[1], "f"), "f", this.sat(ins)); return;
      case OPC.MOVC: this.store(o[0], `select(${this.src(o[3], "f")}, ${this.src(o[2], "f")}, ${this.src(o[1], "u")} != vec4<u32>(0u))`, "f", this.sat(ins)); return;
      case OPC.ADD: this.f2(ins, (a, b) => `${a} + ${b}`); return;
      case OPC.MUL: this.f2(ins, (a, b) => `${a} * ${b}`); return;
      case OPC.DIV: this.f2(ins, (a, b) => `${a} / ${b}`); return;
      case OPC.MAD: this.store(o[0], `${this.src(o[1], "f")} * ${this.src(o[2], "f")} + ${this.src(o[3], "f")}`, "f", this.sat(ins)); return;
      case OPC.MIN: this.f2(ins, (a, b) => `min(${a}, ${b})`); return;
      case OPC.MAX: this.f2(ins, (a, b) => `max(${a}, ${b})`); return;
      case OPC.DP2: this.store(o[0], `vec4<f32>(dot(${this.src(o[1], "f")}.xy, ${this.src(o[2], "f")}.xy))`, "f", this.sat(ins)); return;
      case OPC.DP3: this.store(o[0], `vec4<f32>(dot(${this.src(o[1], "f")}.xyz, ${this.src(o[2], "f")}.xyz))`, "f", this.sat(ins)); return;
      case OPC.DP4: this.store(o[0], `vec4<f32>(dot(${this.src(o[1], "f")}, ${this.src(o[2], "f")}))`, "f", this.sat(ins)); return;
      case OPC.SQRT: this.f1(ins, (a) => `sqrt(${a})`); return;
      case OPC.RSQ: this.f1(ins, (a) => `inverseSqrt(${a})`); return;
      case OPC.RCP: this.f1(ins, (a) => `(vec4<f32>(1.0) / ${a})`); return;
      case OPC.EXP: this.f1(ins, (a) => `exp2(${a})`); return;
      case OPC.LOG: this.f1(ins, (a) => `log2(${a})`); return;
      case OPC.FRC: this.f1(ins, (a) => `fract(${a})`); return;
      case OPC.ROUND_NE: this.f1(ins, (a) => `round(${a})`); return;
      case OPC.ROUND_NI: this.f1(ins, (a) => `floor(${a})`); return;
      case OPC.ROUND_PI: this.f1(ins, (a) => `ceil(${a})`); return;
      case OPC.ROUND_Z: this.f1(ins, (a) => `trunc(${a})`); return;
      case OPC.DERIV_RTX: case OPC.DERIV_RTX_COARSE: this.f1(ins, (a) => `dpdxCoarse(${a})`); return;
      case OPC.DERIV_RTY: case OPC.DERIV_RTY_COARSE: this.f1(ins, (a) => `dpdyCoarse(${a})`); return;
      case OPC.DERIV_RTX_FINE: this.f1(ins, (a) => `dpdxFine(${a})`); return;
      case OPC.DERIV_RTY_FINE: this.f1(ins, (a) => `dpdyFine(${a})`); return;
      case OPC.SINCOS: {
        const t = this.tmp();
        this.w(`let ${t} = ${this.src(o[2], "f")};`);
        if (o[0].type !== OT.NULL) this.store(o[0], `sin(${t})`, "f", this.sat(ins));
        if (o[1].type !== OT.NULL) this.store(o[1], `cos(${t})`, "f", this.sat(ins));
        return;
      }
      case OPC.EQ: this.cmp(ins, "f", "=="); return;
      case OPC.NE: this.cmp(ins, "f", "!="); return;
      case OPC.LT: this.cmp(ins, "f", "<"); return;
      case OPC.GE: this.cmp(ins, "f", ">="); return;
      case OPC.IEQ: this.cmp(ins, "i", "=="); return;
      case OPC.INE: this.cmp(ins, "i", "!="); return;
      case OPC.ILT: this.cmp(ins, "i", "<"); return;
      case OPC.IGE: this.cmp(ins, "i", ">="); return;
      case OPC.ULT: this.cmp(ins, "u", "<"); return;
      case OPC.UGE: this.cmp(ins, "u", ">="); return;
      case OPC.AND: this.i2(ins, "u", (a, b) => `${a} & ${b}`); return;
      case OPC.OR: this.i2(ins, "u", (a, b) => `${a} | ${b}`); return;
      case OPC.XOR: this.i2(ins, "u", (a, b) => `${a} ^ ${b}`); return;
      case OPC.NOT: this.store(o[0], `~${this.src(o[1], "u")}`, "u"); return;
      case OPC.IADD: this.i2(ins, "i", (a, b) => `${a} + ${b}`); return;
      case OPC.INEG: this.store(o[0], `(-${this.src(o[1], "i")})`, "i"); return;
      case OPC.IMUL: {
        // imul dst_hi, dst_lo, a, b
        const a = this.tmp(), b = this.tmp();
        this.w(`let ${a} = ${this.src(o[2], "i")}; let ${b} = ${this.src(o[3], "i")};`);
        if (o[1].type !== OT.NULL) this.store(o[1], `${a} * ${b}`, "i");
        if (o[0].type !== OT.NULL) this.store(o[0], `vec4<i32>(mulhi_i(${a}.x, ${b}.x), mulhi_i(${a}.y, ${b}.y), mulhi_i(${a}.z, ${b}.z), mulhi_i(${a}.w, ${b}.w))`, "i");
        this.needMulhi = true;
        return;
      }
      case OPC.UMUL: {
        const a = this.tmp(), b = this.tmp();
        this.w(`let ${a} = ${this.src(o[2], "u")}; let ${b} = ${this.src(o[3], "u")};`);
        if (o[1].type !== OT.NULL) this.store(o[1], `${a} * ${b}`, "u");
        if (o[0].type !== OT.NULL) this.store(o[0], `vec4<u32>(mulhi_u(${a}.x, ${b}.x), mulhi_u(${a}.y, ${b}.y), mulhi_u(${a}.z, ${b}.z), mulhi_u(${a}.w, ${b}.w))`, "u");
        this.needMulhi = true;
        return;
      }
      case OPC.IMAD: this.store(o[0], `${this.src(o[1], "i")} * ${this.src(o[2], "i")} + ${this.src(o[3], "i")}`, "i"); return;
      case OPC.UMAD: this.store(o[0], `${this.src(o[1], "u")} * ${this.src(o[2], "u")} + ${this.src(o[3], "u")}`, "u"); return;
      case OPC.IMAX: this.i2(ins, "i", (a, b) => `max(${a}, ${b})`); return;
      case OPC.IMIN: this.i2(ins, "i", (a, b) => `min(${a}, ${b})`); return;
      case OPC.UMAX: this.i2(ins, "u", (a, b) => `max(${a}, ${b})`); return;
      case OPC.UMIN: this.i2(ins, "u", (a, b) => `min(${a}, ${b})`); return;
      case OPC.ISHL: this.store(o[0], `${this.src(o[1], "i")} << (${this.src(o[2], "u")} & vec4<u32>(31u))`, "i"); return;
      case OPC.ISHR: this.store(o[0], `${this.src(o[1], "i")} >> (${this.src(o[2], "u")} & vec4<u32>(31u))`, "i"); return;
      case OPC.USHR: this.store(o[0], `${this.src(o[1], "u")} >> (${this.src(o[2], "u")} & vec4<u32>(31u))`, "u"); return;
      case OPC.UDIV: {
        const a = this.tmp(), b = this.tmp();
        this.w(`let ${a} = ${this.src(o[2], "u")}; let ${b} = ${this.src(o[3], "u")};`);
        if (o[0].type !== OT.NULL) this.store(o[0], `select(vec4<u32>(0xffffffffu), ${a} / max(${b}, vec4<u32>(1u)), ${b} != vec4<u32>(0u))`, "u");
        if (o[1].type !== OT.NULL) this.store(o[1], `select(vec4<u32>(0xffffffffu), ${a} % max(${b}, vec4<u32>(1u)), ${b} != vec4<u32>(0u))`, "u");
        return;
      }
      case OPC.FTOI: this.store(o[0], `vec4<i32>(${this.src(o[1], "f")})`, "i"); return;
      case OPC.FTOU: this.store(o[0], `vec4<u32>(max(${this.src(o[1], "f")}, vec4<f32>(0.0)))`, "u"); return;
      case OPC.ITOF: this.store(o[0], `vec4<f32>(${this.src(o[1], "i")})`, "f"); return;
      case OPC.UTOF: this.store(o[0], `vec4<f32>(${this.src(o[1], "u")})`, "f"); return;
      case OPC.F32TOF16: {
        const a = this.tmp();
        this.w(`let ${a} = ${this.src(o[1], "f")};`);
        this.store(o[0], `vec4<u32>(pack2x16float(vec2<f32>(${a}.x, 0.0)) & 0xffffu, pack2x16float(vec2<f32>(${a}.y, 0.0)) & 0xffffu, pack2x16float(vec2<f32>(${a}.z, 0.0)) & 0xffffu, pack2x16float(vec2<f32>(${a}.w, 0.0)) & 0xffffu)`, "u");
        return;
      }
      case OPC.F16TOF32: {
        const a = this.tmp();
        this.w(`let ${a} = ${this.src(o[1], "u")};`);
        this.store(o[0], `vec4<f32>(unpack2x16float(${a}.x).x, unpack2x16float(${a}.y).x, unpack2x16float(${a}.z).x, unpack2x16float(${a}.w).x)`, "f");
        return;
      }
      case OPC.COUNTBITS: this.store(o[0], `countOneBits(${this.src(o[1], "u")})`, "u"); return;
      case OPC.FIRSTBIT_HI: { const a = this.tmp(); this.w(`let ${a} = ${this.src(o[1], "u")};`); this.store(o[0], `select(vec4<u32>(31u) - countLeadingZeros(${a}), vec4<u32>(0xffffffffu), ${a} == vec4<u32>(0u))`, "u"); return; }
      case OPC.FIRSTBIT_LO: { const a = this.tmp(); this.w(`let ${a} = ${this.src(o[1], "u")};`); this.store(o[0], `select(countTrailingZeros(${a}), vec4<u32>(0xffffffffu), ${a} == vec4<u32>(0u))`, "u"); return; }
      case OPC.FIRSTBIT_SHI: { const a = this.tmp(); this.w(`let ${a} = ${this.src(o[1], "i")};`); this.store(o[0], `select(vec4<u32>(31u) - countLeadingZeros(bitcast<vec4<u32>>(select(${a}, ~${a}, ${a} < vec4<i32>(0)))), vec4<u32>(0xffffffffu), (${a} == vec4<i32>(0)) | (${a} == vec4<i32>(-1)))`, "u"); return; }
      case OPC.BFREV: this.store(o[0], `reverseBits(${this.src(o[1], "u")})`, "u"); return;
      case OPC.UBFE: {
        const w_ = this.tmp(), off = this.tmp(), v = this.tmp();
        this.w(`let ${w_} = ${this.src(o[1], "u")} & vec4<u32>(31u); let ${off} = ${this.src(o[2], "u")} & vec4<u32>(31u); let ${v} = ${this.src(o[3], "u")};`);
        this.store(o[0], `select(extractBits(${v}, ${off}, ${w_}), vec4<u32>(0u), ${w_} == vec4<u32>(0u))`, "u");
        return;
      }
      case OPC.IBFE: {
        const w_ = this.tmp(), off = this.tmp(), v = this.tmp();
        this.w(`let ${w_} = ${this.src(o[1], "u")} & vec4<u32>(31u); let ${off} = ${this.src(o[2], "u")} & vec4<u32>(31u); let ${v} = ${this.src(o[3], "i")};`);
        this.store(o[0], `select(extractBits(${v}, ${off}, ${w_}), vec4<i32>(0), ${w_} == vec4<u32>(0u))`, "i");
        return;
      }
      case OPC.BFI: {
        const w_ = this.tmp(), off = this.tmp(), a = this.tmp(), b = this.tmp();
        this.w(`let ${w_} = ${this.src(o[1], "u")} & vec4<u32>(31u); let ${off} = ${this.src(o[2], "u")} & vec4<u32>(31u); let ${a} = ${this.src(o[3], "u")}; let ${b} = ${this.src(o[4], "u")};`);
        this.store(o[0], `select(insertBits(${b}, ${a}, ${off}, ${w_}), ${b}, ${w_} == vec4<u32>(0u))`, "u");
        return;
      }
      case OPC.UADDC: case OPC.USUBB: this.unsupported(ins); return;
      case OPC.SWAPC: this.unsupported(ins); return;

      // ---- texture ops ----
      case OPC.SAMPLE: case OPC.SAMPLE_B: case OPC.SAMPLE_L: case OPC.SAMPLE_D: case OPC.SAMPLE_C: case OPC.SAMPLE_C_LZ: {
        const res = o[2], smp = o[3];
        const slot = res.idx[0].imm, ss = smp.idx[0].imm;
        const info = this.texTypeName(slot);
        const addr = this.tmp();
        this.w(`let ${addr} = ${this.src(o[1], "f")};`);
        const { c, layer } = this.coords(addr, info.dim);
        const off = this.offsetArg(ins, info.dim);
        const L = layer ? `, i32(round(${layer}))` : "";
        const t = `t${slot}`, s = `s${ss}`;
        let call: string;
        switch (ins.op) {
          case OPC.SAMPLE: call = this.stage === "ps" ? `textureSample(${t}, ${s}, ${c}${L}${off})` : `textureSampleLevel(${t}, ${s}, ${c}${L}, 0.0${off})`; break;
          case OPC.SAMPLE_B: call = `textureSampleBias(${t}, ${s}, ${c}${L}, ${this.scalar(o[4], "f")}${off})`; break;
          case OPC.SAMPLE_L: call = `textureSampleLevel(${t}, ${s}, ${c}${L}, ${this.scalar(o[4], "f")}${off})`; break;
          case OPC.SAMPLE_D: {
            const dx = this.src(o[4], "f"), dy = this.src(o[5], "f");
            const n = info.dim === 5 || info.dim === 6 || info.dim === 10 ? 3 : info.dim === 2 || info.dim === 7 ? 1 : 2;
            const sw = n === 1 ? ".x" : n === 2 ? ".xy" : ".xyz";
            call = `textureSampleGrad(${t}, ${s}, ${c}${L}, ${dx}${sw}, ${dy}${sw}${off})`;
            break;
          }
          case OPC.SAMPLE_C: call = `vec4<f32>(textureSampleCompare(${t}, ${s}, ${c}${L}, ${this.scalar(o[4], "f")}${off}))`; break;
          default: call = `vec4<f32>(textureSampleCompareLevel(${t}, ${s}, ${c}${L}, ${this.scalar(o[4], "f")}${off}))`;
        }
        if (info.sample === "u32") call = `vec4<f32>(${call})`; // sampling of integer textures is not permitted by D3D; keep valid WGSL
        this.store(o[0], this.resultSwz(res, call.startsWith("vec4<f32>(") || info.sample === "depth" && ins.op >= OPC.SAMPLE_C ? call : call), "f");
        return;
      }
      case OPC.LD: case OPC.LD_MS: {
        const res = o[2];
        const slot = res.idx[0].imm;
        const r = this.sh.srvs.get(slot);
        const info = this.texTypeName(slot);
        const addr = this.tmp();
        this.w(`let ${addr} = ${this.src(o[1], "i")};`);
        const dim = r ? r.dim : 3;
        if (dim === 1 || (r && (r.raw || r.structured))) {
          // typed buffer: element index in x
          this.store(o[0], this.resultSwz(res, this.bufferLoad(slot, `u32(${addr}.x)`)), "f");
          return;
        }
        let call: string;
        const t = `t${slot}`;
        const sw = ins.op === OPC.LD_MS ? `, ${this.scalar(o[3], "i")}` : "";
        switch (dim) {
          case 2: case 7: call = `textureLoad(${t}, ${addr}.x, ${addr}.y)`; break;
          case 3: call = `textureLoad(${t}, ${addr}.xy, ${addr}.z)`; break;
          case 4: call = `textureLoad(${t}, ${addr}.xy${sw})`; break;
          case 5: call = `textureLoad(${t}, ${addr}.xyz, ${addr}.w)`; break;
          case 8: call = `textureLoad(${t}, ${addr}.xy, ${addr}.z, ${addr}.w)`; break;
          case 6: call = `textureLoad(${t}, ${addr}.xy, ${addr}.z, ${addr}.w)`; break;
          default: call = `textureLoad(${t}, ${addr}.xy, ${addr}.z)`;
        }
        if (info.sample === "u32") call = `bitcast<vec4<f32>>(${call})`;
        else if (info.sample === "i32") call = `bitcast<vec4<f32>>(${call})`;
        else if (info.sample === "depth") call = `vec4<f32>(${call})`;
        this.store(o[0], this.resultSwz(res, call), "f");
        return;
      }
      case OPC.GATHER4: case OPC.GATHER4_C: case OPC.GATHER4_PO: case OPC.GATHER4_PO_C: {
        const po = ins.op === OPC.GATHER4_PO || ins.op === OPC.GATHER4_PO_C;
        const cmpOp = ins.op === OPC.GATHER4_C || ins.op === OPC.GATHER4_PO_C;
        const resIdx = po ? 3 : 2, smpIdx = po ? 4 : 3;
        const res = o[resIdx], smp = o[smpIdx];
        const slot = res.idx[0].imm, ss = smp.idx[0].imm;
        const info = this.texTypeName(slot);
        const addr = this.tmp();
        this.w(`let ${addr} = ${this.src(o[1], "f")};`);
        const { c, layer } = this.coords(addr, info.dim);
        const L = layer ? `, i32(round(${layer}))` : "";
        const comp = smp.numComps === 4 && (smp.selMode === 1 || smp.selMode === 2) ? smp.swz[0] : 0;
        const off = ins.offset ? this.offsetArg(ins, info.dim) : "";
        let call: string;
        if (cmpOp) call = `textureGatherCompare(t${slot}, s${ss}, ${c}${L}, ${this.scalar(o[smpIdx + 1], "f")}${off})`;
        else if (info.sample === "depth") call = `textureGather(t${slot}, s${ss}, ${c}${L}${off})`;
        else call = `textureGather(${comp}, t${slot}, s${ss}, ${c}${L}${off})`;
        if (info.sample === "u32" || info.sample === "i32") call = `bitcast<vec4<f32>>(${call})`;
        this.store(o[0], this.resultSwz(res, call), "f");
        return;
      }
      case OPC.RESINFO: {
        const res = o[2];
        const slot = res.idx[0].imm;
        const r = this.sh.srvs.get(slot);
        const dim = r ? r.dim : 3;
        const mip = this.scalar(o[1], "u");
        const t = `t${slot}`;
        let dims: string, levels = `textureNumLevels(${t})`;
        switch (dim) {
          case 2: case 7: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), 0u, 0u, 0u)`; break;
          case 3: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), 0u, 0u)`; break;
          case 4: dims = `vec4<u32>(textureDimensions(${t}), 0u, 0u)`; levels = "1u"; break;
          case 5: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), 0u)`; break;
          case 6: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), 0u, 0u)`; break;
          case 8: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), textureNumLayers(${t}), 0u)`; break;
          case 1: case 11: case 12: dims = `vec4<u32>(arrayLength(&${t}), 0u, 0u, 0u)`; levels = "0u"; break;
          default: dims = `vec4<u32>(textureDimensions(${t}, i32(${mip})), 0u, 0u)`;
        }
        const rt = ins.ctrl & 3;
        const d = this.tmp();
        this.w(`var ${d} = ${dims}; ${d}.w = ${levels};`);
        if (rt === 0) this.store(o[0], this.resultSwz(res, `vec4<f32>(${d})`), "f");
        else if (rt === 1) this.store(o[0], this.resultSwz(res, `vec4<f32>(1.0) / vec4<f32>(${d})`), "f");
        else this.store(o[0], this.resultSwz(res, d), "u");
        return;
      }
      case OPC.BUFINFO: {
        const res = o[1];
        const slot = res.idx[0].imm;
        const r = this.sh.srvs.get(slot) ?? this.sh.uavs.get(slot);
        const stride = r && (r as any).structured ? (r as any).stride || 4 : 4;
        this.store(o[0], `vec4<u32>(arrayLength(&t${slot}) * 4u / ${stride}u, 0u, 0u, 0u)`, "u");
        return;
      }
      case OPC.SAMPLEINFO: this.store(o[0], "vec4<f32>(1.0, 0.0, 0.0, 0.0)", "f"); return;
      case OPC.SAMPLEPOS: this.store(o[0], "vec4<f32>(0.0)", "f"); return;
      case OPC.LOD: this.store(o[0], "vec4<f32>(0.0)", "f"); return;

      // ---- raw / structured / typed UAV and SRV access ----
      case OPC.LD_RAW: this.loadRaw(ins, o[0], o[2], this.scalar(o[1], "u"), null); return;
      case OPC.LD_STRUCTURED: this.loadRaw(ins, o[0], o[3], this.scalar(o[1], "u"), this.scalar(o[2], "u")); return;
      case OPC.STORE_RAW: this.storeRaw(ins, o[0], this.scalar(o[1], "u"), null, o[2]); return;
      case OPC.STORE_STRUCTURED: this.storeRaw(ins, o[0], this.scalar(o[1], "u"), this.scalar(o[2], "u"), o[3]); return;
      case OPC.LD_UAV_TYPED: {
        const u = o[2].idx[0].imm;
        const info = this.sh.uavs.get(u);
        const addr = this.tmp();
        this.w(`let ${addr} = ${this.src(o[1], "i")};`);
        let call: string;
        const d = info?.dim ?? 3;
        if (info && (info.raw || info.structured || d === 1)) call = this.uavBufferLoad(u, `u32(${addr}.x)`);
        else call = d === 5 ? `textureLoad(u${u}, ${addr}.xyz)` : d === 8 ? `textureLoad(u${u}, ${addr}.xy, ${addr}.z)` : d === 2 || d === 7 ? `textureLoad(u${u}, ${addr}.x)` : `textureLoad(u${u}, ${addr}.xy)`;
        const k = info && info.ret[0] === 4 ? "u" : info && info.ret[0] === 3 ? "i" : "f";
        this.store(o[0], this.resultSwz(o[2], k === "f" ? call : `bitcast<vec4<f32>>(${call})`), "f");
        return;
      }
      case OPC.STORE_UAV_TYPED: {
        const u = o[0].idx[0].imm;
        const info = this.sh.uavs.get(u);
        const addr = this.tmp();
        this.w(`let ${addr} = ${this.src(o[1], "i")};`);
        const d = info?.dim ?? 3;
        const k: Kind = info && info.ret[0] === 4 ? "u" : info && info.ret[0] === 3 ? "i" : "f";
        const val = this.src(o[2], k);
        if (info && (info.raw || info.structured || d === 1)) { this.uavBufferStore(u, `u32(${addr}.x)`, val, k); return; }
        const call = d === 5 ? `textureStore(u${u}, ${addr}.xyz, ${val})` : d === 8 ? `textureStore(u${u}, ${addr}.xy, ${addr}.z, ${val})` : d === 2 || d === 7 ? `textureStore(u${u}, ${addr}.x, ${val})` : `textureStore(u${u}, ${addr}.xy, ${val})`;
        this.w(call + ";");
        return;
      }
      case OPC.ATOMIC_AND: case OPC.ATOMIC_OR: case OPC.ATOMIC_XOR: case OPC.ATOMIC_IADD: case OPC.ATOMIC_IMAX: case OPC.ATOMIC_IMIN: case OPC.ATOMIC_UMAX: case OPC.ATOMIC_UMIN: case OPC.ATOMIC_CMP_STORE:
        this.atomic(ins, false); return;
      case OPC.IMM_ATOMIC_IADD: case OPC.IMM_ATOMIC_AND: case OPC.IMM_ATOMIC_OR: case OPC.IMM_ATOMIC_XOR: case OPC.IMM_ATOMIC_EXCH: case OPC.IMM_ATOMIC_CMP_EXCH: case OPC.IMM_ATOMIC_IMAX: case OPC.IMM_ATOMIC_IMIN:
      case OPC.IMM_ATOMIC_UMAX: case OPC.IMM_ATOMIC_UMIN:
        this.atomic(ins, true); return;
      case OPC.IMM_ATOMIC_ALLOC: case OPC.IMM_ATOMIC_CONSUME: this.unsupported(ins); return;
      case OPC.SYNC: {
        const f = ins.ctrl;
        // bit0: threads in group sync, bit1: group shared memory fence, bit2: UAV fence (group), bit3: UAV global
        if (f & 1) this.w("workgroupBarrier();");
        else if (f & 2) this.w("workgroupBarrier();");
        if ((f & 4) || (f & 8)) this.w("storageBarrier();");
        return;
      }

      // ---- control flow ----
      case OPC.IF: this.w(`if (${this.cond(ins, o[0])}) {`); this.ind++; return;
      case OPC.ELSE: this.ind--; this.w("} else {"); this.ind++; return;
      case OPC.ENDIF: this.ind--; this.w("}"); return;
      case OPC.LOOP: this.w("loop {"); this.ind++; return;
      case OPC.ENDLOOP: this.ind--; this.w("}"); return;
      case OPC.BREAK: this.w("break;"); return;
      case OPC.BREAKC: this.w(`if (${this.cond(ins, o[0])}) { break; }`); return;
      case OPC.CONTINUE: this.w("continue;"); return;
      case OPC.CONTINUEC: this.w(`if (${this.cond(ins, o[0])}) { continue; }`); return;
      case OPC.RET: this.w(this.curLabel >= 0 ? "return;" : "return;"); return;
      case OPC.RETC: this.w(`if (${this.cond(ins, o[0])}) { return; }`); return;
      case OPC.DISCARD: this.w(`if (${this.cond(ins, o[0])}) { discard; }`); return;
      case OPC.CALL: this.labels.add(o[0].idx[0].imm); this.w(`sub_${o[0].idx[0].imm}();`); return;
      case OPC.CALLC: this.labels.add(o[1].idx[0].imm); this.w(`if (${this.cond(ins, o[0])}) { sub_${o[1].idx[0].imm}(); }`); return;
      case OPC.SWITCH: {
        this.w(`switch (${this.scalar(o[0], "i")}) {`);
        this.ind++;
        this.switchStack.push({ pendingCases: [], open: false, hasDefault: false });
        return;
      }
      case OPC.CASE: {
        const sw = this.switchStack[this.switchStack.length - 1];
        if (sw.open) { this.ind--; this.rawClose(); sw.open = false; }
        sw.pendingCases.push(String((o[0].imm![0] | 0)));
        return;
      }
      case OPC.DEFAULT: {
        const sw = this.switchStack[this.switchStack.length - 1];
        if (sw.open) { this.ind--; this.rawClose(); sw.open = false; }
        sw.pendingCases.push("default");
        sw.hasDefault = true;
        return;
      }
      case OPC.ENDSWITCH: {
        const sw = this.switchStack.pop()!;
        if (sw.open) { this.ind--; this.rawClose(); }
        this.closing = true;
        if (sw.pendingCases.length) { this.w(`${this.caseLabel(sw.hasDefault ? sw.pendingCases : [...sw.pendingCases, "default"])} {}`); }
        else if (!sw.hasDefault) this.w("default: {}");
        this.closing = false;
        this.ind--; this.w("}");
        return;
      }
      case OPC.LABEL: return; // handled by the splitter
      case OPC.DCL_RESOURCE: case OPC.DCL_RESOURCE_RAW: case OPC.DCL_RESOURCE_STRUCTURED: case OPC.DCL_CONSTANT_BUFFER: case OPC.DCL_SAMPLER: case OPC.DCL_INPUT: case OPC.DCL_OUTPUT:
      case OPC.DCL_INPUT_PS: case OPC.DCL_INPUT_SGV: case OPC.DCL_INPUT_SIV: case OPC.DCL_INPUT_PS_SGV: case OPC.DCL_INPUT_PS_SIV: case OPC.DCL_OUTPUT_SGV: case OPC.DCL_OUTPUT_SIV: case OPC.DCL_TEMPS:
      case OPC.DCL_INDEXABLE_TEMP: case OPC.DCL_GLOBAL_FLAGS: case OPC.DCL_THREAD_GROUP: case OPC.DCL_UAV_TYPED: case OPC.DCL_UAV_RAW: case OPC.DCL_UAV_STRUCTURED: case OPC.DCL_TGSM_RAW:
      case OPC.DCL_TGSM_STRUCTURED: case OPC.DCL_INDEX_RANGE: case OPC.DCL_STREAM: case OPC.DCL_GS_INSTANCE_COUNT:
        return;
      default:
        this.unsupported(ins);
    }
  }
  needMulhi = false;
  private unsupported(ins: Sm5Ins) {
    this.sh.unsupported.push(OPNAME[ins.op] ?? String(ins.op));
    this.w(`// unsupported instruction ${OPNAME[ins.op] ?? ins.op}`);
  }
  private rawClose() { this.out.push("  ".repeat(this.ind) + "}"); }
  private caseLabel(cases: string[]): string {
    const vals = cases.filter((c) => c !== "default");
    const def = cases.includes("default");
    return `case ${[...vals, ...(def ? ["default"] : [])].join(", ")}:`;
  }

  // typed / raw buffer access ---------------------------------------------------------------------------------------------
  private bufferLoad(slot: number, idx: string): string {
    const r = this.sh.srvs.get(slot);
    const fmt = this.link.bufferFormats?.get(slot) ?? "f4";
    if (r?.structured) return `vec4<f32>(bitcast<f32>(t${slot}[${idx} * ${Math.max(1, r.stride / 4)}u]), 0.0, 0.0, 0.0)`;
    switch (fmt) {
      case "f1": return `vec4<f32>(bitcast<f32>(t${slot}[${idx}]), 0.0, 0.0, 1.0)`;
      case "f2": return `vec4<f32>(bitcast<f32>(t${slot}[${idx} * 2u]), bitcast<f32>(t${slot}[${idx} * 2u + 1u]), 0.0, 1.0)`;
      case "f3": return `vec4<f32>(bitcast<f32>(t${slot}[${idx} * 3u]), bitcast<f32>(t${slot}[${idx} * 3u + 1u]), bitcast<f32>(t${slot}[${idx} * 3u + 2u]), 1.0)`;
      case "u1": return `bitcast<vec4<f32>>(vec4<u32>(t${slot}[${idx}], 0u, 0u, 1u))`;
      case "u4": return `bitcast<vec4<f32>>(vec4<u32>(t${slot}[${idx} * 4u], t${slot}[${idx} * 4u + 1u], t${slot}[${idx} * 4u + 2u], t${slot}[${idx} * 4u + 3u]))`;
      case "rgba8": return `unpack4x8unorm(t${slot}[${idx}])`;
      default: return `vec4<f32>(bitcast<f32>(t${slot}[${idx} * 4u]), bitcast<f32>(t${slot}[${idx} * 4u + 1u]), bitcast<f32>(t${slot}[${idx} * 4u + 2u]), bitcast<f32>(t${slot}[${idx} * 4u + 3u]))`;
    }
  }
  private uavBufferLoad(u: number, idx: string): string {
    const atomic = this.sh.atomicUavs.has(u);
    const rd = (i: string) => (atomic ? `atomicLoad(&u${u}[${i}])` : `u${u}[${i}]`);
    return `bitcast<vec4<f32>>(vec4<u32>(${rd(idx)}, 0u, 0u, 0u))`;
  }
  private uavBufferStore(u: number, idx: string, val: string, k: Kind) {
    const atomic = this.sh.atomicUavs.has(u);
    const v = k === "f" ? `bitcast<vec4<u32>>(${val})` : k === "i" ? `bitcast<vec4<u32>>(${val})` : val;
    const t = this.tmp();
    this.w(`let ${t} = ${v};`);
    if (atomic) this.w(`atomicStore(&u${u}[${idx}], ${t}.x);`); else this.w(`u${u}[${idx}] = ${t}.x;`);
  }
  /** word address for raw (byte offset) or structured (index, byte offset) access */
  private wordAddr(res: Sm5Operand, byteOrIdx: string, off: string | null): { arr: string; word: string; atomic: boolean; isUav: boolean; tg: boolean } {
    const slot = res.idx[0].imm;
    if (res.type === OT.THREAD_GROUP_SHARED_MEMORY) {
      const g = this.sh.tgsm.get(slot);
      const stride = g && !g.raw ? g.stride : 4;
      const word = off !== null ? `(${byteOrIdx} * ${stride}u + ${off}) / 4u` : `${byteOrIdx} / 4u`;
      return { arr: `g${slot}`, word, atomic: this.sh.atomicTgsm.has(slot), isUav: false, tg: true };
    }
    if (res.type === OT.UAV) {
      const u = this.sh.uavs.get(slot);
      const stride = u && u.structured ? u.stride : 4;
      const word = off !== null ? `(${byteOrIdx} * ${stride}u + ${off}) / 4u` : `${byteOrIdx} / 4u`;
      return { arr: `u${slot}`, word, atomic: this.sh.atomicUavs.has(slot), isUav: true, tg: false };
    }
    const r = this.sh.srvs.get(slot);
    const stride = r && r.structured ? r.stride : 4;
    const word = off !== null ? `(${byteOrIdx} * ${stride}u + ${off}) / 4u` : `${byteOrIdx} / 4u`;
    return { arr: `t${slot}`, word, atomic: false, isUav: false, tg: false };
  }
  private loadRaw(_ins: Sm5Ins, dst: Sm5Operand, res: Sm5Operand, a: string, b: string | null) {
    const { arr, word, atomic } = this.wordAddr(res, a, b);
    const w0 = this.tmp();
    this.w(`let ${w0} = ${word};`);
    const rd = (i: string) => (atomic ? `atomicLoad(&${arr}[${w0} + ${i}u])` : `${arr}[${w0} + ${i}u]`);
    // the resource operand's swizzle selects which words are returned
    const sel = res.numComps === 4 && (res.selMode === 1 || res.selMode === 2) ? res.swz : [0, 1, 2, 3];
    const v = `bitcast<vec4<f32>>(vec4<u32>(${rd("0")}, ${rd("1")}, ${rd("2")}, ${rd("3")}))`;
    // only the words actually needed are valid; out-of-range reads are clamped by WebGPU
    this.store(dst, `(${v}).${COMP[sel[0]]}${COMP[sel[1]]}${COMP[sel[2]]}${COMP[sel[3]]}`, "f");
  }
  private storeRaw(_ins: Sm5Ins, res: Sm5Operand, a: string, b: string | null, val: Sm5Operand) {
    const { arr, word, atomic } = this.wordAddr(res, a, b);
    const w0 = this.tmp(), v = this.tmp();
    this.w(`let ${w0} = ${word}; let ${v} = ${this.src(val, "u")};`);
    const mask = res.mask & 0xf;
    let k = 0;
    for (let c = 0; c < 4; c++) {
      if (!(mask & (1 << c))) continue;
      if (atomic) this.w(`atomicStore(&${arr}[${w0} + ${k}u], ${v}.${COMP[c]});`); else this.w(`${arr}[${w0} + ${k}u] = ${v}.${COMP[c]};`);
      k++;
    }
  }
  private atomic(ins: Sm5Ins, imm: boolean) {
    const o = ins.ops;
    const dst = imm ? o[0] : null;
    const res = imm ? o[1] : o[0];
    const addrOp = imm ? o[2] : o[1];
    const vals = o.slice(imm ? 3 : 2);
    const op = ins.op;
    const slot = res.idx[0].imm;
    // address operand: raw/structured use byte offset in x; typed uses coordinates (buffers only supported)
    let w0: string, arr: string;
    const t = this.tmp();
    if (res.type === OT.THREAD_GROUP_SHARED_MEMORY) {
      const g = this.sh.tgsm.get(slot);
      const stride = g && !g.raw ? g.stride : 4;
      const a4 = this.src(addrOp, "u");
      w0 = addrOp.numComps && addrOp.mask !== undefined && (g && !g.raw) ? `(${a4}.x * ${stride}u + ${a4}.y) / 4u` : `${a4}.x / 4u`;
      arr = `g${slot}`;
    } else {
      const u = this.sh.uavs.get(slot);
      const a4 = this.src(addrOp, "u");
      if (u && u.raw) w0 = `${a4}.x / 4u`;
      else if (u && u.structured) w0 = `(${a4}.x * ${u.stride}u + ${a4}.y) / 4u`;
      else w0 = `${a4}.x`;
      arr = `u${slot}`;
    }
    this.w(`let ${t} = ${w0};`);
    const v0 = vals[0] ? this.scalar(vals[0], "u") : "0u";
    const vs0 = vals[0] ? this.scalar(vals[0], "i") : "0";
    let call: string;
    const p = `&${arr}[${t}]`;
    switch (op) {
      case OPC.ATOMIC_IADD: case OPC.IMM_ATOMIC_IADD: call = `atomicAdd(${p}, ${v0})`; break;
      case OPC.ATOMIC_AND: case OPC.IMM_ATOMIC_AND: call = `atomicAnd(${p}, ${v0})`; break;
      case OPC.ATOMIC_OR: case OPC.IMM_ATOMIC_OR: call = `atomicOr(${p}, ${v0})`; break;
      case OPC.ATOMIC_XOR: case OPC.IMM_ATOMIC_XOR: call = `atomicXor(${p}, ${v0})`; break;
      case OPC.ATOMIC_UMAX: case OPC.IMM_ATOMIC_UMAX: call = `atomicMax(${p}, ${v0})`; break;
      case OPC.ATOMIC_UMIN: case OPC.IMM_ATOMIC_UMIN: call = `atomicMin(${p}, ${v0})`; break;
      case OPC.ATOMIC_IMAX: case OPC.IMM_ATOMIC_IMAX: call = `atomicMax_i(${p}, ${vs0})`; this.needAtomicSigned = true; break;
      case OPC.ATOMIC_IMIN: case OPC.IMM_ATOMIC_IMIN: call = `atomicMin_i(${p}, ${vs0})`; this.needAtomicSigned = true; break;
      case OPC.IMM_ATOMIC_EXCH: call = `atomicExchange(${p}, ${v0})`; break;
      case OPC.ATOMIC_CMP_STORE: case OPC.IMM_ATOMIC_CMP_EXCH: {
        const cmp = this.scalar(vals[0], "u"), val = this.scalar(vals[1], "u");
        call = `atomicCompareExchangeWeak(${p}, ${cmp}, ${val}).old_value`;
        break;
      }
      default: call = "0u";
    }
    if (imm && dst) { const r = this.tmp(); this.w(`let ${r} = ${call};`); this.store(dst, `vec4<u32>(${r})`, "u"); }
    else this.w(`${call};`);
  }
  needAtomicSigned = false;

  // ---- module assembly -------------------------------------------------------------------------------------------------
  emit(): { wgsl: string; vsOutputs: string[]; psInputs: string[] } {
    const sh = this.sh, link = this.link;
    const stage = this.stage;
    const group = stage === "vs" ? 0 : stage === "ps" ? 1 : 2;
    const head: string[] = ["diagnostic(off, derivative_uniformity);"];
    const decls: string[] = [];
    // constant buffers
    for (const [slot, cb] of [...sh.cbs].sort((a, b) => a[0] - b[0])) {
      const n = Math.max(1, Math.min(cb.size || 4096, 4096));
      decls.push(`struct CB${slot} { d: array<vec4<f32>, ${n}> };`);
      decls.push(`@group(${group}) @binding(${slot}) var<uniform> cb${slot}: CB${slot};`);
    }
    // samplers
    for (const [slot, s] of [...sh.samplers].sort((a, b) => a[0] - b[0])) decls.push(`@group(${group}) @binding(${144 + slot}) var s${slot}: ${s.comparison ? "sampler_comparison" : "sampler"};`);
    // srvs
    for (const slot of [...sh.srvs.keys()].sort((a, b) => a - b)) decls.push(this.texDecl(slot, group));
    // uavs
    for (const [slot, u] of [...sh.uavs].sort((a, b) => a[0] - b[0])) {
      const b = 160 + slot;
      if (u.raw || u.structured || u.dim === 1) decls.push(`@group(${group}) @binding(${b}) var<storage, read_write> u${slot}: ${sh.atomicUavs.has(slot) ? "array<atomic<u32>>" : "array<u32>"};`);
      else {
        const fmt = link.uavFormats?.get(slot) ?? "rgba8unorm";
        const ty = u.dim === 5 ? "texture_storage_3d" : u.dim === 8 ? "texture_storage_2d_array" : u.dim === 2 || u.dim === 7 ? "texture_storage_1d" : "texture_storage_2d";
        decls.push(`@group(${group}) @binding(${b}) var u${slot}: ${ty}<${fmt}, ${sh.uavReads.has(slot) ? "read_write" : "write"}>;`);
      }
    }
    // thread group shared memory
    for (const [slot, g] of sh.tgsm) decls.push(`var<workgroup> g${slot}: array<${sh.atomicTgsm.has(slot) ? "atomic<u32>" : "u32"}, ${Math.max(1, g.count * (g.raw ? 1 : g.stride / 4))}>;`);
    // registers
    const priv: string[] = [];
    for (let i = 0; i < sh.temps; i++) priv.push(`var<private> r${i}: vec4<f32>;`);
    for (const [slot, x] of sh.indexableTemps) priv.push(`var<private> x${slot}: array<vec4<f32>, ${Math.max(1, x.size)}>;`);
    if (sh.icb) {
      const n = (sh.icb.length - 1) / 4;
      const vals: string[] = [];
      for (let i = 0; i < n; i++) vals.push(`vec4<f32>(${[0, 1, 2, 3].map((c) => f32lit(sh.icb![1 + i * 4 + c])).join(", ")})`);
      priv.push(`var<private> icb: array<vec4<f32>, ${Math.max(1, n)}> = array<vec4<f32>, ${Math.max(1, n)}>(${vals.join(", ")});`);
    }
    priv.push("var<private> zbits: u32;");
    priv.push("var<private> oDepth: f32;");
    priv.push("var<private> oMaskBits: u32;");

    // entry interface
    const entryIn: string[] = [], entryOut: string[] = [], prologue: string[] = [], epilogue: string[] = [];
    const usedIn = new Set<number>();
    if (stage === "vs") {
      for (const [reg, d] of sh.declIn) {
        usedIn.add(reg);
        priv.push(`var<private> v${reg}: vec4<f32>;`);
        if (d.kind === "sgv" || d.kind === "siv") {
          if (d.sv === SV.VERTEX_ID) { entryIn.push(`@builtin(vertex_index) vertex_id: u32`); prologue.push(`v${reg} = bitcast<vec4<f32>>(vec4<u32>(in.vertex_id, 0u, 0u, 0u));`); }
          else if (d.sv === SV.INSTANCE_ID) { entryIn.push(`@builtin(instance_index) instance_id: u32`); prologue.push(`v${reg} = bitcast<vec4<f32>>(vec4<u32>(in.instance_id, 0u, 0u, 0u));`); }
          continue;
        }
        const kind = link.inputKinds?.get(reg) ?? "f";
        if (kind === "z") { prologue.push(`v${reg} = vec4<f32>(0.0, 0.0, 0.0, 1.0);`); continue; }
        const ty = kind === "u" ? "vec4<u32>" : kind === "i" ? "vec4<i32>" : "vec4<f32>";
        entryIn.push(`@location(${reg}) i${reg}: ${ty}`);
        prologue.push(`v${reg} = ${kind === "f" ? `in.i${reg}` : `bitcast<vec4<f32>>(in.i${reg})`};`);
      }
      // outputs
      let posReg = -1;
      for (const [reg, d] of sh.declOut) {
        priv.push(`var<private> o${reg}: vec4<f32>;`);
        if (d.kind === "siv" && d.sv === SV.POSITION) { posReg = reg; continue; }
        if (d.kind === "siv" || d.kind === "sgv") continue; // clip/cull distances, array indices: not carried
        const el = sh.outputs.find((e) => e.reg === reg);
        if (!el) continue;
        const key = (el.name + "#" + el.index).toUpperCase();
        const sl = link.slots.get(key);
        if (!sl) continue;
        const ty = sl.kind === "u" ? "vec4<u32>" : sl.kind === "i" ? "vec4<i32>" : "vec4<f32>";
        const interp = sl.kind === "f" ? sl.interp : "@interpolate(flat)";
        entryOut.push(`@location(${sl.slot}) ${interp} l${sl.slot}: ${ty}`);
        epilogue.push(`out.l${sl.slot} = ${sl.kind === "f" ? `o${reg}` : `bitcast<${ty}>(o${reg})`};`);
        this.vsOutputs.push(key);
      }
      for (const ex of link.extraSlots ?? []) {
        const ty = ex.kind === "u" ? "vec4<u32>" : ex.kind === "i" ? "vec4<i32>" : "vec4<f32>";
        entryOut.push(`@location(${ex.slot}) ${ex.kind === "f" ? ex.interp : "@interpolate(flat)"} l${ex.slot}: ${ty}`);
        epilogue.push(`out.l${ex.slot} = ${ty}(${ex.kind === "f" ? "0.0" : "0"});`);
      }
      epilogue.push(posReg >= 0 ? `out.pos = o${posReg};` : "out.pos = vec4<f32>(0.0, 0.0, 0.0, 1.0);");
    } else if (stage === "ps") {
      for (const [reg, d] of sh.declIn) {
        priv.push(`var<private> v${reg}: vec4<f32>;`);
        if (d.kind === "siv" || d.kind === "sgv") {
          if (d.sv === SV.POSITION) { entryIn.push("@builtin(position) frag_pos: vec4<f32>"); prologue.push(`v${reg} = in.frag_pos;`); }
          else if (d.sv === SV.IS_FRONT_FACE) { entryIn.push("@builtin(front_facing) front: bool"); prologue.push(`v${reg} = bitcast<vec4<f32>>(vec4<u32>(select(0u, 0xffffffffu, in.front), 0u, 0u, 0u));`); }
          else if (d.sv === SV.SAMPLE_INDEX) { entryIn.push("@builtin(sample_index) sample_idx: u32"); prologue.push(`v${reg} = bitcast<vec4<f32>>(vec4<u32>(in.sample_idx, 0u, 0u, 0u));`); }
          else if (d.sv === SV.PRIMITIVE_ID) prologue.push(`v${reg} = vec4<f32>(0.0);`);
          else prologue.push(`v${reg} = vec4<f32>(0.0);`);
          continue;
        }
        const el = sh.inputs.find((e) => e.reg === reg);
        const key = el ? (el.name + "#" + el.index).toUpperCase() : "";
        const sl = link.slots.get(key);
        if (!sl) { prologue.push(`v${reg} = vec4<f32>(0.0);`); continue; }
        const ty = sl.kind === "u" ? "vec4<u32>" : sl.kind === "i" ? "vec4<i32>" : "vec4<f32>";
        const interp = sl.kind === "f" ? sl.interp : "@interpolate(flat)";
        if (!entryIn.some((e) => e.includes(`@location(${sl.slot})`))) entryIn.push(`@location(${sl.slot}) ${interp} l${sl.slot}: ${ty}`);
        prologue.push(`v${reg} = ${sl.kind === "f" ? `in.l${sl.slot}` : `bitcast<vec4<f32>>(in.l${sl.slot})`};`);
        this.psInputs.push(key);
      }
      let nTargets = 0;
      for (const [reg, d] of sh.declOut) {
        priv.push(`var<private> o${reg}: vec4<f32>;`);
        void d;
        const el = sh.outputs.find((e) => e.reg === reg);
        const target = el && el.sysVal === SV.TARGET ? el.index : reg;
        if (target < (link.targets ?? 8)) {
          const ty = el && el.compType === 1 ? "vec4<u32>" : el && el.compType === 2 ? "vec4<i32>" : "vec4<f32>";
          entryOut.push(`@location(${target}) c${target}: ${ty}`);
          epilogue.push(`out.c${target} = ${ty === "vec4<f32>" ? `o${reg}` : `bitcast<${ty}>(o${reg})`};`);
          nTargets++;
        }
      }
      if (sh.outDepth) { entryOut.push("@builtin(frag_depth) depth: f32"); epilogue.push("out.depth = oDepth;"); }
      void nTargets;
    } else {
      priv.push("var<private> gtid: vec3<u32>;", "var<private> gid: vec3<u32>;", "var<private> ltid: vec3<u32>;", "var<private> lidx: u32;");
    }
    if (stage === "ps") priv.push("var<private> sample_mask_in: u32 = 0xffffffffu;");
    // special inputs for compute
    const csArgs = stage === "cs" ? ["@builtin(global_invocation_id) gtid_in: vec3<u32>", "@builtin(workgroup_id) gid_in: vec3<u32>", "@builtin(local_invocation_id) ltid_in: vec3<u32>", "@builtin(local_invocation_index) lidx_in: u32"] : [];
    // split the stream into main and labelled subroutines
    const main: Sm5Ins[] = [];
    const subs = new Map<number, Sm5Ins[]>();
    let cur = main;
    let depth = 0;
    for (const ins of sh.ins) {
      if (ins.op === OPC.LABEL) { const id = ins.ops[0].idx[0].imm; const a: Sm5Ins[] = []; subs.set(id, a); cur = a; continue; }
      if (ins.op === OPC.IF || ins.op === OPC.LOOP || ins.op === OPC.SWITCH) depth++;
      else if (ins.op === OPC.ENDIF || ins.op === OPC.ENDLOOP || ins.op === OPC.ENDSWITCH) depth--;
      cur.push(ins);
    }
    void depth;
    const bodyOf = (list: Sm5Ins[]): string => {
      this.out = [];
      this.ind = 1;
      for (const i of list) this.inst(i);
      return this.out.join("\n");
    };
    const subTexts: string[] = [];
    for (const [id, list] of subs) subTexts.push(`fn sub_${id}() {\n${bodyOf(list)}\n}`);
    const mainBody = bodyOf(main);

    const helpers: string[] = [];
    if (this.needMulhi) {
      helpers.push("fn mulhi_u(a: u32, b: u32) -> u32 { let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u; let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh; let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu); return hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u); }");
      helpers.push("fn mulhi_i(a: i32, b: i32) -> i32 { var r = mulhi_u(bitcast<u32>(a), bitcast<u32>(b)); if (a < 0) { r = r - bitcast<u32>(b); } if (b < 0) { r = r - bitcast<u32>(a); } return bitcast<i32>(r); }");
    }
    if (this.needAtomicSigned) {
      helpers.push("fn atomicMax_i(p: ptr<storage, atomic<u32>, read_write>, v: i32) -> u32 { var old = atomicLoad(p); loop { let nv = bitcast<u32>(max(bitcast<i32>(old), v)); let r = atomicCompareExchangeWeak(p, old, nv); if (r.exchanged) { return old; } old = r.old_value; } return old; }");
      helpers.push("fn atomicMin_i(p: ptr<storage, atomic<u32>, read_write>, v: i32) -> u32 { var old = atomicLoad(p); loop { let nv = bitcast<u32>(min(bitcast<i32>(old), v)); let r = atomicCompareExchangeWeak(p, old, nv); if (r.exchanged) { return old; } old = r.old_value; } return old; }");
    }
    const inStruct = stage === "cs" ? "" : entryIn.length ? `struct In {\n${entryIn.map((s) => "  " + s + ",").join("\n")}\n};` : "";
    const outStruct = stage === "cs" ? "" : `struct Out {\n${stage === "vs" ? "  @builtin(position) pos: vec4<f32>,\n" : ""}${entryOut.map((s) => "  " + s + ",").join("\n")}\n};`;
    let ent: string;
    if (stage === "vs") {
      ent = `@vertex fn main(${entryIn.length ? "in: In" : ""}) -> Out {\n  var out: Out;\n${prologue.map((l) => "  " + l).join("\n")}\n  shader_main();\n${epilogue.map((l) => "  " + l).join("\n")}\n  return out;\n}`;
    } else if (stage === "ps") {
      ent = `@fragment fn main(${entryIn.length ? "in: In" : ""}) -> Out {\n  var out: Out;\n${prologue.map((l) => "  " + l).join("\n")}\n  shader_main();\n${epilogue.map((l) => "  " + l).join("\n")}\n  return out;\n}`;
    } else {
      const [x, y, z] = sh.threadGroup;
      ent = `@compute @workgroup_size(${x}, ${y}, ${z}) fn main(${csArgs.join(", ")}) {\n  gtid = gtid_in; gid = gid_in; ltid = ltid_in; lidx = lidx_in;\n  shader_main();\n}`;
    }
    const wgsl = [head.join("\n"), decls.join("\n"), priv.join("\n"), helpers.join("\n"), inStruct, outStruct, subTexts.join("\n"), `fn shader_main() {\n${mainBody}\n}`, ent].filter(Boolean).join("\n") + "\n";
    return { wgsl, vsOutputs: this.vsOutputs, psInputs: this.psInputs };
  }
}
