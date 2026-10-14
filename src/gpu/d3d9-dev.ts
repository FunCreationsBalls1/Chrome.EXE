// IDirect3DDevice9 implementation on top of WebGPU.
import { ComObject, S_OK, S_FALSE, E_NOINTERFACE } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import type { Process } from "../win32/process.ts";
import type { Gpu } from "./gpu.ts";
import { D3DCLEAR, D3DDECLTYPE, D3DDECLUSAGE, D3DERR, D3DFMT, D3DFVF, D3DLOCK, D3DPOOL, D3DPT, D3DRS, D3DRTYPE, D3DSWAPEFFECT, D3DUSAGE } from "./d3d9-consts.ts";
import {
  BaseTexture9, CubeTexture9, IndexBuffer9, Query9, Shader9, Surface9, Texture9, VertexBuffer9, VertexDecl9, VolumeTexture9, declTypeSize, fmt9, fvfToElements, fvfStride, mipLevels, decodeBc,
} from "./d3d9-res.ts";
import type { DeclElement, Fmt9 } from "./d3d9-res.ts";
import { DrawEngine9, vertexCount } from "./d3d9-draw.ts";
import { FFP_FLOATS, FFP_UNIFORM_BYTES, MAX_LIGHTS, stageNeedsTexture } from "./d3d9-ffp.ts";
import type { FfpPixelState, FfpStage, FfpVertexState } from "./d3d9-ffp.ts";
import type { Direct3D9 } from "./d3d9.ts";
import { semKey } from "./sm3.ts";
void semKey;

const fa = (c: Cpu, i: number): number => {
  if (i < 4) return c.argF32(i);
  return new Float32Array(new Uint32Array([c.arg(i)]).buffer)[0];
};
const f32bits = (v: number): number => new Uint32Array(new Float32Array([v]).buffer)[0];

export interface PresentParams {
  w: number; h: number; fmt: number; count: number; msaa: number; swap: number; hwnd: number; windowed: boolean; autoDs: boolean; dsFmt: number; flags: number; refresh: number; interval: number;
}
export interface LightData { type: number; diffuse: number[]; specular: number[]; ambient: number[]; position: number[]; direction: number[]; range: number; falloff: number; att: number[]; theta: number; phi: number }

type JournalEntry = { key: string; set: () => void; snap: () => () => void };

// swap chain -----------------------------------------------------------------------------------------------------
export class SwapChain9 extends ComObject {
  dev!: Device9;
  params!: PresentParams;
  back: Surface9[] = [];
  hwnd = 0;
  ctx: GPUCanvasContext | null = null;
  canvas: any = null;
  configured = "";
  lastPresent = 0;
  frames = 0;
  isImplicit = false;

  GetFrontBufferData(): number { return S_OK; }
  Present(c: Cpu): number { return this.dev.presentChain(this, c.arg(1), c.arg(2), c.arg(3)); }
  GetBackBuffer(c: Cpu): number {
    const i = c.arg(1), out = c.arg(3);
    const s = this.back[i];
    if (!s) return D3DERR.INVALIDCALL;
    this.rt.p.mem.wptr(out, s.ptr);
    s.refs++;
    return S_OK;
  }
  GetRasterStatus(c: Cpu): number { const m = this.rt.p.mem; m.w32(c.arg(1), 0); m.w32(c.arg(1) + 4, 0); return S_OK; }
  GetDisplayMode(c: Cpu): number { return this.dev.GetDisplayMode({ arg: (i: number) => [0, 0, c.arg(1)][i] } as any); }
  GetDevice(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; return S_OK; }
  GetPresentParameters(c: Cpu): number { this.dev.writePresentParams(c.arg(1), this.params); return S_OK; }
  destroy() {
    for (const b of this.back) { b.refs = 0; if (!b.destroyed) { b.destroyed = true; b.destroy(); this.rt.free(b); } }
    this.back = [];
  }
}

export class StateBlock9 extends ComObject {
  dev!: Device9;
  entries: JournalEntry[] = [];
  GetDevice(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; return S_OK; }
  Capture(): number { for (const e of this.entries) e.set = e.snap(); return S_OK; }
  Apply(): number { for (const e of this.entries) e.set(); return S_OK; }
}

export class Device9 extends ComObject {
  p!: Process;
  gpu!: Gpu;
  d3d!: Direct3D9;
  adapter = 0;
  devType = 1;
  behavior = 0;
  focusWindow = 0;
  chains: SwapChain9[] = [];
  eng!: DrawEngine9;
  debugShaders = false;

  // state
  renderState = new Uint32Array(256);
  samplerState = new Uint32Array(20 * 16);
  tss = new Uint32Array(8 * 33);
  tex: (BaseTexture9 | null)[] = new Array(20).fill(null);
  streams: ({ vb: VertexBuffer9 | null; offset: number; stride: number } | undefined)[] = new Array(16).fill(undefined).map(() => ({ vb: null, offset: 0, stride: 0 }));
  streamFreq = new Uint32Array(16).fill(1);
  ib: IndexBuffer9 | null = null;
  decl: VertexDecl9 | null = null;
  fvf = 0;
  fvfElements: DeclElement[] = [];
  vs: Shader9 | null = null;
  ps: Shader9 | null = null;
  vsF = new Float32Array(256 * 4);
  vsI = new Int32Array(16 * 4);
  vsB = new Uint32Array(16);
  psF = new Float32Array(256 * 4);
  psI = new Int32Array(16 * 4);
  psB = new Uint32Array(16);
  bumpEnv = new Float32Array(64);
  transforms = new Map<number, Float32Array>();
  material = new Float32Array(17).fill(0);
  lights = new Map<number, LightData>();
  lightEnabled = new Set<number>();
  viewport = { x: 0, y: 0, w: 1, h: 1, minZ: 0, maxZ: 1 };
  scissor = { l: 0, t: 0, r: 0, b: 0 };
  clipPlanes = new Float32Array(24);
  rtSurf: (Surface9 | null)[] = [null, null, null, null];
  dsSurf: Surface9 | null = null;
  upStride = -1;
  sceneActive = false;
  recording: JournalEntry[] | null = null;
  softwareVp = false;
  nPatch = 0;
  cursorVisible = false;
  paletteEntries = new Map<number, Uint8Array>();
  ffpDirtyAll = true;
  private ffpData = new Float32Array(FFP_FLOATS + 16);
  gamma = new Uint16Array(768);
  frameTimes: number[] = [];
  inflight = 0;
  private pendingOps = new Map<string, { done: boolean; value: any }>();
  releaseDevice: (() => void) | null = null;
  vsyncBase = 0;

  init(p: Process, gpu: Gpu, d3d: Direct3D9) {
    this.p = p; this.gpu = gpu; this.d3d = d3d;
    this.eng = new DrawEngine9(this);
    this.resetState();
  }

  /** release a reference held internally by a resource */
  releaseInternal() {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0 && !this.destroyed) { this.destroyed = true; this.destroy(); this.rt.free(this); }
  }
  destroy() {
    for (const c of this.chains) { c.refs = 0; c.destroy(); this.rt.free(c); }
    this.chains = [];
    this.releaseDevice?.();
  }

  resetState() {
    const rs = this.renderState;
    rs.fill(0);
    const set = (k: number, v: number) => { rs[k] = v; };
    set(D3DRS.ZENABLE, 1); set(D3DRS.FILLMODE, 3); set(D3DRS.SHADEMODE, 2); set(D3DRS.ZWRITEENABLE, 1); set(D3DRS.LASTPIXEL, 1); set(D3DRS.SRCBLEND, 2); set(D3DRS.DESTBLEND, 1);
    set(D3DRS.CULLMODE, 3); set(D3DRS.ZFUNC, 4); set(D3DRS.ALPHAFUNC, 8); set(D3DRS.STENCILFAIL, 1); set(D3DRS.STENCILZFAIL, 1); set(D3DRS.STENCILPASS, 1); set(D3DRS.STENCILFUNC, 8);
    set(D3DRS.STENCILMASK, 0xffffffff); set(D3DRS.STENCILWRITEMASK, 0xffffffff); set(D3DRS.TEXTUREFACTOR, 0xffffffff); set(D3DRS.CLIPPING, 1); set(D3DRS.LIGHTING, 1);
    set(D3DRS.COLORVERTEX, 1); set(D3DRS.LOCALVIEWER, 1); set(D3DRS.DIFFUSEMATERIALSOURCE, 1); set(D3DRS.SPECULARMATERIALSOURCE, 2); set(D3DRS.FOGEND, f32bits(1)); set(D3DRS.FOGDENSITY, f32bits(1));
    set(D3DRS.POINTSIZE, f32bits(1)); set(D3DRS.POINTSIZE_MIN, f32bits(1)); set(D3DRS.POINTSCALE_A, f32bits(1)); set(D3DRS.POINTSIZE_MAX, f32bits(64)); set(D3DRS.MULTISAMPLEANTIALIAS, 1);
    set(D3DRS.MULTISAMPLEMASK, 0xffffffff); set(D3DRS.COLORWRITEENABLE, 0xf); set(D3DRS.COLORWRITEENABLE1, 0xf); set(D3DRS.COLORWRITEENABLE2, 0xf); set(D3DRS.COLORWRITEENABLE3, 0xf);
    set(D3DRS.BLENDOP, 1); set(D3DRS.BLENDOPALPHA, 1); set(D3DRS.SRCBLENDALPHA, 2); set(D3DRS.DESTBLENDALPHA, 1); set(D3DRS.BLENDFACTOR, 0xffffffff); set(D3DRS.POSITIONDEGREE, 3); set(D3DRS.NORMALDEGREE, 1);
    set(D3DRS.MINTESSELLATIONLEVEL, f32bits(1)); set(D3DRS.MAXTESSELLATIONLEVEL, f32bits(1)); set(D3DRS.CCW_STENCILFAIL, 1); set(D3DRS.CCW_STENCILZFAIL, 1); set(D3DRS.CCW_STENCILPASS, 1);
    set(D3DRS.CCW_STENCILFUNC, 8);
    const ss = this.samplerState;
    ss.fill(0);
    for (let i = 0; i < 20; i++) { const b = i * 16; ss[b + 1] = 1; ss[b + 2] = 1; ss[b + 3] = 1; ss[b + 5] = 1; ss[b + 6] = 1; ss[b + 7] = 0; ss[b + 10] = 1; }
    const t = this.tss;
    t.fill(0);
    for (let s = 0; s < 8; s++) {
      const b = s * 33;
      t[b + 1] = s === 0 ? 4 : 1; t[b + 2] = 2; t[b + 3] = 1; t[b + 4] = s === 0 ? 2 : 1; t[b + 5] = 2; t[b + 6] = 1; t[b + 11] = s; t[b + 26] = 1; t[b + 27] = 1; t[b + 28] = 1;
    }
    this.tex.fill(null);
    this.transforms.clear();
    this.lights.clear(); this.lightEnabled.clear();
    this.material.fill(0);
    this.clipPlanes.fill(0);
    this.vs = null; this.ps = null;
    this.decl = null; this.fvf = 0; this.fvfElements = [];
    this.streamFreq.fill(1);
    this.vsF.fill(0); this.psF.fill(0);
    this.eng.vsDirty = this.eng.psDirty = this.eng.ffpDirty = true;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------------------------
  /** run an async GPU operation to completion from a restartable HLE call (blocks the calling guest thread) */
  waitFor<T>(key: string, start: () => Promise<T>): T {
    let op = this.pendingOps.get(key);
    if (!op) {
      const o = { done: false, value: undefined as any };
      this.pendingOps.set(key, (op = o));
      start().then((v) => { o.value = v; o.done = true; }, (e) => { o.value = e; o.done = true; this.p.log(`[d3d9] gpu operation failed: ${e}`); });
    }
    const o = op;
    if (!o.done) this.p.waitUntil(() => o.done, 0xffffffff, "gpu " + key);
    this.pendingOps.delete(key);
    return o.value as T;
  }

  /** flush pending GPU work if the resource was used by recorded-but-unsubmitted commands */
  syncBefore(res: { usedGen: number }) {
    if (res.usedGen === this.gpu.stats.submits) this.gpu.flush();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // GPU resource creation / data transfer
  // ------------------------------------------------------------------------------------------------------------------
  gpuFormatOf(f: Fmt9): { fmt: GPUTextureFormat; srgb: GPUTextureFormat | undefined; compressed: boolean } {
    if (f.compressed && !this.gpu.hasBC) return { fmt: "rgba8unorm", srgb: "rgba8unorm-srgb", compressed: false };
    return { fmt: f.gpu, srgb: f.srgb, compressed: !!f.compressed };
  }
  createTextureGpu(w: number, h: number, depthOrLayers: number, levels: number, f: Fmt9, usage: number, dim: "2d" | "3d", rt: boolean): GPUTexture {
    const g = this.gpuFormatOf(f);
    let u = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    const renderable = (rt || (usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL | D3DUSAGE.AUTOGENMIPMAP))) && !g.compressed;
    if (renderable || f.depth) u |= GPUTextureUsage.RENDER_ATTACHMENT;
    const viewFormats: GPUTextureFormat[] = g.srgb && g.srgb !== g.fmt ? [g.srgb] : [];
    return this.gpu.device.createTexture({ size: dim === "3d" ? [w, h, depthOrLayers] : [w, h, depthOrLayers], dimension: dim, format: g.fmt, mipLevelCount: levels, usage: u, viewFormats, label: f.name });
  }

  /** upload (part of) a surface's shadow to its GPU texture */
  uploadSurface(s: Surface9, l: number, t: number, r: number, b: number) {
    if (!s.tex || !s.shadow) return;
    const f = s.fmt;
    if (f.depth) return; // depth buffers are written only by rendering
    this.syncBefore(s);
    if (s.container) this.syncBefore(s.container);
    const blk = f.block;
    const el = Math.floor(l / blk) * blk, et = Math.floor(t / blk) * blk;
    const er = Math.min(s.w, Math.ceil(r / blk) * blk), eb = Math.min(s.h, Math.ceil(b / blk) * blk);
    const w = er - el, h = eb - et;
    if (w <= 0 || h <= 0) return;
    const mem = this.p.mem;
    const mip = s.container ? s.level : 0;
    const layer = s.container instanceof CubeTexture9 ? s.face : 0;
    const g = this.gpuFormatOf(f);
    const copyW = f.compressed ? Math.max(blk, Math.ceil(w / blk) * blk) : w, copyH = f.compressed ? Math.max(blk, Math.ceil(h / blk) * blk) : h;
    const srcRowBytes = Math.ceil(w / blk) * f.bytes;
    const base = s.shadow + Math.floor(et / blk) * s.pitch + Math.floor(el / blk) * f.bytes;
    const rows = Math.ceil(h / blk);
    let data: Uint8Array, bpr: number;
    if (f.compressed && !this.gpu.hasBC) {
      // decode blocks to RGBA8
      const src = new Uint8Array(rows * s.pitch);
      for (let y = 0; y < rows; y++) src.set(mem.bytes(base + y * s.pitch, srcRowBytes), y * s.pitch);
      const dec = decodeBc(f.compressed, src, s.pitch, w, h);
      data = dec.data; bpr = dec.pitch;
    } else if (f.convert) {
      const src = new Uint8Array(rows * s.pitch);
      for (let y = 0; y < rows; y++) src.set(mem.bytes(base + y * s.pitch, Math.min(s.pitch, mem.m.u8.length - base - y * s.pitch)), y * s.pitch);
      bpr = w * f.gpuBytes;
      data = new Uint8Array(bpr * h);
      f.convert(src, s.pitch, data, bpr, w, h);
    } else {
      bpr = srcRowBytes;
      data = new Uint8Array(bpr * rows);
      for (let y = 0; y < rows; y++) data.set(mem.bytes(base + y * s.pitch, srcRowBytes), y * bpr);
    }
    try {
      this.gpu.queue.writeTexture({ texture: s.tex, mipLevel: mip, origin: { x: el, y: et, z: layer } }, data as any, { bytesPerRow: bpr, rowsPerImage: f.compressed && g.compressed ? rows : h }, { width: copyW && g.compressed ? copyW : w, height: copyH && g.compressed ? copyH : h, depthOrArrayLayers: 1 });
    } catch (e: any) { this.p.log(`[d3d9] texture upload failed: ${e.message}`); }
    this.gpu.stats.uploads++;
    if (s.container && s.container.autogen) s.container.mipsDirty = true;
  }
  uploadVolumeLevel(v: VolumeTexture9, level: number) {
    if (!v.tex) return;
    this.syncBefore(v);
    const f = v.fmt;
    const w = Math.max(1, v.w >> level), h = Math.max(1, v.h >> level), d = Math.max(1, v.d >> level);
    const mem = this.p.mem;
    const rows = Math.max(1, Math.ceil(h / f.block));
    const srcRow = Math.ceil(w / f.block) * f.bytes;
    let data = new Uint8Array(v.slicePitches[level] * d);
    data.set(mem.bytes(v.shadows[level], data.length));
    let bpr = v.pitches[level];
    if (f.convert) {
      const out = new Uint8Array(w * f.gpuBytes * h * d);
      for (let z = 0; z < d; z++) f.convert(data.subarray(z * v.slicePitches[level]), bpr, out.subarray(z * w * f.gpuBytes * h), w * f.gpuBytes, w, h);
      data = out; bpr = w * f.gpuBytes;
    }
    void srcRow; void rows;
    this.gpu.queue.writeTexture({ texture: v.tex, mipLevel: level }, data, { bytesPerRow: bpr, rowsPerImage: f.convert ? h : Math.ceil(h / f.block) }, { width: w, height: h, depthOrArrayLayers: d });
  }
  uploadBuffer(b: IndexBuffer9 | VertexBuffer9, off: number, size: number) {
    if (!b.gpu) return;
    this.syncBefore(b);
    const data = this.p.mem.bytes(b.shadow + off, size);
    this.gpu.writeBuffer(b.gpu, off, data.slice());
    this.gpu.stats.uploads++;
  }
  /** a DISCARD lock on a dynamic buffer: take a fresh GPU buffer so pending commands keep the old contents */
  orphanBuffer(b: IndexBuffer9 | VertexBuffer9) {
    if (b.usedGen !== this.gpu.stats.submits) return; // not referenced by unsubmitted commands
    const old = b.gpu;
    b.gpu = this.gpu.createBuffer(b.size, b.gpuUsage | GPUBufferUsage.COPY_DST, "d3d9 buffer (orphaned)");
    // the old buffer is still referenced by recorded commands; it is released after the next submit
    if (old) this.gpu.deferDestroy(old);
    // re-upload the current contents so non-locked ranges stay valid
    this.gpu.writeBuffer(b.gpu, 0, this.p.mem.bytes(b.shadow, b.size).slice());
  }

  /** make a surface's shadow reflect the GPU contents (blocks the calling thread while the read completes) */
  readbackSurfaceSync(s: Surface9) {
    if (!s.tex || s.fmt.depth) return;
    this.syncBefore(s);
    const key = `rb:${s.uid}`;
    const bpp = s.fmt.gpuBytes;
    const res = this.waitFor<Uint8Array>(key, () => this.gpu.readTexture(s.tex!, bpp, 0, 0, s.w, s.h, s.container instanceof CubeTexture9 ? s.face : 0, s.container ? s.level : 0));
    if (!(res instanceof Uint8Array)) return;
    s.allocShadow();
    const mem = this.p.mem;
    const f = s.fmt;
    const row = s.w * f.gpuBytes;
    for (let y = 0; y < s.h; y++) {
      if (f.convert) {
        // lossy formats read back as their GPU representation reduced to the native layout is not attempted; copy raw bytes for 32-bit formats
        mem.write(s.shadow + y * s.pitch, res.subarray(y * row, y * row + Math.min(row, s.pitch)));
      } else mem.write(s.shadow + y * s.pitch, res.subarray(y * row, y * row + Math.min(row, s.pitch)));
    }
    s.gpuDirty = false;
  }

  generateMips(t: BaseTexture9) {
    if (!t.tex || t.levels < 1 || t.mipsDirty === false && !t.autogen) return;
    // autogen textures are created with a full chain on the GPU side
    t.mipsDirty = false;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // IDirect3DDevice9 -- device-level queries
  // ------------------------------------------------------------------------------------------------------------------
  TestCooperativeLevel(): number { return S_OK; }
  GetAvailableTextureMem(): number { return 0x40000000; }
  EvictManagedResources(): number { return S_OK; }
  GetDirect3D(c: Cpu): number { this.p.mem.wptr(c.arg(1), this.d3d.ptr); this.d3d.refs++; return S_OK; }
  GetDeviceCaps(c: Cpu): number { return this.d3d.writeCaps(c.arg(1)); }
  GetDisplayMode(c: Cpu): number {
    const a = c.arg(2), m = this.p.mem, h = this.p.host;
    m.w32(a, h.screenWidth); m.w32(a + 4, h.screenHeight); m.w32(a + 8, h.refreshRate); m.w32(a + 12, D3DFMT.X8R8G8B8);
    return S_OK;
  }
  GetCreationParameters(c: Cpu): number {
    const a = c.arg(1), m = this.p.mem;
    m.w32(a, this.adapter); m.w32(a + 4, this.devType); m.wptr(a + 8, this.focusWindow); m.w32(a + 16, this.behavior);
    return S_OK;
  }
  SetCursorProperties(): number { return S_OK; }
  SetCursorPosition(): void {}
  ShowCursor(c: Cpu): number { const o = this.cursorVisible; this.cursorVisible = c.arg(1) !== 0; return o ? 1 : 0; }
  GetNumberOfSwapChains(): number { return this.chains.length; }
  GetSwapChain(c: Cpu): number {
    const ch = this.chains[c.arg(1)];
    if (!ch) return D3DERR.INVALIDCALL;
    this.p.mem.wptr(c.arg(2), ch.ptrFor("IDirect3DSwapChain9"));
    ch.refs++;
    return S_OK;
  }
  CreateAdditionalSwapChain(c: Cpu): number {
    const pp = this.readPresentParams(c.arg(1));
    const ch = this.makeSwapChain(pp, false);
    if (!ch) return D3DERR.INVALIDCALL;
    this.p.mem.wptr(c.arg(2), ch.ptrFor("IDirect3DSwapChain9"));
    return S_OK;
  }
  SetDialogBoxMode(): number { return S_OK; }
  SetGammaRamp(c: Cpu): void { const m = this.p.mem; for (let i = 0; i < 768; i++) this.gamma[i] = m.r16(c.arg(3) + i * 2); }
  GetGammaRamp(c: Cpu): void { const m = this.p.mem; for (let i = 0; i < 768; i++) m.w16(c.arg(2) + i * 2, this.gamma[i] || (i % 256) * 257); }
  GetRasterStatus(c: Cpu): number { const m = this.p.mem; m.w32(c.arg(2), 0); m.w32(c.arg(2) + 4, 0); return S_OK; }

  // ------------------------------------------------------------------------------------------------------------------
  // swap chains and presentation
  // ------------------------------------------------------------------------------------------------------------------
  readPresentParams(a: number): PresentParams {
    const m = this.p.mem;
    return { w: m.r32(a), h: m.r32(a + 4), fmt: m.r32(a + 8), count: m.r32(a + 12), msaa: m.r32(a + 16), swap: m.r32(a + 24), hwnd: m.r32(a + 32), windowed: m.r32(a + 40) !== 0, autoDs: m.r32(a + 44) !== 0, dsFmt: m.r32(a + 48), flags: m.r32(a + 52), refresh: m.r32(a + 56), interval: m.r32(a + 60) };
  }
  writePresentParams(a: number, pp: PresentParams) {
    const m = this.p.mem;
    m.w32(a, pp.w); m.w32(a + 4, pp.h); m.w32(a + 8, pp.fmt); m.w32(a + 12, pp.count); m.w32(a + 16, pp.msaa); m.w32(a + 20, 0); m.w32(a + 24, pp.swap); m.wptr(a + 32, pp.hwnd); m.w32(a + 40, pp.windowed ? 1 : 0);
    m.w32(a + 44, pp.autoDs ? 1 : 0); m.w32(a + 48, pp.dsFmt); m.w32(a + 52, pp.flags); m.w32(a + 56, pp.refresh); m.w32(a + 60, pp.interval);
  }
  /** fill defaults (zero sizes, unknown formats) in presentation parameters, in place */
  normalizeParams(pp: PresentParams): PresentParams {
    const ws = this.p.win;
    const hwnd = pp.hwnd || this.focusWindow;
    const w = hwnd ? ws.win(hwnd) : undefined;
    if (w) { const cs = ws.clientSize(w); if (!pp.w) pp.w = cs.w; if (!pp.h) pp.h = cs.h; }
    if (!pp.w) pp.w = 800;
    if (!pp.h) pp.h = 600;
    if (!pp.fmt || pp.fmt === D3DFMT.UNKNOWN) pp.fmt = D3DFMT.X8R8G8B8;
    if (!pp.count) pp.count = 1;
    pp.hwnd = hwnd;
    return pp;
  }
  makeSwapChain(pp: PresentParams, implicit: boolean): SwapChain9 | null {
    pp = this.normalizeParams(pp);
    const ch = new SwapChain9();
    this.rt.create(ch, ["IDirect3DSwapChain9"]);
    ch.dev = this; ch.params = pp; ch.hwnd = pp.hwnd; ch.isImplicit = implicit;
    this.refs++;
    ch.onDestroy = () => { this.releaseInternal(); };
    this.buildBackBuffers(ch);
    this.chains.push(ch);
    // fullscreen: the display takes the backbuffer's size
    if (!pp.windowed) this.enterFullscreen(pp);
    return ch;
  }
  private enterFullscreen(pp: PresentParams) {
    const ws = this.p.win, host = this.p.host;
    if (pp.w && pp.h && (host.screenWidth !== pp.w || host.screenHeight !== pp.h)) ws.setScreenSize(pp.w, pp.h);
    const w = pp.hwnd ? ws.win(pp.hwnd) : undefined;
    if (w) ws.setWindowPos(w, 0, 0, 0, pp.w, pp.h, 0x40 | 0x10);
    host.setFullscreen?.(true);
  }
  private buildBackBuffers(ch: SwapChain9) {
    const pp = ch.params;
    const f = fmt9(pp.fmt) ?? fmt9(D3DFMT.X8R8G8B8)!;
    for (const b of ch.back) { b.refs = 0; b.destroyed = true; b.destroy(); this.rt.free(b); }
    ch.back = [];
    const n = Math.max(1, pp.count);
    for (let i = 0; i < n; i++) {
      const s = new Surface9();
      this.rt.create(s, ["IDirect3DSurface9", "IDirect3DResource9"]);
      s.init(this, "back", pp.w, pp.h, f, D3DPOOL.DEFAULT, D3DUSAGE.RENDERTARGET, pp.msaa);
      s.tex = this.createTextureGpu(pp.w, pp.h, 1, 1, f, D3DUSAGE.RENDERTARGET, "2d", true);
      s.lockableRt = (pp.flags & 1) !== 0; // D3DPRESENTFLAG_LOCKABLE_BACKBUFFER
      // the swap chain owns the buffer: external references go through the chain
      s.refs = 1;
      ch.back.push(s);
    }
    if (ch.isImplicit) {
      this.rtSurf[0] = ch.back[0];
      this.setViewportInternal({ x: 0, y: 0, w: pp.w, h: pp.h, minZ: 0, maxZ: 1 });
      this.scissor = { l: 0, t: 0, r: pp.w, b: pp.h };
      if (pp.autoDs) this.createAutoDepth(pp);
    }
  }
  private createAutoDepth(pp: PresentParams) {
    const f = fmt9(pp.dsFmt) ?? fmt9(D3DFMT.D24S8)!;
    const s = new Surface9();
    this.rt.create(s, ["IDirect3DSurface9", "IDirect3DResource9"]);
    s.init(this, "ds", pp.w, pp.h, f, D3DPOOL.DEFAULT, D3DUSAGE.DEPTHSTENCIL, pp.msaa);
    s.tex = this.createTextureGpu(pp.w, pp.h, 1, 1, f, D3DUSAGE.DEPTHSTENCIL, "2d", true);
    this.dsSurf = s;
    this.autoDs = s;
  }
  autoDs: Surface9 | null = null;

  Reset(c: Cpu): number {
    const pp = this.normalizeParams(this.readPresentParams(c.arg(1)));
    const ch = this.chains[0];
    if (!ch) return D3DERR.INVALIDCALL;
    this.gpu.flush();
    ch.params = pp;
    ch.configured = "";
    this.buildBackBuffers(ch);
    if (this.autoDs && !pp.autoDs) { this.dsSurf = null; }
    this.rtSurf = [ch.back[0], null, null, null];
    if (this.autoDs) { this.autoDs.refs = 0; this.autoDs.destroyed = true; this.autoDs.destroy(); this.rt.free(this.autoDs); this.autoDs = null; }
    this.dsSurf = null;
    if (pp.autoDs) this.createAutoDepth(pp);
    this.setViewportInternal({ x: 0, y: 0, w: pp.w, h: pp.h, minZ: 0, maxZ: 1 });
    this.scissor = { l: 0, t: 0, r: pp.w, b: pp.h };
    if (!pp.windowed) this.enterFullscreen(pp); else this.p.host.setFullscreen?.(false);
    this.renderState[D3DRS.ZENABLE] = pp.autoDs ? 1 : 0;
    return S_OK;
  }
  ResetEx(c: Cpu): number { return this.Reset(c); }
  Present(c: Cpu): number { return this.presentChain(this.chains[0], c.arg(1), c.arg(2), c.arg(3)); }
  PresentEx(c: Cpu): number { return this.presentChain(this.chains[0], c.arg(1), c.arg(2), c.arg(3)); }
  GetBackBuffer(c: Cpu): number {
    const ch = this.chains[c.arg(1)];
    const s = ch?.back[c.arg(2)];
    if (!s) return D3DERR.INVALIDCALL;
    this.p.mem.wptr(c.arg(4), s.ptr);
    s.refs++;
    return S_OK;
  }
  GetFrontBufferData(): number { return S_OK; }

  /** blocking prelude of Present: runs before any side effects because blocking calls restart from the top */
  private paceTarget = 0;
  private paceBeforePresent(pp: PresentParams) {
    const p = this.p;
    if (this.inflight >= 3) p.waitUntil(() => this.inflight < 3, 0xffffffff, "gpu frame pacing");
    if (pp.interval === 0x80000000) return;
    const period = 1000 / Math.max(30, this.p.host.refreshRate || 60);
    if (!this.paceTarget) {
      const now = performance.now();
      if (!this.vsyncBase || now - this.vsyncBase > period * 8) this.vsyncBase = now;
      this.paceTarget = this.vsyncBase + Math.max(1, Math.ceil((now - this.vsyncBase) / period)) * period;
      if (this.paceTarget - now < 0.5) this.paceTarget += period;
    }
    const target = this.paceTarget;
    if (performance.now() < target - 0.5) {
      p.waitUntil(() => performance.now() >= target - 0.5, Math.max(1, Math.ceil(target - performance.now())), "vsync");
    }
    this.vsyncBase = target - Math.ceil((target - this.vsyncBase) / period) * period + 0;
    this.paceTarget = 0;
  }

  presentChain(ch: SwapChain9 | undefined, _src: number, _dst: number, override: number): number {
    if (!ch) return D3DERR.INVALIDCALL;
    const gpu = this.gpu;
    const pp = ch.params;
    this.paceBeforePresent(pp);
    const hwnd = override || ch.hwnd || this.focusWindow;
    const ws = this.p.win;
    let w = hwnd ? ws.win(hwnd) : undefined;
    if (w) w = ws.rootOf(w);
    const host = this.p.host;
    const canvas = w ? host.canvasFor?.(w.hwnd) : null;
    const front = ch.back[0];
    if (canvas && front?.tex && host.presentMode === "readback") {
      // headless environments: copy the frame to the CPU and show it through a 2D canvas
      if (w) w.gpuOwned = true;
      this.resolveClears(front);
      gpu.endPass();
      const tex = front.tex, bgra = front.fmt.gpu.startsWith("bgra"), hw = w!.hwnd;
      this.inflight++;
      gpu.readTexture(tex, front.fmt.gpuBytes, 0, 0, pp.w, pp.h).then((px) => { host.presentPixels?.(hw, pp.w, pp.h, px, bgra); }).catch((e) => this.p.log(`[d3d9] readback present failed: ${e}`)).finally(() => { this.inflight--; });
      ch.frames++;
      if (this.debugShaders && ch.frames % 20 === 1) this.p.log(`[d3d9] frame ${ch.frames} stats ${JSON.stringify(gpu.stats)}`);
      this.p.host.frame?.();
      this.p.yieldRequested = true;
      return S_OK;
    }
    if (canvas && front?.tex) {
      if (w) w.gpuOwned = true;
      if (canvas.width !== pp.w || canvas.height !== pp.h) { canvas.width = pp.w; canvas.height = pp.h; ch.configured = ""; }
      try {
        if (ch.canvas !== canvas) { ch.canvas = canvas; ch.ctx = null; ch.configured = ""; }
        if (!ch.ctx) ch.ctx = canvas.getContext("webgpu");
        if (ch.ctx && ch.configured !== `${pp.w}x${pp.h}`) {
          ch.ctx.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
          ch.configured = `${pp.w}x${pp.h}`;
        }
        if (ch.ctx) {
          const cur = ch.ctx.getCurrentTexture();
          // resolve pending clears of the back buffer, then copy/blit it to the screen
          this.resolveClears(front);
          gpu.endPass();
          if (front.fmt.gpu === gpu.canvasFormat && cur.width === front.tex.width && cur.height === front.tex.height) gpu.cmd().copyTextureToTexture({ texture: front.tex }, { texture: cur }, { width: cur.width, height: cur.height });
          else gpu.blit(front.tex, null, cur, gpu.canvasFormat, null, true);
        }
      } catch (e: any) { this.p.log(`[d3d9] present failed: ${e.message}`); }
    } else if (front) {
      this.resolveClears(front);
    }
    gpu.flush();
    ch.frames++;
    this.inflight++;
    gpu.queue.onSubmittedWorkDone().then(() => { this.inflight--; }, () => { this.inflight = Math.max(0, this.inflight - 1); });
    this.p.host.frame?.();
    this.p.yieldRequested = true;
    return S_OK;
  }
  private resolveClears(s: Surface9) {
    if (s.tex && this.gpu.pending.has(s.tex)) {
      const t = { colors: [{ view: s.view(), tex: s.tex, format: s.fmt.gpu }], depth: null, width: s.w, height: s.h, samples: 1 };
      this.gpu.resolvePending(t, "resolve:" + s.uid);
    }
  }
  // ------------------------------------------------------------------------------------------------------------------
  // resource creation
  // ------------------------------------------------------------------------------------------------------------------
  private checkFormatForPool(fmt: Fmt9 | undefined): fmt is Fmt9 { return !!fmt; }
  CreateTexture(c: Cpu): number {
    const [w, h, levels, usage, fid, pool, out] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5), c.arg(6), c.arg(7)];
    const f = fmt9(fid);
    if (!this.checkFormatForPool(f) || !w || !h || !out) { this.p.log(`[d3d9] CreateTexture: unsupported format ${fid}`); return D3DERR.INVALIDCALL; }
    const t = new Texture9();
    this.rt.create(t, ["IDirect3DTexture9", "IDirect3DBaseTexture9", "IDirect3DResource9"]);
    t.init(this, w, h, levels, usage, f, pool);
    const rtU = (usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL)) !== 0;
    const levelCount = t.autogen ? mipLevels(w, h) : t.levels;
    if (pool !== D3DPOOL.SYSTEMMEM && pool !== D3DPOOL.SCRATCH) {
      t.tex = this.createTextureGpu(w, h, 1, levelCount, f, usage, "2d", rtU);
    }
    const needShadow = pool !== D3DPOOL.DEFAULT || (usage & D3DUSAGE.DYNAMIC) !== 0;
    for (let l = 0; l < t.levels; l++) { const s = t.getSurface(l); s.tex = t.tex; if (needShadow) s.allocShadow(); if (rtU) { s.kind = (usage & D3DUSAGE.DEPTHSTENCIL) ? "ds" : "rt"; s.container = t; } }
    if (rtU) for (let l = 0; l < t.levels; l++) { const s = t.getSurface(l); s.kind = (usage & D3DUSAGE.DEPTHSTENCIL) ? "ds" : "rt"; }
    this.p.mem.wptr(out, t.ptr);
    return S_OK;
  }
  CreateCubeTexture(c: Cpu): number {
    const [edge, levels, usage, fid, pool, out] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5), c.arg(6)];
    const f = fmt9(fid);
    if (!f || !edge || !out) return D3DERR.INVALIDCALL;
    const t = new CubeTexture9();
    this.rt.create(t, ["IDirect3DCubeTexture9", "IDirect3DBaseTexture9", "IDirect3DResource9"]);
    t.init(this, edge, levels, usage, f, pool);
    if (pool !== D3DPOOL.SYSTEMMEM && pool !== D3DPOOL.SCRATCH) t.tex = this.createTextureGpu(edge, edge, 6, t.autogen ? mipLevels(edge, edge) : t.levels, f, usage, "2d", (usage & D3DUSAGE.RENDERTARGET) !== 0);
    const needShadow = pool !== D3DPOOL.DEFAULT || (usage & D3DUSAGE.DYNAMIC) !== 0;
    for (let face = 0; face < 6; face++) for (let l = 0; l < t.levels; l++) { const s = t.faceSurface(face, l); s.tex = t.tex; if (needShadow) s.allocShadow(); if (usage & D3DUSAGE.RENDERTARGET) s.kind = "rt"; }
    this.p.mem.wptr(out, t.ptr);
    return S_OK;
  }
  CreateVolumeTexture(c: Cpu): number {
    const [w, h, d, levels, usage, fid, pool, out] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5), c.arg(6), c.arg(7), c.arg(8)];
    const f = fmt9(fid);
    if (!f || !out) return D3DERR.INVALIDCALL;
    const t = new VolumeTexture9();
    this.rt.create(t, ["IDirect3DVolumeTexture9", "IDirect3DBaseTexture9", "IDirect3DResource9"]);
    t.init(this, w, h, d, levels, usage, f, pool);
    if (pool !== D3DPOOL.SYSTEMMEM && pool !== D3DPOOL.SCRATCH) t.tex = this.createTextureGpu(w, h, d, t.levels, f, usage, "3d", false);
    this.p.mem.wptr(out, t.ptr);
    return S_OK;
  }
  CreateVertexBuffer(c: Cpu): number {
    const [len, usage, fvf, pool, out] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5)];
    if (!len || !out) return D3DERR.INVALIDCALL;
    const b = new VertexBuffer9();
    this.rt.create(b, ["IDirect3DVertexBuffer9", "IDirect3DResource9"]);
    b.rtype = D3DRTYPE.VERTEXBUFFER;
    b.fvf = fvf;
    b.initBuffer(this, len, usage, pool, GPUBufferUsage.VERTEX);
    this.p.mem.wptr(out, b.ptr);
    return S_OK;
  }
  CreateIndexBuffer(c: Cpu): number {
    const [len, usage, fmt, pool, out] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5)];
    if (!len || !out) return D3DERR.INVALIDCALL;
    const b = new IndexBuffer9();
    this.rt.create(b, ["IDirect3DIndexBuffer9", "IDirect3DResource9"]);
    b.rtype = D3DRTYPE.INDEXBUFFER;
    b.format = fmt;
    b.initBuffer(this, len, usage, pool, GPUBufferUsage.INDEX);
    this.p.mem.wptr(out, b.ptr);
    return S_OK;
  }
  private makeSurface(kind: "rt" | "ds" | "offscreen", w: number, h: number, fid: number, pool: number, usage: number, msaa: number): Surface9 | null {
    const f = fmt9(fid);
    if (!f || !w || !h) return null;
    const s = new Surface9();
    this.rt.create(s, ["IDirect3DSurface9", "IDirect3DResource9"]);
    s.init(this, kind, w, h, f, pool, usage, msaa);
    if (kind !== "offscreen" || (pool === D3DPOOL.DEFAULT && f.id !== FOURCC_NULL)) { /* offscreen DEFAULT surfaces are GPU resident */ }
    if (kind === "rt" || kind === "ds" || pool === D3DPOOL.DEFAULT) s.tex = this.createTextureGpu(w, h, 1, 1, f, kind === "ds" ? D3DUSAGE.DEPTHSTENCIL : D3DUSAGE.RENDERTARGET, "2d", true);
    if (pool !== D3DPOOL.DEFAULT) s.allocShadow();
    return s;
  }
  CreateRenderTarget(c: Cpu): number {
    const s = this.makeSurface("rt", c.arg(1), c.arg(2), c.arg(3), D3DPOOL.DEFAULT, D3DUSAGE.RENDERTARGET, c.arg(4));
    if (!s) return D3DERR.INVALIDCALL;
    s.lockableRt = c.arg(6) !== 0;
    this.p.mem.wptr(c.arg(7), s.ptr);
    return S_OK;
  }
  CreateRenderTargetEx(c: Cpu): number { return this.CreateRenderTarget(c); }
  CreateDepthStencilSurface(c: Cpu): number {
    const s = this.makeSurface("ds", c.arg(1), c.arg(2), c.arg(3), D3DPOOL.DEFAULT, D3DUSAGE.DEPTHSTENCIL, c.arg(4));
    if (!s) return D3DERR.INVALIDCALL;
    this.p.mem.wptr(c.arg(7), s.ptr);
    return S_OK;
  }
  CreateDepthStencilSurfaceEx(c: Cpu): number { return this.CreateDepthStencilSurface(c); }
  CreateOffscreenPlainSurface(c: Cpu): number {
    const s = this.makeSurface("offscreen", c.arg(1), c.arg(2), c.arg(3), c.arg(4), 0, 0);
    if (!s) return D3DERR.INVALIDCALL;
    this.p.mem.wptr(c.arg(5), s.ptr);
    return S_OK;
  }
  CreateOffscreenPlainSurfaceEx(c: Cpu): number { return this.CreateOffscreenPlainSurface(c); }
  CreateVertexDeclaration(c: Cpu): number {
    const m = this.p.mem;
    const el: DeclElement[] = [];
    for (let a = c.arg(1); ; a += 8) {
      const stream = m.r16(a);
      if (stream === 0xff) break;
      const type = m.r8(a + 4);
      if (type === D3DDECLTYPE.UNUSED) break;
      el.push({ stream, offset: m.r16(a + 2), type, method: m.r8(a + 5), usage: m.r8(a + 6), usageIndex: m.r8(a + 7) });
      if (el.length > 64) return D3DERR.INVALIDCALL;
    }
    const d = new VertexDecl9();
    this.rt.create(d, ["IDirect3DVertexDeclaration9"]);
    d.attach(this, el);
    m.wptr(c.arg(2), d.ptr);
    return S_OK;
  }
  CreateVertexShader(c: Cpu): number { return this.createShader(c, "vs"); }
  CreatePixelShader(c: Cpu): number { return this.createShader(c, "ps"); }
  private createShader(c: Cpu, stage: "vs" | "ps"): number {
    const m = this.p.mem;
    const a = c.arg(1), out = c.arg(2);
    if (!a || !out) return D3DERR.INVALIDCALL;
    // measure the token stream (terminated by 0x0000FFFF)
    let n = 1;
    const ver = m.r32(a);
    if ((ver >>> 16) !== (stage === "vs" ? 0xfffe : 0xffff)) return D3DERR.INVALIDCALL;
    for (;;) {
      const t = m.r32(a + n * 4);
      n++;
      if ((t & 0xffff) === 0xffff && (t >>> 16) === 0) break;
      if ((t & 0xffff) === 0xfffe) { n += (t >>> 16) & 0x7fff; continue; }
      if (n > 1 << 18) return D3DERR.INVALIDCALL;
    }
    // comment blocks may embed 0x0000FFFF-looking words: re-scan properly
    n = 1;
    for (;;) {
      const t = m.r32(a + n * 4);
      n++;
      const op = t & 0xffff;
      if (op === 0xffff) break;
      if (op === 0xfffe) { n += (t >>> 16) & 0x7fff; continue; }
      if (ver & 0xff00 && ((ver >>> 8) & 0xff) >= 2) n += (t >>> 24) & 0xf;
      else if (op === 81) n += 5;
      else { while ((m.r32(a + n * 4) & 0x80000000) !== 0 && n < 1 << 18) n++; }
    }
    const code = new Uint32Array(n);
    for (let i = 0; i < n; i++) code[i] = m.r32(a + i * 4);
    const s = new Shader9();
    this.rt.create(s, [stage === "vs" ? "IDirect3DVertexShader9" : "IDirect3DPixelShader9"]);
    s.attach(this, code, stage);
    m.wptr(out, s.ptr);
    return S_OK;
  }
  CreateQuery(c: Cpu): number {
    const q = new Query9();
    this.rt.create(q, ["IDirect3DQuery9"]);
    q.attach(this, c.arg(1));
    if (c.arg(2)) this.p.mem.wptr(c.arg(2), q.ptr);
    else { q.refs = 0; this.rt.free(q); return S_OK; }
    return S_OK;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // surfaces: copies
  // ------------------------------------------------------------------------------------------------------------------
  private surf(ptr: number): Surface9 | null {
    const o = this.rt.objectAt(ptr);
    return o instanceof Surface9 ? o : null;
  }
  UpdateSurface(c: Cpu): number {
    const src = this.surf(c.arg(1)), dst = this.surf(c.arg(3));
    if (!src || !dst) return D3DERR.INVALIDCALL;
    const m = this.p.mem;
    let sl = 0, st = 0, sr = src.w, sb = src.h;
    if (c.arg(2)) { sl = m.ri32(c.arg(2)); st = m.ri32(c.arg(2) + 4); sr = m.ri32(c.arg(2) + 8); sb = m.ri32(c.arg(2) + 12); }
    let dx = 0, dy = 0;
    if (c.arg(4)) { dx = m.ri32(c.arg(4)); dy = m.ri32(c.arg(4) + 4); }
    if (src.fmt.id !== dst.fmt.id) return D3DERR.INVALIDCALL;
    src.allocShadow(); dst.allocShadow();
    const blk = src.fmt.block, bpp = src.fmt.bytes;
    const rowBytes = Math.ceil((sr - sl) / blk) * bpp;
    for (let y = 0; y < Math.ceil((sb - st) / blk); y++) {
      m.copy(dst.shadow + (Math.floor(dy / blk) + y) * dst.pitch + Math.floor(dx / blk) * bpp, src.shadow + (Math.floor(st / blk) + y) * src.pitch + Math.floor(sl / blk) * bpp, rowBytes);
    }
    this.uploadSurface(dst, dx, dy, dx + (sr - sl), dy + (sb - st));
    return S_OK;
  }
  UpdateTexture(c: Cpu): number {
    const src = this.rt.objectAt(c.arg(1)), dst = this.rt.objectAt(c.arg(2));
    if (src instanceof Texture9 && dst instanceof Texture9) {
      const n = Math.min(src.levels, dst.levels);
      const offset = src.levels - dst.levels > 0 ? 0 : 0;
      for (let l = 0; l < n; l++) {
        const s = src.getSurface(l + offset), d = dst.getSurface(l);
        if (!s.shadow) continue;
        d.allocShadow();
        this.p.mem.copy(d.shadow, s.shadow, Math.min(s.pitch * Math.ceil(s.h / s.fmt.block), d.pitch * Math.ceil(d.h / d.fmt.block)));
        this.uploadSurface(d, 0, 0, d.w, d.h);
      }
      return S_OK;
    }
    if (src instanceof CubeTexture9 && dst instanceof CubeTexture9) {
      for (let f = 0; f < 6; f++) for (let l = 0; l < Math.min(src.levels, dst.levels); l++) {
        const s = src.faceSurface(f, l), d = dst.faceSurface(f, l);
        if (!s.shadow) continue;
        d.allocShadow();
        this.p.mem.copy(d.shadow, s.shadow, Math.min(s.pitch * Math.ceil(s.h / s.fmt.block), d.pitch * Math.ceil(d.h / d.fmt.block)));
        this.uploadSurface(d, 0, 0, d.w, d.h);
      }
      return S_OK;
    }
    if (src instanceof VolumeTexture9 && dst instanceof VolumeTexture9) {
      for (let l = 0; l < Math.min(src.levels, dst.levels); l++) { this.p.mem.copy(dst.shadows[l], src.shadows[l], Math.min(src.slicePitches[l] * Math.max(1, src.d >> l), dst.slicePitches[l] * Math.max(1, dst.d >> l))); this.uploadVolumeLevel(dst, l); }
      return S_OK;
    }
    return D3DERR.INVALIDCALL;
  }
  GetRenderTargetData(c: Cpu): number {
    const src = this.surf(c.arg(1)), dst = this.surf(c.arg(2));
    if (!src || !dst || !src.tex) return D3DERR.INVALIDCALL;
    this.resolveClears(src);
    this.readbackSurfaceSync(src);
    dst.allocShadow();
    if (src.shadow && dst.shadow) this.p.mem.copy(dst.shadow, src.shadow, Math.min(src.pitch, dst.pitch) * Math.min(src.h, dst.h) - 0);
    return S_OK;
  }
  StretchRect(c: Cpu): number {
    const src = this.surf(c.arg(1)), dst = this.surf(c.arg(3));
    if (!src || !dst || !src.tex || !dst.tex) return D3DERR.INVALIDCALL;
    const m = this.p.mem;
    const rect = (a: number, s: Surface9): [number, number, number, number] => (a ? [m.ri32(a), m.ri32(a + 4), m.ri32(a + 8), m.ri32(a + 12)] : [0, 0, s.w, s.h]);
    const sr = rect(c.arg(2), src), dr = rect(c.arg(4), dst);
    this.gpu.endPass();
    this.resolveClears(src);
    if (src.fmt.depth) {
      // depth copy through a render pass is not available; copy matching regions directly when formats agree
      if (src.fmt.gpu === dst.fmt.gpu && sr[2] - sr[0] === dr[2] - dr[0]) {
        this.gpu.cmd().copyTextureToTexture({ texture: src.tex, origin: [sr[0], sr[1], 0], aspect: "all" }, { texture: dst.tex, origin: [dr[0], dr[1], 0], aspect: "all" }, [sr[2] - sr[0], sr[3] - sr[1], 1]);
      }
      return S_OK;
    }
    if (src.tex === dst.tex) return S_OK;
    const dstFmt = dst.fmt.gpu;
    this.gpu.blit(src.tex, sr, dst.tex, dstFmt, dr, c.arg(5) === 2 || c.arg(5) === 3);
    dst.gpuDirty = true;
    return S_OK;
  }
  ColorFill(c: Cpu): number {
    const s = this.surf(c.arg(1));
    if (!s) return D3DERR.INVALIDCALL;
    const col = c.arg(3);
    const rgba: [number, number, number, number] = [((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, ((col >> 24) & 255) / 255];
    if (s.tex) {
      if (!c.arg(2)) { this.gpu.endPass(); this.gpu.setPendingClear(s.tex, { color: rgba }); s.gpuDirty = true; }
      else this.clearRects(s, c.arg(2), 1, rgba, 0, 0, true);
    } else if (s.shadow) {
      // fill the system-memory shadow (32-bit formats)
      const m = this.p.mem;
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) m.w32(s.shadow + y * s.pitch + x * 4, col);
    }
    return S_OK;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // render targets, scene, clear
  // ------------------------------------------------------------------------------------------------------------------
  SetRenderTarget(c: Cpu): number {
    const idx = c.arg(1);
    if (idx > 3) return D3DERR.INVALIDCALL;
    const s = c.arg(2) ? this.surf(c.arg(2)) : null;
    if (idx === 0 && !s) return D3DERR.INVALIDCALL;
    if (s && !s.tex) return D3DERR.INVALIDCALL;
    this.rtSurf[idx] = s;
    if (idx === 0 && s) {
      this.setViewportInternal({ x: 0, y: 0, w: s.w, h: s.h, minZ: 0, maxZ: 1 });
      this.scissor = { l: 0, t: 0, r: s.w, b: s.h };
    }
    return S_OK;
  }
  GetRenderTarget(c: Cpu): number {
    const s = this.rtSurf[c.arg(1)];
    if (!s) return D3DERR.NOTFOUND;
    this.p.mem.wptr(c.arg(2), s.ptr);
    s.refs++;
    return S_OK;
  }
  SetDepthStencilSurface(c: Cpu): number { this.dsSurf = c.arg(1) ? this.surf(c.arg(1)) : null; return S_OK; }
  GetDepthStencilSurface(c: Cpu): number {
    if (!this.dsSurf) { this.p.mem.wptr(c.arg(1), 0); return D3DERR.NOTFOUND; }
    this.p.mem.wptr(c.arg(1), this.dsSurf.ptr);
    this.dsSurf.refs++;
    return S_OK;
  }
  BeginScene(): number { if (this.sceneActive) return D3DERR.INVALIDCALL; this.sceneActive = true; return S_OK; }
  EndScene(): number { if (!this.sceneActive) return D3DERR.INVALIDCALL; this.sceneActive = false; return S_OK; }
  Clear(c: Cpu): number {
    const count = c.arg(1), rects = c.arg(2), flags = c.arg(3), color = c.arg(4);
    const z = fa(c, 5), stencil = c.arg(6);
    const rt = this.rtSurf[0], ds = this.dsSurf;
    const gpu = this.gpu;
    const vp = this.viewport;
    const fullVp = rt && vp.x === 0 && vp.y === 0 && vp.w >= rt.w && vp.h >= rt.h;
    const scissor = this.renderState[D3DRS.SCISSORTESTENABLE] !== 0;
    const full = !count && !rects && fullVp && !scissor;
    const rgba: [number, number, number, number] = [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, ((color >> 24) & 255) / 255];
    if (full) {
      if ((flags & D3DCLEAR.TARGET) && rt?.tex) { gpu.endPass(); gpu.setPendingClear(rt.tex, { color: rgba }); rt.gpuDirty = true; }
      if (ds?.tex && (flags & (D3DCLEAR.ZBUFFER | D3DCLEAR.STENCIL))) {
        const hasDepth = ds.fmt.depth, hasStencil = ds.fmt.stencil;
        const cl: { depth?: number; stencil?: number } = {};
        if ((flags & D3DCLEAR.ZBUFFER) && hasDepth) cl.depth = Math.min(Math.max(z, 0), 1);
        if ((flags & D3DCLEAR.STENCIL) && hasStencil) cl.stencil = stencil & 0xff;
        // a partial aspect clear (depth only on a depth+stencil buffer) keeps the other aspect: the pending-clear record only touches set fields
        gpu.endPass();
        gpu.setPendingClear(ds.tex, cl);
        ds.gpuDirty = true;
      }
      return S_OK;
    }
    // partial clear through quads
    if (rt) this.clearRects(rt, rects, count, rgba, flags, z, (flags & D3DCLEAR.TARGET) !== 0, stencil, ds);
    return S_OK;
  }

  private clearPipelines = new Map<string, GPURenderPipeline>();
  /** clear sub-rectangles by drawing quads */
  clearRects(rt: Surface9, rectsPtr: number, count: number, rgba: [number, number, number, number], flags: number, z: number, doColor: boolean, stencil = 0, ds: Surface9 | null = null) {
    const gpu = this.gpu, device = gpu.device;
    const m = this.p.mem;
    const rects: [number, number, number, number][] = [];
    const vp = this.viewport;
    const sc = this.renderState[D3DRS.SCISSORTESTENABLE] ? this.scissor : null;
    if (count && rectsPtr) for (let i = 0; i < count; i++) rects.push([m.ri32(rectsPtr + i * 16), m.ri32(rectsPtr + i * 16 + 4), m.ri32(rectsPtr + i * 16 + 8), m.ri32(rectsPtr + i * 16 + 12)]);
    else rects.push([0, 0, rt.w, rt.h]);
    const doDepth = ds && ds.tex && (flags & D3DCLEAR.ZBUFFER) && ds.fmt.depth;
    const doStencil = ds && ds.tex && (flags & D3DCLEAR.STENCIL) && ds.fmt.stencil;
    const key = `${rt.fmt.gpu}|${doColor}|${doDepth ? ds!.fmt.gpu : doStencil ? ds!.fmt.gpu : "-"}|${!!doDepth}|${!!doStencil}`;
    let pipe = this.clearPipelines.get(key);
    if (!pipe) {
      const code = `
struct U { rect: vec4<f32>, color: vec4<f32>, z: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct O { @builtin(position) p: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
  var q = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0));
  let a = q[i];
  var o: O;
  o.p = vec4<f32>(mix(u.rect.x, u.rect.z, a.x), mix(u.rect.y, u.rect.w, a.y), u.z.x, 1.0);
  return o;
}
@fragment fn fs() -> @location(0) vec4<f32> { return u.color; }`;
      const mod = device.createShaderModule({ code });
      const desc: GPURenderPipelineDescriptor = {
        layout: "auto", vertex: { module: mod, entryPoint: "vs" },
        fragment: { module: mod, entryPoint: "fs", targets: [{ format: rt.fmt.gpu, writeMask: doColor ? 0xf : 0 }] }, primitive: { topology: "triangle-strip" },
      };
      if (doDepth || doStencil) {
        const f = ds!.fmt.gpu;
        desc.depthStencil = { format: f, depthWriteEnabled: !!doDepth && /depth/.test(f), depthCompare: "always", stencilFront: doStencil ? { compare: "always", passOp: "replace" } : undefined, stencilBack: doStencil ? { compare: "always", passOp: "replace" } : undefined, stencilWriteMask: 0xff };
      }
      pipe = device.createRenderPipeline(desc);
      this.clearPipelines.set(key, pipe);
    }
    gpu.endPass();
    const depthAtt = ds && (doDepth || doStencil) ? { view: ds.view(), tex: ds.tex!, format: ds.fmt.gpu } : null;
    const target = { colors: [{ view: rt.view(), tex: rt.tex!, format: rt.fmt.gpu }], depth: depthAtt, width: rt.w, height: rt.h, samples: 1 };
    const pass = gpu.renderPass(target, `clr:${rt.uid}:${depthAtt ? ds!.uid : "-"}`);
    pass.setPipeline(pipe);
    for (const r of rects) {
      let [l, t, rr, b] = r;
      l = Math.max(l, vp.x); t = Math.max(t, vp.y); rr = Math.min(rr, vp.x + vp.w); b = Math.min(b, vp.y + vp.h);
      if (sc) { l = Math.max(l, sc.l); t = Math.max(t, sc.t); rr = Math.min(rr, sc.r); b = Math.min(b, sc.b); }
      if (rr <= l || b <= t) continue;
      const data = new Float32Array([(l / rt.w) * 2 - 1, 1 - (b / rt.h) * 2, (rr / rt.w) * 2 - 1, 1 - (t / rt.h) * 2, rgba[0], rgba[1], rgba[2], rgba[3], z, 0, 0, 0]);
      const buf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu.queue.writeBuffer(buf, 0, data);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }));
      pass.setStencilReference(stencil & 0xff);
      pass.setViewport(0, 0, rt.w, rt.h, 0, 1);
      pass.draw(4);
      gpu.deferDestroy(buf);
    }
    rt.gpuDirty = true;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // state setters (with state-block recording)
  // ------------------------------------------------------------------------------------------------------------------
  private rec(key: string, set: () => void, snap: () => () => void): boolean {
    if (!this.recording) return false;
    const i = this.recording.findIndex((e) => e.key === key);
    const e = { key, set, snap };
    if (i >= 0) this.recording[i] = e; else this.recording.push(e);
    return true;
  }
  setRsInternal(k: number, v: number) { this.renderState[k] = v; if (k === D3DRS.FOGENABLE || (k >= D3DRS.AMBIENT && k <= D3DRS.EMISSIVEMATERIALSOURCE) || k === D3DRS.TEXTUREFACTOR || k === D3DRS.FOGCOLOR || k === D3DRS.FOGSTART || k === D3DRS.FOGEND || k === D3DRS.FOGDENSITY) this.eng.ffpDirty = true; }
  SetRenderState(c: Cpu): number {
    const k = c.arg(1), v = c.arg(2);
    if (k > 255) return D3DERR.INVALIDCALL;
    if (this.rec("rs:" + k, () => this.setRsInternal(k, v), () => { const cv = this.renderState[k]; return () => this.setRsInternal(k, cv); })) return S_OK;
    this.setRsInternal(k, v);
    return S_OK;
  }
  GetRenderState(c: Cpu): number { this.p.mem.w32(c.arg(2), this.renderState[c.arg(1) & 255]); return S_OK; }
  private ssIndex(s: number): number { return s >= 256 ? 16 + (s - 256) : s; }
  SetSamplerState(c: Cpu): number {
    const i = this.ssIndex(c.arg(1)), t = c.arg(2), v = c.arg(3);
    if (i > 19 || t > 15) return D3DERR.INVALIDCALL;
    const set = () => { this.samplerState[i * 16 + t] = v; };
    if (this.rec(`ss:${i}:${t}`, set, () => { const cv = this.samplerState[i * 16 + t]; return () => { this.samplerState[i * 16 + t] = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetSamplerState(c: Cpu): number { this.p.mem.w32(c.arg(3), this.samplerState[this.ssIndex(c.arg(1)) * 16 + (c.arg(2) & 15)]); return S_OK; }
  SetTextureStageState(c: Cpu): number {
    const s = c.arg(1), t = c.arg(2), v = c.arg(3);
    if (s > 7 || t > 32) return D3DERR.INVALIDCALL;
    const set = () => { this.tss[s * 33 + t] = v; this.eng.ffpDirty = true; };
    if (this.rec(`tss:${s}:${t}`, set, () => { const cv = this.tss[s * 33 + t]; return () => { this.tss[s * 33 + t] = cv; this.eng.ffpDirty = true; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetTextureStageState(c: Cpu): number { this.p.mem.w32(c.arg(3), this.tss[(c.arg(1) & 7) * 33 + (c.arg(2) % 33)]); return S_OK; }
  SetTexture(c: Cpu): number {
    const s = this.ssIndex(c.arg(1));
    const t = c.arg(2) ? this.rt.objectAt(c.arg(2)) : null;
    if (s > 19) return D3DERR.INVALIDCALL;
    const tex = t instanceof BaseTexture9 ? t : t instanceof Surface9 && t.container ? t.container : null;
    const set = () => { this.tex[s] = tex; };
    if (this.rec("tex:" + s, set, () => { const cv = this.tex[s]; return () => { this.tex[s] = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetTexture(c: Cpu): number {
    const t = this.tex[this.ssIndex(c.arg(1))];
    if (!t) { this.p.mem.wptr(c.arg(2), 0); return S_OK; }
    this.p.mem.wptr(c.arg(2), t.ptrFor(t instanceof CubeTexture9 ? "IDirect3DCubeTexture9" : t instanceof VolumeTexture9 ? "IDirect3DVolumeTexture9" : "IDirect3DTexture9"));
    t.refs++;
    return S_OK;
  }
  SetTransform(c: Cpu): number {
    const st = c.arg(1);
    const m = new Float32Array(16);
    for (let i = 0; i < 16; i++) m[i] = this.p.mem.rf32(c.arg(2) + i * 4);
    const set = () => { this.transforms.set(st, m); this.eng.ffpDirty = true; };
    if (this.rec("tf:" + st, set, () => { const cv = this.transforms.get(st); return () => { if (cv) this.transforms.set(st, cv); this.eng.ffpDirty = true; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetTransform(c: Cpu): number {
    const m = this.transforms.get(c.arg(1)) ?? IDENTITY;
    for (let i = 0; i < 16; i++) this.p.mem.wf32(c.arg(2) + i * 4, m[i]);
    return S_OK;
  }
  MultiplyTransform(c: Cpu): number {
    const st = c.arg(1);
    const b = new Float32Array(16);
    for (let i = 0; i < 16; i++) b[i] = this.p.mem.rf32(c.arg(2) + i * 4);
    this.transforms.set(st, mul4(this.transforms.get(st) ?? IDENTITY, b));
    this.eng.ffpDirty = true;
    return S_OK;
  }
  setViewportInternal(v: { x: number; y: number; w: number; h: number; minZ: number; maxZ: number }) { this.viewport = v; this.eng.ffpDirty = true; }
  SetViewport(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    const v = { x: m.r32(a), y: m.r32(a + 4), w: m.r32(a + 8), h: m.r32(a + 12), minZ: m.rf32(a + 16), maxZ: m.rf32(a + 20) };
    const set = () => this.setViewportInternal(v);
    if (this.rec("viewport", set, () => { const cv = this.viewport; return () => this.setViewportInternal(cv); })) return S_OK;
    set();
    return S_OK;
  }
  GetViewport(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1), v = this.viewport;
    m.w32(a, v.x); m.w32(a + 4, v.y); m.w32(a + 8, v.w); m.w32(a + 12, v.h); m.wf32(a + 16, v.minZ); m.wf32(a + 20, v.maxZ);
    return S_OK;
  }
  SetScissorRect(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    const r = { l: m.ri32(a), t: m.ri32(a + 4), r: m.ri32(a + 8), b: m.ri32(a + 12) };
    const set = () => { this.scissor = r; };
    if (this.rec("scissor", set, () => { const cv = this.scissor; return () => { this.scissor = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetScissorRect(c: Cpu): number { const m = this.p.mem, a = c.arg(1), r = this.scissor; m.w32(a, r.l); m.w32(a + 4, r.t); m.w32(a + 8, r.r); m.w32(a + 12, r.b); return S_OK; }
  SetMaterial(c: Cpu): number {
    const m = this.p.mem;
    const mat = new Float32Array(17);
    for (let i = 0; i < 17; i++) mat[i] = m.rf32(c.arg(1) + i * 4);
    const set = () => { this.material = mat; this.eng.ffpDirty = true; };
    if (this.rec("material", set, () => { const cv = this.material; return () => { this.material = cv; this.eng.ffpDirty = true; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetMaterial(c: Cpu): number { for (let i = 0; i < 17; i++) this.p.mem.wf32(c.arg(1) + i * 4, this.material[i]); return S_OK; }
  SetLight(c: Cpu): number {
    const m = this.p.mem, a = c.arg(2), idx = c.arg(1);
    const rf = (o: number, n: number) => Array.from({ length: n }, (_, i) => m.rf32(a + o + i * 4));
    const L: LightData = { type: m.r32(a), diffuse: rf(4, 4), specular: rf(20, 4), ambient: rf(36, 4), position: rf(52, 3), direction: rf(64, 3), range: m.rf32(a + 76), falloff: m.rf32(a + 80), att: rf(84, 3), theta: m.rf32(a + 96), phi: m.rf32(a + 100) };
    const set = () => { this.lights.set(idx, L); this.eng.ffpDirty = true; };
    if (this.rec("light:" + idx, set, () => { const cv = this.lights.get(idx); return () => { if (cv) this.lights.set(idx, cv); this.eng.ffpDirty = true; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetLight(c: Cpu): number {
    const L = this.lights.get(c.arg(1));
    if (!L) return D3DERR.INVALIDCALL;
    const m = this.p.mem, a = c.arg(2);
    m.w32(a, L.type);
    const wf = (o: number, v: number[]) => v.forEach((x, i) => m.wf32(a + o + i * 4, x));
    wf(4, L.diffuse); wf(20, L.specular); wf(36, L.ambient); wf(52, L.position); wf(64, L.direction);
    m.wf32(a + 76, L.range); m.wf32(a + 80, L.falloff); wf(84, L.att); m.wf32(a + 96, L.theta); m.wf32(a + 100, L.phi);
    return S_OK;
  }
  LightEnable(c: Cpu): number {
    const idx = c.arg(1), en = c.arg(2) !== 0;
    const set = () => { if (en) this.lightEnabled.add(idx); else this.lightEnabled.delete(idx); this.eng.ffpDirty = true; };
    if (this.rec("lenable:" + idx, set, () => { const cv = this.lightEnabled.has(idx); return () => { if (cv) this.lightEnabled.add(idx); else this.lightEnabled.delete(idx); this.eng.ffpDirty = true; }; })) return S_OK;
    set();
    if (en && !this.lights.has(idx)) this.lights.set(idx, { type: 1, diffuse: [1, 1, 1, 0], specular: [0, 0, 0, 0], ambient: [0, 0, 0, 0], position: [0, 0, 0], direction: [0, 0, 1], range: 0, falloff: 0, att: [0, 0, 0], theta: 0, phi: 0 });
    return S_OK;
  }
  GetLightEnable(c: Cpu): number { this.p.mem.w32(c.arg(2), this.lightEnabled.has(c.arg(1)) ? 1 : 0); return S_OK; }
  SetClipPlane(c: Cpu): number { const i = c.arg(1); if (i > 5) return D3DERR.INVALIDCALL; for (let k = 0; k < 4; k++) this.clipPlanes[i * 4 + k] = this.p.mem.rf32(c.arg(2) + k * 4); this.eng.ffpDirty = true; return S_OK; }
  GetClipPlane(c: Cpu): number { const i = c.arg(1); for (let k = 0; k < 4; k++) this.p.mem.wf32(c.arg(2) + k * 4, this.clipPlanes[i * 4 + k]); return S_OK; }
  SetClipStatus(): number { return S_OK; }
  GetClipStatus(c: Cpu): number { this.p.mem.w32(c.arg(1), 0); this.p.mem.w32(c.arg(1) + 4, 0); return S_OK; }
  ValidateDevice(c: Cpu): number { if (c.arg(1)) this.p.mem.w32(c.arg(1), 1); return S_OK; }
  SetPaletteEntries(c: Cpu): number { this.paletteEntries.set(c.arg(1), this.p.mem.bytes(c.arg(2), 1024).slice()); return S_OK; }
  GetPaletteEntries(c: Cpu): number { const p = this.paletteEntries.get(c.arg(1)); if (p) this.p.mem.write(c.arg(2), p); return S_OK; }
  SetCurrentTexturePalette(): number { return S_OK; }
  GetCurrentTexturePalette(c: Cpu): number { this.p.mem.w32(c.arg(1), 0); return S_OK; }
  SetSoftwareVertexProcessing(c: Cpu): number { this.softwareVp = c.arg(1) !== 0; return S_OK; }
  GetSoftwareVertexProcessing(): number { return this.softwareVp ? 1 : 0; }
  SetNPatchMode(c: Cpu): number { this.nPatch = fa(c, 1); return S_OK; }
  GetNPatchMode(): void { /* float result */ }
  DrawRectPatch(): number { return S_OK; }
  DrawTriPatch(): number { return S_OK; }
  DeletePatch(): number { return S_OK; }
  ProcessVertices(): number { return S_OK; }
  GetGPUThreadPriority(c: Cpu): number { this.p.mem.w32(c.arg(1), 0); return S_OK; }
  SetGPUThreadPriority(): number { return S_OK; }
  WaitForVBlank(): number { return S_OK; }
  CheckResourceResidency(): number { return S_OK; }
  SetMaximumFrameLatency(): number { return S_OK; }
  GetMaximumFrameLatency(c: Cpu): number { this.p.mem.w32(c.arg(1), 3); return S_OK; }
  CheckDeviceState(): number { return S_OK; }
  GetDisplayModeEx(c: Cpu): number {
    const a = c.arg(2), m = this.p.mem, h = this.p.host;
    m.w32(a, 24); m.w32(a + 4, h.screenWidth); m.w32(a + 8, h.screenHeight); m.w32(a + 12, h.refreshRate); m.w32(a + 16, D3DFMT.X8R8G8B8); m.w32(a + 20, 0);
    return S_OK;
  }
  ComposeRects(): number { return S_OK; }
  SetConvolutionMonoKernel(): number { return S_OK; }

  // ------------------------------------------------------------------------------------------------------------------
  // vertex / pixel shader state
  // ------------------------------------------------------------------------------------------------------------------
  SetVertexDeclaration(c: Cpu): number {
    const d = c.arg(1) ? (this.rt.objectAt(c.arg(1)) as VertexDecl9) : null;
    const set = () => { this.decl = d; };
    if (this.rec("decl", set, () => { const cv = this.decl; return () => { this.decl = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetVertexDeclaration(c: Cpu): number {
    if (!this.decl) { this.p.mem.wptr(c.arg(1), 0); return S_OK; }
    this.p.mem.wptr(c.arg(1), this.decl.ptr); this.decl.refs++;
    return S_OK;
  }
  SetFVF(c: Cpu): number {
    const f = c.arg(1);
    const set = () => { this.fvf = f; this.fvfElements = fvfToElements(f); this.decl = null; this.fvfDecl = null; };
    if (this.rec("fvf", set, () => { const cf = this.fvf, cd = this.decl; return () => { this.fvf = cf; this.fvfElements = fvfToElements(cf); this.decl = cd; }; })) return S_OK;
    set();
    return S_OK;
  }
  fvfDecl: VertexDecl9 | null = null;
  GetFVF(c: Cpu): number { this.p.mem.w32(c.arg(1), this.fvf); return S_OK; }
  SetVertexShader(c: Cpu): number {
    const s = c.arg(1) ? (this.rt.objectAt(c.arg(1)) as Shader9) : null;
    const set = () => { this.vs = s; };
    if (this.rec("vs", set, () => { const cv = this.vs; return () => { this.vs = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetVertexShader(c: Cpu): number { if (!this.vs) { this.p.mem.wptr(c.arg(1), 0); return S_OK; } this.p.mem.wptr(c.arg(1), this.vs.ptr); this.vs.refs++; return S_OK; }
  SetPixelShader(c: Cpu): number {
    const s = c.arg(1) ? (this.rt.objectAt(c.arg(1)) as Shader9) : null;
    const set = () => { this.ps = s; };
    if (this.rec("ps", set, () => { const cv = this.ps; return () => { this.ps = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetPixelShader(c: Cpu): number { if (!this.ps) { this.p.mem.wptr(c.arg(1), 0); return S_OK; } this.p.mem.wptr(c.arg(1), this.ps.ptr); this.ps.refs++; return S_OK; }
  private setConsts(kind: "F" | "I" | "B", vs: boolean, c: Cpu): number {
    const reg = c.arg(1), data = c.arg(2), count = c.arg(3);
    const m = this.p.mem;
    const limit = kind === "F" ? 256 : 16;
    if (reg + count > limit) return D3DERR.INVALIDCALL;
    const arrF = vs ? this.vsF : this.psF, arrI = vs ? this.vsI : this.psI, arrB = vs ? this.vsB : this.psB;
    const vals: number[] = [];
    if (kind === "F") for (let i = 0; i < count * 4; i++) vals.push(m.rf32(data + i * 4));
    else if (kind === "I") for (let i = 0; i < count * 4; i++) vals.push(m.ri32(data + i * 4));
    else for (let i = 0; i < count; i++) vals.push(m.r32(data + i * 4) ? 1 : 0);
    const set = () => {
      if (kind === "F") arrF.set(vals, reg * 4); else if (kind === "I") arrI.set(vals, reg * 4); else arrB.set(vals, reg);
      if (vs) this.eng.vsDirty = true; else this.eng.psDirty = true;
    };
    const key = `${vs ? "v" : "p"}c${kind}:${reg}:${count}`;
    if (this.rec(key, set, () => { const cv = (kind === "F" ? arrF : kind === "I" ? arrI : arrB).slice(kind === "B" ? reg : reg * 4, kind === "B" ? reg + count : (reg + count) * 4); return () => { (kind === "F" ? arrF : kind === "I" ? arrI : arrB).set(cv as any, kind === "B" ? reg : reg * 4); if (vs) this.eng.vsDirty = true; else this.eng.psDirty = true; }; })) return S_OK;
    set();
    return S_OK;
  }
  private getConsts(kind: "F" | "I" | "B", vs: boolean, c: Cpu): number {
    const reg = c.arg(1), out = c.arg(2), count = c.arg(3), m = this.p.mem;
    const arrF = vs ? this.vsF : this.psF, arrI = vs ? this.vsI : this.psI, arrB = vs ? this.vsB : this.psB;
    if (kind === "F") for (let i = 0; i < count * 4; i++) m.wf32(out + i * 4, arrF[reg * 4 + i]);
    else if (kind === "I") for (let i = 0; i < count * 4; i++) m.w32(out + i * 4, arrI[reg * 4 + i]);
    else for (let i = 0; i < count; i++) m.w32(out + i * 4, arrB[reg + i]);
    return S_OK;
  }
  SetVertexShaderConstantF(c: Cpu): number { return this.setConsts("F", true, c); }
  SetVertexShaderConstantI(c: Cpu): number { return this.setConsts("I", true, c); }
  SetVertexShaderConstantB(c: Cpu): number { return this.setConsts("B", true, c); }
  GetVertexShaderConstantF(c: Cpu): number { return this.getConsts("F", true, c); }
  GetVertexShaderConstantI(c: Cpu): number { return this.getConsts("I", true, c); }
  GetVertexShaderConstantB(c: Cpu): number { return this.getConsts("B", true, c); }
  SetPixelShaderConstantF(c: Cpu): number { return this.setConsts("F", false, c); }
  SetPixelShaderConstantI(c: Cpu): number { return this.setConsts("I", false, c); }
  SetPixelShaderConstantB(c: Cpu): number { return this.setConsts("B", false, c); }
  GetPixelShaderConstantF(c: Cpu): number { return this.getConsts("F", false, c); }
  GetPixelShaderConstantI(c: Cpu): number { return this.getConsts("I", false, c); }
  GetPixelShaderConstantB(c: Cpu): number { return this.getConsts("B", false, c); }
  SetStreamSource(c: Cpu): number {
    const n = c.arg(1), off = c.arg(3), stride = c.arg(4);
    if (n > 15) return D3DERR.INVALIDCALL;
    const vb = c.arg(2) ? (this.rt.objectAt(c.arg(2)) as VertexBuffer9) : null;
    const set = () => { this.streams[n] = { vb, offset: off, stride }; };
    if (this.rec("stream:" + n, set, () => { const cv = this.streams[n]; return () => { this.streams[n] = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetStreamSource(c: Cpu): number {
    const s = this.streams[c.arg(1)];
    const m = this.p.mem;
    if (s?.vb) { m.wptr(c.arg(2), s.vb.ptr); s.vb.refs++; } else m.wptr(c.arg(2), 0);
    m.w32(c.arg(3), s?.offset ?? 0); m.w32(c.arg(4), s?.stride ?? 0);
    return S_OK;
  }
  SetStreamSourceFreq(c: Cpu): number {
    const n = c.arg(1), v = c.arg(2);
    const set = () => { this.streamFreq[n] = v; };
    if (this.rec("freq:" + n, set, () => { const cv = this.streamFreq[n]; return () => { this.streamFreq[n] = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetStreamSourceFreq(c: Cpu): number { this.p.mem.w32(c.arg(2), this.streamFreq[c.arg(1)]); return S_OK; }
  SetIndices(c: Cpu): number {
    const ib = c.arg(1) ? (this.rt.objectAt(c.arg(1)) as IndexBuffer9) : null;
    const set = () => { this.ib = ib; };
    if (this.rec("ib", set, () => { const cv = this.ib; return () => { this.ib = cv; }; })) return S_OK;
    set();
    return S_OK;
  }
  GetIndices(c: Cpu): number { if (!this.ib) { this.p.mem.wptr(c.arg(1), 0); return S_OK; } this.p.mem.wptr(c.arg(1), this.ib.ptr); this.ib.refs++; return S_OK; }

  // ------------------------------------------------------------------------------------------------------------------
  // state blocks
  // ------------------------------------------------------------------------------------------------------------------
  BeginStateBlock(): number { this.recording = []; return S_OK; }
  EndStateBlock(c: Cpu): number {
    if (!this.recording) return D3DERR.INVALIDCALL;
    const sb = new StateBlock9();
    this.rt.create(sb, ["IDirect3DStateBlock9"]);
    sb.dev = this; this.refs++; sb.onDestroy = () => this.releaseInternal();
    sb.entries = this.recording;
    this.recording = null;
    this.p.mem.wptr(c.arg(1), sb.ptr);
    return S_OK;
  }
  CreateStateBlock(c: Cpu): number {
    const type = c.arg(1); // 1 ALL, 2 PIXELSTATE, 3 VERTEXSTATE
    const sb = new StateBlock9();
    this.rt.create(sb, ["IDirect3DStateBlock9"]);
    sb.dev = this; this.refs++; sb.onDestroy = () => this.releaseInternal();
    const entries: JournalEntry[] = [];
    const add = (key: string, snap: () => () => void) => entries.push({ key, snap, set: snap() });
    const vertexRs = [D3DRS.CULLMODE, D3DRS.FOGENABLE, D3DRS.FOGCOLOR, D3DRS.FOGTABLEMODE, D3DRS.FOGSTART, D3DRS.FOGEND, D3DRS.FOGDENSITY, D3DRS.RANGEFOGENABLE, D3DRS.AMBIENT, D3DRS.COLORVERTEX, D3DRS.FOGVERTEXMODE,
      D3DRS.CLIPPING, D3DRS.LIGHTING, D3DRS.LOCALVIEWER, D3DRS.EMISSIVEMATERIALSOURCE, D3DRS.AMBIENTMATERIALSOURCE, D3DRS.DIFFUSEMATERIALSOURCE, D3DRS.SPECULARMATERIALSOURCE, D3DRS.VERTEXBLEND,
      D3DRS.CLIPPLANEENABLE, D3DRS.POINTSIZE, D3DRS.POINTSIZE_MIN, D3DRS.POINTSPRITEENABLE, D3DRS.POINTSCALEENABLE, D3DRS.POINTSCALE_A, D3DRS.POINTSCALE_B, D3DRS.POINTSCALE_C, D3DRS.POINTSIZE_MAX,
      D3DRS.INDEXEDVERTEXBLENDENABLE, D3DRS.TWEENFACTOR, D3DRS.NORMALIZENORMALS, D3DRS.SHADEMODE, D3DRS.SPECULARENABLE];
    const isVertexRs = (k: number) => vertexRs.includes(k as any);
    const wantV = type === 1 || type === 3, wantP = type === 1 || type === 2;
    for (let k = 7; k < 256; k++) {
      const v = isVertexRs(k);
      if ((v && wantV) || (!v && wantP)) add("rs:" + k, () => { const cv = this.renderState[k]; return () => this.setRsInternal(k, cv); });
    }
    if (wantP) {
      for (let s = 0; s < 16; s++) for (let t = 1; t < 14; t++) add(`ss:${s}:${t}`, () => { const cv = this.samplerState[s * 16 + t]; return () => { this.samplerState[s * 16 + t] = cv; }; });
      for (let s = 0; s < 8; s++) for (let t = 1; t < 33; t++) add(`tss:${s}:${t}`, () => { const cv = this.tss[s * 33 + t]; return () => { this.tss[s * 33 + t] = cv; this.eng.ffpDirty = true; }; });
      for (let s = 0; s < 16; s++) add("tex:" + s, () => { const cv = this.tex[s]; return () => { this.tex[s] = cv; }; });
      add("ps", () => { const cv = this.ps; return () => { this.ps = cv; }; });
      add("pcF", () => { const cv = this.psF.slice(); return () => { this.psF.set(cv); this.eng.psDirty = true; }; });
      add("pcI", () => { const cv = this.psI.slice(); return () => { this.psI.set(cv); this.eng.psDirty = true; }; });
      add("pcB", () => { const cv = this.psB.slice(); return () => { this.psB.set(cv); this.eng.psDirty = true; }; });
    }
    if (wantV) {
      for (let s = 16; s < 20; s++) add("tex:" + s, () => { const cv = this.tex[s]; return () => { this.tex[s] = cv; }; });
      add("vs", () => { const cv = this.vs; return () => { this.vs = cv; }; });
      add("vcF", () => { const cv = this.vsF.slice(); return () => { this.vsF.set(cv); this.eng.vsDirty = true; }; });
      add("vcI", () => { const cv = this.vsI.slice(); return () => { this.vsI.set(cv); this.eng.vsDirty = true; }; });
      add("vcB", () => { const cv = this.vsB.slice(); return () => { this.vsB.set(cv); this.eng.vsDirty = true; }; });
      add("decl", () => { const cv = this.decl, cf = this.fvf; return () => { this.decl = cv; this.fvf = cf; this.fvfElements = fvfToElements(cf); }; });
      for (let s = 0; s < 16; s++) add("stream:" + s, () => { const cv = this.streams[s]; return () => { this.streams[s] = cv; }; });
      for (let s = 0; s < 16; s++) add("freq:" + s, () => { const cv = this.streamFreq[s]; return () => { this.streamFreq[s] = cv; }; });
      add("material", () => { const cv = this.material; return () => { this.material = cv; this.eng.ffpDirty = true; }; });
      add("lights", () => { const l = new Map(this.lights), e = new Set(this.lightEnabled); return () => { this.lights = new Map(l); this.lightEnabled = new Set(e); this.eng.ffpDirty = true; }; });
      add("ib", () => { const cv = this.ib; return () => { this.ib = cv; }; });
    }
    if (type === 1) {
      add("viewport", () => { const cv = this.viewport; return () => this.setViewportInternal(cv); });
      add("scissor", () => { const cv = this.scissor; return () => { this.scissor = cv; }; });
      add("transforms", () => { const cv = new Map(this.transforms); return () => { this.transforms = new Map(cv); this.eng.ffpDirty = true; }; });
    }
    sb.entries = entries;
    this.p.mem.wptr(c.arg(2), sb.ptr);
    return S_OK;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // drawing
  // ------------------------------------------------------------------------------------------------------------------
  private beforeDraw(): boolean {
    if (this.ib) this.syncPendingBuffer(this.ib);
    return true;
  }
  private syncPendingBuffer(_b: IndexBuffer9) {}
  DrawPrimitive(c: Cpu): number {
    this.beforeDraw();
    this.upStride = -1;
    this.eng.drawPrimitive(c.arg(1), c.arg(3), { indexed: false, start: c.arg(2), baseVertex: 0, minIndex: 0, numVertices: 0 });
    return S_OK;
  }
  DrawIndexedPrimitive(c: Cpu): number {
    this.beforeDraw();
    this.upStride = -1;
    if (!this.ib) return D3DERR.INVALIDCALL;
    this.eng.drawPrimitive(c.arg(1), c.arg(6), { indexed: true, start: c.arg(5), baseVertex: c.argI(2), minIndex: c.arg(3), numVertices: c.arg(4) });
    return S_OK;
  }
  DrawPrimitiveUP(c: Cpu): number {
    const prim = c.arg(1), count = c.arg(2), data = c.arg(3), stride = c.arg(4);
    const n = vertexCount(prim, count);
    const vert = this.p.mem.bytes(data, n * stride).slice();
    this.upStride = stride;
    this.eng.drawPrimitive(prim, count, { indexed: false, start: 0, baseVertex: 0, minIndex: 0, numVertices: n, up: { vertex: vert, stride } });
    this.upStride = -1;
    return S_OK;
  }
  DrawIndexedPrimitiveUP(c: Cpu): number {
    const prim = c.arg(1), minIdx = c.arg(2), numVerts = c.arg(3), count = c.arg(4), idxData = c.arg(5), idxFmt = c.arg(6), data = c.arg(7), stride = c.arg(8);
    const is32 = idxFmt === D3DFMT.INDEX32;
    const nIdx = vertexCount(prim, count);
    const idx = this.p.mem.bytes(idxData, nIdx * (is32 ? 4 : 2)).slice();
    const vert = this.p.mem.bytes(data, (minIdx + numVerts) * stride).slice();
    this.upStride = stride;
    this.eng.drawPrimitive(prim, count, { indexed: true, start: 0, baseVertex: 0, minIndex: minIdx, numVertices: numVerts, up: { vertex: vert, stride, index: idx, index32: is32 } });
    this.upStride = -1;
    return S_OK;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // fixed function state derivation
  // ------------------------------------------------------------------------------------------------------------------
  ffpActive(): boolean { return !this.vs || !this.ps; }
  private ffpElements(): DeclElement[] { return this.decl ? this.decl.elements : this.fvfElements; }
  ffpVertexState(): FfpVertexState {
    const el = this.ffpElements();
    const rs = this.renderState;
    const find = (u: number, i = 0) => el.find((e) => e.usage === u && e.usageIndex === i);
    const pos = find(D3DDECLUSAGE.POSITION) ?? find(D3DDECLUSAGE.POSITIONT);
    const pretransformed = !!find(D3DDECLUSAGE.POSITIONT) && !find(D3DDECLUSAGE.POSITION);
    const texDims: number[] = new Array(8).fill(0);
    for (let i = 0; i < 8; i++) { const e = find(D3DDECLUSAGE.TEXCOORD, i); if (e) texDims[i] = declTypeSize(e.type) / 4; }
    const bw = find(D3DDECLUSAGE.BLENDWEIGHT);
    const lights: number[] = [];
    for (const i of [...this.lightEnabled].sort((a, b) => a - b)) { const L = this.lights.get(i); if (L && lights.length < MAX_LIGHTS) lights.push(L.type); }
    // texture stages in use
    let numStages = 0;
    const stages: FfpVertexState["stages"] = [];
    for (let s = 0; s < 8; s++) {
      const op = this.tss[s * 33 + 1];
      if (op === 1) break;
      const ti = this.tss[s * 33 + 11];
      stages.push({ index: ti & 0xffff, gen: (ti >> 16) & 0xf, ttff: this.tss[s * 33 + 24] });
      numStages++;
    }
    const fogEnable = rs[D3DRS.FOGENABLE] !== 0;
    const tableFog = rs[D3DRS.FOGTABLEMODE] !== 0;
    return {
      hasNormal: !!find(D3DDECLUSAGE.NORMAL), hasDiffuse: !!find(D3DDECLUSAGE.COLOR, 0), hasSpecular: !!find(D3DDECLUSAGE.COLOR, 1), pretransformed, position4: !!pos && declTypeSize(pos.type) === 16,
      blendWeights: bw ? declTypeSize(bw.type) / 4 : 0, blendIndices: !!find(D3DDECLUSAGE.BLENDINDICES), texCoordDims: texDims, lighting: rs[D3DRS.LIGHTING] !== 0 && !pretransformed,
      colorVertex: rs[D3DRS.COLORVERTEX] !== 0, diffuseSrc: rs[D3DRS.DIFFUSEMATERIALSOURCE], specularSrc: rs[D3DRS.SPECULARMATERIALSOURCE], ambientSrc: rs[D3DRS.AMBIENTMATERIALSOURCE], emissiveSrc: rs[D3DRS.EMISSIVEMATERIALSOURCE],
      specularEnable: rs[D3DRS.SPECULARENABLE] !== 0, normalize: rs[D3DRS.NORMALIZENORMALS] !== 0, localViewer: rs[D3DRS.LOCALVIEWER] !== 0, lights, vertexBlend: rs[D3DRS.VERTEXBLEND],
      fogVertexMode: fogEnable && !tableFog ? rs[D3DRS.FOGVERTEXMODE] : 0, fogEnable, rangeFog: rs[D3DRS.RANGEFOGENABLE] !== 0, tableFog, stages, numStages,
    };
  }
  ffpPixelState(): FfpPixelState {
    const rs = this.renderState;
    return { specularEnable: rs[D3DRS.SPECULARENABLE] !== 0, fogEnable: rs[D3DRS.FOGENABLE] !== 0, fogMode: rs[D3DRS.FOGTABLEMODE], hasSpecularInput: true };
  }
  ffpStages(): FfpStage[] {
    const out: FfpStage[] = [];
    for (let s = 0; s < 8; s++) {
      const b = s * 33;
      const colorOp = this.tss[b + 1];
      if (colorOp === 1) break;
      const t = this.tex[s];
      const ttff = this.tss[b + 24];
      const stage: FfpStage = {
        colorOp, colorArg1: this.tss[b + 2], colorArg2: this.tss[b + 3], colorArg0: this.tss[b + 26], alphaOp: this.tss[b + 4], alphaArg1: this.tss[b + 5], alphaArg2: this.tss[b + 6], alphaArg0: this.tss[b + 27],
        resultArg: this.tss[b + 28], hasTexture: !!t, dim: t ? t.dim : "2d", projected: (ttff & 256) !== 0, constant: this.tss[b + 32],
      };
      // a stage that needs a texture which is not bound ends the cascade (the previous result stays current)
      if (!t && stageNeedsTexture(stage)) break;
      out.push(stage);
    }
    return out;
  }
  ffpKey(): string {
    return JSON.stringify([this.ffpVertexState().stages.length, this.ffpStages().map((s) => [s.colorOp, s.alphaOp, s.hasTexture ? s.dim : 0])]);
  }
  /** packed uniform data for the fixed-function stages */
  ffpUniformData(): Float32Array {
    const out = new Float32Array(FFP_UNIFORM_BYTES / 4);
    const T = (n: number) => this.transforms.get(n) ?? IDENTITY;
    const world = T(256), view = T(2), proj = T(3);
    const wv = mul4(world, view), wvp = mul4(wv, proj);
    let o = 0;
    const put = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) out[o + i] = a[i]; o += a.length; };
    put(world); put(view); put(proj); put(wv); put(wvp);
    for (let i = 0; i < 8; i++) put(T(16 + i));
    for (let i = 0; i < 4; i++) put(mul4(T(256 + i), view));
    // normal matrix: rows of the inverse of the upper 3x3 of world*view
    const inv = invert3(wv);
    put([inv[0], inv[1], inv[2], 0, inv[3], inv[4], inv[5], 0, inv[6], inv[7], inv[8], 0]);
    const mat = this.material;
    put(mat.subarray(0, 4)); put(mat.subarray(4, 8)); put(mat.subarray(8, 12)); put(mat.subarray(12, 16)); put([mat[16], 0, 0, 0]);
    const amb = this.renderState[D3DRS.AMBIENT];
    put([((amb >> 16) & 255) / 255, ((amb >> 8) & 255) / 255, (amb & 255) / 255, ((amb >> 24) & 255) / 255]);
    // lights in view space, in enabled order
    const enabled = [...this.lightEnabled].sort((a, b) => a - b).slice(0, MAX_LIGHTS);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const L = enabled[i] !== undefined ? this.lights.get(enabled[i]) : undefined;
      if (!L) { put(new Array(28).fill(0)); continue; }
      const pv = transformPoint(view, L.position), dv = transformDir(view, L.direction);
      put([L.type, L.range, L.falloff, 0]); put(L.diffuse); put(L.specular); put(L.ambient);
      put([pv[0], pv[1], pv[2], Math.cos(L.phi / 2)]); put([dv[0], dv[1], dv[2], Math.cos(L.theta / 2)]); put([L.att[0], L.att[1], L.att[2], 0]);
    }
    const tf = this.renderState[D3DRS.TEXTUREFACTOR];
    put([((tf >> 16) & 255) / 255, ((tf >> 8) & 255) / 255, (tf & 255) / 255, ((tf >> 24) & 255) / 255]);
    const vp = this.viewport;
    put([vp.x, vp.y, vp.w, vp.h]);
    const fv = new Float32Array(new Uint32Array([this.renderState[D3DRS.FOGSTART], this.renderState[D3DRS.FOGEND], this.renderState[D3DRS.FOGDENSITY]]).buffer);
    put([fv[0], fv[1], fv[2], this.renderState[D3DRS.FOGVERTEXMODE]]);
    const fc = this.renderState[D3DRS.FOGCOLOR];
    put([((fc >> 16) & 255) / 255, ((fc >> 8) & 255) / 255, (fc & 255) / 255, 1]);
    put(this.clipPlanes);
    return out;
  }
}

const FOURCC_NULL = 0x4c4c554e;
export const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** row-major product A*B (row vectors: apply A first) */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  return r;
}
function transformPoint(m: Float32Array, p: number[]): number[] {
  const x = p[0], y = p[1], z = p[2];
  return [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
}
function transformDir(m: Float32Array, p: number[]): number[] {
  const x = p[0], y = p[1], z = p[2];
  return [x * m[0] + y * m[4] + z * m[8], x * m[1] + y * m[5] + z * m[9], x * m[2] + y * m[6] + z * m[10]];
}
/** inverse of the upper-left 3x3 of a row-major 4x4 matrix (row-major 3x3 result) */
function invert3(m: Float32Array): number[] {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

void E_NOINTERFACE; void S_FALSE; void D3DPT; void D3DLOCK; void D3DSWAPEFFECT; void fvfStride;
