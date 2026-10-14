// ID3D11Device: resource and state-object creation, capability queries, GPU->CPU readback plumbing.
import { ComObject, guidToString } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import type { Process } from "../win32/process.ts";
import type { Gpu } from "./gpu.ts";
import { BIND, CPU, E, FEATURE_LEVEL, FS, MISC, QUERY, USAGE } from "./d3d11-consts.ts";
import { Buf11, BlendState11, ClassLinkage11, CommandList11, DSV11, DepthStencilState11, InputLayout11, Query11, RTV11, RasterizerState11, Resource11, SRV11, SamplerState11, Shader11, Tex11, UAV11 } from "./d3d11-res.ts";
import type { InputElement, PendingRead, ShaderStage, ViewDesc } from "./d3d11-res.ts";
import { Context11 } from "./d3d11-ctx.ts";
import { fmt11, resolveGpuFormat, vertexFormat } from "./dxgi-fmt.ts";
import { parseDxbc } from "./sm5.ts";

const KEEP_ALIGNED = 0xffffffff;

export class Device11 extends ComObject {
  p!: Process;
  gpu!: Gpu;
  immediate!: Context11;
  creationFlags = 0;
  featureLevel = FEATURE_LEVEL.L11_0;
  adapterObj: ComObject | null = null;
  frameLatency = 3;
  priority = 0;
  exceptionMode = 0;
  priv = new Map<string, Uint8Array>();

  // caches shared by all contexts
  pipelines = new Map<string, GPURenderPipeline>();
  computePipelines = new Map<string, GPUComputePipeline>();
  bgCache = new Map<string, GPUBindGroup>();
  private bgls = new Map<string, GPUBindGroupLayout>();
  private pendingOps = new Map<string, { done: boolean; value: any }>();
  private polls = new Map<number, { done: boolean }>();

  init(p: Process, gpu: Gpu, flags: number) {
    this.p = p; this.gpu = gpu; this.creationFlags = flags;
    const ctx = new Context11();
    this.rt.create(ctx, ["ID3D11DeviceContext1", "ID3D11DeviceContext", "ID3D11DeviceChild", "ID3DUserDefinedAnnotation", "ID3D11Multithread"]);
    ctx.init(this, false);
    this.immediate = ctx;
  }
  destroy() {
    this.immediate.destroyed = true;
    this.pipelines.clear(); this.bgCache.clear();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // async plumbing (restartable blocking calls)
  // ------------------------------------------------------------------------------------------------------------------
  waitFor<T>(key: string, start: () => Promise<T>): T {
    let op = this.pendingOps.get(key);
    if (!op) {
      const o = { done: false, value: undefined as any };
      this.pendingOps.set(key, (op = o));
      start().then((v) => { o.value = v; o.done = true; }, (e) => { o.value = e; o.done = true; this.p.log(`[d3d11] gpu operation failed: ${e}`); });
    }
    const o = op;
    if (!o.done) this.p.waitUntil(() => o.done, 0xffffffff, "gpu " + key);
    this.pendingOps.delete(key);
    return o.value as T;
  }
  waitReadback(res: Buf11 | Tex11) {
    this.waitFor("rb" + res.uid, () => this.fetchReads(res));
    res.pendingReads.length = 0;
  }
  pollReadback(res: Buf11 | Tex11): boolean {
    let op = this.polls.get(res.uid);
    if (!op) {
      const o = { done: false };
      this.polls.set(res.uid, (op = o));
      this.fetchReads(res).then(() => { o.done = true; }, () => { o.done = true; });
    }
    if (!op.done) return false;
    this.polls.delete(res.uid);
    res.pendingReads.length = 0;
    return true;
  }
  private async fetchReads(res: Buf11 | Tex11): Promise<void> {
    this.gpu.flush();
    const reads = (res.pendingReads as any[]).slice();
    await Promise.all(reads.map((r) => r.buf.mapAsync(GPUMapMode.READ)));
    const mem = this.p.mem;
    for (const r of reads) {
      const range = new Uint8Array(r.buf.getMappedRange());
      if (res instanceof Buf11) {
        mem.write(res.shadow + r.dstOffset, range.subarray(r.srcOffset, r.srcOffset + r.size));
      } else {
        const rd = r as PendingRead;
        const t = res, l = t.layouts[rd.sub], blk = t.fmt.block;
        const appRow = (blk > 1 ? Math.ceil(rd.w / blk) : rd.w) * t.fmt.bytes;
        const gpuRow = blk > 1 ? appRow : rd.w * t.gpuBytes;
        const x0 = (blk > 1 ? Math.floor(rd.x / blk) : rd.x) * t.fmt.bytes, y0 = blk > 1 ? Math.floor(rd.y / blk) : rd.y;
        for (let z = 0; z < rd.d; z++) for (let row = 0; row < rd.rows; row++) {
          const src = range.subarray((z * rd.rows + row) * rd.bytesPerRow, (z * rd.rows + row) * rd.bytesPerRow + gpuRow);
          const dstAddr = t.shadow + l.offset + (rd.z + z) * l.slicePitch + (y0 + row) * l.rowPitch + x0;
          if (t.unconvert) { const tmp = new Uint8Array(appRow); t.unconvert(src, gpuRow, tmp, appRow, rd.w, 1); mem.write(dstAddr, tmp); }
          else mem.write(dstAddr, src.subarray(0, appRow));
        }
      }
      r.buf.unmap();
      r.buf.destroy();
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // shared GPU helpers
  // ------------------------------------------------------------------------------------------------------------------
  bindGroupLayout(key: string, entries: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout {
    let l = this.bgls.get(key);
    if (!l) { l = this.gpu.device.createBindGroupLayout({ entries }); this.bgls.set(key, l); }
    return l;
  }
  emptyLayout(): GPUBindGroupLayout { return this.bindGroupLayout("empty", []); }
  private zeroCache = new Map<number, { epoch: number; off: number }>();
  zeroUniform(bytes: number): number {
    const z = this.zeroCache.get(bytes);
    if (z && z.epoch === this.gpu.ringEpoch) return z.off;
    const off = this.gpu.pushUniform(new Uint8Array(bytes));
    this.zeroCache.set(bytes, { epoch: this.gpu.ringEpoch, off });
    return off;
  }
  private defSampler: SamplerState11 | null = null;
  defaultSampler(): SamplerState11 {
    if (!this.defSampler) {
      const s = new SamplerState11();
      s.dev = this; s.filter = 0x15; s.addrU = s.addrV = s.addrW = 3; s.maxLod = 1000;
      s.build();
      this.defSampler = s;
    }
    return this.defSampler;
  }
  private cmpSampler: GPUSampler | null = null;
  comparisonSampler(): GPUSampler {
    return (this.cmpSampler ??= this.gpu.device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear" }));
  }
  private nearSampler: GPUSampler | null = null;
  nearestSampler(): GPUSampler {
    return (this.nearSampler ??= this.gpu.device.createSampler({ magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" }));
  }
  private nullFrag: GPUShaderModule | null = null;
  nullFragment(): GPUShaderModule {
    return (this.nullFrag ??= this.gpu.device.createShaderModule({ code: "@fragment fn main() {}" }));
  }
  private defDs: DepthStencilState11 | null = null;
  defaultDepthStencil(): DepthStencilState11 {
    if (!this.defDs) { const d = new DepthStencilState11(); d.dev = this; d.depthEnable = true; d.depthWrite = true; d.depthFunc = 2; this.defDs = d; }
    return this.defDs;
  }
  private dummyStore: GPUBuffer | null = null;
  dummyStorage(): GPUBuffer {
    return (this.dummyStore ??= this.gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  }
  private dummies = new Map<string, GPUTextureView>();
  dummyTexture(vdim: GPUTextureViewDimension, st: GPUTextureSampleType, ms: boolean): GPUTextureView {
    const key = `${vdim}|${st}|${ms}`;
    let v = this.dummies.get(key);
    if (v) return v;
    const fmt: GPUTextureFormat = st === "uint" ? "rgba8uint" : st === "sint" ? "rgba8sint" : st === "depth" ? "depth32float" : st === "unfilterable-float" ? "r32float" : "rgba8unorm";
    const layers = vdim === "cube" ? 6 : vdim === "cube-array" ? 6 : 1;
    const dim: GPUTextureDimension = vdim === "1d" ? "1d" : vdim === "3d" ? "3d" : "2d";
    const tex = this.gpu.device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: dim === "2d" ? layers : 1 }, format: fmt, dimension: dim, sampleCount: ms ? 4 : 1,
      usage: ms ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    v = tex.createView({ dimension: vdim });
    this.dummies.set(key, v);
    return v;
  }
  dummyStorageTexture(vdim: GPUTextureViewDimension, fmt: GPUTextureFormat): GPUTextureView {
    const key = `S${vdim}|${fmt}`;
    let v = this.dummies.get(key);
    if (v) return v;
    const dim: GPUTextureDimension = vdim === "1d" ? "1d" : vdim === "3d" ? "3d" : "2d";
    const tex = this.gpu.device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, format: fmt, dimension: dim, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    v = tex.createView({ dimension: vdim });
    this.dummies.set(key, v);
    return v;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // object construction helpers
  // ------------------------------------------------------------------------------------------------------------------
  private make<T extends ComObject>(obj: T, ifaces: string[]): T { return this.rt.create(obj, ifaces); }
  makeCommandList(ops: CommandList11["ops"]): CommandList11 {
    const l = new CommandList11();
    this.make(l, ["ID3D11CommandList", "ID3D11DeviceChild"]);
    l.attach(this);
    l.ops = ops;
    return l;
  }
  private ret(c: Cpu, idx: number, o: ComObject): number {
    const out = c.arg(idx);
    if (!out) { o.refs = 1; o.Release(null as any); return E.S_FALSE; }
    this.p.mem.wptr(out, o.ptr);
    return 0;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // ID3D11Device resources
  // ------------------------------------------------------------------------------------------------------------------
  private readInit(addr: number, count: number): { ptr: number; pitch: number; slice: number }[] | null {
    if (!addr) return null;
    const m = this.p.mem, out = [];
    for (let i = 0; i < count; i++) out.push({ ptr: m.r32(addr + i * 16), pitch: m.r32(addr + i * 16 + 8), slice: m.r32(addr + i * 16 + 12) });
    return out;
  }
  CreateBuffer(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    if (!a) return E.INVALIDARG;
    const size = m.r32(a), usage = m.r32(a + 4), bind = m.r32(a + 8), cpu = m.r32(a + 12), misc = m.r32(a + 16), stride = m.r32(a + 20);
    if (!size) return E.INVALIDARG;
    const init = this.readInit(c.arg(2), 1);
    if (usage === USAGE.IMMUTABLE && !init) return E.INVALIDARG;
    if (bind & BIND.STREAM_OUTPUT) this.p.log("[d3d11] stream-output buffers are not supported");
    const b = new Buf11();
    this.make(b, ["ID3D11Buffer", "ID3D11Resource", "ID3D11DeviceChild"]);
    const data = init && init[0].ptr ? m.bytes(init[0].ptr, size) : null;
    const r = b.init(this, size, usage, bind, cpu, misc, stride, data);
    if (r) return r;
    return this.ret(c, 3, b);
  }
  private createTexture(c: Cpu, dim: number): number {
    const m = this.p.mem, a = c.arg(1);
    if (!a) return E.INVALIDARG;
    let w: number, h: number, dOrA: number, mips: number, fmt: number, usage: number, bind: number, cpu: number, misc: number, samples = 1;
    if (dim === 1) { w = m.r32(a); h = 1; mips = m.r32(a + 4); dOrA = m.r32(a + 8); fmt = m.r32(a + 12); usage = m.r32(a + 16); bind = m.r32(a + 20); cpu = m.r32(a + 24); misc = m.r32(a + 28); }
    else if (dim === 2) { w = m.r32(a); h = m.r32(a + 4); mips = m.r32(a + 8); dOrA = m.r32(a + 12); fmt = m.r32(a + 16); samples = m.r32(a + 20); usage = m.r32(a + 28); bind = m.r32(a + 32); cpu = m.r32(a + 36); misc = m.r32(a + 40); }
    else { w = m.r32(a); h = m.r32(a + 4); dOrA = m.r32(a + 8); mips = m.r32(a + 12); fmt = m.r32(a + 16); usage = m.r32(a + 20); bind = m.r32(a + 24); cpu = m.r32(a + 28); misc = m.r32(a + 32); }
    const t = new Tex11();
    this.make(t, [dim === 1 ? "ID3D11Texture1D" : dim === 2 ? "ID3D11Texture2D" : "ID3D11Texture3D", "ID3D11Resource", "ID3D11DeviceChild", "IDXGISurface1", "IDXGISurface", "IDXGIResource", "IDXGIDeviceSubObject", "IDXGIObject"]);
    const r = t.init(this, dim, w, h, dOrA, mips, fmt, usage, bind, cpu, misc, samples);
    if (r) { t.destroyed = true; this.rt.free(t); return r; }
    const init = this.readInit(c.arg(2), t.subresources);
    if (init) {
      const ctx = this.immediate, mem = this.p.mem;
      for (let s = 0; s < t.subresources; s++) {
        const i = init[s], l = t.layouts[s];
        if (!i.ptr) continue;
        const rowPitch = i.pitch || l.rowPitch, slicePitch = i.slice || rowPitch * (t.fmt.block > 1 ? Math.ceil(l.h / t.fmt.block) : l.h);
        const rows = t.fmt.block > 1 ? Math.ceil(l.h / t.fmt.block) : l.h;
        const total = (l.d - 1) * slicePitch + (rows - 1) * rowPitch + l.rowPitch;
        const bytes = mem.bytes(i.ptr, total);
        if (t.shadow) for (let z = 0; z < l.d; z++) for (let y = 0; y < rows; y++) mem.write(t.shadow + l.offset + z * l.slicePitch + y * l.rowPitch, bytes.subarray(z * slicePitch + y * rowPitch, z * slicePitch + y * rowPitch + l.rowPitch));
        if (t.gpu) ctx.upload(t, s, 0, 0, 0, l.w, l.h, l.d, bytes, rowPitch, slicePitch);
      }
    }
    return this.ret(c, 3, t);
  }
  CreateTexture1D(c: Cpu): number { return this.createTexture(c, 1); }
  CreateTexture2D(c: Cpu): number { return this.createTexture(c, 2); }
  CreateTexture3D(c: Cpu): number { return this.createTexture(c, 3); }

  private readViewDesc(a: number, kind: "srv" | "rtv" | "dsv" | "uav"): ViewDesc | null {
    if (!a) return null;
    const m = this.p.mem;
    const d: ViewDesc = { fmt: m.r32(a), dim: m.r32(a + 4), mostDetailedMip: 0, mipLevels: 0, firstSlice: 0, arraySize: 0, firstElement: 0, numElements: 0, flags: 0, firstW: 0, wSize: 0 };
    const u = a + 8;
    if (kind === "srv") {
      switch (d.dim) {
        case 1: d.firstElement = m.r32(u); d.numElements = m.r32(u + 4); break;
        case 11: d.firstElement = m.r32(u); d.numElements = m.r32(u + 4); d.flags = m.r32(u + 8); break;
        case 2: case 4: case 8: case 9: d.mostDetailedMip = m.r32(u); d.mipLevels = m.r32(u + 4); break;
        case 3: case 5: d.mostDetailedMip = m.r32(u); d.mipLevels = m.r32(u + 4); d.firstSlice = m.r32(u + 8); d.arraySize = m.r32(u + 12); break;
        case 7: d.firstSlice = m.r32(u); d.arraySize = m.r32(u + 4); break;
        case 10: d.mostDetailedMip = m.r32(u); d.mipLevels = m.r32(u + 4); d.firstSlice = m.r32(u + 8); d.arraySize = m.r32(u + 12) * 6; break;
      }
    } else if (kind === "rtv") {
      switch (d.dim) {
        case 1: d.firstElement = m.r32(u); d.numElements = m.r32(u + 4); break;
        case 2: case 4: d.mostDetailedMip = m.r32(u); break;
        case 3: case 5: d.mostDetailedMip = m.r32(u); d.firstSlice = m.r32(u + 4); d.arraySize = m.r32(u + 8); break;
        case 7: d.firstSlice = m.r32(u); d.arraySize = m.r32(u + 4); break;
        case 8: d.mostDetailedMip = m.r32(u); d.firstW = m.r32(u + 4); d.wSize = m.r32(u + 8); break;
      }
    } else if (kind === "dsv") {
      d.flags = m.r32(a + 8);
      const uu = a + 12;
      switch (d.dim) {
        case 1: case 3: d.mostDetailedMip = m.r32(uu); break;
        case 2: case 4: d.mostDetailedMip = m.r32(uu); d.firstSlice = m.r32(uu + 4); d.arraySize = m.r32(uu + 8); break;
        case 6: d.firstSlice = m.r32(uu); d.arraySize = m.r32(uu + 4); break;
      }
    } else {
      switch (d.dim) {
        case 1: d.firstElement = m.r32(u); d.numElements = m.r32(u + 4); d.flags = m.r32(u + 8); break;
        case 2: case 4: d.mostDetailedMip = m.r32(u); break;
        case 3: case 5: d.mostDetailedMip = m.r32(u); d.firstSlice = m.r32(u + 4); d.arraySize = m.r32(u + 8); break;
        case 8: d.mostDetailedMip = m.r32(u); d.firstW = m.r32(u + 4); d.wSize = m.r32(u + 8); break;
      }
    }
    return d;
  }
  CreateShaderResourceView(c: Cpu): number {
    const res = this.rt.objectAt(c.arg(1)) as Resource11 | undefined;
    if (!res || !(res instanceof Buf11 || res instanceof Tex11)) return E.INVALIDARG;
    if (res instanceof Tex11 && !res.gpu) return E.INVALIDARG;
    const v = new SRV11();
    this.make(v, ["ID3D11ShaderResourceView1", "ID3D11ShaderResourceView", "ID3D11View", "ID3D11DeviceChild"]);
    const r = v.init(this, res, this.readViewDesc(c.arg(2), "srv"));
    if (r) return r;
    return this.ret(c, 3, v);
  }
  CreateRenderTargetView(c: Cpu): number {
    const res = this.rt.objectAt(c.arg(1)) as Resource11 | undefined;
    if (!(res instanceof Tex11) || !res.gpu) return E.INVALIDARG;
    const v = new RTV11();
    this.make(v, ["ID3D11RenderTargetView1", "ID3D11RenderTargetView", "ID3D11View", "ID3D11DeviceChild"]);
    const r = v.init(this, res, this.readViewDesc(c.arg(2), "rtv"));
    if (r) return r;
    return this.ret(c, 3, v);
  }
  CreateDepthStencilView(c: Cpu): number {
    const res = this.rt.objectAt(c.arg(1)) as Resource11 | undefined;
    if (!(res instanceof Tex11) || !res.gpu) return E.INVALIDARG;
    const v = new DSV11();
    this.make(v, ["ID3D11DepthStencilView", "ID3D11View", "ID3D11DeviceChild"]);
    const r = v.init(this, res, this.readViewDesc(c.arg(2), "dsv"));
    if (r) return r;
    return this.ret(c, 3, v);
  }
  CreateUnorderedAccessView(c: Cpu): number {
    const res = this.rt.objectAt(c.arg(1)) as Resource11 | undefined;
    if (!res || !(res instanceof Buf11 || res instanceof Tex11)) return E.INVALIDARG;
    const v = new UAV11();
    this.make(v, ["ID3D11UnorderedAccessView1", "ID3D11UnorderedAccessView", "ID3D11View", "ID3D11DeviceChild"]);
    const r = v.init(this, res, this.readViewDesc(c.arg(2), "uav"));
    if (r) return r;
    return this.ret(c, 3, v);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // shaders and layouts
  // ------------------------------------------------------------------------------------------------------------------
  private createShader(c: Cpu, stage: ShaderStage, outIdx: number): number {
    const code = c.arg(1), len = c.arg(2);
    if (!code || !len) return E.INVALIDARG;
    const sh = new Shader11();
    const iface = { vs: "ID3D11VertexShader", ps: "ID3D11PixelShader", gs: "ID3D11GeometryShader", hs: "ID3D11HullShader", ds: "ID3D11DomainShader", cs: "ID3D11ComputeShader" }[stage];
    this.make(sh, [iface, "ID3D11DeviceChild"]);
    const r = sh.init(this, stage, this.p.mem.bytes(code, len));
    if (r) { sh.destroyed = true; this.rt.free(sh); return r; }
    return this.ret(c, outIdx, sh);
  }
  CreateVertexShader(c: Cpu): number { return this.createShader(c, "vs", 4); }
  CreatePixelShader(c: Cpu): number { return this.createShader(c, "ps", 4); }
  CreateGeometryShader(c: Cpu): number { return this.createShader(c, "gs", 4); }
  CreateHullShader(c: Cpu): number { return this.createShader(c, "hs", 4); }
  CreateDomainShader(c: Cpu): number { return this.createShader(c, "ds", 4); }
  CreateComputeShader(c: Cpu): number { return this.createShader(c, "cs", 4); }
  CreateGeometryShaderWithStreamOutput(c: Cpu): number { return this.createShader(c, "gs", 9); }
  CreateClassLinkage(c: Cpu): number {
    const l = new ClassLinkage11();
    this.make(l, ["ID3D11ClassLinkage", "ID3D11DeviceChild"]);
    l.attach(this);
    return this.ret(c, 1, l);
  }
  CreateInputLayout(c: Cpu): number {
    const m = this.p.mem, pe = c.arg(1), n = c.arg(2), code = c.arg(3), len = c.arg(4);
    if (!pe || !n || !code) return E.INVALIDARG;
    const il = new InputLayout11();
    const els: InputElement[] = [];
    const next = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const a = pe + i * 32;
      const name = m.cstr(m.r32(a)), index = m.r32(a + 8), format = m.r32(a + 12), slot = m.r32(a + 16);
      let off = m.r32(a + 20);
      const cls = m.r32(a + 24), rate = m.r32(a + 28);
      if (off === KEEP_ALIGNED) off = next.get(slot) ?? 0;
      const sz = fmt11(format)?.bytes ?? 4;
      next.set(slot, off + sz);
      els.push({ name, index, format, slot, offset: off, perInstance: cls === 1, stepRate: rate });
      if (!vertexFormat(format)) this.p.log(`[d3d11] input element ${name}${index} uses format ${format}, which cannot be fetched by the WebGPU input assembler`);
    }
    try { il.sig = parseDxbc(m.bytes(code, len)); } catch { return E.INVALIDARG; }
    this.make(il, ["ID3D11InputLayout", "ID3D11DeviceChild"]);
    il.attach(this);
    il.elements = els;
    return this.ret(c, 5, il);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // state objects
  // ------------------------------------------------------------------------------------------------------------------
  CreateBlendState(c: Cpu): number {
    const s = new BlendState11();
    this.make(s, ["ID3D11BlendState1", "ID3D11BlendState", "ID3D11DeviceChild"]);
    s.attach(this);
    s.decode(this.p.mem, c.arg(1), 8);
    return this.ret(c, 2, s);
  }
  CreateBlendState1(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    const s = new BlendState11();
    this.make(s, ["ID3D11BlendState1", "ID3D11BlendState", "ID3D11DeviceChild"]);
    s.attach(this);
    s.alphaToCoverage = m.r32(a) !== 0; s.independent = m.r32(a + 4) !== 0;
    s.targets = [];
    for (let i = 0; i < 8; i++) {
      const b = a + 8 + i * 40;
      s.targets.push({ enable: m.r32(b) !== 0, src: m.r32(b + 8), dst: m.r32(b + 12), op: m.r32(b + 16), srcA: m.r32(b + 20), dstA: m.r32(b + 24), opA: m.r32(b + 28), mask: m.r8(b + 36) });
    }
    s.key = `${+s.alphaToCoverage}|` + s.targets.map((r, i) => (i > 0 && !s.independent ? "" : `${+r.enable},${r.src},${r.dst},${r.op},${r.srcA},${r.dstA},${r.opA},${r.mask}`)).join("|");
    return this.ret(c, 2, s);
  }
  CreateDepthStencilState(c: Cpu): number {
    const s = new DepthStencilState11();
    this.make(s, ["ID3D11DepthStencilState", "ID3D11DeviceChild"]);
    s.attach(this);
    s.decode(this.p.mem, c.arg(1));
    return this.ret(c, 2, s);
  }
  CreateRasterizerState(c: Cpu): number {
    const s = new RasterizerState11();
    this.make(s, ["ID3D11RasterizerState1", "ID3D11RasterizerState", "ID3D11DeviceChild"]);
    s.attach(this);
    s.decode(this.p.mem, c.arg(1));
    return this.ret(c, 2, s);
  }
  CreateRasterizerState1(c: Cpu): number { return this.CreateRasterizerState(c); }
  CreateSamplerState(c: Cpu): number {
    const s = new SamplerState11();
    this.make(s, ["ID3D11SamplerState", "ID3D11DeviceChild"]);
    s.attach(this);
    s.decode(this.p.mem, c.arg(1));
    s.build();
    return this.ret(c, 2, s);
  }
  private makeQuery(c: Cpu, predicate: boolean): number {
    const m = this.p.mem, a = c.arg(1);
    const q = new Query11();
    this.make(q, predicate ? ["ID3D11Predicate", "ID3D11Query", "ID3D11Asynchronous", "ID3D11DeviceChild"] : ["ID3D11Query", "ID3D11Asynchronous", "ID3D11DeviceChild"]);
    q.attach(this);
    q.qtype = m.r32(a); q.qflags = m.r32(a + 4);
    if (q.qtype === QUERY.TIMESTAMP_DISJOINT || q.qtype === QUERY.TIMESTAMP) q.ready = true;
    q.ready = true;
    return this.ret(c, 2, q);
  }
  CreateQuery(c: Cpu): number { return this.makeQuery(c, false); }
  CreatePredicate(c: Cpu): number { return this.makeQuery(c, true); }
  CreateCounter(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  CreateDeferredContext(c: Cpu): number { return this.deferredContext(c, 2); }
  CreateDeferredContext1(c: Cpu): number { return this.deferredContext(c, 2); }
  private deferredContext(c: Cpu, outIdx: number): number {
    const ctx = new Context11();
    this.make(ctx, ["ID3D11DeviceContext1", "ID3D11DeviceContext", "ID3D11DeviceChild", "ID3DUserDefinedAnnotation"]);
    ctx.init(this, true);
    return this.ret(c, outIdx, ctx);
  }
  CreateDeviceContextState(): number { return E.NOTIMPL; }
  OpenSharedResource(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  OpenSharedResource1(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  OpenSharedResourceByName(): number { return E.DXGI_ERROR_UNSUPPORTED; }

  // ------------------------------------------------------------------------------------------------------------------
  // capability queries
  // ------------------------------------------------------------------------------------------------------------------
  formatSupport(id: number): number {
    const f = fmt11(id);
    if (!f || f.unsupported || !f.gpu) return 0;
    let s = 0;
    const isDepth = !!f.depth;
    if (f.vertex) s |= FS.IA_VERTEX_BUFFER;
    if (id === 57 || id === 42) s |= FS.IA_INDEX_BUFFER;
    if (f.kind !== "typeless" || f.depthGpu) {
      s |= FS.TEXTURE1D | FS.TEXTURE2D | FS.TEXTURE3D | FS.TEXTURECUBE | FS.MIP | FS.SHADER_LOAD | FS.CPU_LOCKABLE | FS.CAST_WITHIN_BIT_LAYOUT;
      if (f.compressed) s &= ~(FS.TEXTURE1D | FS.TEXTURE3D | FS.CPU_LOCKABLE);
      if (f.kind === "typeless") s &= ~(FS.SHADER_LOAD);
      if (!/(uint|sint)/.test(f.kind) && !(/32float/.test(f.gpu) && !this.gpu.hasFloat32Filterable)) s |= FS.SHADER_SAMPLE | FS.SHADER_GATHER;
      if (isDepth || id === 41 || id === 46 || id === 56) s |= FS.SHADER_SAMPLE_COMPARISON | FS.SHADER_GATHER_COMPARISON;
      if (isDepth) s |= FS.DEPTH_STENCIL | FS.MULTISAMPLE_RENDERTARGET | FS.MULTISAMPLE_LOAD;
      else if (!f.compressed && id !== 67 && f.kind !== "typeless") {
        s |= FS.RENDER_TARGET | FS.MIP_AUTOGEN | FS.MULTISAMPLE_RENDERTARGET | FS.MULTISAMPLE_RESOLVE | FS.MULTISAMPLE_LOAD;
        if (!/(uint|sint)/.test(f.kind) && !(/32float/.test(f.gpu) && !this.gpu.hasFloat32Blendable)) s |= FS.BLENDABLE;
        if (/^(rgba8unorm|rgba8snorm|rgba8uint|rgba8sint|rgba16(uint|sint|float)|r32(uint|sint|float)|rg32|rgba32)/.test(f.gpu) && !/srgb/.test(f.gpu)) s |= FS.TYPED_UNORDERED_ACCESS_VIEW;
      }
      if ([2, 10, 24, 28, 29, 87, 91, 88, 93, 41, 34].includes(id)) s |= FS.DISPLAY | FS.BACK_BUFFER_CAST;
    }
    return s;
  }
  CheckFormatSupport(c: Cpu): number {
    const s = this.formatSupport(c.arg(1));
    this.p.mem.w32(c.arg(2), s);
    return s || c.arg(1) === 0 ? 0 : E.INVALIDARG;
  }
  CheckMultisampleQualityLevels(c: Cpu): number {
    const f = c.arg(1), n = c.arg(2);
    const sup = this.formatSupport(f);
    this.p.mem.w32(c.arg(3), n === 1 ? 1 : (n === 2 || n === 4) && (sup & FS.MULTISAMPLE_RENDERTARGET) ? 1 : 0);
    return 0;
  }
  CheckCounterInfo(c: Cpu): void { const a = c.arg(1); this.p.mem.w32(a, 0); this.p.mem.w32(a + 4, 0); this.p.mem.w8(a + 8, 0); }
  CheckCounter(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  CheckFeatureSupport(c: Cpu): number {
    const feature = c.arg(1), data = c.arg(2), size = c.arg(3), m = this.p.mem;
    if (!data) return E.INVALIDARG;
    switch (feature) {
      case 0: m.w32(data, 1); m.w32(data + 4, 0); return 0;
      case 2: { const f = m.r32(data); m.w32(data + 4, this.formatSupport(f)); return 0; }
      case 3: {
        const f = m.r32(data), s = this.formatSupport(f);
        m.w32(data + 4, s & FS.TYPED_UNORDERED_ACCESS_VIEW ? 0x10 | 0x20 | 0x80 | 0x100 : 0);
        return 0;
      }
      case 4: m.w32(data, 1); return 0;
      case 6: m.w32(data, 0); return 0;
      case 7: m.w32(data, 1); return 0;
      default: m.fill(data, 0, size); return 0;
    }
  }
  GetFeatureLevel(): number { return this.featureLevel; }
  GetCreationFlags(): number { return this.creationFlags; }
  GetDeviceRemovedReason(): number { return 0; }
  GetImmediateContext(c: Cpu): void { this.p.mem.wptr(c.arg(1), this.immediate.ptr); this.immediate.refs++; }
  GetImmediateContext1(c: Cpu): void { this.GetImmediateContext(c); }
  SetExceptionMode(c: Cpu): number { this.exceptionMode = c.arg(1); return 0; }
  GetExceptionMode(): number { return this.exceptionMode; }
  // private data (ID3D11Device / IDXGIObject)
  SetPrivateData(c: Cpu): number {
    const mem = this.p.mem, g = mem.bytes(c.arg(1), 16).join(","), size = c.arg(2);
    if (!size) { this.priv.delete(g); return 0; }
    this.priv.set(g, mem.bytes(c.arg(3), size).slice());
    return 0;
  }
  SetPrivateDataInterface(): number { return 0; }
  GetPrivateData(c: Cpu): number {
    const mem = this.p.mem, d = this.priv.get(mem.bytes(c.arg(1), 16).join(",")), szp = c.arg(2);
    if (!d) { if (szp) mem.w32(szp, 0); return E.DXGI_ERROR_NOT_FOUND; }
    const have = szp ? mem.r32(szp) : 0;
    if (szp) mem.w32(szp, d.length);
    if (c.arg(3)) { if (have < d.length) return E.DXGI_ERROR_MORE_DATA; mem.write(c.arg(3), d); }
    return 0;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // IDXGIDevice
  // ------------------------------------------------------------------------------------------------------------------
  GetParent(c: Cpu): number {
    const riid = c.arg(1), out = c.arg(2);
    if (!this.adapterObj) return E.DXGI_ERROR_NOT_FOUND;
    const a = this.adapterObj;
    const g = guidToString(this.p.mem, riid);
    void g;
    // QueryInterface on the adapter with the requested IID
    return a.QueryInterface({ arg: (i: number) => [a.ptr, riid, out][i] } as any);
  }
  GetAdapter(c: Cpu): number {
    if (!this.adapterObj) return E.DXGI_ERROR_NOT_FOUND;
    this.p.mem.wptr(c.arg(1), this.adapterObj.ptrFor("IDXGIAdapter"));
    this.adapterObj.refs++;
    return 0;
  }
  CreateSurface(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  QueryResourceResidency(c: Cpu): number { const n = c.arg(3); for (let i = 0; i < n; i++) this.p.mem.w32(c.arg(2) + i * 4, 1); return 0; }
  SetGPUThreadPriority(c: Cpu): number { this.priority = c.argI(1); return 0; }
  GetGPUThreadPriority(c: Cpu): number { this.p.mem.w32(c.arg(1), this.priority >>> 0); return 0; }
  SetMaximumFrameLatency(c: Cpu): number { this.frameLatency = c.arg(1) || 3; return 0; }
  GetMaximumFrameLatency(c: Cpu): number { this.p.mem.w32(c.arg(1), this.frameLatency); return 0; }
  OfferResources(): number { return 0; }
  ReclaimResources(): number { return 0; }
  EnqueueSetEvent(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  // ID3D11Multithread
  Enter(): void {}
  Leave(): void {}
  SetMultithreadProtected(): number { return 0; }
  GetMultithreadProtected(): number { return 1; }
}

void CPU; void MISC; void resolveGpuFormat; void Resource11;
