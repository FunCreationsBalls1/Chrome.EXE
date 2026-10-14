// Direct3D 9 draw engine: turns the device state machine into WebGPU pipelines, bind groups and draw calls.
import { D3DRS, D3DPT, D3DCMP, D3DBLEND } from "./d3d9-consts.ts";
import { emitSm3, semKey, USAGE, R } from "./sm3.ts";
import type { Sm3Link, Sm3Shader } from "./sm3.ts";
import { BaseTexture9, CubeTexture9, Surface9, VolumeTexture9, declFormat, declTypeSize } from "./d3d9-res.ts";
import type { DeclElement } from "./d3d9-res.ts";
import type { Device9 } from "./d3d9-dev.ts";
import { ffpPixel, ffpVertex, FFP_UNIFORM_BYTES } from "./d3d9-ffp.ts";
import type { FfpStage } from "./d3d9-ffp.ts";

export const CONST_BLOCK_BYTES = 4672;
export const PARAM_BYTES = 80;

interface InputDecl { loc: number; usage: number; usageIndex: number }
interface SemanticId { usage: number; usageIndex: number }

/** A vertex or pixel stage ready to be linked: either a translated D3D shader or a generated fixed-function stage. */
interface Stage {
  key: string;
  stage: "vs" | "ps";
  /** vertex shader inputs by register; pixel shader inputs (varyings) as semantics */
  inputs: InputDecl[];
  varyingsIn: SemanticId[];
  /** sampler register -> dimension */
  samplers: Map<number, "2d" | "cube" | "3d">;
  colorOuts: number;
  emit(link: Sm3Link): { wgsl: string; vsOutputs: number[]; psInputs: number[] };
  shader: Sm3Shader | null;
}

const TOPO: Record<number, GPUPrimitiveTopology> = {
  [D3DPT.POINTLIST]: "point-list", [D3DPT.LINELIST]: "line-list", [D3DPT.LINESTRIP]: "line-strip", [D3DPT.TRIANGLELIST]: "triangle-list", [D3DPT.TRIANGLESTRIP]: "triangle-strip", [D3DPT.TRIANGLEFAN]: "triangle-list",
};
const CMPF: Record<number, GPUCompareFunction> = {
  [D3DCMP.NEVER]: "never", [D3DCMP.LESS]: "less", [D3DCMP.EQUAL]: "equal", [D3DCMP.LESSEQUAL]: "less-equal", [D3DCMP.GREATER]: "greater", [D3DCMP.NOTEQUAL]: "not-equal", [D3DCMP.GREATEREQUAL]: "greater-equal", [D3DCMP.ALWAYS]: "always",
};
const STENCILOP: Record<number, GPUStencilOperation> = { 1: "keep", 2: "zero", 3: "replace", 4: "increment-clamp", 5: "decrement-clamp", 6: "invert", 7: "increment-wrap", 8: "decrement-wrap" };
const BLENDF: Record<number, GPUBlendFactor> = {
  [D3DBLEND.ZERO]: "zero", [D3DBLEND.ONE]: "one", [D3DBLEND.SRCCOLOR]: "src", [D3DBLEND.INVSRCCOLOR]: "one-minus-src", [D3DBLEND.SRCALPHA]: "src-alpha", [D3DBLEND.INVSRCALPHA]: "one-minus-src-alpha",
  [D3DBLEND.DESTALPHA]: "dst-alpha", [D3DBLEND.INVDESTALPHA]: "one-minus-dst-alpha", [D3DBLEND.DESTCOLOR]: "dst", [D3DBLEND.INVDESTCOLOR]: "one-minus-dst", [D3DBLEND.SRCALPHASAT]: "src-alpha-saturated",
  [D3DBLEND.BLENDFACTOR]: "constant", [D3DBLEND.INVBLENDFACTOR]: "one-minus-constant",
};
const BLENDOP: Record<number, GPUBlendOperation> = { 1: "add", 2: "subtract", 3: "reverse-subtract", 4: "min", 5: "max" };

let nextViewId = 1;
const viewIds = new WeakMap<object, number>();
const idOf = (o: object): number => { let v = viewIds.get(o); if (!v) viewIds.set(o, (v = nextViewId++)); return v; };

export class DrawEngine9 {
  dev: Device9;
  private modules = new Map<string, GPUShaderModule>();
  private pipelines = new Map<string, GPURenderPipeline>();
  private bgl0 = new Map<boolean, GPUBindGroupLayout>();
  private bg0 = new Map<boolean, GPUBindGroup>();
  private layoutCache = new Map<string, GPUBindGroupLayout>();
  private pipeLayoutCache = new Map<string, GPUPipelineLayout>();
  private bindGroupCache = new Map<string, GPUBindGroup>();
  private samplerCache = new Map<string, GPUSampler>();
  private linkCache = new Map<string, { vs: { wgsl: string; vsOutputs: number[] }; ps: { wgsl: string }; slots: Map<number, number> }>();
  private dummyTex = new Map<string, GPUTexture>();
  private zeroBuf: GPUBuffer | null = null;
  private fanIndex: { u16: Uint16Array; u32: Uint32Array } | null = null;
  private fanBuf: GPUBuffer | null = null;
  private fanBufCount = 0;
  // uniform offsets reused while the data is unchanged
  private ringGen = -1;
  vsOff = -1; psOff = -1; prmOff = -1; ffpOff = -1;
  vsDirty = true; psDirty = true; prmDirty = true; ffpDirty = true;
  private constBytes = new ArrayBuffer(CONST_BLOCK_BYTES);

  constructor(dev: Device9) {
    this.dev = dev;
  }

  private get gpu() { return this.dev.gpu; }
  private get device() { return this.dev.gpu.device; }

  // ------------------------------------------------------------------------------------------------------------------
  // stage construction
  // ------------------------------------------------------------------------------------------------------------------
  private vertexStage(): Stage | null {
    const d = this.dev;
    if (d.vs) {
      const sh = d.vs.parsed;
      if (!sh) return null;
      return {
        key: "v" + d.vs.uid, stage: "vs", inputs: sh.inputs.map((i) => ({ loc: i.reg, usage: i.usage, usageIndex: i.usageIndex })), varyingsIn: [], samplers: new Map([...sh.samplers.keys()].map((k) => [k, sh.samplers.get(k) === 3 ? "cube" : sh.samplers.get(k) === 4 ? "3d" : "2d"] as [number, "2d" | "cube" | "3d"])),
        colorOuts: 0, shader: sh, emit: (link) => emitSm3(sh, link),
      };
    }
    const g = ffpVertex(d.ffpVertexState());
    return { key: "f" + g.key, stage: "vs", inputs: g.inputs, varyingsIn: [], samplers: new Map(), colorOuts: 0, shader: null, emit: (link) => g.emit(link) };
  }
  private pixelStage(vsOutputs: SemanticId[]): Stage | null {
    const d = this.dev;
    if (d.ps) {
      const sh = d.ps.parsed;
      if (!sh) return null;
      const samplers = new Map<number, "2d" | "cube" | "3d">();
      for (const [k, t] of sh.samplers) samplers.set(k, t === 3 ? "cube" : t === 4 ? "3d" : "2d");
      // implicit samplers of legacy shaders follow the bound textures
      for (let s = 0; s < 16; s++) if (!samplers.has(s) && sh.major === 1) { const t = d.tex[s]; samplers.set(s, t instanceof CubeTexture9 ? "cube" : t instanceof VolumeTexture9 ? "3d" : "2d"); }
      return {
        key: "p" + d.ps.uid, stage: "ps", inputs: [], varyingsIn: sh.inputs.map((i) => ({ usage: i.usage, usageIndex: i.usageIndex })), samplers,
        colorOuts: sh.colorOuts.length ? Math.max(...sh.colorOuts) + 1 : 1, shader: sh, emit: (link) => emitSm3(sh, link),
      };
    }
    const stages = d.ffpStages();
    const g = ffpPixel(stages, d.ffpPixelState(), vsOutputs);
    return { key: "q" + g.key, stage: "ps", inputs: [], varyingsIn: g.varyings, samplers: g.samplers, colorOuts: 1, shader: null, emit: (link) => g.emit(link) };
  }

  /** the semantics a vertex stage writes */
  private vertexOutputs(vs: Stage): SemanticId[] {
    if (vs.shader) return vs.shader.outputs.filter((o) => o.type !== R.RASTOUT).map((o) => ({ usage: o.usage, usageIndex: o.usageIndex }));
    const g = ffpVertex(this.dev.ffpVertexState());
    return g.outputs;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // samplers and textures
  // ------------------------------------------------------------------------------------------------------------------
  private samplerFor(idx: number, filterable: boolean, tex: BaseTexture9 | null): GPUSampler {
    const d = this.dev;
    const ss = (t: number) => d.samplerState[idx * 16 + t];
    const addr = (v: number): GPUAddressMode => (v === 2 || v === 5 ? "mirror-repeat" : v === 1 ? "repeat" : "clamp-to-edge");
    let mag = ss(5), min = ss(6), mip = ss(7);
    const aniso = mag === 3 || min === 3 ? Math.max(1, Math.min(16, ss(10))) : 1;
    const lin = (v: number) => (v === 2 || v === 3 || v === 6 || v === 7) && filterable;
    const magL = lin(mag), minL = lin(min), mipL = lin(mip) && (tex?.levels ?? 1) > 1;
    const useMips = mip !== 0 && (tex?.levels ?? 1) > 1;
    const maxMip = ss(9);
    const key = `${addr(ss(1))}${addr(ss(2))}${addr(ss(3))}${magL}${minL}${mipL}${aniso}${useMips}${maxMip}`;
    let s = this.samplerCache.get(key);
    if (!s) {
      const an = aniso > 1 && magL && minL && mipL ? aniso : 1;
      s = this.device.createSampler({
        addressModeU: addr(ss(1)), addressModeV: addr(ss(2)), addressModeW: addr(ss(3)), magFilter: magL ? "linear" : "nearest", minFilter: minL ? "linear" : "nearest",
        mipmapFilter: mipL ? "linear" : "nearest", maxAnisotropy: an, lodMinClamp: Math.min(maxMip, 15), lodMaxClamp: useMips ? 32 : 0,
      });
      this.samplerCache.set(key, s);
    }
    return s;
  }
  private dummyFor(dim: "2d" | "cube" | "3d"): GPUTextureView {
    let t = this.dummyTex.get(dim);
    if (!t) {
      const layers = dim === "cube" ? 6 : 1;
      t = this.device.createTexture({ size: dim === "3d" ? [1, 1, 1] : [1, 1, layers], dimension: dim === "3d" ? "3d" : "2d", format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.gpu.queue.writeTexture({ texture: t }, new Uint8Array(4 * layers).map((_, i) => (i % 4 === 3 ? 255 : 0)), { bytesPerRow: 4, rowsPerImage: 1 }, dim === "3d" ? [1, 1, 1] : [1, 1, layers]);
      this.dummyTex.set(dim, t);
    }
    return t.createView({ dimension: dim === "cube" ? "cube" : dim === "3d" ? "3d" : "2d" });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // vertex layout
  // ------------------------------------------------------------------------------------------------------------------
  private currentElements(): DeclElement[] {
    const d = this.dev;
    return d.decl ? d.decl.elements : d.fvfElements;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // main entry
  // ------------------------------------------------------------------------------------------------------------------
  drawPrimitive(prim: number, primCount: number, a: { indexed: boolean; start: number; baseVertex: number; minIndex: number; numVertices: number; up?: { vertex: Uint8Array; stride: number; index?: Uint8Array; index32?: boolean } }): boolean {
    const d = this.dev;
    const gpu = this.gpu;
    if (primCount <= 0) return true;
    if (d.rtSurf[0] === null && d.dsSurf === null) return true;
    // programmable stages
    if (d.vs && !d.vs.parsed) return true;
    if (d.ps && !d.ps.parsed) return true;
    const vs = this.vertexStage();
    if (!vs) return true;
    const vsOuts = this.vertexOutputs(vs);
    const ps = this.pixelStage(vsOuts);
    if (!ps) return true;

    // ---- vertex layout ----
    const elements = this.currentElements();
    if (!elements.length && !d.vs) return true;
    const used = new Map<number, number>(); // stream -> buffer slot
    const bufLayouts: GPUVertexBufferLayout[] = [];
    const bindings: { stream: number; slot: number }[] = [];
    const kinds = new Map<number, string>();
    let layoutKey = "";
    const attrsBySlot: GPUVertexAttribute[][] = [];
    const missing: InputDecl[] = [];
    for (const inp of vs.inputs) {
      const el = elements.find((e) => (e.usage === inp.usage || (inp.usage === USAGE.POSITION && e.usage === USAGE.POSITIONT)) && e.usageIndex === inp.usageIndex);
      if (!el) { missing.push(inp); kinds.set(inp.loc, "f"); continue; }
      let slot = used.get(el.stream);
      if (slot === undefined) {
        slot = bufLayouts.length;
        used.set(el.stream, slot);
        const sv = d.streams[el.stream];
        let stride = d.upStride >= 0 && el.stream === 0 ? d.upStride : sv?.stride ?? 0;
        if (!stride) stride = (d.decl?.streamEnd.get(el.stream) ?? 0) || 0;
        bufLayouts.push({ arrayStride: stride, stepMode: d.streamFreq[el.stream] & 0x80000000 ? "instance" : "vertex", attributes: [] });
        attrsBySlot.push(bufLayouts[slot].attributes as GPUVertexAttribute[]);
        bindings.push({ stream: el.stream, slot });
      }
      const f = declFormat(el.type);
      kinds.set(inp.loc, f.kind);
      (bufLayouts[slot].attributes as GPUVertexAttribute[]).push({ shaderLocation: inp.loc, offset: el.offset, format: f.fmt });
    }
    if (missing.length) {
      const slot = bufLayouts.length;
      bufLayouts.push({ arrayStride: 0, stepMode: "vertex", attributes: missing.map((m) => ({ shaderLocation: m.loc, offset: 0, format: "float32x4" as GPUVertexFormat })) });
      bindings.push({ stream: -1, slot });
    }
    layoutKey = bufLayouts.map((b) => `${b.arrayStride}${b.stepMode}[${(b.attributes as GPUVertexAttribute[]).map((x) => `${x.shaderLocation}:${x.offset}:${x.format}`).join(",")}]`).join("|");

    // ---- link ----
    const linkKey = vs.key + "|" + ps.key + "|" + [...kinds].map(([k, v]) => k + v).join("") + "|" + this.stateKeyForShaders(ps);
    let lk = this.linkCache.get(linkKey);
    if (!lk) {
      const slots = new Map<number, number>();
      for (const v of ps.varyingsIn) { const k = semKey(v.usage, v.usageIndex); if (!slots.has(k)) slots.set(k, slots.size); }
      const samplerDims = new Map<number, string>();
      for (const [k, v] of ps.samplers) samplerDims.set(k, v);
      const alphaFunc = d.renderState[D3DRS.ALPHATESTENABLE] && !(ps.shader && ps.shader.major >= 3 && false) ? d.renderState[D3DRS.ALPHAFUNC] : 0;
      const depthSamplers = new Set<number>();
      const plink: Sm3Link = { stage: "ps", slots, samplerDims, alphaFunc, colorTargets: this.colorTargetCount(ps.colorOuts), depthSamplers };
      const pOut = ps.emit(plink);
      const vlink: Sm3Link = { stage: "vs", slots, inputKinds: kinds, halfPixel: true, samplerDims: new Map([...vs.samplers].map(([k, v]) => [k, v as string])) };
      let vOut = vs.emit(vlink);
      const extra = pOut.psInputs.filter((s) => !vOut.vsOutputs.includes(s));
      if (extra.length) vOut = vs.emit({ ...vlink, extraSlots: extra });
      lk = { vs: vOut, ps: pOut, slots };
      this.linkCache.set(linkKey, lk);
    }

    // ---- targets ----
    const rts = d.rtSurf.filter((s): s is Surface9 => s !== null);
    const ds = d.dsSurf;
    const nTargets = Math.max(1, Math.min(rts.length, this.colorTargetCount(ps.colorOuts)));
    const srgbWrite = d.renderState[D3DRS.SRGBWRITEENABLE] !== 0;

    // ---- texture signature and bind group layouts ----
    const psSig: string[] = [], vsSig: string[] = [];
    const psTex: { idx: number; tex: BaseTexture9 | null }[] = [], vsTex: { idx: number; tex: BaseTexture9 | null }[] = [];
    const stageSig = (samplers: Map<number, string>, base: number, sig: string[], list: { idx: number; tex: BaseTexture9 | null }[], isVs: boolean) => {
      for (const [idx, dim] of [...samplers].sort((a, b) => a[0] - b[0])) {
        const si = base + idx;
        const t = d.tex[si] ?? null;
        const okDim = t && t.dim === dim ? t : null;
        const f = okDim ? okDim.fmt : null;
        const filterable = !!f && (f.filterable !== false) && !f.depth && !(f.gpu.includes("32float") && !gpu.hasFloat32Filterable);
        sig.push(`${idx}:${dim}:${okDim ? (f!.depth ? "d" : filterable ? "f" : "u") : "f"}`);
        list.push({ idx, tex: okDim });
      }
      void isVs;
    };
    stageSig(ps.samplers, 0, psSig, psTex, false);
    stageSig(vs.samplers, 16, vsSig, vsTex, true);

    // ---- pipeline ----
    const rs = d.renderState;
    const topology = TOPO[prim] ?? "triangle-list";
    const indexed = a.indexed || prim === D3DPT.TRIANGLEFAN;
    const cull = rs[D3DRS.CULLMODE];
    const depthFmt = ds ? ds.fmt.gpu : null;
    const depthKey = ds ? `${depthFmt}|${rs[D3DRS.ZENABLE]}${rs[D3DRS.ZWRITEENABLE]}${rs[D3DRS.ZFUNC]}|${rs[D3DRS.STENCILENABLE]}${rs[D3DRS.STENCILFUNC]}${rs[D3DRS.STENCILFAIL]}${rs[D3DRS.STENCILZFAIL]}${rs[D3DRS.STENCILPASS]}${rs[D3DRS.STENCILMASK]}${rs[D3DRS.STENCILWRITEMASK]}${rs[D3DRS.TWOSIDEDSTENCILMODE]}${rs[D3DRS.CCW_STENCILFUNC]}${rs[D3DRS.CCW_STENCILFAIL]}${rs[D3DRS.CCW_STENCILZFAIL]}${rs[D3DRS.CCW_STENCILPASS]}|${rs[D3DRS.DEPTHBIAS]}${rs[D3DRS.SLOPESCALEDEPTHBIAS]}` : "nods";
    const blendKey = `${rs[D3DRS.ALPHABLENDENABLE]}${rs[D3DRS.SRCBLEND]}${rs[D3DRS.DESTBLEND]}${rs[D3DRS.BLENDOP]}${rs[D3DRS.SEPARATEALPHABLENDENABLE]}${rs[D3DRS.SRCBLENDALPHA]}${rs[D3DRS.DESTBLENDALPHA]}${rs[D3DRS.BLENDOPALPHA]}`;
    const wmKey = `${rs[D3DRS.COLORWRITEENABLE]},${rs[D3DRS.COLORWRITEENABLE1]},${rs[D3DRS.COLORWRITEENABLE2]},${rs[D3DRS.COLORWRITEENABLE3]}`;
    const tfmts = rts.slice(0, nTargets).map((s) => (srgbWrite && s.fmt.srgb ? s.fmt.srgb : s.fmt.gpu)).join(",");
    const stripFmt = (topology === "triangle-strip" || topology === "line-strip") && indexed ? (a.up ? (a.up.index32 ? "u32" : "u16") : d.ib && d.ib.format === 102 ? "u32" : "u16") : "";
    const pkey = [linkKey, layoutKey, topology, stripFmt, cull, depthKey, blendKey, wmKey, tfmts, psSig.join(";"), vsSig.join(";"), d.ffpActive() ? "F" : ""].join("#");
    let pipeline = this.pipelines.get(pkey);
    const ffp = !d.vs || !d.ps;
    if (!pipeline) {
      const vmod = this.module("v|" + linkKey, lk.vs.wgsl);
      const pmod = this.module("p|" + linkKey, lk.ps.wgsl);
      const bgl0 = this.group0Layout(ffp);
      const bgl1 = this.texLayout(psSig, "ps");
      const bgl2 = this.texLayout(vsSig, "vs");
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bgl2] });
      const targets: (GPUColorTargetState | null)[] = [];
      for (let i = 0; i < nTargets; i++) {
        const s = rts[i];
        const fmt = srgbWrite && s.fmt.srgb ? s.fmt.srgb : s.fmt.gpu;
        const wm = [rs[D3DRS.COLORWRITEENABLE], rs[D3DRS.COLORWRITEENABLE1], rs[D3DRS.COLORWRITEENABLE2], rs[D3DRS.COLORWRITEENABLE3]][i] & 0xf;
        const blendable = !(/32float$/.test(fmt) && !gpu.hasFloat32Blendable);
        targets.push({ format: fmt, writeMask: wm, blend: rs[D3DRS.ALPHABLENDENABLE] && blendable ? this.blendState() : undefined });
      }
      const desc: GPURenderPipelineDescriptor = {
        layout,
        vertex: { module: vmod, entryPoint: "main", buffers: bufLayouts },
        fragment: { module: pmod, entryPoint: "main", targets },
        primitive: { topology, frontFace: "cw", cullMode: cull === 2 ? "front" : cull === 3 ? "back" : "none", ...(stripFmt ? { stripIndexFormat: stripFmt === "u32" ? "uint32" : "uint16" } : {}) },
        label: "d3d9 " + linkKey.slice(0, 40),
      };
      if (ds) desc.depthStencil = this.depthState(ds);
      pipeline = this.device.createRenderPipeline(desc);
      this.pipelines.set(pkey, pipeline);
      gpu.stats.pipelines++;
    }

    // ---- render pass ----
    const first = rts[0] ?? null;
    const w = first ? first.w : ds!.w, h = first ? first.h : ds!.h;
    const colors = rts.slice(0, nTargets).map((s) => ({ view: s.view(srgbWrite), tex: s.tex!, format: s.fmt.gpu }));
    // the render pass must cover every bound RT even when the shader writes fewer outputs
    const allColors = rts.map((s) => ({ view: s.view(srgbWrite), tex: s.tex!, format: s.fmt.gpu }));
    void colors;
    const target = { colors: allColors.slice(0, nTargets), depth: ds ? { view: ds.view(), tex: ds.tex!, format: ds.fmt.gpu } : null, width: w, height: h, samples: 1 };
    const pkeyPass = allColors.slice(0, nTargets).map((c) => idOf(c.view)).join(",") + "/" + (ds ? idOf(ds.view()) : "-");
    gpu.reserve(CONST_BLOCK_BYTES * 2 + FFP_UNIFORM_BYTES + 1024, (a.up ? a.up.vertex.byteLength + (a.up.index?.byteLength ?? 0) : 0) + (prim === D3DPT.TRIANGLEFAN ? primCount * 12 + 64 : 0) + (a.indexed && !a.up ? 0 : 0));
    const pass = gpu.renderPass(target, pkeyPass);
    for (const s of rts) { s.gpuDirty = true; s.usedGen = gpu.stats.submits; }
    if (ds) { ds.gpuDirty = true; ds.usedGen = gpu.stats.submits; }

    pass.setPipeline(pipeline);
    // ---- uniforms ----
    if (this.ringGen !== gpu.ringEpoch) { this.ringGen = gpu.ringEpoch; this.vsOff = this.psOff = this.prmOff = this.ffpOff = -1; }
    if (this.vsOff < 0 || this.vsDirty) { this.vsOff = gpu.pushUniform(new Uint8Array(this.packConsts(d.vsF, d.vsI, d.vsB, null))); this.vsDirty = false; }
    if (this.psOff < 0 || this.psDirty) { this.psOff = gpu.pushUniform(new Uint8Array(this.packConsts(d.psF, d.psI, d.psB, d.bumpEnv))); this.psDirty = false; }
    const vp = d.viewport;
    const params = new Float32Array(PARAM_BYTES / 4);
    params[0] = 1 / Math.max(vp.w, 1); params[1] = 1 / Math.max(vp.h, 1);
    params[4] = (rs[D3DRS.ALPHAREF] & 0xff) / 255;
    const fc = rs[D3DRS.FOGCOLOR];
    params[8] = ((fc >> 16) & 255) / 255; params[9] = ((fc >> 8) & 255) / 255; params[10] = (fc & 255) / 255; params[11] = 1;
    const f32v = new Float32Array(new Uint32Array([rs[D3DRS.FOGSTART], rs[D3DRS.FOGEND], rs[D3DRS.FOGDENSITY]]).buffer);
    params[12] = f32v[0]; params[13] = f32v[1]; params[14] = f32v[2]; params[15] = rs[D3DRS.FOGTABLEMODE] || rs[D3DRS.FOGVERTEXMODE];
    params[16] = vp.w; params[17] = vp.h; params[18] = vp.x; params[19] = vp.y;
    this.prmOff = gpu.pushUniform(params);
    const dyn: number[] = [this.vsOff, this.psOff, this.prmOff];
    if (ffp) { if (this.ffpOff < 0 || this.ffpDirty) { this.ffpOff = gpu.pushUniform(d.ffpUniformData()); this.ffpDirty = false; } dyn.push(this.ffpOff); }
    pass.setBindGroup(0, this.group0(ffp), dyn);

    // ---- textures ----
    pass.setBindGroup(1, this.texGroup(psSig, psTex, 0, this.pipelineLayoutOf(pipeline, 1, psSig, "ps")));
    pass.setBindGroup(2, this.texGroup(vsSig, vsTex, 16, this.pipelineLayoutOf(pipeline, 2, vsSig, "vs")));

    // ---- viewport, scissor, blend constant, stencil ref ----
    const vx = Math.max(0, vp.x), vy = Math.max(0, vp.y);
    const vw = Math.max(1, Math.min(vp.w, w - vx)), vh = Math.max(1, Math.min(vp.h, h - vy));
    pass.setViewport(vx, vy, vw, vh, Math.min(Math.max(vp.minZ, 0), 1), Math.min(Math.max(vp.maxZ, 0), 1));
    if (rs[D3DRS.SCISSORTESTENABLE]) {
      const sc = d.scissor;
      const x0 = Math.max(0, Math.min(sc.l, w)), y0 = Math.max(0, Math.min(sc.t, h)), x1 = Math.max(x0, Math.min(sc.r, w)), y1 = Math.max(y0, Math.min(sc.b, h));
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    } else pass.setScissorRect(0, 0, w, h);
    const bf = rs[D3DRS.BLENDFACTOR];
    pass.setBlendConstant({ r: ((bf >> 16) & 255) / 255, g: ((bf >> 8) & 255) / 255, b: (bf & 255) / 255, a: ((bf >> 24) & 255) / 255 });
    if (ds && rs[D3DRS.STENCILENABLE]) pass.setStencilReference(rs[D3DRS.STENCILREF] & 0xff);

    // ---- vertex / index buffers ----
    let vertexBase = 0;
    for (const b of bindings) {
      if (b.stream === -1) { pass.setVertexBuffer(b.slot, this.zeroBuffer()); continue; }
      if (a.up && b.stream === 0) {
        const off = gpu.pushTransient(a.up.vertex, 4);
        pass.setVertexBuffer(b.slot, gpu.transientRing, off);
        if (a.indexed) vertexBase = 0;
        continue;
      }
      const sv = d.streams[b.stream];
      if (!sv || !sv.vb) { pass.setVertexBuffer(b.slot, this.zeroBuffer()); continue; }
      pass.setVertexBuffer(b.slot, sv.vb.gpu!, sv.offset);
      sv.vb.usedGen = gpu.stats.submits;
    }
    // ---- draw ----
    let instanceCount = 1;
    const f0 = d.streamFreq[0];
    if (f0 & 0x40000000) instanceCount = f0 & 0x3fffffff || 1;
    if (!(f0 & 0x40000000) && !(f0 & 0x80000000) && f0 > 1) instanceCount = f0;
    const nverts = vertexCount(prim, primCount);
    gpu.stats.draws++;
    if (prim === D3DPT.TRIANGLEFAN) {
      // triangle fans are not a WebGPU topology: draw an index list (0,i,i+1)
      let idxData: Uint32Array | Uint16Array | null = null;
      if (a.indexed) { const src = this.indexSource(a); idxData = fanFromIndices(src.data, src.is32, primCount, a.start); }
      else idxData = fanIndices(primCount, a.start);
      const is32 = idxData instanceof Uint32Array;
      const off = gpu.pushTransient(idxData, 4);
      pass.setIndexBuffer(gpu.transientRing, is32 ? "uint32" : "uint16", off);
      pass.drawIndexed(primCount * 3, instanceCount, 0, a.baseVertex, 0);
      return true;
    }
    if (a.indexed) {
      const src = this.indexSource(a);
      if (src.gpu) { pass.setIndexBuffer(src.gpu, src.is32 ? "uint32" : "uint16", src.offset); src.owner && (src.owner.usedGen = gpu.stats.submits); }
      else { const off = gpu.pushTransient(src.data, 4); pass.setIndexBuffer(gpu.transientRing, src.is32 ? "uint32" : "uint16", off); }
      pass.drawIndexed(nverts, instanceCount, a.start, a.baseVertex, 0);
    } else {
      pass.draw(nverts, instanceCount, a.start + vertexBase, 0);
    }
    return true;
  }

  private indexSource(a: { start: number; up?: { index?: Uint8Array; index32?: boolean } }): { gpu: GPUBuffer | null; data: Uint8Array; is32: boolean; offset: number; owner: { usedGen: number } | null } {
    const d = this.dev;
    if (a.up && a.up.index) return { gpu: null, data: a.up.index, is32: !!a.up.index32, offset: 0, owner: null };
    const ib = d.ib!;
    const is32 = ib.format === 102;
    const mem = d.p.mem;
    return { gpu: ib.gpu, data: mem.bytes(ib.shadow, ib.size), is32, offset: 0, owner: ib };
  }

  private colorTargetCount(psOuts: number): number {
    const nrt = this.dev.rtSurf.filter((s) => s !== null).length;
    return Math.max(1, Math.min(psOuts, nrt || 1));
  }
  private stateKeyForShaders(ps: Stage): string {
    const d = this.dev;
    let k = "";
    if (d.renderState[D3DRS.ALPHATESTENABLE]) k += "A" + d.renderState[D3DRS.ALPHAFUNC];
    k += "T" + this.colorTargetCount(ps.colorOuts);
    // legacy pixel shaders pick sampler dimensions from the bound textures
    if (ps.shader && ps.shader.major === 1) for (let i = 0; i < 8; i++) k += d.tex[i] ? d.tex[i]!.dim[0] : "-";
    if (!d.ps || !d.vs) k += "F" + d.ffpKey();
    return k;
  }

  private module(key: string, code: string): GPUShaderModule {
    let m = this.modules.get(key);
    if (!m) {
      m = this.device.createShaderModule({ code, label: key.slice(0, 48) });
      this.modules.set(key, m);
      if (this.dev.debugShaders) this.dev.p.log(`[d3d9] WGSL ${key}:\n${code}`);
    }
    return m;
  }

  private blendState(): GPUBlendState {
    const rs = this.dev.renderState;
    const mapSrc = (v: number): GPUBlendFactor => (v === D3DBLEND.BOTHSRCALPHA ? "src-alpha" : v === D3DBLEND.BOTHINVSRCALPHA ? "one-minus-src-alpha" : BLENDF[v] ?? "one");
    const mapDst = (v: number): GPUBlendFactor => (v === D3DBLEND.BOTHSRCALPHA ? "one-minus-src-alpha" : v === D3DBLEND.BOTHINVSRCALPHA ? "src-alpha" : BLENDF[v] ?? "zero");
    const op = BLENDOP[rs[D3DRS.BLENDOP]] ?? "add";
    const color: GPUBlendComponent = { operation: op, srcFactor: mapSrc(rs[D3DRS.SRCBLEND]), dstFactor: mapDst(rs[D3DRS.DESTBLEND]) };
    let alpha = color;
    if (rs[D3DRS.SEPARATEALPHABLENDENABLE]) alpha = { operation: BLENDOP[rs[D3DRS.BLENDOPALPHA]] ?? "add", srcFactor: mapSrc(rs[D3DRS.SRCBLENDALPHA]), dstFactor: mapDst(rs[D3DRS.DESTBLENDALPHA]) };
    for (const c of [color, alpha]) if (c.operation === "min" || c.operation === "max") { c.srcFactor = "one"; c.dstFactor = "one"; }
    return { color, alpha };
  }
  private depthState(ds: Surface9): GPUDepthStencilState {
    const rs = this.dev.renderState;
    const f = ds.fmt.gpu;
    const hasDepth = /depth/.test(f), hasStencil = /stencil/.test(f);
    const zEnable = rs[D3DRS.ZENABLE] !== 0;
    const st = rs[D3DRS.STENCILENABLE] !== 0 && hasStencil;
    const front: GPUStencilFaceState = st ? { compare: CMPF[rs[D3DRS.STENCILFUNC]] ?? "always", failOp: STENCILOP[rs[D3DRS.STENCILFAIL]] ?? "keep", depthFailOp: STENCILOP[rs[D3DRS.STENCILZFAIL]] ?? "keep", passOp: STENCILOP[rs[D3DRS.STENCILPASS]] ?? "keep" } : {};
    const back: GPUStencilFaceState = st ? (rs[D3DRS.TWOSIDEDSTENCILMODE] ? { compare: CMPF[rs[D3DRS.CCW_STENCILFUNC]] ?? "always", failOp: STENCILOP[rs[D3DRS.CCW_STENCILFAIL]] ?? "keep", depthFailOp: STENCILOP[rs[D3DRS.CCW_STENCILZFAIL]] ?? "keep", passOp: STENCILOP[rs[D3DRS.CCW_STENCILPASS]] ?? "keep" } : front) : {};
    const unorm = /unorm|24/.test(f);
    const biasF = new Float32Array(new Uint32Array([rs[D3DRS.DEPTHBIAS], rs[D3DRS.SLOPESCALEDEPTHBIAS]]).buffer);
    const bias = biasF[0] ? Math.round(biasF[0] * (unorm ? (f === "depth16unorm" ? 65535 : 16777215) : 8388608)) : 0;
    const out: GPUDepthStencilState = {
      format: f, depthWriteEnabled: hasDepth ? (zEnable && rs[D3DRS.ZWRITEENABLE] !== 0) : undefined, depthCompare: hasDepth ? (zEnable ? CMPF[rs[D3DRS.ZFUNC]] ?? "less-equal" : "always") : undefined,
      depthBias: bias, depthBiasSlopeScale: biasF[1], depthBiasClamp: 0,
    };
    if (st) { out.stencilFront = front; out.stencilBack = back; out.stencilReadMask = rs[D3DRS.STENCILMASK] & 0xff; out.stencilWriteMask = rs[D3DRS.STENCILWRITEMASK] & 0xff; }
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // bind groups
  // ------------------------------------------------------------------------------------------------------------------
  private group0Layout(ffp: boolean): GPUBindGroupLayout {
    let l = this.bgl0.get(ffp);
    if (!l) {
      const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: V, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: CONST_BLOCK_BYTES } },
        { binding: 1, visibility: F, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: CONST_BLOCK_BYTES } },
        { binding: 2, visibility: V | F, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: PARAM_BYTES } },
      ];
      if (ffp) entries.push({ binding: 3, visibility: V | F, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: FFP_UNIFORM_BYTES } });
      l = this.device.createBindGroupLayout({ entries });
      this.bgl0.set(ffp, l);
    }
    return l;
  }
  private group0(ffp: boolean): GPUBindGroup {
    let g = this.bg0.get(ffp);
    if (!g) {
      const ring = this.gpu.uniformRing;
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: ring, size: CONST_BLOCK_BYTES } },
        { binding: 1, resource: { buffer: ring, size: CONST_BLOCK_BYTES } },
        { binding: 2, resource: { buffer: ring, size: PARAM_BYTES } },
      ];
      if (ffp) entries.push({ binding: 3, resource: { buffer: ring, size: FFP_UNIFORM_BYTES } });
      g = this.device.createBindGroup({ layout: this.group0Layout(ffp), entries });
      this.bg0.set(ffp, g);
    }
    return g;
  }
  private texLayout(sig: string[], stage: "vs" | "ps"): GPUBindGroupLayout {
    const key = stage + sig.join(";");
    let l = this.layoutCache.get(key);
    if (!l) {
      const vis = stage === "vs" ? GPUShaderStage.VERTEX : GPUShaderStage.FRAGMENT;
      const entries: GPUBindGroupLayoutEntry[] = [];
      for (const s of sig) {
        const [idx, dim, kind] = s.split(":");
        const i = Number(idx);
        const viewDimension: GPUTextureViewDimension = dim === "cube" ? "cube" : dim === "3d" ? "3d" : "2d";
        entries.push({ binding: i * 2, visibility: vis, texture: { sampleType: kind === "f" ? "float" : "unfilterable-float", viewDimension } });
        entries.push({ binding: i * 2 + 1, visibility: vis, sampler: { type: kind === "f" ? "filtering" : "non-filtering" } });
      }
      l = this.device.createBindGroupLayout({ entries });
      this.layoutCache.set(key, l);
    }
    return l;
  }
  private pipelineLayoutOf(_p: GPURenderPipeline, _group: number, sig: string[], stage: "vs" | "ps"): GPUBindGroupLayout {
    return this.texLayout(sig, stage);
  }
  private texGroup(sig: string[], list: { idx: number; tex: BaseTexture9 | null }[], base: number, layout: GPUBindGroupLayout): GPUBindGroup {
    const d = this.dev;
    const entries: GPUBindGroupEntry[] = [];
    let key = idOf(layout) + ":";
    for (let i = 0; i < list.length; i++) {
      const { idx, tex } = list[i];
      const dim = sig[i].split(":")[1] as "2d" | "cube" | "3d";
      const kind = sig[i].split(":")[2];
      const si = base + idx;
      const srgb = d.samplerState[si * 16 + 11] !== 0;
      let view: GPUTextureView;
      if (tex && tex.tex) { view = tex.viewFor(srgb); tex.usedGen = this.gpu.stats.submits; for (const s of tex.surfaces) if (s) s.usedGen = this.gpu.stats.submits; }
      else view = this.dummyFor(dim);
      const sampler = this.samplerFor(si, kind === "f", tex);
      key += `${idOf(view)}.${idOf(sampler)},`;
      entries.push({ binding: idx * 2, resource: view }, { binding: idx * 2 + 1, resource: sampler });
    }
    let g = this.bindGroupCache.get(key);
    if (!g) {
      g = this.device.createBindGroup({ layout, entries });
      if (this.bindGroupCache.size > 4000) this.bindGroupCache.clear();
      this.bindGroupCache.set(key, g);
    }
    return g;
  }
  private zeroBuffer(): GPUBuffer {
    if (!this.zeroBuf) {
      this.zeroBuf = this.gpu.createBuffer(16, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, "zero vertex data");
      this.gpu.queue.writeBuffer(this.zeroBuf, 0, new Float32Array([0, 0, 0, 1]));
    }
    return this.zeroBuf;
  }

  private packConsts(f: Float32Array, i: Int32Array, b: Uint32Array, bem: Float32Array | null): ArrayBuffer {
    const buf = new ArrayBuffer(CONST_BLOCK_BYTES);
    new Float32Array(buf, 0, 1024).set(f);
    new Int32Array(buf, 4096, 64).set(i);
    new Uint32Array(buf, 4352, 16).set(b);
    if (bem) new Float32Array(buf, 4416, 64).set(bem.subarray(0, 64));
    return buf;
  }
}

export function vertexCount(prim: number, n: number): number {
  switch (prim) {
    case D3DPT.POINTLIST: return n;
    case D3DPT.LINELIST: return n * 2;
    case D3DPT.LINESTRIP: return n + 1;
    case D3DPT.TRIANGLELIST: return n * 3;
    case D3DPT.TRIANGLESTRIP: case D3DPT.TRIANGLEFAN: return n + 2;
    default: return n;
  }
}
function fanIndices(primCount: number, start: number): Uint16Array | Uint32Array {
  const n = primCount * 3;
  const big = start + primCount + 2 > 65535;
  const out = big ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < primCount; i++) { out[i * 3] = start; out[i * 3 + 1] = start + i + 1; out[i * 3 + 2] = start + i + 2; }
  return out;
}
function fanFromIndices(data: Uint8Array, is32: boolean, primCount: number, startIndex: number): Uint16Array | Uint32Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const get = (i: number) => (is32 ? dv.getUint32((startIndex + i) * 4, true) : dv.getUint16((startIndex + i) * 2, true));
  const out = is32 ? new Uint32Array(primCount * 3) : new Uint16Array(primCount * 3);
  for (let i = 0; i < primCount; i++) { out[i * 3] = get(0); out[i * 3 + 1] = get(i + 1); out[i * 3 + 2] = get(i + 2); }
  return out;
}

export type { FfpStage };
export { declTypeSize };
