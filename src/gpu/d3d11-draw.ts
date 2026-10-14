// Direct3D 11 draw/dispatch engine: turns context state into WebGPU pipelines, bind groups and passes.
import { emitSm5, interpAttr } from "./sm5.ts";
import type { Sm5Link } from "./sm5.ts";
import { BIND, SRV_DIM, topologyInfo } from "./d3d11-consts.ts";
import { Buf11, Tex11, UAV11 } from "./d3d11-res.ts";
import type { RTV11, SRV11, Shader11, ShaderStage, SamplerState11, InputLayout11 } from "./d3d11-res.ts";
import { vertexFormat, bytesPerVertexFormat } from "./dxgi-fmt.ts";
import type { PassTarget } from "./gpu.ts";
import type { Context11 } from "./d3d11-ctx.ts";

interface StageSetup {
  stage: ShaderStage;
  sh: Shader11;
  bgl: GPUBindGroupLayout;
  bglKey: string;
  bg: GPUBindGroup;
  dyn: number[];
  /** key identifying the resources in the bind group (for pipeline-independent caching) */
  usedTex: Tex11[];
  usedBuf: Buf11[];
}

const VIS: Record<string, number> = { vs: 1, ps: 2, cs: 4 };

/** resource-signature facts that influence the generated WGSL */
interface ResInfo { uavFormats: Map<number, string>; bufferFormats: Map<number, string>; key: string }

/** storage-texture format names the emitter understands for a UAV view format */
function storageFormat(f: GPUTextureFormat): string { return f; }

function bufFormatClass(fmt: number): string {
  switch (fmt) {
    case 41: return "f1";
    case 16: return "f2";
    case 6: return "f3";
    case 2: return "f4";
    case 42: case 43: return "u1";
    case 3: case 4: return "u4";
    case 28: return "rgba8";
    default: return "f4";
  }
}

export class DrawEngine11 {
  readonly ctx: Context11;
  private warned = new Set<string>();
  /** current pass bookkeeping */
  private passObj: GPURenderPassEncoder | null = null;
  private lastPipeline: GPURenderPipeline | null = null;
  private lastVp = "";
  private lastSc = "";
  private lastStencil = -1;
  private lastBlend = "";
  private lastIb = "";
  private lastVb: string[] = [];
  private lastBg: (GPUBindGroup | null)[] = [null, null];
  private lastDyn: string[] = ["", ""];
  private target: PassTarget | null = null;
  private targetKey = "";
  private targetVersion = -1;
  private targetInfo: { w: number; h: number; samples: number; nT: number; attTex: Set<Tex11>; fmts: (GPUTextureFormat | null)[]; ds: GPUTextureFormat | null; roD: boolean; roS: boolean } | null = null;
  private scratch = new Uint8Array(65536);
  private vertexCache = new Map<string, { buffers: GPUVertexBufferLayout[]; slotMap: number[]; kinds: Map<number, string>; key: string }>();
  private moduleCache = new Map<string, GPUShaderModule>();

  constructor(ctx: Context11) { this.ctx = ctx; }
  private get s() { return this.ctx.s; }
  private get dev() { return this.ctx.dev; }
  private get gpu() { return this.ctx.dev.gpu; }
  warn(key: string, msg: string) { if (!this.warned.has(key)) { this.warned.add(key); this.dev.p.log("[d3d11] " + msg); } }

  // ------------------------------------------------------------------------------------------------------------------
  // render targets
  // ------------------------------------------------------------------------------------------------------------------
  private buildTarget(): boolean {
    const s = this.s;
    if (this.targetVersion === this.ctx.omVersion && this.target) return true;
    const colors: PassTarget["colors"] = [];
    let nT = 0, w = 0, h = 0, samples = 1;
    const attTex = new Set<Tex11>();
    const fmts: (GPUTextureFormat | null)[] = [];
    let key = "";
    for (let i = 0; i < 8; i++) {
      const r = s.rtv[i];
      if (!r || !r.view || !(r.res instanceof Tex11) || !r.res.gpu) { colors.push(null); fmts.push(null); key += "-,"; continue; }
      const t = r.res;
      nT = i + 1;
      const mip = r.desc.mostDetailedMip;
      w = Math.max(1, t.gw >> mip); h = Math.max(1, t.gh >> mip);
      samples = t.gpuSamples;
      attTex.add(t);
      colors.push({ view: r.view, tex: t.gpu!, format: r.fmtGpu, depthSlice: t.dim === 3 ? r.desc.firstW : undefined });
      fmts.push(r.fmtGpu);
      key += `${r.uid},`;
    }
    colors.length = nT;
    fmts.length = nT;
    let depth: PassTarget["depth"] = null;
    let dsFmt: GPUTextureFormat | null = null;
    const d = s.dsv;
    if (d && d.view && d.res instanceof Tex11 && d.res.gpu) {
      const t = d.res;
      const mip = d.desc.mostDetailedMip;
      if (!nT) { w = Math.max(1, t.gw >> mip); h = Math.max(1, t.gh >> mip); samples = t.gpuSamples; }
      attTex.add(t);
      depth = { view: d.view, tex: t.gpu!, format: d.fmtGpu, readOnlyDepth: d.readOnlyDepth, readOnlyStencil: d.readOnlyStencil };
      dsFmt = d.fmtGpu;
      key += `d${d.uid}`;
    }
    if (!nT && !depth) return false;
    this.target = { colors, depth, width: w, height: h, samples };
    this.targetKey = key;
    this.targetVersion = this.ctx.omVersion;
    this.targetInfo = { w, h, samples, nT, attTex, fmts, ds: dsFmt, roD: !!d?.readOnlyDepth, roS: !!d?.readOnlyStencil };
    return true;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // shaders and links
  // ------------------------------------------------------------------------------------------------------------------
  private resInfo(stage: ShaderStage, sh: Shader11): ResInfo {
    const p = sh.parsed, s = this.s;
    const uavFormats = new Map<number, string>(), bufferFormats = new Map<number, string>();
    let key = "";
    for (const slot of p.srvs.keys()) {
      const v = s.srv[stage][slot];
      const d = p.srvs.get(slot)!;
      if (v && v.isBuffer && d.dim === 1 && !d.raw && !d.structured) { const c = bufFormatClass(v.desc.fmt); bufferFormats.set(slot, c); key += `b${slot}${c};`; }
    }
    const uavs = stage === "cs" ? s.uavCs : s.uavPs;
    for (const slot of p.uavs.keys()) {
      const v = uavs[slot];
      const d = p.uavs.get(slot)!;
      if (!v) continue;
      if (v.isBuffer) { if (d.dim === 1 && !d.raw && !d.structured) { const c = bufFormatClass(v.desc.fmt); bufferFormats.set(slot, c); key += `B${slot}${c};`; } }
      else { uavFormats.set(slot, storageFormat(v.fmtGpu)); key += `u${slot}${v.fmtGpu};`; }
    }
    return { uavFormats, bufferFormats, key };
  }

  private moduleFor(sh: Shader11, link: Sm5Link, linkKey: string): GPUShaderModule {
    const key = sh.uid + "|" + linkKey;
    let m = this.moduleCache.get(key);
    if (m) return m;
    const r = emitSm5(sh.parsed, link);
    if (this.dev.p.ext.debugShaders) this.dev.p.log(`[d3d11] WGSL for ${link.stage} ${sh.uid}:\n${r.wgsl}`);
    m = this.gpu.device.createShaderModule({ code: r.wgsl, label: `d3d11 ${link.stage} ${sh.uid}` });
    this.moduleCache.set(key, m);
    return m;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // bind groups
  // ------------------------------------------------------------------------------------------------------------------
  private f32Filterable(): boolean { return this.gpu.hasFloat32Filterable; }

  private sampleTypeFor(v: SRV11 | null, declRet: number, cmp: boolean): GPUTextureSampleType {
    if (!v || v.isBuffer) return cmp ? "depth" : declRet === 4 ? "uint" : declRet === 3 ? "sint" : "float";
    const f = v.tex.gpuFmt;
    if (/depth|stencil/.test(f)) {
      if (v.desc.fmt && (v.desc.fmt === 47 || v.desc.fmt === 22)) return "uint";
      return cmp ? "depth" : "unfilterable-float";
    }
    if (/uint$/.test(f)) return "uint";
    if (/sint$/.test(f)) return "sint";
    if (/32float$/.test(f) && !this.f32Filterable()) return "unfilterable-float";
    return "float";
  }

  private viewDim(declDim: number): GPUTextureViewDimension {
    switch (declDim) {
      case 2: case 7: return "1d";
      case 5: return "3d";
      case 6: return "cube";
      case 10: return "cube-array";
      case 8: case 9: return "2d-array";
      default: return "2d";
    }
  }

  private cbBytes(buf: Buf11, first: number, declBytes: number): Uint8Array {
    if (this.scratch.length < declBytes) this.scratch = new Uint8Array(declBytes);
    const out = this.scratch.subarray(0, declBytes);
    out.fill(0);
    const avail = Math.max(0, Math.min(declBytes, buf.size - first * 16));
    if (avail > 0 && buf.shadow) out.set(this.dev.p.mem.bytes(buf.shadow + first * 16, avail));
    return out;
  }

  private buildStage(stage: ShaderStage, sh: Shader11, group: number, attTex: Set<Tex11>): StageSetup | null {
    const s = this.s, p = sh.parsed, dev = this.dev, gpu = this.gpu;
    const vis = stage === "vs" ? GPUShaderStage.VERTEX : stage === "ps" ? GPUShaderStage.FRAGMENT : GPUShaderStage.COMPUTE;
    const layoutEntries: GPUBindGroupLayoutEntry[] = [];
    const entries: GPUBindGroupEntry[] = [];
    const dyn: number[] = [];
    const usedTex: Tex11[] = [], usedBuf: Buf11[] = [];
    let lkey = "";
    let ckey = "";
    // constant buffers (dynamic uniform offsets into the shared ring)
    for (const [slot, cb] of [...p.cbs].sort((a, b) => a[0] - b[0])) {
      const n = Math.max(1, Math.min(cb.size || 4096, 4096));
      const bytes = n * 16;
      layoutEntries.push({ binding: slot, visibility: vis, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: bytes } });
      entries.push({ binding: slot, resource: { buffer: gpu.uniformRing, offset: 0, size: bytes } });
      const b = s.cb[stage][slot];
      let off: number;
      if (!b.buf || !b.buf.shadow) off = dev.zeroUniform(bytes);
      else {
        const c = b.buf;
        const ck = `${c.version}:${b.first}:${bytes}`;
        if (c.ringEpoch === gpu.ringEpoch && c.ringKey === ck) off = c.ringOffset;
        else { off = gpu.pushUniform(this.cbBytes(c, b.first, bytes)); c.ringEpoch = gpu.ringEpoch; c.ringKey = ck; c.ringOffset = off; }
      }
      dyn.push(off);
      lkey += `c${slot}:${bytes};`;
    }
    // samplers
    const texFiltering = new Set<number>();
    void texFiltering;
    let anyUnfilterable = false;
    for (const [slot, d] of p.srvs) {
      const v = s.srv[stage][slot];
      if (v && !v.isBuffer && !d.raw && !d.structured && d.dim !== 1 && this.sampleTypeFor(v, d.ret[0], p.cmpTextures.has(slot)) === "unfilterable-float") anyUnfilterable = true;
    }
    for (const [slot, sm] of [...p.samplers].sort((a, b) => a[0] - b[0])) {
      const st = s.smp[stage][slot] ?? dev.defaultSampler();
      let type: GPUSamplerBindingType, smp: GPUSampler;
      if (sm.comparison) { type = "comparison"; smp = st.comparison ? st.gpu : dev.comparisonSampler(); }
      else {
        smp = st.comparison ? dev.defaultSampler().gpu : st.gpu;
        type = anyUnfilterable ? "non-filtering" : "filtering";
        if (anyUnfilterable && !st.pointOnly) smp = dev.nearestSampler();
      }
      layoutEntries.push({ binding: 144 + slot, visibility: vis, sampler: { type } });
      entries.push({ binding: 144 + slot, resource: smp });
      lkey += `s${slot}:${type};`;
      ckey += `s${st.uid}:${sm.comparison ? 1 : 0}:${anyUnfilterable ? 1 : 0};`;
    }
    // shader resource views
    for (const [slot, d] of [...p.srvs].sort((a, b) => a[0] - b[0])) {
      const binding = 16 + slot;
      let v = s.srv[stage][slot];
      const isBufDecl = d.raw || d.structured || d.dim === 1 || d.dim === 11 || d.dim === 12;
      if (v && !isBufDecl && !v.isBuffer && attTex.has(v.tex)) v = null; // read/write hazard: D3D unbinds the view
      if (isBufDecl) {
        layoutEntries.push({ binding, visibility: vis, buffer: { type: "read-only-storage" } });
        let res: GPUBufferBinding;
        if (v && v.isBuffer && v.buf.gpu) {
          const b = v.buf;
          const esz = d.raw ? 4 : d.structured ? Math.max(4, d.stride || b.stride || 4) : this.elemSize(v.desc.fmt);
          let off = v.desc.firstElement * esz, size = v.desc.numElements * esz;
          if (!size || off + size > b.size) { off = 0; size = b.size; }
          if (off % 256 !== 0) { this.warn("srvoff", "buffer SRV with a non-256-aligned FirstElement offset: binding from the start"); off = 0; size = b.size; }
          size = Math.max(4, (size + 3) & ~3);
          res = { buffer: b.gpu!, offset: off, size: Math.min(size, b.gpu!.size - off) };
          b.usedGen = gpu.stats.submits; usedBuf.push(b);
          ckey += `B${b.uid}:${b.gpuId}:${off}:${size};`;
        } else { res = { buffer: dev.dummyStorage(), offset: 0, size: 256 }; ckey += "B0;"; }
        entries.push({ binding, resource: res });
        lkey += `B${slot};`;
        continue;
      }
      const cmp = p.cmpTextures.has(slot);
      const ms = d.dim === 4 || d.dim === 9;
      const sampleType = this.sampleTypeFor(v, d.ret[0], cmp);
      const vdim = this.viewDim(d.dim);
      layoutEntries.push({ binding, visibility: vis, texture: { sampleType, viewDimension: vdim, multisampled: ms } });
      let view: GPUTextureView;
      if (v && !v.isBuffer && v.tex.gpu) {
        view = v.gpuView(d.dim);
        v.tex.usedGen = gpu.stats.submits; usedTex.push(v.tex);
        ckey += `t${v.uid}:${d.dim};`;
      } else { view = dev.dummyTexture(vdim, sampleType, ms); ckey += `T${vdim}${sampleType};`; }
      entries.push({ binding, resource: view });
      lkey += `t${slot}:${sampleType}:${vdim}:${ms ? 1 : 0};`;
    }
    // unordered access views
    const uavs = stage === "cs" ? s.uavCs : s.uavPs;
    for (const [slot, d] of [...p.uavs].sort((a, b) => a[0] - b[0])) {
      const binding = 160 + slot;
      const v = uavs[slot];
      if (d.raw || d.structured || d.dim === 1) {
        layoutEntries.push({ binding, visibility: vis, buffer: { type: "storage" } });
        let res: GPUBufferBinding;
        if (v && v.isBuffer && v.buf.gpu) {
          const b = v.buf;
          const esz = d.raw ? 4 : d.structured ? Math.max(4, d.stride || b.stride || 4) : this.elemSize(v.desc.fmt);
          let off = v.desc.firstElement * esz, size = v.desc.numElements * esz;
          if (!size || off + size > b.size) { off = 0; size = b.size; }
          if (off % 256 !== 0) { this.warn("uavoff", "buffer UAV with a non-256-aligned FirstElement offset: binding from the start"); off = 0; size = b.size; }
          size = Math.max(4, (size + 3) & ~3);
          res = { buffer: b.gpu!, offset: off, size: Math.min(size, b.gpu!.size - off) };
          b.usedGen = gpu.stats.submits; usedBuf.push(b);
          ckey += `U${b.uid}:${b.gpuId}:${off}:${size};`;
        } else { res = { buffer: dev.dummyStorage(), offset: 0, size: 256 }; ckey += "U0;"; }
        entries.push({ binding, resource: res });
        lkey += `U${slot};`;
      } else {
        const vdim: GPUTextureViewDimension = d.dim === 5 ? "3d" : d.dim === 8 ? "2d-array" : d.dim === 2 || d.dim === 7 ? "1d" : "2d";
        const fmt = (v && !v.isBuffer ? v.fmtGpu : "rgba8unorm") as GPUTextureFormat;
        const reads = p.uavReads.has(slot);
        layoutEntries.push({ binding, visibility: vis, storageTexture: { access: reads ? "read-write" : "write-only", format: fmt, viewDimension: vdim } });
        let view: GPUTextureView;
        if (v && !v.isBuffer && v.view) { view = v.view; v.tex.usedGen = gpu.stats.submits; usedTex.push(v.tex); ckey += `u${v.uid};`; }
        else { view = dev.dummyStorageTexture(vdim, fmt); ckey += `u0${fmt};`; }
        entries.push({ binding, resource: view });
        lkey += `T${slot}:${fmt}:${vdim}:${reads ? "rw" : "w"};`;
      }
    }
    const bglKey = `${stage}|${lkey}`;
    const bgl = dev.bindGroupLayout(bglKey, layoutEntries);
    const bgKey = bglKey + "#" + ckey;
    let bg = dev.bgCache.get(bgKey);
    if (!bg) {
      bg = gpu.device.createBindGroup({ layout: bgl, entries });
      dev.bgCache.set(bgKey, bg);
      if (dev.bgCache.size > 6000) dev.bgCache.clear();
    }
    void group;
    return { stage, sh, bgl, bglKey, bg, dyn, usedTex, usedBuf };
  }

  private elemSize(fmt: number): number {
    switch (fmt) {
      case 2: case 3: case 4: return 16;
      case 6: case 7: case 8: return 12;
      case 16: case 17: case 18: return 8;
      default: return 4;
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // vertex layout
  // ------------------------------------------------------------------------------------------------------------------
  private vertexState(vs: Shader11, layout: InputLayout11 | null): { buffers: GPUVertexBufferLayout[]; slotMap: number[]; kinds: Map<number, string>; key: string } {
    const s = this.s;
    let sk = `${layout?.uid ?? 0}:${vs.uid}`;
    if (layout) { const slots = new Set(layout.elements.map((e) => e.slot)); for (const sl of [...slots].sort((a, b) => a - b)) sk += `:${sl}=${s.vb[sl].stride}`; }
    let r = this.vertexCache.get(sk);
    if (r) return r;
    const kinds = new Map<number, string>();
    const attrs = new Map<number, { fmt: GPUVertexFormat; offset: number; loc: number }[]>();
    const steps = new Map<number, boolean>();
    for (const inp of vs.parsed.inputs) {
      if (inp.sysVal) continue; // SV_VertexID and friends are builtins
      const el = layout?.elements.find((e) => e.name.toUpperCase() === inp.name.toUpperCase() && e.index === inp.index);
      const vf = el ? vertexFormat(el.format) : null;
      if (!el || !vf) { kinds.set(inp.reg, "z"); if (el) this.warn("vfmt" + el.format, `unsupported vertex format ${el.format} for ${el.name}`); continue; }
      kinds.set(inp.reg, vf.kind);
      let list = attrs.get(el.slot);
      if (!list) attrs.set(el.slot, (list = []));
      list.push({ fmt: vf.fmt, offset: el.offset, loc: inp.reg });
      steps.set(el.slot, el.perInstance);
    }
    // inputs declared as system values still need kinds
    for (const [reg] of vs.parsed.declIn) if (!kinds.has(reg)) kinds.set(reg, "f");
    const buffers: GPUVertexBufferLayout[] = [];
    const slotMap: number[] = new Array(16).fill(-1);
    for (const sl of [...attrs.keys()].sort((a, b) => a - b)) {
      const list = attrs.get(sl)!;
      let need = 0;
      for (const a of list) need = Math.max(need, a.offset + bytesPerVertexFormat(a.fmt));
      let stride = s.vb[sl].stride;
      if (stride < need) stride = need; // WebGPU requires attributes to fit in the stride
      stride = (stride + 3) & ~3;
      slotMap[sl] = buffers.length;
      buffers.push({ arrayStride: stride, stepMode: steps.get(sl) ? "instance" : "vertex", attributes: list.map((a) => ({ format: a.fmt, offset: a.offset, shaderLocation: a.loc })) });
    }
    r = { buffers, slotMap, kinds, key: JSON.stringify(buffers) };
    this.vertexCache.set(sk, r);
    if (this.vertexCache.size > 4000) this.vertexCache.clear();
    return r;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // draw
  // ------------------------------------------------------------------------------------------------------------------
  draw(kind: "draw" | "indexed" | "indirect" | "indexedIndirect", a: number, b: number, c: number, d: number, e: number, indirect?: Buf11) {
    const s = this.s, gpu = this.gpu, dev = this.dev;
    const vs = s.sh.vs, ps = s.sh.ps;
    if (!vs) { this.warn("novs", "draw without a vertex shader"); return; }
    if (s.sh.hs || s.sh.ds) { this.warn("tess", "tessellation shaders are not supported: draw skipped"); return; }
    if (s.sh.gs) { this.warn("gs", "geometry shaders are not supported: draw skipped"); return; }
    if (vs.unsupported.length || (ps && ps.unsupported.length)) { this.warn("unsupp" + vs.uid + (ps?.uid ?? 0), "draw uses a shader with unsupported instructions"); }
    const topo = topologyInfo(s.topology);
    if (!topo) { this.warn("topo" + s.topology, `unsupported primitive topology ${s.topology}`); return; }
    const indexed = kind === "indexed" || kind === "indexedIndirect";
    if (indexed && (!s.ib.buf || !s.ib.buf.gpu)) { this.warn("noib", "indexed draw without an index buffer"); return; }
    if (!this.buildTarget()) return;
    const t = this.target!, ti = this.targetInfo!;
    // stages
    const vsSetup = this.buildStage("vs", vs, 0, ti.attTex);
    const psSetup = ps ? this.buildStage("ps", ps, 1, ti.attTex) : null;
    if (!vsSetup || (ps && !psSetup)) return;
    // links
    const vsRes = this.resInfo("vs", vs), psRes = ps ? this.resInfo("ps", ps) : null;
    const vstate = this.vertexState(vs, s.layout);
    const link = this.linkStages(vs, ps, vstate.kinds, ti.nT, vsRes, psRes);
    const vsMod = this.moduleFor(vs, link.vs, link.vsKey);
    const psMod = ps ? this.moduleFor(ps, link.ps!, link.psKey) : dev.nullFragment();
    // pipeline
    const bs = s.blend, rs = s.raster, dss = s.ds;
    const stripFmt = topo.strip && indexed ? (s.ib.format === 42 ? "uint32" : "uint16") : "";
    const pkey = [vs.uid, ps?.uid ?? 0, link.vsKey, link.psKey, vsSetup.bglKey, psSetup?.bglKey ?? "", vstate.key, topo.topology, stripFmt, bs?.key ?? "-", rs?.key ?? "-", dss?.key ?? "-",
      ti.fmts.join(","), ti.ds ?? "", ti.samples, s.sampleMask, ti.roD ? 1 : 0, ti.roS ? 1 : 0].join("~");
    let pipe = dev.pipelines.get(pkey);
    if (!pipe) {
      const targets: (GPUColorTargetState | null)[] = ti.fmts.map((f, i) => {
        if (!f) return null;
        const tgt: GPUColorTargetState = { format: f, writeMask: ps ? (bs ? bs.writeMask(i) : 15) : 0 };
        const bl = bs?.gpuBlend(i);
        if (bl && ps && this.blendable(f)) tgt.blend = bl;
        return tgt;
      });
      const raster = rs;
      const primitive: GPUPrimitiveState = {
        topology: topo.topology,
        frontFace: raster?.frontCCW ? "ccw" : "cw",
        cullMode: raster ? (raster.cull === 2 ? "front" : raster.cull === 3 ? "back" : "none") : "back",
      };
      if (stripFmt) primitive.stripIndexFormat = stripFmt as GPUIndexFormat;
      if (raster && !raster.depthClip && gpu.features.has("depth-clip-control")) primitive.unclippedDepth = true;
      const desc: GPURenderPipelineDescriptor = {
        layout: gpu.device.createPipelineLayout({ bindGroupLayouts: ps ? [vsSetup.bgl, psSetup!.bgl] : [vsSetup.bgl] }),
        vertex: { module: vsMod, entryPoint: "main", buffers: vstate.buffers },
        primitive,
        multisample: { count: ti.samples, mask: s.sampleMask >>> 0, alphaToCoverageEnabled: !!bs?.alphaToCoverage && ti.samples > 1 },
        label: `d3d11 pipeline vs${vs.uid} ps${ps?.uid ?? 0}`,
      };
      if (ti.nT > 0 || ps) desc.fragment = { module: psMod, entryPoint: "main", targets };
      if (ti.ds) {
        const dsd = (dss ?? dev.defaultDepthStencil()).gpuState(ti.ds, ti.roD, ti.roS);
        if (rs && /depth/.test(ti.ds)) { dsd.depthBias = rs.depthBias; dsd.depthBiasSlopeScale = rs.slopeBias; dsd.depthBiasClamp = rs.depthBiasClamp; }
        desc.depthStencil = dsd;
      }
      pipe = gpu.device.createRenderPipeline(desc);
      dev.pipelines.set(pkey, pipe);
      gpu.stats.pipelines++;
    }
    // resolve deferred clears on textures about to be sampled
    if (gpu.pending.size) {
      for (const st of [vsSetup, psSetup]) if (st) for (const tx of st.usedTex) if (tx.gpu && gpu.pending.has(tx.gpu)) gpu.resolveTexture(tx.gpu);
    }
    const dsvTex = s.dsv?.res as Tex11 | undefined;
    if (dsvTex) dsvTex.usedGen = gpu.stats.submits;
    for (const rv of s.rtv) if (rv) rv.res.usedGen = gpu.stats.submits;
    for (const vi of vstate.slotMap.keys()) if (vstate.slotMap[vi] >= 0) { const vb = s.vb[vi].buf; if (!vb || !vb.gpu) { this.warn("novb" + vi, `vertex buffer slot ${vi} is not bound`); return; } vb.usedGen = gpu.stats.submits; }
    if (indexed) s.ib.buf!.usedGen = gpu.stats.submits;
    if (indirect) indirect.usedGen = gpu.stats.submits;
    gpu.reserve(65536 * 2, 0);
    const pass = gpu.renderPass(t, this.targetKey);
    const fresh = pass !== this.passObj;
    if (fresh) {
      this.passObj = pass;
      this.lastPipeline = null; this.lastVp = ""; this.lastSc = ""; this.lastStencil = -1; this.lastBlend = ""; this.lastIb = ""; this.lastVb = []; this.lastBg = [null, null]; this.lastDyn = ["", ""];
    }
    if (pipe !== this.lastPipeline) { pass.setPipeline(pipe); this.lastPipeline = pipe; }
    // dynamic state
    const vp = s.viewports[0];
    const vpk = vp ? `${vp.x},${vp.y},${vp.w},${vp.h},${vp.minZ},${vp.maxZ}` : "full";
    if (vpk !== this.lastVp) {
      this.lastVp = vpk;
      if (vp) {
        const x = Math.max(0, Math.min(vp.x, ti.w)), y = Math.max(0, Math.min(vp.y, ti.h));
        const w = Math.max(0, Math.min(vp.w - (x - vp.x), ti.w - x)), h = Math.max(0, Math.min(vp.h - (y - vp.y), ti.h - y));
        pass.setViewport(x, y, Math.max(w, 0), Math.max(h, 0), Math.max(0, Math.min(1, vp.minZ)), Math.max(0, Math.min(1, vp.maxZ)));
      } else pass.setViewport(0, 0, ti.w, ti.h, 0, 1);
    }
    const sr = rs?.scissor ? s.scissors[0] : undefined;
    const sck = sr ? `${sr.l},${sr.t},${sr.r},${sr.b}` : "full";
    if (sck !== this.lastSc) {
      this.lastSc = sck;
      if (sr) {
        const x = Math.max(0, Math.min(sr.l, ti.w)), y = Math.max(0, Math.min(sr.t, ti.h));
        const w = Math.max(0, Math.min(sr.r, ti.w) - x), h = Math.max(0, Math.min(sr.b, ti.h) - y);
        pass.setScissorRect(x, y, w, h);
      } else pass.setScissorRect(0, 0, ti.w, ti.h);
    }
    if (s.stencilRef !== this.lastStencil) { this.lastStencil = s.stencilRef; pass.setStencilReference(s.stencilRef); }
    const bf = s.blendFactor;
    const bk = `${bf[0]},${bf[1]},${bf[2]},${bf[3]}`;
    if (bk !== this.lastBlend) { this.lastBlend = bk; pass.setBlendConstant({ r: bf[0], g: bf[1], b: bf[2], a: bf[3] }); }
    // resources
    const setBg = (i: number, st: StageSetup) => {
      const dk = st.dyn.join(",");
      if (this.lastBg[i] !== st.bg || this.lastDyn[i] !== dk) { pass.setBindGroup(i, st.bg, st.dyn); this.lastBg[i] = st.bg; this.lastDyn[i] = dk; }
    };
    setBg(0, vsSetup);
    if (psSetup) setBg(1, psSetup);
    for (let si = 0; si < 16; si++) {
      const dense = vstate.slotMap[si];
      if (dense < 0) continue;
      const vb = s.vb[si];
      const k = `${vb.buf!.uid}:${vb.buf!.gpuId}:${vb.offset}`;
      if (this.lastVb[dense] !== k) { this.lastVb[dense] = k; pass.setVertexBuffer(dense, vb.buf!.gpu!, vb.offset); }
    }
    if (indexed) {
      const ib = s.ib;
      const k = `${ib.buf!.uid}:${ib.buf!.gpuId}:${ib.format}:${ib.offset}`;
      if (k !== this.lastIb) { this.lastIb = k; pass.setIndexBuffer(ib.buf!.gpu!, ib.format === 42 ? "uint32" : "uint16", ib.offset); }
    }
    gpu.stats.draws++;
    switch (kind) {
      case "draw": pass.draw(a, b, c, d); break;
      case "indexed": pass.drawIndexed(a, b, c, d | 0, e); break;
      case "indirect": pass.drawIndirect(indirect!.gpu!, a); break;
      case "indexedIndirect": pass.drawIndexedIndirect(indirect!.gpu!, a); break;
    }
  }

  private blendable(f: GPUTextureFormat): boolean {
    if (/(uint|sint)$/.test(f)) return false;
    if (/32float$/.test(f) && !this.gpu.hasFloat32Blendable) return false;
    return true;
  }

  private linkStages(vs: Shader11, ps: Shader11 | null, kinds: Map<number, string>, nT: number, vsRes: ResInfo, psRes: ResInfo | null) {
    const slots = new Map<string, { slot: number; interp: string; kind: "f" | "u" | "i" }>();
    const extra: { slot: number; interp: string; kind: "f" | "u" | "i" }[] = [];
    let n = 0;
    if (ps) {
      const pp = ps.parsed;
      for (const [reg, d] of [...pp.declIn].sort((a, b) => a[0] - b[0])) {
        if (d.kind !== "plain") continue;
        const el = pp.inputs.find((e) => e.reg === reg);
        if (!el) continue;
        const key = `${el.name.toUpperCase()}#${el.index}`;
        if (slots.has(key)) continue;
        const kind = el.compType === 1 ? "u" : el.compType === 2 ? "i" : "f";
        const sl = { slot: n++, interp: interpAttr(d.interp), kind: kind as "f" | "u" | "i" };
        slots.set(key, sl);
        if (!vs.parsed.outputs.some((o) => `${o.name.toUpperCase()}#${o.index}` === key)) extra.push(sl);
      }
    }
    const slotKey = [...slots].map(([k, v]) => `${k}=${v.slot}${v.interp}${v.kind}`).join(",");
    const inputKinds = new Map(kinds);
    const vsLink: Sm5Link = { stage: "vs", slots, inputKinds, extraSlots: extra, uavFormats: vsRes.uavFormats, bufferFormats: vsRes.bufferFormats };
    const vsKey = `vs:${slotKey}:${[...inputKinds].map(([r, k]) => r + k).join("")}:${vsRes.key}`;
    let psLink: Sm5Link | undefined, psKey = "";
    if (ps) {
      psLink = { stage: "ps", slots, targets: nT, uavFormats: psRes!.uavFormats, bufferFormats: psRes!.bufferFormats };
      psKey = `ps:${slotKey}:${nT}:${psRes!.key}`;
    }
    return { vs: vsLink, ps: psLink, vsKey, psKey };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // compute
  // ------------------------------------------------------------------------------------------------------------------
  dispatch(x: number, y: number, z: number, indirect?: Buf11, indirectOffset = 0) {
    const s = this.s, gpu = this.gpu, dev = this.dev;
    const cs = s.sh.cs;
    if (!cs) { this.warn("nocs", "dispatch without a compute shader"); return; }
    const setup = this.buildStage("cs", cs, 2, new Set());
    if (!setup) return;
    const res = this.resInfo("cs", cs);
    const link: Sm5Link = { stage: "cs", slots: new Map(), uavFormats: res.uavFormats, bufferFormats: res.bufferFormats };
    const key = `cs:${res.key}`;
    const mod = this.moduleFor(cs, link, key);
    const pkey = `cs${cs.uid}~${key}~${setup.bglKey}`;
    let pipe = dev.computePipelines.get(pkey);
    if (!pipe) {
      pipe = gpu.device.createComputePipeline({
        layout: gpu.device.createPipelineLayout({ bindGroupLayouts: [dev.emptyLayout(), dev.emptyLayout(), setup.bgl] }),
        compute: { module: mod, entryPoint: "main" }, label: "d3d11 cs " + cs.uid,
      });
      dev.computePipelines.set(pkey, pipe);
    }
    if (gpu.pending.size) for (const tx of setup.usedTex) if (tx.gpu && gpu.pending.has(tx.gpu)) gpu.resolveTexture(tx.gpu);
    gpu.endPass();
    this.passObj = null;
    const cp = gpu.cmd().beginComputePass();
    cp.setPipeline(pipe);
    cp.setBindGroup(2, setup.bg, setup.dyn);
    if (indirect) { indirect.usedGen = gpu.stats.submits; cp.dispatchWorkgroupsIndirect(indirect.gpu!, indirectOffset); }
    else cp.dispatchWorkgroups(x, y, z);
    cp.end();
  }

  /** call when a pass was ended behind the engine's back */
  invalidatePass() { this.passObj = null; }
}

void BIND; void SRV_DIM; void UAV11; void ({} as RTV11 | SamplerState11);
