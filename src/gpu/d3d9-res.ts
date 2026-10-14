// Direct3D 9 resource objects: surfaces, textures, buffers, declarations, shaders, queries.
import { ComObject, S_OK, E_NOINTERFACE } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import { D3DERR, D3DFMT, D3DPOOL, D3DRTYPE, D3DUSAGE, D3DLOCK, D3DDECLTYPE, D3DDECLUSAGE, D3DFVF } from "./d3d9-consts.ts";
import { fmt9, decodeBc } from "./formats9.ts";
import type { Fmt9 } from "./formats9.ts";
import { parseSm3 } from "./sm3.ts";
import type { Sm3Shader } from "./sm3.ts";
import type { Device9 } from "./d3d9-dev.ts";

let nextResId = 1;

/** common IDirect3DResource9 behaviour */
export class Resource9 extends ComObject {
  dev!: Device9;
  uid = nextResId++;
  rtype = 0;
  priv = new Map<string, Uint8Array>();
  priority = 0;
  /** Gpu encoder generation at the last GPU use (to order CPU writes against pending commands) */
  usedGen = -1;

  attach(dev: Device9) {
    this.dev = dev;
    dev.refs++; // resources keep their device alive
    this.onDestroy = () => { dev.releaseInternal(); };
  }
  GetDevice(c: Cpu): number {
    const out = c.arg(1);
    if (!out) return D3DERR.INVALIDCALL;
    this.rt.p.mem.wptr(out, this.dev.ptr);
    this.dev.refs++;
    return S_OK;
  }
  SetPrivateData(c: Cpu): number {
    const mem = this.rt.p.mem;
    const g = mem.bytes(c.arg(1), 16).join(",");
    const flags = c.arg(4);
    const size = c.arg(3);
    if (flags & 1) this.priv.set(g, new Uint8Array(8)); // D3DSPD_IUNKNOWN: store pointer
    this.priv.set(g, mem.bytes(c.arg(2), size).slice());
    return S_OK;
  }
  GetPrivateData(c: Cpu): number {
    const mem = this.rt.p.mem;
    const d = this.priv.get(mem.bytes(c.arg(1), 16).join(","));
    if (!d) return D3DERR.NOTFOUND;
    const szp = c.arg(3);
    const have = mem.r32(szp);
    mem.w32(szp, d.length);
    if (c.arg(2)) { if (have < d.length) return D3DERR.MOREDATA; mem.write(c.arg(2), d); }
    return S_OK;
  }
  FreePrivateData(c: Cpu): number { this.priv.delete(this.rt.p.mem.bytes(c.arg(1), 16).join(",")); return S_OK; }
  SetPriority(c: Cpu): number { const o = this.priority; this.priority = c.arg(1); return o; }
  GetPriority(): number { return this.priority; }
  PreLoad(): void {}
  GetType(): number { return this.rtype; }
}

// ------------------------------------------------------------------------------------------------------------------
// surfaces
// ------------------------------------------------------------------------------------------------------------------
export type SurfaceKind = "rt" | "ds" | "offscreen" | "level" | "back";

export class Surface9 extends Resource9 {
  w = 0;
  h = 0;
  fmt!: Fmt9;
  pool = 0;
  usage = 0;
  msaa = 0;
  kind: SurfaceKind = "offscreen";
  /** GPU texture holding the pixels (for render targets, depth buffers and texture levels) */
  tex: GPUTexture | null = null;
  container: Texture9 | CubeTexture9 | null = null;
  level = 0;
  face = 0;
  /** system-memory shadow of this surface in the native format */
  shadow = 0;
  pitch = 0;
  lockedRect: { l: number; t: number; r: number; b: number } | null = null;
  lockFlags = 0;
  lockCount = 0;
  /** true once something rendered into the GPU copy since the shadow was written */
  gpuDirty = false;
  views = new Map<string, GPUTextureView>();
  discard = false;

  init(dev: Device9, kind: SurfaceKind, w: number, h: number, fmt: Fmt9, pool: number, usage: number, msaa = 0) {
    if (kind === "level") this.dev = dev; else this.attach(dev); // level surfaces live and die with their texture
    this.kind = kind; this.w = w; this.h = h; this.fmt = fmt; this.pool = pool; this.usage = usage; this.msaa = msaa;
    this.rtype = D3DRTYPE.SURFACE;
    this.pitch = Math.max(1, Math.ceil(w / fmt.block)) * fmt.bytes;
  }
  allocShadow() {
    if (this.shadow) return;
    const rows = Math.max(1, Math.ceil(this.h / this.fmt.block));
    this.shadow = this.dev.p.vm.alloc(Math.max(this.pitch * rows, 16), { commit: true, tag: "d3d9-surface" });
  }
  get hasGpu(): boolean { return this.tex !== null; }
  /** a view for rendering/sampling this surface (mip level / face aware) */
  view(srgb = false): GPUTextureView {
    const key = srgb ? "s" : "n";
    let v = this.views.get(key);
    if (!v) {
      const fmt = srgb && this.fmt.srgb ? this.fmt.srgb : this.fmt.gpu;
      v = this.tex!.createView({ format: fmt, dimension: "2d", baseMipLevel: this.container ? this.level : 0, mipLevelCount: 1, baseArrayLayer: this.container instanceof CubeTexture9 ? this.face : 0, arrayLayerCount: 1, aspect: this.fmt.depth ? "all" : "all" });
      this.views.set(key, v);
    }
    return v;
  }
  destroy() {
    if (this.kind !== "level" && this.tex) this.tex.destroy();
    if (this.shadow && !this.container) this.dev.p.vm.release(this.shadow);
    this.tex = null;
  }
  AddRef(c: Cpu): number { return this.container ? this.container.AddRef(c) : super.AddRef(c); }
  Release(c: Cpu): number { return this.container ? this.container.Release(c) : super.Release(c); }
  GetContainer(c: Cpu): number {
    const out = c.arg(2);
    if (!this.container) return E_NOINTERFACE;
    return this.container.QueryInterface({ arg: (i: number) => [0, c.arg(1), out][i] } as any);
  }
  GetDesc(c: Cpu): number {
    const a = c.arg(1), mem = this.rt.p.mem;
    mem.w32(a, this.fmt.id); mem.w32(a + 4, this.rtype); mem.w32(a + 8, this.usage); mem.w32(a + 12, this.pool); mem.w32(a + 16, this.msaa); mem.w32(a + 20, 0); mem.w32(a + 24, this.w); mem.w32(a + 28, this.h);
    return S_OK;
  }
  LockRect(c: Cpu): number {
    const mem = this.rt.p.mem;
    const out = c.arg(1), rect = c.arg(2), flags = c.arg(3);
    if (this.pool === D3DPOOL.DEFAULT && !(this.usage & D3DUSAGE.DYNAMIC) && this.kind !== "offscreen" && this.kind !== "rt") {
      if (this.kind === "ds" && !(this.fmt.id === D3DFMT.D16_LOCKABLE || this.fmt.id === D3DFMT.D32F_LOCKABLE)) return D3DERR.INVALIDCALL;
      if (this.kind === "back") { /* backbuffers are lockable only with a flag; allow */ }
    }
    if (this.kind === "rt" && this.pool === D3DPOOL.DEFAULT && !this.lockableRt) return D3DERR.INVALIDCALL;
    this.allocShadow();
    let l = 0, t = 0, r = this.w, b = this.h;
    if (rect) { l = mem.ri32(rect); t = mem.ri32(rect + 4); r = mem.ri32(rect + 8); b = mem.ri32(rect + 12); if (l < 0 || t < 0 || r > this.w || b > this.h || l >= r || t >= b) return D3DERR.INVALIDCALL; }
    const blk = this.fmt.block;
    const addr = this.shadow + Math.floor(t / blk) * this.pitch + Math.floor(l / blk) * this.fmt.bytes;
    mem.w32(out, this.pitch); mem.wptr(out + 8, addr);
    this.lockedRect = { l, t, r, b };
    this.lockFlags = flags;
    this.lockCount++;
    // reading back a GPU-resident surface requires its current contents
    if (this.gpuDirty && !(flags & D3DLOCK.DISCARD) && this.tex) this.dev.readbackSurfaceSync(this);
    return S_OK;
  }
  lockableRt = false;
  UnlockRect(): number {
    if (!this.lockCount) return D3DERR.INVALIDCALL;
    this.lockCount--;
    const r = this.lockedRect;
    if (r && !(this.lockFlags & D3DLOCK.READONLY)) this.dev.uploadSurface(this, r.l, r.t, r.r, r.b);
    this.lockedRect = null;
    return S_OK;
  }
  GetDC(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), 0); return D3DERR.INVALIDCALL; }
  ReleaseDC(): number { return D3DERR.INVALIDCALL; }
}

// ------------------------------------------------------------------------------------------------------------------
// textures
// ------------------------------------------------------------------------------------------------------------------
export class BaseTexture9 extends Resource9 {
  levels = 1;
  fmt!: Fmt9;
  pool = 0;
  usage = 0;
  tex: GPUTexture | null = null;
  lod = 0;
  filterType = 2;
  dim: "2d" | "cube" | "3d" = "2d";
  w = 0;
  h = 0;
  d = 1;
  surfaces: Surface9[] = [];
  autogen = false;
  mipsDirty = false;
  viewCache = new Map<string, GPUTextureView>();

  viewFor(srgb: boolean): GPUTextureView {
    const key = (srgb ? "s" : "n") + this.dim;
    let v = this.viewCache.get(key);
    if (!v) {
      const f = srgb && this.fmt.srgb ? this.fmt.srgb : this.fmt.gpu;
      v = this.tex!.createView({ format: f, dimension: this.dim === "cube" ? "cube" : this.dim === "3d" ? "3d" : "2d", aspect: this.fmt.depth && !this.fmt.stencil ? "depth-only" : this.fmt.depth ? "depth-only" : "all" });
      this.viewCache.set(key, v);
    }
    return v;
  }
  SetLOD(c: Cpu): number { const o = this.lod; this.lod = Math.min(c.arg(1), this.levels - 1); return o; }
  GetLOD(): number { return this.lod; }
  GetLevelCount(): number { return this.levels; }
  SetAutoGenFilterType(c: Cpu): number { this.filterType = c.arg(1); return S_OK; }
  GetAutoGenFilterType(): number { return this.filterType; }
  GenerateMipSubLevels(): void { if (this.autogen || this.levels > 1) this.mipsDirty = true; this.dev.generateMips(this); }
  destroy() {
    this.tex?.destroy();
    this.tex = null;
    for (const s of this.surfaces) if (s) { if (s.shadow) this.dev.p.vm.release(s.shadow); s.destroyed = true; this.rt.free(s); }
    this.surfaces = [];
  }
}

export function mipLevels(w: number, h: number, d = 1): number {
  let n = 1;
  while (w > 1 || h > 1 || d > 1) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); d = Math.max(1, d >> 1); n++; }
  return n;
}

export class Texture9 extends BaseTexture9 {
  init(dev: Device9, w: number, h: number, levels: number, usage: number, fmt: Fmt9, pool: number) {
    this.attach(dev);
    this.rtype = D3DRTYPE.TEXTURE;
    this.w = w; this.h = h; this.fmt = fmt; this.pool = pool; this.usage = usage;
    this.autogen = (usage & D3DUSAGE.AUTOGENMIPMAP) !== 0;
    this.levels = this.autogen ? 1 : (levels === 0 ? mipLevels(w, h) : Math.min(levels, mipLevels(w, h)));
    this.dim = "2d";
  }
  GetLevelDesc(c: Cpu): number {
    const lv = c.arg(1);
    if (lv >= this.levels) return D3DERR.INVALIDCALL;
    return this.getSurface(lv).GetDesc({ arg: (i: number) => [0, c.arg(2)][i] } as any);
  }
  getSurface(level: number): Surface9 {
    let s = this.surfaces[level];
    if (!s) {
      s = new Surface9();
      this.rt.create(s, ["IDirect3DSurface9", "IDirect3DResource9"]);
      const w = Math.max(1, this.w >> level), h = Math.max(1, this.h >> level);
      s.init(this.dev, "level", w, h, this.fmt, this.pool, this.usage);
      s.container = this; s.level = level; s.tex = this.tex;
      // a level object does not hold a reference to the device separately from the texture; the texture owns the chain
      this.surfaces[level] = s;
    }
    return s;
  }
  GetSurfaceLevel(c: Cpu): number {
    const lv = c.arg(1), out = c.arg(2);
    if (lv >= this.levels || !out) return D3DERR.INVALIDCALL;
    const s = this.getSurface(lv);
    this.refs++; // the returned level keeps the texture alive
    this.rt.p.mem.wptr(out, s.ptr);
    return S_OK;
  }
  LockRect(c: Cpu): number {
    const lv = c.arg(1);
    if (lv >= this.levels) return D3DERR.INVALIDCALL;
    return this.getSurface(lv).LockRect({ arg: (i: number) => [0, c.arg(2), c.arg(3), c.arg(4)][i] } as any);
  }
  UnlockRect(c: Cpu): number { return this.getSurface(c.arg(1)).UnlockRect(); }
  AddDirtyRect(): number { return S_OK; }
}

export class CubeTexture9 extends BaseTexture9 {
  init(dev: Device9, edge: number, levels: number, usage: number, fmt: Fmt9, pool: number) {
    this.attach(dev);
    this.rtype = D3DRTYPE.CUBETEXTURE;
    this.w = this.h = edge; this.fmt = fmt; this.pool = pool; this.usage = usage;
    this.autogen = (usage & D3DUSAGE.AUTOGENMIPMAP) !== 0;
    this.levels = this.autogen ? 1 : (levels === 0 ? mipLevels(edge, edge) : Math.min(levels, mipLevels(edge, edge)));
    this.dim = "cube";
  }
  faceSurface(face: number, level: number): Surface9 {
    const idx = face * this.levels + level;
    let s = this.surfaces[idx];
    if (!s) {
      s = new Surface9();
      this.rt.create(s, ["IDirect3DSurface9", "IDirect3DResource9"]);
      const e = Math.max(1, this.w >> level);
      s.init(this.dev, "level", e, e, this.fmt, this.pool, this.usage);
      s.container = this; s.level = level; s.face = face; s.tex = this.tex;
      this.surfaces[idx] = s;
    }
    return s;
  }
  GetLevelDesc(c: Cpu): number { return this.faceSurface(0, c.arg(1)).GetDesc({ arg: (i: number) => [0, c.arg(2)][i] } as any); }
  GetCubeMapSurface(c: Cpu): number {
    const face = c.arg(1), lv = c.arg(2), out = c.arg(3);
    if (face > 5 || lv >= this.levels) return D3DERR.INVALIDCALL;
    const s = this.faceSurface(face, lv);
    this.refs++;
    this.rt.p.mem.wptr(out, s.ptr);
    return S_OK;
  }
  LockRect(c: Cpu): number { return this.faceSurface(c.arg(1), c.arg(2)).LockRect({ arg: (i: number) => [0, c.arg(3), c.arg(4), c.arg(5)][i] } as any); }
  UnlockRect(c: Cpu): number { return this.faceSurface(c.arg(1), c.arg(2)).UnlockRect(); }
  AddDirtyRect(): number { return S_OK; }
}

export class VolumeTexture9 extends BaseTexture9 {
  shadows: number[] = [];
  pitches: number[] = [];
  slicePitches: number[] = [];
  locked: number[] = [];
  init(dev: Device9, w: number, h: number, d: number, levels: number, usage: number, fmt: Fmt9, pool: number) {
    this.attach(dev);
    this.rtype = D3DRTYPE.VOLUMETEXTURE;
    this.w = w; this.h = h; this.d = d; this.fmt = fmt; this.pool = pool; this.usage = usage;
    this.levels = levels === 0 ? mipLevels(w, h, d) : Math.min(levels, mipLevels(w, h, d));
    this.dim = "3d";
    for (let l = 0; l < this.levels; l++) {
      const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l), ld = Math.max(1, d >> l);
      const pitch = Math.max(1, Math.ceil(lw / fmt.block)) * fmt.bytes;
      const rows = Math.max(1, Math.ceil(lh / fmt.block));
      this.pitches.push(pitch);
      this.slicePitches.push(pitch * rows);
      this.shadows.push(dev.p.vm.alloc(Math.max(pitch * rows * ld, 16), { commit: true, tag: "d3d9-volume" }));
    }
  }
  GetLevelDesc(c: Cpu): number {
    const lv = c.arg(1), a = c.arg(2), mem = this.rt.p.mem;
    mem.w32(a, this.fmt.id); mem.w32(a + 4, D3DRTYPE.VOLUME); mem.w32(a + 8, this.usage); mem.w32(a + 12, this.pool);
    mem.w32(a + 16, Math.max(1, this.w >> lv)); mem.w32(a + 20, Math.max(1, this.h >> lv)); mem.w32(a + 24, Math.max(1, this.d >> lv));
    return S_OK;
  }
  LockBox(c: Cpu): number {
    const lv = c.arg(1), out = c.arg(2), box = c.arg(3), mem = this.rt.p.mem;
    if (lv >= this.levels) return D3DERR.INVALIDCALL;
    let x = 0, y = 0, z = 0;
    if (box) { x = mem.r32(box); y = mem.r32(box + 4); z = mem.r32(box + 16); }
    mem.w32(out, this.pitches[lv]); mem.w32(out + 4, this.slicePitches[lv]);
    mem.wptr(out + 8, this.shadows[lv] + z * this.slicePitches[lv] + Math.floor(y / this.fmt.block) * this.pitches[lv] + Math.floor(x / this.fmt.block) * this.fmt.bytes);
    this.locked[lv] = (this.locked[lv] ?? 0) | ((c.arg(4) & D3DLOCK.READONLY) ? 0 : 1);
    return S_OK;
  }
  UnlockBox(c: Cpu): number {
    const lv = c.arg(1);
    if (this.locked[lv]) { this.locked[lv] = 0; this.dev.uploadVolumeLevel(this, lv); }
    return S_OK;
  }
  AddDirtyBox(): number { return S_OK; }
  destroy() {
    super.destroy();
    for (const s of this.shadows) this.dev.p.vm.release(s);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// buffers
// ------------------------------------------------------------------------------------------------------------------
export class Buffer9 extends Resource9 {
  size = 0;
  bufUsage = 0;
  pool = 0;
  gpu: GPUBuffer | null = null;
  shadow = 0;
  locked = 0;
  lockOff = 0;
  lockSize = 0;
  lockFlags = 0;
  gpuUsage: GPUBufferUsageFlags = 0;
  fvf = 0;
  format = 0;

  initBuffer(dev: Device9, size: number, usage: number, pool: number, gpuUsage: GPUBufferUsageFlags) {
    this.attach(dev);
    this.size = size; this.bufUsage = usage; this.pool = pool; this.gpuUsage = gpuUsage;
    this.shadow = dev.p.vm.alloc(Math.max(size, 16), { commit: true, tag: "d3d9-buffer" });
    this.gpu = dev.gpu.createBuffer(size, gpuUsage | GPUBufferUsage.COPY_DST, "d3d9 buffer");
  }
  Lock(c: Cpu): number {
    const off = c.arg(1), size = c.arg(2) || this.size - c.arg(1), out = c.arg(3), flags = c.arg(4);
    if (off + size > this.size) return D3DERR.INVALIDCALL;
    if (flags & D3DLOCK.DISCARD && this.bufUsage & D3DUSAGE.DYNAMIC) this.dev.orphanBuffer(this);
    this.rt.p.mem.wptr(out, this.shadow + off);
    this.locked++;
    this.lockOff = off; this.lockSize = size; this.lockFlags = flags;
    return S_OK;
  }
  Unlock(): number {
    if (!this.locked) return S_OK;
    this.locked--;
    if (!(this.lockFlags & D3DLOCK.READONLY)) this.dev.uploadBuffer(this, this.lockOff, this.lockSize);
    return S_OK;
  }
  GetDesc(c: Cpu): number {
    const a = c.arg(1), mem = this.rt.p.mem;
    mem.w32(a, this.format || D3DFMT.VERTEXDATA); mem.w32(a + 4, this.rtype); mem.w32(a + 8, this.bufUsage); mem.w32(a + 12, this.pool); mem.w32(a + 16, this.size); mem.w32(a + 20, this.fvf);
    return S_OK;
  }
  destroy() {
    this.gpu?.destroy();
    this.dev.p.vm.release(this.shadow);
  }
}
export class VertexBuffer9 extends Buffer9 {}
export class IndexBuffer9 extends Buffer9 {}

// ------------------------------------------------------------------------------------------------------------------
// vertex declarations and FVF
// ------------------------------------------------------------------------------------------------------------------
export interface DeclElement { stream: number; offset: number; type: number; method: number; usage: number; usageIndex: number }

export class VertexDecl9 extends ComObject {
  dev!: Device9;
  elements: DeclElement[] = [];
  fvf = 0;
  /** per stream: highest end offset of the elements (the implied stride) */
  streamEnd = new Map<number, number>();
  uid = nextResId++;
  attach(dev: Device9, el: DeclElement[]) {
    this.dev = dev;
    dev.refs++;
    this.onDestroy = () => dev.releaseInternal();
    this.elements = el;
    for (const e of el) this.streamEnd.set(e.stream, Math.max(this.streamEnd.get(e.stream) ?? 0, e.offset + declTypeSize(e.type)));
  }
  GetDeclaration(c: Cpu): number {
    const out = c.arg(1), pn = c.arg(2), mem = this.rt.p.mem;
    const n = this.elements.length + 1;
    if (out) {
      this.elements.forEach((e, i) => { const o = out + i * 8; mem.w16(o, e.stream); mem.w16(o + 2, e.offset); mem.w8(o + 4, e.type); mem.w8(o + 5, e.method); mem.w8(o + 6, e.usage); mem.w8(o + 7, e.usageIndex); });
      const e = out + this.elements.length * 8;
      mem.w16(e, 0xff); mem.w16(e + 2, 0); mem.w8(e + 4, D3DDECLTYPE.UNUSED); mem.w8(e + 5, 0); mem.w8(e + 6, 0); mem.w8(e + 7, 0);
    }
    if (pn) mem.w32(pn, n);
    return S_OK;
  }
  GetDevice(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; return S_OK; }
}

export function declTypeSize(t: number): number {
  switch (t) {
    case D3DDECLTYPE.FLOAT1: return 4; case D3DDECLTYPE.FLOAT2: return 8; case D3DDECLTYPE.FLOAT3: return 12; case D3DDECLTYPE.FLOAT4: return 16;
    case D3DDECLTYPE.D3DCOLOR: case D3DDECLTYPE.UBYTE4: case D3DDECLTYPE.SHORT2: case D3DDECLTYPE.UBYTE4N: case D3DDECLTYPE.SHORT2N: case D3DDECLTYPE.USHORT2N: case D3DDECLTYPE.UDEC3: case D3DDECLTYPE.DEC3N: case D3DDECLTYPE.FLOAT16_2: return 4;
    case D3DDECLTYPE.SHORT4: case D3DDECLTYPE.SHORT4N: case D3DDECLTYPE.USHORT4N: case D3DDECLTYPE.FLOAT16_4: return 8;
    default: return 0;
  }
}

/** vertex format + shader input kind for a D3DDECLTYPE */
export function declFormat(t: number): { fmt: GPUVertexFormat; kind: string } {
  switch (t) {
    case D3DDECLTYPE.FLOAT1: return { fmt: "float32", kind: "f" };
    case D3DDECLTYPE.FLOAT2: return { fmt: "float32x2", kind: "f" };
    case D3DDECLTYPE.FLOAT3: return { fmt: "float32x3", kind: "f" };
    case D3DDECLTYPE.FLOAT4: return { fmt: "float32x4", kind: "f" };
    case D3DDECLTYPE.D3DCOLOR: return { fmt: "unorm8x4", kind: "c" };
    case D3DDECLTYPE.UBYTE4: return { fmt: "uint8x4", kind: "u" };
    case D3DDECLTYPE.SHORT2: return { fmt: "sint16x2", kind: "i" };
    case D3DDECLTYPE.SHORT4: return { fmt: "sint16x4", kind: "i" };
    case D3DDECLTYPE.UBYTE4N: return { fmt: "unorm8x4", kind: "f" };
    case D3DDECLTYPE.SHORT2N: return { fmt: "snorm16x2", kind: "f" };
    case D3DDECLTYPE.SHORT4N: return { fmt: "snorm16x4", kind: "f" };
    case D3DDECLTYPE.USHORT2N: return { fmt: "unorm16x2", kind: "f" };
    case D3DDECLTYPE.USHORT4N: return { fmt: "unorm16x4", kind: "f" };
    case D3DDECLTYPE.UDEC3: return { fmt: "uint32", kind: "d" };
    case D3DDECLTYPE.DEC3N: return { fmt: "uint32", kind: "D" };
    case D3DDECLTYPE.FLOAT16_2: return { fmt: "float16x2", kind: "f" };
    case D3DDECLTYPE.FLOAT16_4: return { fmt: "float16x4", kind: "f" };
    default: return { fmt: "float32x4", kind: "f" };
  }
}

/** The vertex elements implied by an FVF code. */
export function fvfToElements(fvf: number): DeclElement[] {
  const el: DeclElement[] = [];
  let off = 0;
  const add = (type: number, usage: number, idx = 0) => { el.push({ stream: 0, offset: off, type, method: 0, usage, usageIndex: idx }); off += declTypeSize(type); };
  const pos = fvf & D3DFVF.POSITION_MASK;
  switch (pos) {
    case D3DFVF.XYZ: add(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.POSITION); break;
    case D3DFVF.XYZRHW: add(D3DDECLTYPE.FLOAT4, D3DDECLUSAGE.POSITIONT); break;
    case D3DFVF.XYZW: add(D3DDECLTYPE.FLOAT4, D3DDECLUSAGE.POSITION); break;
    case D3DFVF.XYZB1: case D3DFVF.XYZB2: case D3DFVF.XYZB3: case D3DFVF.XYZB4: case D3DFVF.XYZB5: {
      add(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.POSITION);
      const nb = (pos - D3DFVF.XYZB1) / 2 + 1;
      const lastByte = (fvf & D3DFVF.LASTBETA_UBYTE4) !== 0, lastColor = (fvf & D3DFVF.LASTBETA_D3DCOLOR) !== 0;
      const nw = lastByte || lastColor ? nb - 1 : nb;
      if (nw > 0) add([0, D3DDECLTYPE.FLOAT1, D3DDECLTYPE.FLOAT2, D3DDECLTYPE.FLOAT3, D3DDECLTYPE.FLOAT4][nw], D3DDECLUSAGE.BLENDWEIGHT);
      if (lastByte) add(D3DDECLTYPE.UBYTE4, D3DDECLUSAGE.BLENDINDICES);
      else if (lastColor) add(D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.BLENDINDICES);
      break;
    }
  }
  if (fvf & D3DFVF.NORMAL) add(D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.NORMAL);
  if (fvf & D3DFVF.PSIZE) add(D3DDECLTYPE.FLOAT1, D3DDECLUSAGE.PSIZE);
  if (fvf & D3DFVF.DIFFUSE) add(D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.COLOR, 0);
  if (fvf & D3DFVF.SPECULAR) add(D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.COLOR, 1);
  const nt = (fvf & D3DFVF.TEXCOUNT_MASK) >> D3DFVF.TEXCOUNT_SHIFT;
  for (let i = 0; i < nt; i++) {
    const sz = (fvf >> (16 + i * 2)) & 3; // 0 -> 2D, 1 -> 3D, 2 -> 4D, 3 -> 1D
    add(sz === 0 ? D3DDECLTYPE.FLOAT2 : sz === 1 ? D3DDECLTYPE.FLOAT3 : sz === 2 ? D3DDECLTYPE.FLOAT4 : D3DDECLTYPE.FLOAT1, D3DDECLUSAGE.TEXCOORD, i);
  }
  return el;
}
export function fvfStride(fvf: number): number {
  const el = fvfToElements(fvf);
  const last = el[el.length - 1];
  return last ? last.offset + declTypeSize(last.type) : 0;
}

// ------------------------------------------------------------------------------------------------------------------
// shaders
// ------------------------------------------------------------------------------------------------------------------
export class Shader9 extends ComObject {
  dev!: Device9;
  code!: Uint32Array;
  parsed: Sm3Shader | null = null;
  parseError: string | null = null;
  uid = nextResId++;
  stage: "vs" | "ps" = "vs";
  attach(dev: Device9, code: Uint32Array, stage: "vs" | "ps") {
    this.dev = dev; this.code = code; this.stage = stage;
    dev.refs++;
    this.onDestroy = () => dev.releaseInternal();
    try { this.parsed = parseSm3(code); } catch (e: any) { this.parseError = e.message; dev.p.log(`[d3d9] shader parse failed: ${e.message}`); }
  }
  GetDevice(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; return S_OK; }
  GetFunction(c: Cpu): number {
    const out = c.arg(1), pn = c.arg(2), mem = this.rt.p.mem;
    if (!out) { mem.w32(pn, this.code.length * 4); return S_OK; }
    const n = Math.min(mem.r32(pn), this.code.length * 4);
    mem.write(out, new Uint8Array(this.code.buffer, this.code.byteOffset, n));
    mem.w32(pn, this.code.length * 4);
    return S_OK;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// queries
// ------------------------------------------------------------------------------------------------------------------
export class Query9 extends ComObject {
  dev!: Device9;
  qtype = 0;
  issued = false;
  value = 0n;
  doneGen = -1;
  attach(dev: Device9, t: number) { this.dev = dev; this.qtype = t; dev.refs++; this.onDestroy = () => dev.releaseInternal(); }
  GetDevice(c: Cpu): number { this.rt.p.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; return S_OK; }
  GetType(): number { return this.qtype; }
  GetDataSize(): number { switch (this.qtype) { case 9: return 4; case 10: return 8; case 11: return 4; case 12: return 8; case 8: return 4; default: return 4; } }
  Issue(c: Cpu): number {
    const flags = c.arg(1);
    if (flags & 2) { this.issued = true; this.doneGen = this.dev.gpu.stats.submits; this.dev.gpu.flush(); } // END
    return S_OK;
  }
  GetData(c: Cpu): number {
    const out = c.arg(1), size = c.arg(2), mem = this.rt.p.mem;
    if (out && size) {
      switch (this.qtype) {
        case 8: mem.w32(out, 1); break; // event: signalled (the GPU work was submitted at Issue)
        case 9: mem.w32(out, 0x100000); break; // occlusion: report plenty of visible pixels
        case 10: mem.w64(out, BigInt(Math.floor(performance.now() * 1000))); break;
        case 11: mem.w32(out, 0); break; // timestamp disjoint = FALSE
        case 12: mem.w64(out, 1000000n); break;
        default: mem.fill(out, 0, size);
      }
    }
    return S_OK;
  }
}

export { fmt9, decodeBc };
export type { Fmt9 };
