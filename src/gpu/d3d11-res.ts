// Direct3D 11 objects: resources (buffers, textures), views, state objects, shaders, queries.
import { ComObject } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import { BIND, CPU, E, MAP, MISC, SRV_DIM, USAGE, QUERY, UAV_DIM, DSV_DIM, RTV_DIM, CMP, STENCIL_OP, BLEND_OP, blendFactor } from "./d3d11-consts.ts";
import { fmt11, mipCount, mipDim, resolveGpuFormat, subresourceLayouts } from "./dxgi-fmt.ts";
import type { Fmt11, SubLayout } from "./dxgi-fmt.ts";
import { parseDxbc } from "./sm5.ts";
import type { Sm5Shader } from "./sm5.ts";
import type { Device11 } from "./d3d11-dev.ts";

let nextUid = 1;

/** common ID3D11DeviceChild behaviour */
export class DeviceChild11 extends ComObject {
  dev!: Device11;
  uid = nextUid++;
  priv = new Map<string, Uint8Array>();
  name = "";
  /** Gpu submit generation of the last recorded GPU use (orders CPU writes against unsubmitted commands) */
  usedGen = -1;

  attach(dev: Device11) {
    this.dev = dev;
    dev.refs++;
    this.onDestroy = () => { dev.Release(null as any); };
  }
  GetDevice(c: Cpu): number {
    const out = c.arg(1);
    if (!out) return E.INVALIDARG;
    this.rt.p.mem.wptr(out, this.dev.ptr);
    this.dev.refs++;
    return 0;
  }
  SetPrivateData(c: Cpu): number {
    const mem = this.rt.p.mem;
    const g = mem.bytes(c.arg(1), 16).join(",");
    const size = c.arg(2);
    if (size === 0 && !c.arg(3)) { this.priv.delete(g); return 0; }
    this.priv.set(g, mem.bytes(c.arg(3), size).slice());
    return 0;
  }
  SetPrivateDataInterface(c: Cpu): number {
    const mem = this.rt.p.mem;
    const g = mem.bytes(c.arg(1), 16).join(",");
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, c.arg(2), true);
    this.priv.set(g, buf);
    return 0;
  }
  GetPrivateData(c: Cpu): number {
    const mem = this.rt.p.mem;
    const d = this.priv.get(mem.bytes(c.arg(1), 16).join(","));
    const szp = c.arg(2);
    if (!d) { if (szp) mem.w32(szp, 0); return E.DXGI_ERROR_NOT_FOUND; }
    const have = szp ? mem.r32(szp) : 0;
    if (szp) mem.w32(szp, d.length);
    if (c.arg(3)) { if (have < d.length) return E.DXGI_ERROR_MORE_DATA; mem.write(c.arg(3), d); }
    return 0;
  }
  /** IDXGIObject::GetParent default: the device */
  GetParent(c: Cpu): number { return this.dev.GetParent(c); }
  SetDebugObjectName(): number { return 0; }
}

// ----------------------------------------------------------------------------------------------------------------------
// resources
// ----------------------------------------------------------------------------------------------------------------------
export class Resource11 extends DeviceChild11 {
  usage = 0;
  bind = 0;
  cpu = 0;
  misc = 0;
  evictionPriority = 0;
  /** resource type for GetType: 1 buffer, 2 tex1d, 3 tex2d, 4 tex3d */
  rtype = 0;
  mapState: { sub: number; type: number } | null = null;
  GetType(c: Cpu): void { this.rt.p.mem.w32(c.arg(1), this.rtype); }
  SetEvictionPriority(c: Cpu): void { this.evictionPriority = c.arg(1); }
  GetEvictionPriority(): number { return this.evictionPriority; }
  // IDXGIResource
  GetSharedHandle(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), 0); return E.DXGI_ERROR_UNSUPPORTED; }
  GetUsage(c: Cpu): number { this.rt.p.mem.w32(c.arg(1), 0x20 | 0x80); return 0; }
}

export class Buf11 extends Resource11 {
  size = 0;
  stride = 0;
  gpu: GPUBuffer | null = null;
  /** incremented when `gpu` is replaced (renaming) so cached bind groups are dropped */
  gpuId = 0;
  /** guest-memory shadow (constant buffers, dynamic and staging buffers) */
  shadow = 0;
  /** what the GPU buffer currently holds (dynamic buffers), used to upload only changed ranges */
  mirror: Uint8Array | null = null;
  /** bumped when the contents change (constant buffers) */
  version = 1;
  pendingReads: { buf: GPUBuffer; srcOffset: number; dstOffset: number; size: number }[] = [];
  /** constant-buffer ring cache */
  ringEpoch = -1; ringKey = ""; ringOffset = 0;
  get isCB(): boolean { return (this.bind & BIND.CONSTANT_BUFFER) !== 0; }

  init(dev: Device11, size: number, usage: number, bind: number, cpu: number, misc: number, stride: number, initial: Uint8Array | null): number {
    this.attach(dev);
    this.rtype = 1;
    this.size = size; this.usage = usage; this.bind = bind; this.cpu = cpu; this.misc = misc; this.stride = stride;
    const mem = dev.p.vm;
    const needShadow = this.isCB || usage === USAGE.STAGING || usage === USAGE.DYNAMIC || (cpu & (CPU.READ | CPU.WRITE)) !== 0;
    if (needShadow) this.shadow = mem.alloc(Math.max(16, (size + 15) & ~15), { commit: true, tag: "d3d11-buffer" });
    if (initial && this.shadow) dev.p.mem.write(this.shadow, initial.subarray(0, size));
    if (this.isCB || usage === USAGE.STAGING) return 0;
    let u = GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    if (bind & BIND.VERTEX_BUFFER) u |= GPUBufferUsage.VERTEX;
    if (bind & BIND.INDEX_BUFFER) u |= GPUBufferUsage.INDEX;
    if (bind & (BIND.SHADER_RESOURCE | BIND.UNORDERED_ACCESS) || misc & (MISC.RAW_VIEWS | MISC.STRUCTURED)) u |= GPUBufferUsage.STORAGE;
    if (misc & MISC.DRAWINDIRECT_ARGS) u |= GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE;
    this.gpu = dev.gpu.createBuffer(size, u, "d3d11 buffer " + this.uid);
    if (initial) dev.gpu.writeBuffer(this.gpu, 0, initial.subarray(0, size));
    if (usage === USAGE.DYNAMIC || (cpu & CPU.WRITE)) { this.mirror = new Uint8Array((size + 3) & ~3); if (initial) this.mirror.set(initial.subarray(0, size)); }
    return 0;
  }
  /** replace the GPU buffer by a fresh one (the old contents stay valid for commands already recorded) */
  rename() {
    if (!this.gpu) return;
    const g = this.dev.gpu;
    g.deferDestroy(this.gpu);
    this.gpu = g.createBuffer(this.size, this.gpu.usage, "d3d11 buffer " + this.uid);
    this.gpuId++;
    if (this.mirror) this.mirror.fill(0);
  }
  /** push shadow changes to the GPU buffer (dynamic buffers) */
  uploadShadow(start = 0, end = this.size) {
    if (!this.gpu || !this.shadow) return;
    const dev = this.dev, mem = dev.p.mem;
    start &= ~3; end = Math.min((end + 3) & ~3, (this.size + 3) & ~3);
    const cur = mem.bytes(this.shadow, end);
    const mir = this.mirror!;
    // coalesce changed 64-byte chunks into upload runs
    const CH = 64;
    let runStart = -1;
    for (let o = start; o < end; o += CH) {
      const n = Math.min(CH, end - o);
      let same = true;
      for (let i = 0; i < n; i += 4) { if (cur[o + i] !== mir[o + i] || cur[o + i + 1] !== mir[o + i + 1] || cur[o + i + 2] !== mir[o + i + 2] || cur[o + i + 3] !== mir[o + i + 3]) { same = false; break; } }
      if (!same) { if (runStart < 0) runStart = o; } else if (runStart >= 0) { this.flushRun(cur, runStart, o); runStart = -1; }
    }
    if (runStart >= 0) this.flushRun(cur, runStart, end);
  }
  private flushRun(cur: Uint8Array, a: number, b: number) {
    this.mirror!.set(cur.subarray(a, b), a);
    this.dev.gpu.writeBuffer(this.gpu!, a, cur.subarray(a, b));
  }
  GetDesc(c: Cpu): void {
    const m = this.rt.p.mem, a = c.arg(1);
    m.w32(a, this.size); m.w32(a + 4, this.usage); m.w32(a + 8, this.bind); m.w32(a + 12, this.cpu); m.w32(a + 16, this.misc); m.w32(a + 20, this.stride);
  }
  destroy() {
    if (this.gpu) this.dev.gpu.deferDestroy(this.gpu);
    this.gpu = null;
    if (this.shadow) this.dev.p.vm.release(this.shadow);
    this.shadow = 0;
    for (const r of this.pendingReads) r.buf.destroy();
    this.pendingReads = [];
  }
}

export interface PendingRead {
  buf: GPUBuffer;
  bytesPerRow: number;
  rows: number;
  /** destination subresource and origin within it (in texels/blocks as copied) */
  sub: number;
  x: number; y: number; z: number;
  w: number; h: number; d: number;
}

export class Tex11 extends Resource11 {
  dim = 2;
  w = 1; h = 1; depth = 1; mips = 1; arrays = 1;
  fmtId = 0;
  fmt!: Fmt11;
  gpuFmt: GPUTextureFormat = "rgba8unorm";
  gpuBytes = 4;
  convert: Fmt11["convert"];
  unconvert: Fmt11["unconvert"];
  samples = 1;
  gpuSamples = 1;
  isCube = false;
  gpu: GPUTexture | null = null;
  layouts: SubLayout[] = [];
  /** guest memory shadow of all subresources (dynamic and staging textures) */
  shadow = 0;
  shadowSize = 0;
  pendingReads: PendingRead[] = [];
  /** swap-chain back buffers */
  backBuffer = false;
  /** GPU extent of mip 0 (block-compressed textures are rounded up to whole blocks) */
  gw = 1; gh = 1;
  /** the texture is cleared by pending clears through this full view */
  fullView: GPUTextureView | null = null;

  get subresources(): number { return this.mips * this.arrays; }

  init(dev: Device11, dim: number, w: number, h: number, depthOrArray: number, mips: number, fmtId: number, usage: number, bind: number, cpu: number, misc: number, samples: number): number {
    const f = fmt11(fmtId);
    if (!f || f.unsupported || !f.gpu) { dev.p.log(`[d3d11] unsupported texture format ${fmtId}`); return E.INVALIDARG; }
    if (w < 1 || h < 1) return E.INVALIDARG;
    this.attach(dev);
    this.rtype = dim + 1;
    this.dim = dim; this.w = w; this.h = h; this.fmtId = fmtId; this.fmt = f;
    this.usage = usage; this.bind = bind; this.cpu = cpu; this.misc = misc; this.samples = Math.max(1, samples);
    this.gpuSamples = this.samples > 1 ? 4 : 1;
    if (dim === 3) { this.depth = depthOrArray; this.arrays = 1; } else { this.depth = 1; this.arrays = Math.max(1, depthOrArray); }
    this.isCube = (misc & MISC.TEXTURECUBE) !== 0;
    const maxMips = mipCount(w, h, dim === 3 ? this.depth : 1);
    this.mips = this.gpuSamples > 1 ? 1 : mips === 0 ? maxMips : Math.min(mips, maxMips);
    const r = resolveGpuFormat(f, (bind & BIND.DEPTH_STENCIL) !== 0, { tier1: dev.gpu.features.has("texture-formats-tier1") });
    if (!r) return E.INVALIDARG;
    this.gpuFmt = r.gpu; this.gpuBytes = r.gpuBytes; this.convert = r.convert; this.unconvert = r.unconvert;
    const lay = subresourceLayouts(f, w, h, this.depth, this.mips, this.arrays);
    this.layouts = lay.subs;
    this.gw = f.block > 1 ? Math.ceil(w / f.block) * f.block : w;
    this.gh = f.block > 1 ? Math.ceil(h / f.block) * f.block : h;
    const cpuAccess = usage === USAGE.STAGING || usage === USAGE.DYNAMIC || (cpu & (CPU.READ | CPU.WRITE)) !== 0;
    if (cpuAccess) {
      this.shadowSize = lay.total;
      this.shadow = dev.p.vm.alloc(Math.max(16, lay.total), { commit: true, tag: "d3d11-texture" });
    }
    if (usage === USAGE.STAGING) return 0;
    if (f.compressed && !dev.gpu.hasBC) { dev.p.log("[d3d11] block-compressed texture without texture-compression-bc support"); return E.INVALIDARG; }
    let u = GPUTextureUsage.TEXTURE_BINDING;
    if (this.gpuSamples === 1) u |= GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    if (bind & (BIND.RENDER_TARGET | BIND.DEPTH_STENCIL) || misc & MISC.GENERATE_MIPS || this.gpuSamples > 1) u |= GPUTextureUsage.RENDER_ATTACHMENT;
    if (bind & BIND.UNORDERED_ACCESS) u |= GPUTextureUsage.STORAGE_BINDING;
    const viewFormats: GPUTextureFormat[] = [];
    if (f.srgbGpu && this.gpuFmt === f.gpu && f.srgbGpu !== this.gpuFmt) viewFormats.push(f.srgbGpu);
    else if (this.gpuFmt.endsWith("-srgb")) viewFormats.push(this.gpuFmt.replace("-srgb", "") as GPUTextureFormat);
    const gdim: GPUTextureDimension = dim === 1 ? "1d" : dim === 3 ? "3d" : "2d";
    this.gpu = dev.gpu.device.createTexture({
      size: { width: this.gw, height: dim === 1 ? 1 : this.gh, depthOrArrayLayers: dim === 3 ? this.depth : dim === 1 ? 1 : this.arrays },
      mipLevelCount: dim === 1 ? 1 : this.mips, sampleCount: this.gpuSamples, dimension: gdim, format: this.gpuFmt, usage: u, viewFormats,
      label: `d3d11 tex ${this.uid} ${f.name}`,
    });
    return 0;
  }
  subIndex(mip: number, arr: number): number { return mip + arr * this.mips; }
  /** WebGPU format a view of this texture uses for a DXGI view format */
  viewFormat(viewFmtId: number): GPUTextureFormat {
    if (!viewFmtId) return this.gpuFmt;
    const vf = fmt11(viewFmtId);
    if (!vf || vf.aspect) return this.gpuFmt;
    const base = this.gpuFmt;
    if (vf.kind === "srgb") return base.endsWith("-srgb") ? base : ((this.fmt.srgbGpu ?? base) as GPUTextureFormat);
    if (base.endsWith("-srgb")) return base;
    return base;
  }
  GetDesc(c: Cpu): void {
    const m = this.rt.p.mem, a = c.arg(1);
    if (this.dim === 1) { m.w32(a, this.w); m.w32(a + 4, this.mips); m.w32(a + 8, this.arrays); m.w32(a + 12, this.fmtId); m.w32(a + 16, this.usage); m.w32(a + 20, this.bind); m.w32(a + 24, this.cpu); m.w32(a + 28, this.misc); }
    else if (this.dim === 2) { m.w32(a, this.w); m.w32(a + 4, this.h); m.w32(a + 8, this.mips); m.w32(a + 12, this.arrays); m.w32(a + 16, this.fmtId); m.w32(a + 20, this.samples); m.w32(a + 24, 0); m.w32(a + 28, this.usage); m.w32(a + 32, this.bind); m.w32(a + 36, this.cpu); m.w32(a + 40, this.misc); }
    else { m.w32(a, this.w); m.w32(a + 4, this.h); m.w32(a + 8, this.depth); m.w32(a + 12, this.mips); m.w32(a + 16, this.fmtId); m.w32(a + 20, this.usage); m.w32(a + 24, this.bind); m.w32(a + 28, this.cpu); m.w32(a + 32, this.misc); }
  }
  // IDXGISurface
  IDXGISurface_GetDesc(c: Cpu): number {
    const m = this.rt.p.mem, a = c.arg(1);
    m.w32(a, this.w); m.w32(a + 4, this.h); m.w32(a + 8, this.fmtId); m.w32(a + 12, this.samples); m.w32(a + 16, 0);
    return 0;
  }
  /** mip 0 / layer 0 as a 2D view in the texture's own format (presentation, clears) */
  full(): GPUTextureView {
    this.fullView ??= this.gpu!.createView({ format: this.gpuFmt, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
    return this.fullView;
  }
  destroy() {
    if (this.gpu) this.dev.gpu.deferDestroy(this.gpu);
    this.gpu = null;
    this.fullView = null;
    if (this.shadow) this.dev.p.vm.release(this.shadow);
    this.shadow = 0;
    for (const r of this.pendingReads) r.buf.destroy();
    this.pendingReads = [];
  }
}

// ----------------------------------------------------------------------------------------------------------------------
// views
// ----------------------------------------------------------------------------------------------------------------------
export interface ViewDesc {
  fmt: number;
  dim: number;
  mostDetailedMip: number;
  mipLevels: number;
  firstSlice: number;
  arraySize: number;
  /** buffer views */
  firstElement: number;
  numElements: number;
  flags: number;
  /** 3D render target slices */
  firstW: number;
  wSize: number;
}
const blankDesc = (): ViewDesc => ({ fmt: 0, dim: 0, mostDetailedMip: 0, mipLevels: 0, firstSlice: 0, arraySize: 0, firstElement: 0, numElements: 0, flags: 0, firstW: 0, wSize: 0 });

export class View11 extends DeviceChild11 {
  res!: Resource11;
  desc: ViewDesc = blankDesc();
  attachView(dev: Device11, res: Resource11) {
    this.attach(dev);
    this.res = res;
    res.refs++;
    const base = this.onDestroy;
    this.onDestroy = () => { base?.(); res.Release(null as any); };
  }
  GetResource(c: Cpu): void {
    this.rt.p.mem.wptr(c.arg(1), this.res.ptr);
    this.res.refs++;
  }
  get tex(): Tex11 { return this.res as Tex11; }
  get buf(): Buf11 { return this.res as Buf11; }
  get isBuffer(): boolean { return this.res instanceof Buf11; }
}

export class SRV11 extends View11 {
  /** cached GPU views by shader dimension */
  views = new Map<string, GPUTextureView>();
  init(dev: Device11, res: Resource11, d: ViewDesc | null): number {
    this.attachView(dev, res);
    if (res instanceof Buf11) {
      const desc = d ?? { ...blankDesc(), dim: SRV_DIM.BUFFER, numElements: res.stride ? res.size / res.stride : res.size / 4 };
      this.desc = desc;
      if (!desc.numElements) desc.numElements = res.stride ? res.size / res.stride : res.size / 4;
      return 0;
    }
    const t = res as Tex11;
    if (d) this.desc = { ...d };
    else {
      const dd = blankDesc();
      dd.fmt = t.fmtId;
      dd.mostDetailedMip = 0; dd.mipLevels = t.mips; dd.firstSlice = 0; dd.arraySize = t.arrays;
      dd.dim = t.dim === 1 ? (t.arrays > 1 ? SRV_DIM.TEXTURE1DARRAY : SRV_DIM.TEXTURE1D)
        : t.dim === 3 ? SRV_DIM.TEXTURE3D
        : t.isCube ? (t.arrays > 6 ? SRV_DIM.TEXTURECUBEARRAY : SRV_DIM.TEXTURECUBE)
        : t.samples > 1 ? (t.arrays > 1 ? SRV_DIM.TEXTURE2DMSARRAY : SRV_DIM.TEXTURE2DMS)
        : (t.arrays > 1 ? SRV_DIM.TEXTURE2DARRAY : SRV_DIM.TEXTURE2D);
      this.desc = dd;
    }
    const dd = this.desc;
    if (!dd.fmt) dd.fmt = t.fmtId;
    if (dd.mipLevels === 0 || dd.mipLevels === 0xffffffff) dd.mipLevels = t.mips - dd.mostDetailedMip;
    if (dd.arraySize === 0 || dd.arraySize === 0xffffffff) dd.arraySize = t.arrays - dd.firstSlice;
    return 0;
  }
  /** the GPU texture view for a shader-declared dimension (D3D10_SB_RESOURCE_DIMENSION value) */
  gpuView(declDim: number): GPUTextureView {
    const key = String(declDim);
    let v = this.views.get(key);
    if (v) return v;
    const t = this.tex, d = this.desc;
    const vf = fmt11(d.fmt);
    const dimension: GPUTextureViewDimension = declDim === 2 || declDim === 7 ? "1d" : declDim === 5 ? "3d" : declDim === 6 ? "cube" : declDim === 10 ? "cube-array" : declDim === 8 || declDim === 9 ? "2d-array" : "2d";
    let layers = d.arraySize, first = d.firstSlice;
    if (dimension === "cube") { if (this.desc.dim === SRV_DIM.TEXTURECUBEARRAY) { first = d.firstSlice; } layers = 6; if (this.desc.dim === SRV_DIM.TEXTURECUBE) first = 0; }
    else if (dimension === "cube-array") { layers = (d.arraySize || 1) * 6; first = d.firstSlice; }
    else if (dimension === "2d" || dimension === "1d") layers = 1;
    else if (dimension === "3d") { layers = 1; first = 0; }
    // cube-array SRV descs carry First2DArrayFace/NumCubes in the slice fields
    v = t.gpu!.createView({
      format: t.viewFormat(d.fmt), dimension, baseMipLevel: d.mostDetailedMip, mipLevelCount: d.mipLevels || 1, baseArrayLayer: first, arrayLayerCount: layers,
      aspect: vf?.aspect === "stencil" ? "stencil-only" : vf?.aspect === "depth" ? "depth-only" : "all",
    });
    this.views.set(key, v);
    return v;
  }
}

export class RTV11 extends View11 {
  view: GPUTextureView | null = null;
  fmtGpu: GPUTextureFormat = "rgba8unorm";
  /** a view over exactly mip 0 / layer 0 of a single-layer texture: eligible for deferred clears */
  simple = false;
  init(dev: Device11, res: Resource11, d: ViewDesc | null): number {
    this.attachView(dev, res);
    if (res instanceof Buf11) { this.desc = d ?? blankDesc(); return 0; }
    const t = res as Tex11;
    const dd = d ? { ...d } : blankDesc();
    if (!d) { dd.fmt = t.fmtId; dd.dim = t.dim === 3 ? RTV_DIM.TEXTURE3D : t.dim === 1 ? RTV_DIM.TEXTURE1D : t.samples > 1 ? RTV_DIM.TEXTURE2DMS : t.arrays > 1 ? RTV_DIM.TEXTURE2DARRAY : RTV_DIM.TEXTURE2D; dd.arraySize = t.arrays; dd.wSize = t.depth; }
    if (!dd.fmt) dd.fmt = t.fmtId;
    this.desc = dd;
    this.fmtGpu = t.viewFormat(dd.fmt);
    const dim: GPUTextureViewDimension = t.dim === 3 ? "3d" : t.dim === 1 ? "1d" : "2d";
    if (t.dim === 2 && dd.arraySize > 1 && dd.dim !== RTV_DIM.TEXTURE2DMSARRAY) { /* layered rendering is not available; slice firstSlice is used */ }
    this.view = t.gpu!.createView({ format: this.fmtGpu, dimension: dim, baseMipLevel: dd.mostDetailedMip, mipLevelCount: 1, baseArrayLayer: t.dim === 2 ? dd.firstSlice : 0, arrayLayerCount: 1 });
    this.simple = t.dim === 2 && dd.mostDetailedMip === 0 && dd.firstSlice === 0 && t.arrays === 1 && t.gpuFmt === this.fmtGpu;
    return 0;
  }
}

export class DSV11 extends View11 {
  view: GPUTextureView | null = null;
  fmtGpu: GPUTextureFormat = "depth24plus-stencil8";
  simple = false;
  get readOnlyDepth(): boolean { return (this.desc.flags & 1) !== 0; }
  get readOnlyStencil(): boolean { return (this.desc.flags & 2) !== 0; }
  init(dev: Device11, res: Resource11, d: ViewDesc | null): number {
    this.attachView(dev, res);
    const t = res as Tex11;
    const dd = d ? { ...d } : blankDesc();
    if (!d) { dd.fmt = t.fmtId; dd.dim = t.samples > 1 ? (t.arrays > 1 ? DSV_DIM.TEXTURE2DMSARRAY : DSV_DIM.TEXTURE2DMS) : t.arrays > 1 ? DSV_DIM.TEXTURE2DARRAY : DSV_DIM.TEXTURE2D; dd.arraySize = t.arrays; }
    if (!dd.fmt) dd.fmt = t.fmtId;
    this.desc = dd;
    this.fmtGpu = t.gpuFmt;
    this.view = t.gpu!.createView({ format: t.gpuFmt, dimension: "2d", baseMipLevel: dd.mostDetailedMip, mipLevelCount: 1, baseArrayLayer: dd.firstSlice, arrayLayerCount: 1, aspect: "all" });
    this.simple = dd.mostDetailedMip === 0 && dd.firstSlice === 0 && t.arrays === 1;
    return 0;
  }
}

export class UAV11 extends View11 {
  view: GPUTextureView | null = null;
  fmtGpu: GPUTextureFormat = "rgba8unorm";
  init(dev: Device11, res: Resource11, d: ViewDesc | null): number {
    this.attachView(dev, res);
    if (res instanceof Buf11) {
      const dd = d ? { ...d } : { ...blankDesc(), dim: UAV_DIM.BUFFER };
      if (!dd.numElements) dd.numElements = res.stride ? res.size / res.stride : res.size / 4;
      this.desc = dd;
      return 0;
    }
    const t = res as Tex11;
    const dd = d ? { ...d } : blankDesc();
    if (!d) { dd.fmt = t.fmtId; dd.dim = t.dim === 3 ? UAV_DIM.TEXTURE3D : t.dim === 1 ? UAV_DIM.TEXTURE1D : t.arrays > 1 ? UAV_DIM.TEXTURE2DARRAY : UAV_DIM.TEXTURE2D; dd.arraySize = t.arrays; dd.wSize = t.depth; }
    if (!dd.fmt) dd.fmt = t.fmtId;
    this.desc = dd;
    this.fmtGpu = t.viewFormat(dd.fmt);
    const dim: GPUTextureViewDimension = dd.dim === UAV_DIM.TEXTURE3D ? "3d" : dd.dim === UAV_DIM.TEXTURE1D ? "1d" : dd.dim === UAV_DIM.TEXTURE2DARRAY ? "2d-array" : "2d";
    this.view = t.gpu!.createView({ format: this.fmtGpu, dimension: dim, baseMipLevel: dd.mostDetailedMip, mipLevelCount: 1, baseArrayLayer: dd.dim === UAV_DIM.TEXTURE2DARRAY ? dd.firstSlice : 0, arrayLayerCount: dd.dim === UAV_DIM.TEXTURE2DARRAY ? (dd.arraySize || t.arrays - dd.firstSlice) : 1 });
    return 0;
  }
}

// ----------------------------------------------------------------------------------------------------------------------
// state objects
// ----------------------------------------------------------------------------------------------------------------------
export interface RtBlend { enable: boolean; src: number; dst: number; op: number; srcA: number; dstA: number; opA: number; mask: number }
export class BlendState11 extends DeviceChild11 {
  alphaToCoverage = false;
  independent = false;
  targets: RtBlend[] = [];
  key = "";
  decode(m: import("../win32/mem.ts").GuestMem, a: number, off: number) {
    this.alphaToCoverage = m.r32(a) !== 0;
    this.independent = m.r32(a + 4) !== 0;
    this.targets = [];
    for (let i = 0; i < 8; i++) {
      const b = a + off + i * 32;
      this.targets.push({ enable: m.r32(b) !== 0, src: m.r32(b + 4), dst: m.r32(b + 8), op: m.r32(b + 12), srcA: m.r32(b + 16), dstA: m.r32(b + 20), opA: m.r32(b + 24), mask: m.r8(b + 28) });
    }
    this.key = `${this.alphaToCoverage ? 1 : 0}|` + this.targets.map((r, i) => (i > 0 && !this.independent ? "" : `${r.enable ? 1 : 0},${r.src},${r.dst},${r.op},${r.srcA},${r.dstA},${r.opA},${r.mask}`)).join("|");
  }
  state(i: number): RtBlend { return this.independent ? this.targets[i] : this.targets[0]; }
  /** WebGPU colour target blend state for render target i (undefined when blending is off) */
  gpuBlend(i: number): GPUBlendState | undefined {
    const r = this.state(i);
    if (!r.enable) return undefined;
    const mm = (op: number) => op === 4 || op === 5;
    const col: GPUBlendComponent = mm(r.op) ? { operation: BLEND_OP[r.op], srcFactor: "one", dstFactor: "one" } : { operation: BLEND_OP[r.op] ?? "add", srcFactor: blendFactor(r.src, false), dstFactor: blendFactor(r.dst, false) };
    const alp: GPUBlendComponent = mm(r.opA) ? { operation: BLEND_OP[r.opA], srcFactor: "one", dstFactor: "one" } : { operation: BLEND_OP[r.opA] ?? "add", srcFactor: blendFactor(r.srcA, true), dstFactor: blendFactor(r.dstA, true) };
    return { color: col, alpha: alp };
  }
  writeMask(i: number): number { return this.state(i).mask; }
  GetDesc(c: Cpu): void { this.writeDesc(c.arg(1), 8); }
  writeDesc(a: number, off: number) {
    const m = this.dev.p.mem;
    m.w32(a, this.alphaToCoverage ? 1 : 0); m.w32(a + 4, this.independent ? 1 : 0);
    for (let i = 0; i < 8; i++) { const r = this.targets[i], b = a + off + i * 32; m.w32(b, r.enable ? 1 : 0); m.w32(b + 4, r.src); m.w32(b + 8, r.dst); m.w32(b + 12, r.op); m.w32(b + 16, r.srcA); m.w32(b + 20, r.dstA); m.w32(b + 24, r.opA); m.w32(b + 28, r.mask); }
  }
}

export class DepthStencilState11 extends DeviceChild11 {
  depthEnable = true; depthWrite = true; depthFunc = 2;
  stencilEnable = false; readMask = 0xff; writeMask = 0xff;
  front = { fail: 1, depthFail: 1, pass: 1, func: 8 };
  back = { fail: 1, depthFail: 1, pass: 1, func: 8 };
  key = "";
  decode(m: import("../win32/mem.ts").GuestMem, a: number) {
    this.depthEnable = m.r32(a) !== 0; this.depthWrite = m.r32(a + 4) !== 0; this.depthFunc = m.r32(a + 8);
    this.stencilEnable = m.r32(a + 12) !== 0; this.readMask = m.r8(a + 16); this.writeMask = m.r8(a + 17);
    this.front = { fail: m.r32(a + 20), depthFail: m.r32(a + 24), pass: m.r32(a + 28), func: m.r32(a + 32) };
    this.back = { fail: m.r32(a + 36), depthFail: m.r32(a + 40), pass: m.r32(a + 44), func: m.r32(a + 48) };
    const f = this.front, b = this.back;
    this.key = `${+this.depthEnable}${+this.depthWrite}${this.depthFunc}|${+this.stencilEnable},${this.readMask},${this.writeMask}|${f.fail},${f.depthFail},${f.pass},${f.func}|${b.fail},${b.depthFail},${b.pass},${b.func}`;
  }
  /** WebGPU depth/stencil state for a given attachment format */
  gpuState(format: GPUTextureFormat, readOnlyDepth: boolean, readOnlyStencil: boolean): GPUDepthStencilState {
    const hasStencil = /stencil/.test(format);
    const s: GPUDepthStencilState = {
      format,
      depthWriteEnabled: this.depthEnable && this.depthWrite && !readOnlyDepth,
      depthCompare: this.depthEnable ? CMP[this.depthFunc] : "always",
    };
    if (hasStencil) {
      const on = this.stencilEnable;
      s.stencilFront = on ? { compare: CMP[this.front.func], failOp: STENCIL_OP[this.front.fail], depthFailOp: STENCIL_OP[this.front.depthFail], passOp: STENCIL_OP[this.front.pass] } : {};
      s.stencilBack = on ? { compare: CMP[this.back.func], failOp: STENCIL_OP[this.back.fail], depthFailOp: STENCIL_OP[this.back.depthFail], passOp: STENCIL_OP[this.back.pass] } : {};
      s.stencilReadMask = on ? this.readMask : 0;
      s.stencilWriteMask = on && !readOnlyStencil ? this.writeMask : 0;
    }
    return s;
  }
  GetDesc(c: Cpu): void {
    const m = this.dev.p.mem, a = c.arg(1);
    m.w32(a, +this.depthEnable); m.w32(a + 4, +this.depthWrite); m.w32(a + 8, this.depthFunc); m.w32(a + 12, +this.stencilEnable); m.w8(a + 16, this.readMask); m.w8(a + 17, this.writeMask);
    const w = (o: number, s: { fail: number; depthFail: number; pass: number; func: number }) => { m.w32(a + o, s.fail); m.w32(a + o + 4, s.depthFail); m.w32(a + o + 8, s.pass); m.w32(a + o + 12, s.func); };
    w(20, this.front); w(36, this.back);
  }
}

export class RasterizerState11 extends DeviceChild11 {
  fill = 3; cull = 3; frontCCW = false; depthBias = 0; depthBiasClamp = 0; slopeBias = 0; depthClip = true; scissor = false; multisample = false; aaLine = false;
  key = "";
  decode(m: import("../win32/mem.ts").GuestMem, a: number) {
    this.fill = m.r32(a); this.cull = m.r32(a + 4); this.frontCCW = m.r32(a + 8) !== 0; this.depthBias = m.ri32(a + 12);
    this.depthBiasClamp = m.rf32(a + 16); this.slopeBias = m.rf32(a + 20); this.depthClip = m.r32(a + 24) !== 0; this.scissor = m.r32(a + 28) !== 0;
    this.multisample = m.r32(a + 32) !== 0; this.aaLine = m.r32(a + 36) !== 0;
    this.key = `${this.fill},${this.cull},${+this.frontCCW},${this.depthBias},${this.depthBiasClamp},${this.slopeBias},${+this.depthClip}`;
  }
  GetDesc(c: Cpu): void {
    const m = this.dev.p.mem, a = c.arg(1);
    m.w32(a, this.fill); m.w32(a + 4, this.cull); m.w32(a + 8, +this.frontCCW); m.w32(a + 12, this.depthBias); m.wf32(a + 16, this.depthBiasClamp); m.wf32(a + 20, this.slopeBias);
    m.w32(a + 24, +this.depthClip); m.w32(a + 28, +this.scissor); m.w32(a + 32, +this.multisample); m.w32(a + 36, +this.aaLine);
  }
}

export class SamplerState11 extends DeviceChild11 {
  filter = 0x15; addrU = 1; addrV = 1; addrW = 1; lodBias = 0; maxAniso = 1; cmpFunc = 1; border = [0, 0, 0, 0]; minLod = 0; maxLod = 3.4e38;
  gpu!: GPUSampler;
  key = "";
  decode(m: import("../win32/mem.ts").GuestMem, a: number) {
    this.filter = m.r32(a); this.addrU = m.r32(a + 4); this.addrV = m.r32(a + 8); this.addrW = m.r32(a + 12); this.lodBias = m.rf32(a + 16); this.maxAniso = m.r32(a + 20); this.cmpFunc = m.r32(a + 24);
    this.border = [m.rf32(a + 28), m.rf32(a + 32), m.rf32(a + 36), m.rf32(a + 40)]; this.minLod = m.rf32(a + 44); this.maxLod = m.rf32(a + 48);
  }
  get comparison(): boolean { return (this.filter & 0x180) === 0x80; }
  get aniso(): boolean { return (this.filter & 0x40) !== 0; }
  /** the sampler never filters between texels: usable with unfilterable textures */
  get pointOnly(): boolean { return !this.aniso && (this.filter & 0x15) === 0; }
  build() {
    const addr = (m: number): GPUAddressMode => (m === 1 ? "repeat" : m === 2 || m === 5 ? "mirror-repeat" : "clamp-to-edge");
    const lin = (bit: number) => ((this.filter & bit) !== 0 || this.aniso ? "linear" : "nearest") as GPUFilterMode;
    const desc: GPUSamplerDescriptor = {
      addressModeU: addr(this.addrU), addressModeV: addr(this.addrV), addressModeW: addr(this.addrW),
      magFilter: lin(4), minFilter: lin(0x10), mipmapFilter: ((this.filter & 1) !== 0 || this.aniso ? "linear" : "nearest") as GPUMipmapFilterMode,
      lodMinClamp: Math.max(0, this.minLod), lodMaxClamp: Math.min(32, Math.max(this.minLod, this.maxLod)),
    };
    if (this.comparison) desc.compare = CMP[this.cmpFunc] ?? "always";
    if (this.aniso && this.maxAniso > 1) desc.maxAnisotropy = Math.min(16, this.maxAniso);
    this.key = JSON.stringify(desc);
    this.gpu = this.dev.gpu.device.createSampler(desc);
  }
  GetDesc(c: Cpu): void {
    const m = this.dev.p.mem, a = c.arg(1);
    m.w32(a, this.filter); m.w32(a + 4, this.addrU); m.w32(a + 8, this.addrV); m.w32(a + 12, this.addrW); m.wf32(a + 16, this.lodBias); m.w32(a + 20, this.maxAniso); m.w32(a + 24, this.cmpFunc);
    for (let i = 0; i < 4; i++) m.wf32(a + 28 + i * 4, this.border[i]); m.wf32(a + 44, this.minLod); m.wf32(a + 48, this.maxLod);
  }
}

export interface InputElement { name: string; index: number; format: number; slot: number; offset: number; perInstance: boolean; stepRate: number }
export class InputLayout11 extends DeviceChild11 {
  elements: InputElement[] = [];
  /** per-slot stride when the layout is used without explicit buffer strides */
  sig: Sm5Shader | null = null;
}

export type ShaderStage = "vs" | "ps" | "gs" | "hs" | "ds" | "cs";
export class Shader11 extends DeviceChild11 {
  stage: ShaderStage = "vs";
  bytecode!: Uint8Array;
  parsed!: Sm5Shader;
  unsupported: string[] = [];
  init(dev: Device11, stage: ShaderStage, code: Uint8Array): number {
    this.attach(dev);
    this.stage = stage;
    this.bytecode = code.slice();
    try { this.parsed = parseDxbc(this.bytecode); } catch (e: any) { dev.p.log(`[d3d11] shader parse failed: ${e.message}`); return E.INVALIDARG; }
    const want = { vs: 1, ps: 0, gs: 2, hs: 3, ds: 4, cs: 5 }[stage];
    if (this.parsed.type !== want) { dev.p.log(`[d3d11] ${stage} shader has program type ${this.parsed.type}`); return E.INVALIDARG; }
    this.unsupported = this.parsed.unsupported;
    if (stage !== "gs" && this.unsupported.length) dev.p.log(`[d3d11] ${stage} shader uses unsupported instructions: ${[...new Set(this.unsupported)].join(", ")}`);
    return 0;
  }
}

export class ClassLinkage11 extends DeviceChild11 {
  GetClassInstance(): number { return E.FAIL; }
  CreateClassInstance(): number { return E.FAIL; }
}

export class Query11 extends DeviceChild11 {
  qtype = 0;
  qflags = 0;
  /** result availability: set when GPU work submitted at End() has finished */
  ready = false;
  started = false;
  value = 0n;
  GetDataSize(): number {
    switch (this.qtype) {
      case QUERY.EVENT: return 4;
      case QUERY.OCCLUSION: return 8;
      case QUERY.TIMESTAMP: return 8;
      case QUERY.TIMESTAMP_DISJOINT: return 16;
      case QUERY.PIPELINE_STATISTICS: return 88;
      case QUERY.OCCLUSION_PREDICATE: return 4;
      case QUERY.SO_STATISTICS: return 16;
      case QUERY.SO_OVERFLOW_PREDICATE: return 4;
      default: return 8;
    }
  }
  GetDesc(c: Cpu): void { this.dev.p.mem.w32(c.arg(1), this.qtype); this.dev.p.mem.w32(c.arg(1) + 4, this.qflags); }
}

export class CommandList11 extends DeviceChild11 {
  ops: ((ctx: import("./d3d11-ctx.ts").Context11) => void)[] = [];
  GetContextFlags(): number { return 0; }
}

void MAP; void mipDim;
