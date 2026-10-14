// Direct3D shader model 1.x–3.0 bytecode -> WGSL.
//
// parseSm3() decodes the token stream once; emitSm3() generates the WGSL module for a given link context
// (vertex attribute signature, inter-stage varying slots, pipeline-dependent epilogues).

export type ShaderStage = "vs" | "ps";

export interface Sm3Param {
  type: number;
  index: number;
  /** relative addressing: register type (3 = a0, 15 = aL) and component */
  rel: { type: number; index: number; comp: number } | null;
}
export interface Sm3Src extends Sm3Param { swz: [number, number, number, number]; mod: number }
export interface Sm3Dst extends Sm3Param { mask: number; sat: boolean; pp: boolean; centroid: boolean; shift: number }
export interface Sm3Ins {
  op: number;
  ctrl: number;
  dst: Sm3Dst | null;
  src: Sm3Src[];
  pred: Sm3Src | null;
  /** immediates for def/defi/defb */
  imm: number[] | null;
  /** dcl payload */
  dcl: { usage: number; usageIndex: number; texType: number } | null;
  coissue: boolean;
}
export interface Sm3Decl { kind: "input" | "output" | "sampler" | "misc"; type: number; index: number; usage: number; usageIndex: number; mask: number; texType: number }
export interface Sm3Shader {
  stage: ShaderStage;
  major: number;
  minor: number;
  ins: Sm3Ins[];
  decls: Sm3Decl[];
  defsF: Map<number, number[]>;
  defsI: Map<number, number[]>;
  defsB: Map<number, boolean>;
  maxTemp: number;
  /** highest float constant register referenced (without relative addressing) */
  maxConst: number;
  usesRelConst: boolean;
  samplers: Map<number, number>; // sampler register -> D3DSTT type code (2 = 2D, 3 = cube, 4 = volume)
  usesDepthOut: boolean;
  colorOuts: number[];
  usesVPos: boolean;
  usesVFace: boolean;
  usesKill: boolean;
  /** PS inputs used (type/index/usage) */
  inputs: { reg: number; type: number; usage: number; usageIndex: number }[];
  outputs: { reg: number; type: number; usage: number; usageIndex: number; mask: number }[];
  /** unsupported opcodes seen */
  unsupported: string[];
}

// opcodes
export const OP = {
  NOP: 0, MOV: 1, ADD: 2, SUB: 3, MAD: 4, MUL: 5, RCP: 6, RSQ: 7, DP3: 8, DP4: 9, MIN: 10, MAX: 11, SLT: 12, SGE: 13, EXP: 14, LOG: 15, LIT: 16, DST: 17, LRP: 18, FRC: 19, M4x4: 20,
  M4x3: 21, M3x4: 22, M3x3: 23, M3x2: 24, CALL: 25, CALLNZ: 26, LOOP: 27, RET: 28, ENDLOOP: 29, LABEL: 30, DCL: 31, POW: 32, CRS: 33, SGN: 34, ABS: 35, NRM: 36, SINCOS: 37, REP: 38,
  ENDREP: 39, IF: 40, IFC: 41, ELSE: 42, ENDIF: 43, BREAK: 44, BREAKC: 45, MOVA: 46, DEFB: 47, DEFI: 48, TEXCOORD: 64, TEXKILL: 65, TEX: 66, TEXBEM: 67, TEXBEML: 68, TEXREG2AR: 69,
  TEXREG2GB: 70, TEXM3x2PAD: 71, TEXM3x2TEX: 72, TEXM3x3PAD: 73, TEXM3x3TEX: 74, TEXM3x3SPEC: 76, TEXM3x3VSPEC: 77, EXPP: 78, LOGP: 79, CND: 80, DEF: 81, TEXREG2RGB: 82, TEXDP3TEX: 83,
  TEXM3x2DEPTH: 84, TEXDP3: 85, TEXM3x3: 86, TEXDEPTH: 87, CMP: 88, BEM: 89, DP2ADD: 90, DSX: 91, DSY: 92, TEXLDD: 93, SETP: 94, TEXLDL: 95, BREAKP: 96, PHASE: 0xfffd, COMMENT: 0xfffe, END: 0xffff,
} as const;

const OPNAMES: Record<number, string> = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k.toLowerCase()]));

export const R = { TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, TEXCRDOUT: 6, OUTPUT: 6, CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9, SAMPLER: 10, CONST2: 11, CONST3: 12, CONST4: 13, CONSTBOOL: 14, LOOP: 15, TEMPFLOAT16: 16, MISC: 17, LABEL: 18, PREDICATE: 19 } as const;

export const USAGE = { POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2, NORMAL: 3, PSIZE: 4, TEXCOORD: 5, TANGENT: 6, BINORMAL: 7, TESSFACTOR: 8, POSITIONT: 9, COLOR: 10, FOG: 11, DEPTH: 12, SAMPLE: 13 } as const;

const regType = (t: number) => ((t >>> 28) & 7) | ((t >>> 8) & 0x18);

export function parseSm3(code: Uint32Array): Sm3Shader {
  const ver = code[0];
  const hi = ver >>> 16;
  if (hi !== 0xfffe && hi !== 0xffff) throw new Error(`not a shader model 1-3 token stream: ${ver.toString(16)}`);
  const sh: Sm3Shader = {
    stage: hi === 0xfffe ? "vs" : "ps", major: (ver >>> 8) & 0xff, minor: ver & 0xff, ins: [], decls: [], defsF: new Map(), defsI: new Map(), defsB: new Map(), maxTemp: -1, maxConst: -1,
    usesRelConst: false, samplers: new Map(), usesDepthOut: false, colorOuts: [], usesVPos: false, usesVFace: false, usesKill: false, inputs: [], outputs: [], unsupported: [],
  };
  let pc = 1;
  const readParam = (): { tok: number; type: number; index: number; relTok: number | null } => {
    const tok = code[pc++];
    const type = regType(tok);
    const index = tok & 0x7ff;
    let relTok: number | null = null;
    if (tok & 0x2000) relTok = code[pc++];
    return { tok, type, index, relTok };
  };
  const relOf = (relTok: number | null): Sm3Param["rel"] => {
    if (relTok === null) return null;
    return { type: regType(relTok), index: relTok & 0x7ff, comp: (relTok >>> 16) & 3 };
  };
  const mkSrc = (tok: number, type: number, index: number, relTok: number | null): Sm3Src => {
    const s = (tok >>> 16) & 0xff;
    return { type, index, rel: relOf(relTok), swz: [s & 3, (s >>> 2) & 3, (s >>> 4) & 3, (s >>> 6) & 3], mod: (tok >>> 24) & 0xf };
  };
  const mkDst = (tok: number, type: number, index: number, relTok: number | null): Sm3Dst => {
    const mod = (tok >>> 20) & 0xf;
    let sh4 = (tok >>> 24) & 0xf;
    if (sh4 > 7) sh4 -= 16;
    return { type, index, rel: relOf(relTok), mask: (tok >>> 16) & 0xf, sat: (mod & 1) !== 0, pp: (mod & 2) !== 0, centroid: (mod & 4) !== 0, shift: sh4 };
  };
  const noteReg = (type: number, index: number, rel: boolean, isDst: boolean) => {
    if (type === R.TEMP) sh.maxTemp = Math.max(sh.maxTemp, index);
    else if (type === R.CONST && !isDst) { if (rel) sh.usesRelConst = true; else sh.maxConst = Math.max(sh.maxConst, index); }
    else if (type === R.COLOROUT && isDst && !sh.colorOuts.includes(index)) sh.colorOuts.push(index);
    else if (type === R.DEPTHOUT) sh.usesDepthOut = true;
    else if (type === R.MISC) { if (index === 0) sh.usesVPos = true; else sh.usesVFace = true; }
    if (type === R.CONST2 || type === R.CONST3 || type === R.CONST4) sh.usesRelConst = true;
  };
  while (pc < code.length) {
    const tok = code[pc++];
    const op = tok & 0xffff;
    if (op === OP.END) break;
    if (op === OP.COMMENT) { pc += (tok >>> 16) & 0x7fff; continue; }
    if (op === OP.PHASE) continue;
    const coissue = (tok & 0x40000000) !== 0;
    const predicated = (tok & 0x10000000) !== 0;
    const ctrl = (tok >>> 16) & 0xff;
    const ins: Sm3Ins = { op, ctrl, dst: null, src: [], pred: null, imm: null, dcl: null, coissue };
    // instruction extent
    let end: number;
    if (sh.major >= 2) end = pc + ((tok >>> 24) & 0xf);
    else if (op === OP.DEF) end = pc + 5;
    else { end = pc; while (end < code.length && (code[end] & 0x80000000) !== 0) end++; }
    const hasDst = !(op === OP.NOP || op === OP.RET || op === OP.ENDLOOP || op === OP.ENDREP || op === OP.ELSE || op === OP.ENDIF || op === OP.BREAK || op === OP.IF || op === OP.IFC ||
      op === OP.BREAKC || op === OP.BREAKP || op === OP.CALL || op === OP.CALLNZ || op === OP.LABEL || op === OP.LOOP || op === OP.REP || op === OP.TEXKILL && false);
    if (op === OP.DCL) {
      const d = code[pc++];
      const p = readParam();
      const usage = d & 0x1f, usageIndex = (d >>> 16) & 0xf, texType = (d >>> 27) & 0xf;
      ins.dcl = { usage, usageIndex, texType };
      ins.dst = mkDst(p.tok, p.type, p.index, p.relTok);
      if (p.type === R.SAMPLER) { sh.samplers.set(p.index, texType); sh.decls.push({ kind: "sampler", type: p.type, index: p.index, usage: 0, usageIndex: 0, mask: 0xf, texType }); }
      else {
        const isOut = (sh.stage === "vs" && (p.type === R.OUTPUT || p.type === R.ATTROUT || p.type === R.RASTOUT)) || (sh.stage === "ps" && p.type === R.COLOROUT);
        sh.decls.push({ kind: p.type === R.MISC ? "misc" : isOut ? "output" : "input", type: p.type, index: p.index, usage, usageIndex, mask: (p.tok >>> 16) & 0xf, texType: 0 });
        if (p.type === R.MISC) { if (p.index === 0) sh.usesVPos = true; else sh.usesVFace = true; }
      }
      pc = end;
      sh.ins.push(ins);
      continue;
    }
    if (op === OP.DEF || op === OP.DEFI || op === OP.DEFB) {
      const p = readParam();
      if (op === OP.DEF) {
        const f = new Float32Array(new Uint32Array([code[pc], code[pc + 1], code[pc + 2], code[pc + 3]]).buffer);
        sh.defsF.set(p.index, [f[0], f[1], f[2], f[3]]);
        ins.imm = [f[0], f[1], f[2], f[3]];
        pc += 4;
      } else if (op === OP.DEFI) {
        const v = [code[pc] | 0, code[pc + 1] | 0, code[pc + 2] | 0, code[pc + 3] | 0];
        sh.defsI.set(p.index, v);
        ins.imm = v;
        pc += 4;
      } else {
        sh.defsB.set(p.index, code[pc] !== 0);
        ins.imm = [code[pc]];
        pc += 1;
      }
      ins.dst = mkDst(p.tok, p.type, p.index, null);
      pc = end;
      sh.ins.push(ins);
      continue;
    }
    // generic: optional dst, then sources; predicate is the last token
    const predTok = predicated ? code[end - 1] : 0;
    const paramEnd = predicated ? end - 1 : end;
    if (hasDst && pc < paramEnd) {
      const p = readParam();
      ins.dst = mkDst(p.tok, p.type, p.index, p.relTok);
      noteReg(p.type, p.index, p.relTok !== null, true);
      if (p.type === R.OUTPUT || p.type === R.ATTROUT || p.type === R.RASTOUT) {
        // implicit output declarations (vs_1_1/2_0)
        const mask = (p.tok >>> 16) & 0xf;
        if (sh.major < 3 && sh.stage === "vs") {
          if (!sh.outputs.some((o) => o.type === p.type && o.reg === p.index)) {
            let usage = 0, ui = 0;
            if (p.type === R.RASTOUT) { usage = p.index === 0 ? USAGE.POSITION : p.index === 1 ? USAGE.FOG : USAGE.PSIZE; }
            else if (p.type === R.ATTROUT) { usage = USAGE.COLOR; ui = p.index; }
            else { usage = USAGE.TEXCOORD; ui = p.index; }
            sh.outputs.push({ reg: p.index, type: p.type, usage, usageIndex: ui, mask });
          } else { const o = sh.outputs.find((o2) => o2.type === p.type && o2.reg === p.index)!; o.mask |= mask; }
        }
      }
    }
    while (pc < paramEnd) {
      const p = readParam();
      ins.src.push(mkSrc(p.tok, p.type, p.index, p.relTok));
      noteReg(p.type, p.index, p.relTok !== null, false);
    }
    if (predicated) ins.pred = mkSrc(predTok, regType(predTok), predTok & 0x7ff, null);
    pc = end;
    if (op === OP.TEXKILL) sh.usesKill = true;
    sh.ins.push(ins);
  }
  // inputs/outputs from decls (SM2/3) or implicit (ps_2_0 colors/texcoords, ps_1_x)
  for (const d of sh.decls) {
    if (d.kind === "input") sh.inputs.push({ reg: d.index, type: d.type, usage: d.usage, usageIndex: d.usageIndex });
    else if (d.kind === "output" && sh.stage === "vs") sh.outputs.push({ reg: d.index, type: d.type, usage: d.usage, usageIndex: d.usageIndex, mask: d.mask });
  }
  if (sh.stage === "ps" && sh.major < 3) {
    // implicit inputs: scan for use of v# and t# registers
    const seenV = new Set<number>(), seenT = new Set<number>();
    for (const i of sh.ins) {
      for (const s of i.src) {
        if (s.type === R.INPUT) seenV.add(s.index);
        if (s.type === R.TEXTURE) seenT.add(s.index);
      }
      if (i.dst && i.dst.type === R.TEXTURE) seenT.add(i.dst.index);
      if (i.op === OP.TEXCOORD || i.op === OP.TEX && sh.major === 1) { if (i.dst) seenT.add(i.dst.index); }
    }
    for (const d of sh.decls) { if (d.kind === "input" && d.type === R.TEXTURE) seenT.add(d.index); if (d.kind === "input" && d.type === R.INPUT) seenV.add(d.index); }
    sh.inputs = [];
    for (const v of [...seenV].sort((a, b) => a - b)) sh.inputs.push({ reg: v, type: R.INPUT, usage: USAGE.COLOR, usageIndex: v });
    for (const t of [...seenT].sort((a, b) => a - b)) sh.inputs.push({ reg: t, type: R.TEXTURE, usage: USAGE.TEXCOORD, usageIndex: t });
  }
  return sh;
}

// ----------------------------------------------------------------------------------------------------------------------
// WGSL emission
// ----------------------------------------------------------------------------------------------------------------------

export interface Sm3Link {
  stage: ShaderStage;
  /** per vertex-input register: attribute kind. f = float, c = BGRA-packed color (swizzle), i = sint -> float, u = uint -> float, d = packed 10:10:10:2 */
  inputKinds?: Map<number, string>;
  /** varying semantic key (usage*16+usageIndex) -> @location slot, shared by the VS outputs and PS inputs */
  slots: Map<number, number>;
  /** slots the pixel shader reads that this vertex shader does not write (padded with zero) */
  extraSlots?: number[];
  /** sampler register -> dimension override */
  samplerDims?: Map<number, string>;
  /** alpha test function (D3DCMP_*), 0/8 = disabled */
  alphaFunc?: number;
  /** vertex shader: apply the D3D9 half-pixel offset to the position */
  halfPixel?: boolean;
  /** pixel shader sampler register -> true when the bound texture is a depth texture */
  depthSamplers?: Set<number>;
  /** pixel shader: color output count to emit */
  colorTargets?: number;
  /** number of active vertex-shader float constants (for array sizing) */
  fogMode?: number;
}

export const semKey = (usage: number, index: number) => usage * 16 + index;

const f32 = (v: number): string => {
  if (Number.isNaN(v)) return "bitcast<f32>(0x7fc00000u)";
  if (!Number.isFinite(v)) return v > 0 ? "bitcast<f32>(0x7f800000u)" : "bitcast<f32>(0xff800000u)";
  let s = Math.fround(v).toPrecision(9);
  if (!/[.e]/.test(s)) s += ".0";
  if (/e/.test(s) && !/\./.test(s.split("e")[0])) s = s.replace("e", ".0e");
  return s;
};
const v4f = (a: number[]) => `vec4<f32>(${a.map(f32).join(", ")})`;
const COMP = ["x", "y", "z", "w"];

export function emitSm3(sh: Sm3Shader, link: Sm3Link): { wgsl: string; vsOutputs: number[]; psInputs: number[] } {
  return new Emitter(sh, link).emit();
}

class Emitter {
  sh: Sm3Shader;
  link: Sm3Link;
  out: string[] = [];
  ind = 1;
  labels = new Set<number>();
  loopDepth = 0;
  loopSeq = 0;
  loopVars: string[] = [];
  tmpCount = 0;
  vsOutputs: number[] = [];
  psInputs: number[] = [];
  isVs: boolean;
  constBase: string;

  constructor(sh: Sm3Shader, link: Sm3Link) {
    this.sh = sh;
    this.link = link;
    this.isVs = sh.stage === "vs";
    this.constBase = this.isVs ? "vc" : "pc";
  }

  w(s: string) { this.out.push("  ".repeat(this.ind) + s); }
  tmp(): string { return "t" + this.tmpCount++; }

  // ---- register naming ----
  regName(type: number, index: number): string {
    switch (type) {
      case R.TEMP: return `r${index}`;
      case R.INPUT: return `v${index}`;
      case R.ADDR: return this.isVs ? "a0" : `t${index}`;
      case R.RASTOUT: return index === 0 ? "oPos" : index === 1 ? "oFog" : "oPts";
      case R.ATTROUT: return `oD${index}`;
      case R.TEXCRDOUT: return `o${index}`;
      case R.COLOROUT: return `oC${index}`;
      case R.DEPTHOUT: return "oDepth";
      case R.LOOP: return "aL";
      case R.PREDICATE: return "p0";
      case R.MISC: return index === 0 ? "vPos" : "vFace";
      default: return `x${type}_${index}`;
    }
  }

  /** the vec4<f32> expression for a source operand before swizzle/modifier */
  srcBase(s: Sm3Param): string {
    const { type, index } = s;
    switch (type) {
      case R.CONST: case R.CONST2: case R.CONST3: case R.CONST4: {
        const base = type === R.CONST ? index : type === R.CONST2 ? 2048 + index : type === R.CONST3 ? 4096 + index : 6144 + index;
        if (s.rel) {
          const r = s.rel.type === R.LOOP ? "aL" : `a0.${COMP[s.rel.comp]}`;
          return `cr(${r} + ${base})`;
        }
        if (!this.sh.defsF.has(base) || false) { /* uniform */ }
        const d = this.sh.defsF.get(base);
        if (d) return v4f(d);
        return `${this.constBase}.f[${base}]`;
      }
      case R.CONSTINT: {
        const d = this.sh.defsI.get(index);
        if (d) return `vec4<f32>(vec4<i32>(${d.join(", ")}))`;
        return `vec4<f32>(${this.constBase}.i[${index}])`;
      }
      case R.CONSTBOOL: {
        const d = this.sh.defsB.get(index);
        if (d !== undefined) return d ? "vec4<f32>(1.0)" : "vec4<f32>(0.0)";
        return `vec4<f32>(f32(bc(${index})))`;
      }
      case R.LOOP: return "vec4<f32>(f32(aL))";
      case R.MISC: return index === 0 ? "vPos" : "vFace";
      case R.PREDICATE: return "vec4<f32>(p0)";
      default: return this.regName(type, index);
    }
  }

  src(s: Sm3Src): string {
    let e = this.srcBase(s);
    const [a, b, c, d] = s.swz;
    const swz = a === 0 && b === 1 && c === 2 && d === 3 ? "" : "." + COMP[a] + COMP[b] + COMP[c] + COMP[d];
    if (swz) e = `(${e})${swz}`;
    switch (s.mod) {
      case 0: break;
      case 1: e = `(-${e})`; break;
      case 2: e = `(${e} - vec4<f32>(0.5))`; break;
      case 3: e = `(-(${e} - vec4<f32>(0.5)))`; break;
      case 4: e = `((${e} - vec4<f32>(0.5)) * 2.0)`; break;
      case 5: e = `(-((${e} - vec4<f32>(0.5)) * 2.0))`; break;
      case 6: e = `(vec4<f32>(1.0) - ${e})`; break;
      case 7: e = `(${e} * 2.0)`; break;
      case 8: e = `(-(${e} * 2.0))`; break;
      case 9: e = `(${e} / ${e}.zzzz)`; break;
      case 10: e = `(${e} / ${e}.wwww)`; break;
      case 11: e = `abs(${e})`; break;
      case 12: e = `(-abs(${e}))`; break;
      case 13: e = `vec4<f32>(select(1.0, 0.0, ${e}.x != 0.0))`; break;
      default: break;
    }
    return e;
  }

  /** scalar float expression of the first component after swizzle */
  scalar(s: Sm3Src): string {
    return `${this.src(s)}.x`;
  }

  /** assign a vec4 expression to the destination, honoring mask, saturate, shift and predication */
  store(d: Sm3Dst, expr: string, pred?: string) {
    let e = expr;
    if (d.shift) e = `(${e}) * ${f32(Math.pow(2, d.shift))}`;
    if (d.sat) e = `clamp(${e}, vec4<f32>(0.0), vec4<f32>(1.0))`;
    let name = this.regName(d.type, d.index);
    if (d.type === R.ADDR && this.isVs) {
      // a0 is integer typed
      const t = this.tmp();
      this.w(`let ${t} = vec4<i32>(floor(${e} + vec4<f32>(0.5)));`);
      this.assign(name, `${t}`, d.mask, pred, "i32");
      return;
    }
    if (d.type === R.RASTOUT && d.index !== 0) {
      // oFog / oPts are scalars stored in .x
      this.assign(name, e, d.mask | 1, pred, "f32", true);
      return;
    }
    if (d.type === R.DEPTHOUT) { this.assign(name, e, 1, pred, "f32", true); return; }
    if (d.type === R.CONSTINT || d.type === R.CONSTBOOL) return;
    if (d.rel) {
      // relative output addressing is not supported by the vertex output model; ignore the offset
    }
    this.assign(name, e, d.mask, pred, "f32");
  }

  assign(name: string, e: string, mask: number, pred: string | undefined, _ty: string, scalarDest = false) {
    const open = pred ? `if (${pred}) { ` : "";
    const close = pred ? " }" : "";
    if (scalarDest) { this.w(`${open}${name} = (${e}).x;${close}`); return; }
    if ((mask & 0xf) === 0xf) { this.w(`${open}${name} = ${e};${close}`); return; }
    if (!(mask & 0xf)) return;
    const t = this.tmp();
    this.w(`${open}{ let ${t} = ${e};`);
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) this.w(`  ${name}.${COMP[i]} = ${t}.${COMP[i]};`);
    this.w(`}${close}`);
  }

  predExpr(ins: Sm3Ins): string | undefined {
    if (!ins.pred) return undefined;
    const p = ins.pred;
    const [a] = p.swz;
    const neg = p.mod === 13;
    const swzAll = p.swz.every((x) => x === a);
    const comp = swzAll ? `p0.${COMP[a]}` : `p0.${COMP[p.swz[0]]}`;
    return neg ? `!${comp}` : comp;
  }

  // ---- texture sampling ----
  samplerDim(idx: number): string {
    const o = this.link.samplerDims?.get(idx);
    if (o) return o;
    const t = this.sh.samplers.get(idx);
    if (t === 3) return "cube";
    if (t === 4) return "3d";
    return "2d";
  }
  sample(idx: number, coord: string, mode: "n" | "p" | "b" | "l" | "g", extra?: string, extra2?: string): string {
    const dim = this.samplerDim(idx);
    const t = `t_${idx}`, s = `s_${idx}`;
    const cmp = this.link.depthSamplers?.has(idx);
    const vs = this.isVs;
    if (dim === "2d") {
      const c = mode === "p" ? `(${coord}).xy / (${coord}).w` : `(${coord}).xy`;
      if (cmp) return `vec4<f32>(textureSampleCompareLevel(${t}, ${s}, ${c}, (${coord}).z))`;
      if (vs) return `textureSampleLevel(${t}, ${s}, ${c}, ${mode === "l" ? `(${coord}).w` : "0.0"})`;
      switch (mode) {
        case "b": return `textureSampleBias(${t}, ${s}, ${c}, (${coord}).w)`;
        case "l": return `textureSampleLevel(${t}, ${s}, ${c}, (${coord}).w)`;
        case "g": return `textureSampleGrad(${t}, ${s}, ${c}, (${extra}).xy, (${extra2}).xy)`;
        default: return `textureSample(${t}, ${s}, ${c})`;
      }
    }
    const c = mode === "p" ? `(${coord}).xyz / (${coord}).w` : `(${coord}).xyz`;
    if (vs) return `textureSampleLevel(${t}, ${s}, ${c}, ${mode === "l" ? `(${coord}).w` : "0.0"})`;
    switch (mode) {
      case "b": return `textureSampleBias(${t}, ${s}, ${c}, (${coord}).w)`;
      case "l": return `textureSampleLevel(${t}, ${s}, ${c}, (${coord}).w)`;
      case "g": return `textureSampleGrad(${t}, ${s}, ${c}, (${extra}).xyz, (${extra2}).xyz)`;
      default: return `textureSample(${t}, ${s}, ${c})`;
    }
  }

  cmpOp(ctrl: number): string {
    switch (ctrl & 7) {
      case 1: return ">"; case 2: return "=="; case 3: return ">="; case 4: return "<"; case 5: return "!="; case 6: return "<=";
      default: return "==";
    }
  }

  // ---- instruction emission ----
  inst(ins: Sm3Ins) {
    const op = ins.op;
    const d = ins.dst;
    const S = (i: number) => this.src(ins.src[i]);
    const pred = this.predExpr(ins);
    const wr = (e: string) => { if (d) this.store(d, e, pred); };
    const sc = (i: number) => `${S(i)}.x`;
    switch (op) {
      case OP.NOP: case OP.COMMENT: case OP.PHASE: return;
      case OP.MOV:
        if (d && d.type === R.ADDR && this.isVs && this.sh.major === 1 && this.sh.minor === 1 && false) return;
        wr(S(0)); return;
      case OP.MOVA: wr(`floor(${S(0)} + vec4<f32>(0.5))`); return;
      case OP.ADD: wr(`${S(0)} + ${S(1)}`); return;
      case OP.SUB: wr(`${S(0)} - ${S(1)}`); return;
      case OP.MUL: wr(`${S(0)} * ${S(1)}`); return;
      case OP.MAD: wr(`${S(0)} * ${S(1)} + ${S(2)}`); return;
      case OP.RCP: wr(`vec4<f32>(1.0 / ${sc(0)})`); return;
      case OP.RSQ: wr(`vec4<f32>(inverseSqrt(abs(${sc(0)})))`); return;
      case OP.DP3: wr(`vec4<f32>(dot(${S(0)}.xyz, ${S(1)}.xyz))`); return;
      case OP.DP4: wr(`vec4<f32>(dot(${S(0)}, ${S(1)}))`); return;
      case OP.DP2ADD: wr(`vec4<f32>(dot(${S(0)}.xy, ${S(1)}.xy) + ${sc(2)})`); return;
      case OP.MIN: wr(`min(${S(0)}, ${S(1)})`); return;
      case OP.MAX: wr(`max(${S(0)}, ${S(1)})`); return;
      case OP.SLT: wr(`select(vec4<f32>(0.0), vec4<f32>(1.0), ${S(0)} < ${S(1)})`); return;
      case OP.SGE: wr(`select(vec4<f32>(0.0), vec4<f32>(1.0), ${S(0)} >= ${S(1)})`); return;
      case OP.EXP: case OP.EXPP: wr(`vec4<f32>(exp2(${sc(0)}))`); return;
      case OP.LOG: case OP.LOGP: wr(`vec4<f32>(log2(abs(${sc(0)})))`); return;
      case OP.LRP: wr(`${S(0)} * (${S(1)} - ${S(2)}) + ${S(2)}`); return;
      case OP.FRC: wr(`fract(${S(0)})`); return;
      case OP.POW: wr(`vec4<f32>(pow(abs(${sc(0)}), ${sc(1)}))`); return;
      case OP.SGN: wr(`sign(${S(0)})`); return;
      case OP.ABS: wr(`abs(${S(0)})`); return;
      case OP.CRS: wr(`vec4<f32>(cross(${S(0)}.xyz, ${S(1)}.xyz), 0.0)`); return;
      case OP.NRM: { const t = this.tmp(); this.w(`let ${t} = ${S(0)};`); wr(`vec4<f32>(${t}.xyz * inverseSqrt(max(dot(${t}.xyz, ${t}.xyz), 1.0e-30)), 0.0)`); return; }
      case OP.SINCOS: wr(`vec4<f32>(cos(${sc(0)}), sin(${sc(0)}), 0.0, 0.0)`); return;
      case OP.LIT: {
        const t = this.tmp();
        this.w(`let ${t} = ${S(0)};`);
        wr(`vec4<f32>(1.0, max(${t}.x, 0.0), select(0.0, pow(max(${t}.y, 0.0), clamp(${t}.w, -127.9961, 127.9961)), ${t}.x > 0.0), 1.0)`);
        return;
      }
      case OP.DST: { const a = this.tmp(), b = this.tmp(); this.w(`let ${a} = ${S(0)}; let ${b} = ${S(1)};`); wr(`vec4<f32>(1.0, ${a}.y * ${b}.y, ${a}.z, ${b}.w)`); return; }
      case OP.CMP: wr(`select(${S(2)}, ${S(1)}, ${S(0)} >= vec4<f32>(0.0))`); return;
      case OP.CND: wr(`select(${S(2)}, ${S(1)}, ${S(0)} > vec4<f32>(0.5))`); return;
      case OP.DSX: wr(`dpdx(${S(0)})`); return;
      case OP.DSY: wr(`dpdy(${S(0)})`); return;
      case OP.M4x4: case OP.M4x3: case OP.M3x4: case OP.M3x3: case OP.M3x2: {
        const rows = op === OP.M4x4 ? 4 : op === OP.M4x3 ? 3 : op === OP.M3x4 ? 4 : op === OP.M3x3 ? 3 : 2;
        const dotN = op === OP.M4x4 || op === OP.M4x3 ? 4 : 3;
        const a = this.tmp();
        this.w(`let ${a} = ${S(0)};`);
        const m = ins.src[1];
        const parts: string[] = [];
        for (let i = 0; i < rows; i++) {
          const row = this.src({ ...m, index: m.index + i, swz: [0, 1, 2, 3], mod: 0 });
          parts.push(dotN === 4 ? `dot(${a}, ${row})` : `dot(${a}.xyz, ${row}.xyz)`);
        }
        while (parts.length < 4) parts.push("0.0");
        wr(`vec4<f32>(${parts.join(", ")})`);
        return;
      }
      case OP.SETP: {
        if (!d) return;
        const cmp = this.cmpOp(ins.ctrl);
        const t = this.tmp();
        this.w(`let ${t} = ${S(0)} ${cmp} ${S(1)};`);
        for (let i = 0; i < 4; i++) if (d.mask & (1 << i)) this.w(`${pred ? `if (${pred}) ` : ""}{ p0.${COMP[i]} = ${t}.${COMP[i]}; }`);
        return;
      }
      case OP.TEXKILL: {
        const r = ins.dst ? this.regName(ins.dst.type, ins.dst.index) : "t0";
        const test = this.sh.major >= 2 ? `any(${r} < vec4<f32>(0.0))` : `any(${r}.xyz < vec3<f32>(0.0))`;
        this.w(`if (${test}) { discard; }`);
        return;
      }
      case OP.TEXCOORD: {
        if (!d) return;
        if (this.sh.major === 1 && this.sh.minor < 4) wr(`vec4<f32>(clamp(${this.regName(R.TEXTURE, d.index)}.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0)`);
        else wr(`vec4<f32>(${S(0)}.xyz, 1.0)`);
        return;
      }
      case OP.TEX: {
        if (!d) return;
        if (this.sh.major >= 2) { // texld
          const sIdx = ins.src[1].index;
          const mode = (ins.ctrl & 3) === 1 ? "p" : (ins.ctrl & 3) === 2 ? "b" : "n";
          wr(this.sample(sIdx, S(0), mode));
        } else if (this.sh.major === 1 && this.sh.minor >= 4) {
          // ps_1_4 texld rD, tS (or rS)
          const sIdx = d.index;
          wr(this.sample(sIdx, ins.src.length ? S(0) : this.regName(R.TEXTURE, d.index), "n"));
        } else {
          // ps_1_1..1_3: tex tN samples stage N with coordinates tN
          const n = d.index;
          wr(this.sample(n, this.regName(R.TEXTURE, n), "n"));
        }
        return;
      }
      case OP.TEXLDL: if (d) wr(this.sample(ins.src[1].index, S(0), "l")); return;
      case OP.TEXLDD: if (d) wr(this.sample(ins.src[1].index, S(0), "g", S(2), S(3))); return;
      case OP.BEM: this.sh.unsupported.push("bem"); this.w("// bem unsupported"); return;
      case OP.TEXREG2AR: if (d) wr(this.sample(d.index, `vec4<f32>(${this.regName(R.TEXTURE, ins.src[0].index)}.wx, 0.0, 0.0)`, "n")); return;
      case OP.TEXREG2GB: if (d) wr(this.sample(d.index, `vec4<f32>(${this.regName(R.TEXTURE, ins.src[0].index)}.yz, 0.0, 0.0)`, "n")); return;
      case OP.TEXREG2RGB: if (d) wr(this.sample(d.index, `vec4<f32>(${this.regName(R.TEXTURE, ins.src[0].index)}.xyz, 0.0)`, "n")); return;
      case OP.TEXBEM: case OP.TEXBEML: {
        if (!d) return;
        const t = this.regName(R.TEXTURE, d.index), s = this.regName(R.TEXTURE, ins.src[0].index);
        const c = this.tmp();
        this.w(`let ${c} = vec2<f32>(${t}.x + pc.bem[${d.index}].x * ${s}.x + pc.bem[${d.index}].z * ${s}.y, ${t}.y + pc.bem[${d.index}].y * ${s}.x + pc.bem[${d.index}].w * ${s}.y);`);
        const smp = `${this.sample(d.index, `vec4<f32>(${c}, 0.0, 0.0)`, "n")}`;
        if (op === OP.TEXBEML) wr(`${smp} * clamp(${s}.z * pc.bemL[${d.index}].x + pc.bemL[${d.index}].y, 0.0, 1.0)`);
        else wr(smp);
        return;
      }
      case OP.TEXM3x2PAD: case OP.TEXM3x3PAD: {
        // accumulate the dot product row; consumed by the following *_TEX/*_SPEC/*_VSPEC op
        const s = this.regName(R.TEXTURE, ins.src[0].index);
        const t = this.regName(R.TEXTURE, ins.dst!.index);
        this.w(`m3_row[m3_n] = dot(${t}.xyz, ${s}.xyz); m3_n = m3_n + 1;`);
        return;
      }
      case OP.TEXM3x2TEX: {
        const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index);
        this.w(`m3_row[1] = dot(${t}.xyz, ${s}.xyz); m3_n = 0;`);
        wr(this.sample(ins.dst!.index, "vec4<f32>(m3_row[0], m3_row[1], 0.0, 0.0)", "n"));
        return;
      }
      case OP.TEXM3x3TEX: case OP.TEXM3x3SPEC: case OP.TEXM3x3VSPEC: {
        const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index);
        this.w(`m3_row[2] = dot(${t}.xyz, ${s}.xyz); m3_n = 0;`);
        const nrm = "vec3<f32>(m3_row[0], m3_row[1], m3_row[2])";
        if (op === OP.TEXM3x3TEX) { wr(this.sample(ins.dst!.index, `vec4<f32>(${nrm}, 0.0)`, "n")); return; }
        const eye = op === OP.TEXM3x3SPEC ? `${this.src(ins.src[1])}.xyz` : `vec3<f32>(m3_eye.x, m3_eye.y, m3_eye.z)`;
        const refl = this.tmp();
        this.w(`let ${refl} = 2.0 * dot(${nrm}, ${eye}) * ${nrm} / dot(${nrm}, ${nrm}) - ${eye};`);
        wr(this.sample(ins.dst!.index, `vec4<f32>(${refl}, 0.0)`, "n"));
        return;
      }
      case OP.TEXM3x3: {
        const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index);
        this.w(`m3_row[2] = dot(${t}.xyz, ${s}.xyz); m3_n = 0;`);
        wr(`vec4<f32>(m3_row[0], m3_row[1], m3_row[2], 1.0)`);
        return;
      }
      case OP.TEXDP3TEX: {
        const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index);
        wr(this.sample(ins.dst!.index, `vec4<f32>(m3_row[0], dot(${t}.xyz, ${s}.xyz), 0.0, 0.0)`, "n"));
        return;
      }
      case OP.TEXDP3: { const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index); wr(`vec4<f32>(dot(${t}.xyz, ${s}.xyz))`); return; }
      case OP.TEXDEPTH: { if (d) { const r = this.regName(R.TEXTURE, d.index); this.w(`depth_out = ${r}.x / ${r}.y;`); } return; }
      case OP.TEXM3x2DEPTH: {
        const s = this.regName(R.TEXTURE, ins.src[0].index), t = this.regName(R.TEXTURE, ins.dst!.index);
        this.w(`depth_out = m3_row[0] / dot(${t}.xyz, ${s}.xyz);`);
        return;
      }
      // control flow
      case OP.IF: {
        const s = ins.src[0];
        let cond: string;
        if (s.type === R.PREDICATE) cond = `p0.${COMP[s.swz[0]]}`;
        else cond = `(${this.srcBase(s)}).x != 0.0`;
        if (s.mod === 13) cond = `!(${cond})`;
        this.w(`if (${cond}) {`); this.ind++; return;
      }
      case OP.IFC: this.w(`if (${S(0)}.x ${this.cmpOp(ins.ctrl)} ${S(1)}.x) {`); this.ind++; return;
      case OP.ELSE: this.ind--; this.w("} else {"); this.ind++; return;
      case OP.ENDIF: this.ind--; this.w("}"); return;
      case OP.LOOP: {
        const lv = `lc${this.loopSeq++}`;
        this.loopVars.push(lv);
        this.loopDepth++;
        const ic = ins.src[1];
        const iv = this.srcBase({ ...ic, rel: null });
        const cnt = this.tmp();
        this.w(`let ${cnt} = vec4<i32>(${iv});`);
        this.w(`var ${lv}: i32 = 0;`);
        this.w(`loop {`); this.ind++;
        this.w(`if (${lv} >= ${cnt}.x) { break; }`);
        this.w(`aL = ${cnt}.y + ${lv} * ${cnt}.z;`);
        return;
      }
      case OP.ENDLOOP: {
        const lv = this.loopVars.pop();
        this.loopDepth--;
        this.w(`${lv} = ${lv} + 1;`);
        this.ind--; this.w("}");
        return;
      }
      case OP.REP: {
        const lv = `lc${this.loopSeq++}`;
        this.loopVars.push(lv);
        this.loopDepth++;
        this.w(`var ${lv}: i32 = 0;`);
        this.w(`let ${lv}_n = i32(${this.srcBase({ ...ins.src[0], rel: null })}.x);`);
        this.w(`loop {`); this.ind++;
        this.w(`if (${lv} >= ${lv}_n) { break; }`);
        return;
      }
      case OP.ENDREP: {
        const lv = this.loopVars.pop();
        this.loopDepth--;
        this.w(`${lv} = ${lv} + 1;`);
        this.ind--; this.w("}");
        return;
      }
      case OP.BREAK: this.w("break;"); return;
      case OP.BREAKC: this.w(`if (${S(0)}.x ${this.cmpOp(ins.ctrl)} ${S(1)}.x) { break; }`); return;
      case OP.BREAKP: { const s = ins.src[0]; this.w(`if (${s.mod === 13 ? "!" : ""}p0.${COMP[s.swz[0]]}) { break; }`); return; }
      case OP.CALL: this.w(`sub_${ins.src[0].index}();`); this.labels.add(ins.src[0].index); return;
      case OP.CALLNZ: {
        const s = ins.src[1];
        const cond = s.type === R.PREDICATE ? `p0.${COMP[s.swz[0]]}` : `(${this.srcBase(s)}).x != 0.0`;
        this.w(`if (${s.mod === 13 ? "!" : ""}(${cond})) { sub_${ins.src[0].index}(); }`);
        this.labels.add(ins.src[0].index);
        return;
      }
      case OP.DEF: case OP.DEFI: case OP.DEFB: case OP.DCL: return;
      default:
        this.sh.unsupported.push(OPNAMES[op] ?? String(op));
        this.w(`// unsupported instruction ${OPNAMES[op] ?? op}`);
    }
  }

  emit(): { wgsl: string; vsOutputs: number[]; psInputs: number[] } {
    const sh = this.sh, link = this.link;
    const isVs = this.isVs;
    const head: string[] = [];
    head.push("diagnostic(off, derivative_uniformity);");
    head.push("diagnostic(off, subgroup_uniformity);");
    head.push(`struct FConsts { f: array<vec4<f32>, 256>, i: array<vec4<i32>, 16>, b: array<vec4<u32>, 4>, bem: array<vec4<f32>, 8>, bemL: array<vec4<f32>, 8> };`);
    head.push(`struct Params { vpInv: vec4<f32>, alpha: vec4<f32>, fogColor: vec4<f32>, fog: vec4<f32>, misc: vec4<f32> };`);
    head.push(`@group(0) @binding(${isVs ? 0 : 1}) var<uniform> ${this.constBase}: FConsts;`);
    head.push(`@group(0) @binding(2) var<uniform> prm: Params;`);
    // samplers
    const grp = isVs ? 2 : 1;
    const samplerIdx = new Set<number>(sh.samplers.keys());
    // implicit samplers (ps 1.x, texld without dcl)
    for (const i of sh.ins) {
      if (i.op === OP.TEX || i.op === OP.TEXLDL || i.op === OP.TEXLDD) {
        if (sh.major >= 2 && i.src[1]) samplerIdx.add(i.src[1].index);
        else if (sh.major === 1 && i.dst) samplerIdx.add(i.dst.index);
      } else if ([OP.TEXBEM, OP.TEXBEML, OP.TEXREG2AR, OP.TEXREG2GB, OP.TEXREG2RGB, OP.TEXM3x2TEX, OP.TEXM3x3TEX, OP.TEXM3x3SPEC, OP.TEXM3x3VSPEC, OP.TEXDP3TEX].includes(i.op as any) && i.dst) samplerIdx.add(i.dst.index);
    }
    for (const s of [...samplerIdx].sort((a, b) => a - b)) {
      const dim = this.samplerDim(s);
      const depth = link.depthSamplers?.has(s);
      head.push(`@group(${grp}) @binding(${s * 2}) var t_${s}: ${depth ? "texture_depth_2d" : dim === "cube" ? "texture_cube<f32>" : dim === "3d" ? "texture_3d<f32>" : "texture_2d<f32>"};`);
      head.push(`@group(${grp}) @binding(${s * 2 + 1}) var s_${s}: ${depth ? "sampler_comparison" : "sampler"};`);
    }
    // registers
    const priv: string[] = [];
    for (let i = 0; i <= Math.max(sh.maxTemp, isVs ? sh.maxTemp : (sh.major === 1 ? 3 : sh.maxTemp)); i++) priv.push(`var<private> r${i}: vec4<f32>;`);
    if (isVs) priv.push("var<private> a0: vec4<i32>;");
    priv.push("var<private> aL: i32;");
    priv.push("var<private> p0: vec4<bool>;");
    priv.push("var<private> m3_row: array<f32, 3>;");
    priv.push("var<private> m3_n: i32;");
    priv.push("var<private> m3_eye: vec4<f32>;");
    priv.push("var<private> depth_out: f32;");

    // entry interface
    const entryIn: string[] = [];
    const entryOut: string[] = [];
    const prologue: string[] = [];
    const epilogue: string[] = [];
    if (isVs) {
      // inputs: v# registers declared by dcl
      for (const inp of sh.inputs) {
        const kind = link.inputKinds?.get(inp.reg) ?? "f";
        const ty = kind === "i" ? "vec4<i32>" : kind === "u" ? "vec4<u32>" : kind === "d" ? "u32" : "vec4<f32>";
        entryIn.push(`@location(${inp.reg}) i${inp.reg}: ${ty}`);
        priv.push(`var<private> v${inp.reg}: vec4<f32>;`);
        let conv: string;
        switch (kind) {
          case "i": conv = `vec4<f32>(in.i${inp.reg})`; break;
          case "u": conv = `vec4<f32>(in.i${inp.reg})`; break;
          case "c": conv = `in.i${inp.reg}.zyxw`; break;
          case "d": conv = `vec4<f32>(f32(in.i${inp.reg} & 1023u), f32((in.i${inp.reg} >> 10u) & 1023u), f32((in.i${inp.reg} >> 20u) & 1023u), f32(in.i${inp.reg} >> 30u))`; break;
          case "D": conv = `vec4<f32>(max(f32(bitcast<i32>((in.i${inp.reg} & 1023u) << 22u) >> 22) / 511.0, -1.0), max(f32(bitcast<i32>(((in.i${inp.reg} >> 10u) & 1023u) << 22u) >> 22) / 511.0, -1.0), max(f32(bitcast<i32>(((in.i${inp.reg} >> 20u) & 1023u) << 22u) >> 22) / 511.0, -1.0), 1.0)`; break;
          default: conv = `in.i${inp.reg}`;
        }
        prologue.push(`v${inp.reg} = ${conv};`);
      }
      // outputs
      priv.push("var<private> oPos: vec4<f32>;");
      priv.push("var<private> oFog: f32;");
      priv.push("var<private> oPts: f32;");
      const outs = sh.outputs.filter((o) => o.type !== R.RASTOUT);
      const written = new Set<number>();
      for (const o of outs) {
        const key = semKey(o.usage, o.usageIndex);
        const slot = link.slots.get(key);
        const nm = o.type === R.ATTROUT ? `oD${o.reg}` : `o${o.reg}`;
        priv.push(`var<private> ${nm}: vec4<f32>;`);
        if (o.usage === USAGE.POSITION && o.type === R.OUTPUT) { // vs_3_0 position
          epilogue.push(`oPos = ${nm};`);
          continue;
        }
        if (o.usage === USAGE.PSIZE) continue;
        if (slot === undefined) continue; // not consumed by the pixel shader
        if (written.has(slot)) continue;
        written.add(slot);
        entryOut.push(`@location(${slot}) l${slot}: vec4<f32>`);
        epilogue.push(`out.l${slot} = ${o.usage === USAGE.FOG ? `vec4<f32>(${nm}.x)` : nm};`);
        this.vsOutputs.push(slot);
      }
      // fog from oFog (vs_1/2)
      const fogKey = semKey(USAGE.FOG, 0);
      if (sh.major < 3 && link.slots.has(fogKey) && !written.has(link.slots.get(fogKey)!)) {
        const slot = link.slots.get(fogKey)!;
        entryOut.push(`@location(${slot}) l${slot}: vec4<f32>`);
        epilogue.push(`out.l${slot} = vec4<f32>(oFog);`);
        written.add(slot);
        this.vsOutputs.push(slot);
      }
      for (const slot of link.extraSlots ?? []) {
        if (written.has(slot)) continue;
        entryOut.push(`@location(${slot}) l${slot}: vec4<f32>`);
        epilogue.push(`out.l${slot} = vec4<f32>(0.0);`);
        written.add(slot);
      }
    } else {
      // pixel shader inputs
      const seenRegs = new Set<string>();
      const usedSlots = new Set<number>();
      for (const inp of sh.inputs) {
        const nm = inp.type === R.TEXTURE ? `t${inp.reg}` : `v${inp.reg}`;
        if (inp.usage === USAGE.POSITION && sh.major >= 3 && sh.inputs.some((o) => o !== inp && o.reg === inp.reg && o.type === inp.type)) continue; // placeholder position declaration sharing a register
        if (!seenRegs.has(nm)) { seenRegs.add(nm); priv.push(`var<private> ${nm}: vec4<f32>;`); }
        const slot = inp.usage === USAGE.POSITION ? undefined : link.slots.get(semKey(inp.usage, inp.usageIndex));
        if (slot === undefined) { prologue.push(`${nm} = ${inp.usage === USAGE.COLOR ? "vec4<f32>(0.0, 0.0, 0.0, 1.0)" : "vec4<f32>(0.0)"};`); continue; }
        if (!usedSlots.has(slot)) { usedSlots.add(slot); entryIn.push(`@location(${slot}) l${slot}: vec4<f32>`); this.psInputs.push(slot); }
        const clampIt = sh.major < 3 && inp.type === R.INPUT;
        prologue.push(`${nm} = ${clampIt ? `clamp(in.l${slot}, vec4<f32>(0.0), vec4<f32>(1.0))` : `in.l${slot}`};`);
      }
      if (sh.major === 1) for (let i = 0; i < 4; i++) if (!sh.inputs.some((x) => x.type === R.TEXTURE && x.reg === i) && i <= 3 && false) priv.push(`var<private> t${i}: vec4<f32>;`);
      if (sh.usesVPos) { entryIn.push("@builtin(position) frag_pos: vec4<f32>"); priv.push("var<private> vPos: vec4<f32>;"); prologue.push("vPos = vec4<f32>(frag_pos.x - 0.5, frag_pos.y - 0.5, 0.0, 0.0);"); }
      if (sh.usesVFace) { entryIn.push("@builtin(front_facing) front: bool"); priv.push("var<private> vFace: vec4<f32>;"); prologue.push("vFace = vec4<f32>(select(-1.0, 1.0, front));"); }
      const nColors = Math.max(sh.colorOuts.length ? Math.max(...sh.colorOuts) + 1 : 1, 1);
      const targets = link.colorTargets ?? nColors;
      for (let i = 0; i < nColors; i++) priv.push(`var<private> oC${i}: vec4<f32>;`);
      for (let i = 0; i < Math.min(nColors, targets); i++) entryOut.push(`@location(${i}) c${i}: vec4<f32>`);
      if (sh.usesDepthOut) { entryOut.push("@builtin(frag_depth) depth: f32"); priv.push("var<private> oDepth: f32;"); }
      if (sh.major === 1) {
        // ps_1_x: result in r0; temporaries beyond the declared ones are initialised to zero
        epilogue.push("oC0 = r0;");
      }
      if (link.alphaFunc && link.alphaFunc !== 8) {
        const f = link.alphaFunc;
        const a = "oC0.a";
        const ref = "prm.alpha.x";
        const test = f === 1 ? "false" : f === 2 ? `${a} < ${ref}` : f === 3 ? `${a} == ${ref}` : f === 4 ? `${a} <= ${ref}` : f === 5 ? `${a} > ${ref}` : f === 6 ? `${a} != ${ref}` : `${a} >= ${ref}`;
        epilogue.push(`if (!(${test})) { discard; }`);
      }
      for (let i = 0; i < Math.min(nColors, targets); i++) epilogue.push(`out.c${i} = oC${i};`);
      if (sh.usesDepthOut) epilogue.push("out.depth = clamp(oDepth, 0.0, 1.0);");
      else if (sh.major === 1 && sh.ins.some((x) => x.op === OP.TEXDEPTH || x.op === OP.TEXM3x2DEPTH)) { entryOut.push("@builtin(frag_depth) depth: f32"); epilogue.push("out.depth = clamp(depth_out, 0.0, 1.0);"); }
    }
    // helper functions
    const helpers: string[] = [];
    helpers.push(`fn cr(i: i32) -> vec4<f32> { if (i < 0 || i >= 256) { return vec4<f32>(0.0); } return ${this.constBase}.f[u32(i)]; }`);
    helpers.push(`fn bc(i: i32) -> u32 { return (${this.constBase}.b[u32(i) >> 2u][u32(i) & 3u]) & 1u; }`);

    // body: split main from subroutines at the first top-level ret
    const main: Sm3Ins[] = [];
    const subs = new Map<number, Sm3Ins[]>();
    let cur: Sm3Ins[] = main;
    let depth = 0;
    let seenMainRet = false;
    for (const ins of sh.ins) {
      if (ins.op === OP.IF || ins.op === OP.IFC || ins.op === OP.LOOP || ins.op === OP.REP) depth++;
      else if (ins.op === OP.ENDIF || ins.op === OP.ENDLOOP || ins.op === OP.ENDREP) depth--;
      if (ins.op === OP.LABEL) { const id = ins.src[0].index; const arr: Sm3Ins[] = []; subs.set(id, arr); cur = arr; continue; }
      if (ins.op === OP.RET && depth === 0) {
        if (cur === main) seenMainRet = true;
        if (cur !== main) { cur.push(ins); }
        continue;
      }
      cur.push(ins);
    }
    void seenMainRet;
    const emitBody = (list: Sm3Ins[], isMain: boolean) => {
      for (const ins of list) {
        if (ins.op === OP.RET) { this.w(isMain ? "// ret" : "return;"); continue; }
        this.inst(ins);
      }
    };
    const subTexts: string[] = [];
    for (const [id, list] of subs) {
      this.out = [];
      this.ind = 1;
      emitBody(list, false);
      subTexts.push(`fn sub_${id}() {\n${this.out.join("\n")}\n}`);
    }
    this.out = [];
    this.ind = 1;
    emitBody(main, true);
    const mainBody = this.out.join("\n");

    const inStruct = entryIn.length ? `struct In {\n${entryIn.filter((s) => !s.startsWith("@builtin")).map((s) => "  " + s + ",").join("\n")}\n};` : "";
    const outStruct = `struct Out {\n${isVs ? "  @builtin(position) pos: vec4<f32>,\n" : ""}${entryOut.map((s) => "  " + s + ",").join("\n")}\n};`;
    const builtinsIn = entryIn.filter((s) => s.startsWith("@builtin")).join(", ");
    // WGSL: a struct mixing @location and @builtin members is legal, so keep one struct for simplicity
    const fullIn = entryIn.length ? `struct In {\n${entryIn.map((s) => "  " + s + ",").join("\n")}\n};` : "";
    void inStruct; void builtinsIn;
    const defs: string[] = [];
    // (def constants are inlined at use sites)
    let ent: string;
    if (isVs) {
      ent = `@vertex fn main(${entryIn.length ? "in: In" : ""}) -> Out {\n  var out: Out;\n${prologue.map((l) => "  " + l).join("\n")}\n${mainBody}\n${epilogue.map((l) => "  " + l).join("\n")}\n  var p = oPos;\n${link.halfPixel ? "  p.x = p.x + p.w * prm.vpInv.x;\n  p.y = p.y - p.w * prm.vpInv.y;\n" : ""}  out.pos = p;\n  return out;\n}`;
    } else {
      ent = `@fragment fn main(${entryIn.length ? "in: In" : ""}) -> Out {\n  var out: Out;\n${prologue.map((l) => "  " + l).join("\n")}\n${mainBody}\n${epilogue.map((l) => "  " + l).join("\n")}\n  return out;\n}`;
    }
    const wgsl = [head.join("\n"), priv.join("\n"), helpers.join("\n"), subTexts.join("\n"), fullIn, outStruct, ent, defs.join("\n")].filter(Boolean).join("\n") + "\n";
    return { wgsl, vsOutputs: this.vsOutputs, psInputs: this.psInputs };
  }
}
