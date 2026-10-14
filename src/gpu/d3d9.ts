// d3d9.dll: IDirect3D9 factory object, adapter/format/capability queries, and the DLL's exported entry points.
import { ComObject, ComRuntime, S_OK, E_NOINTERFACE } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import type { Process } from "../win32/process.ts";
import type { Gpu } from "./gpu.ts";
import { D3DERR, D3DFMT, D3DRTYPE, D3DUSAGE, D3DDEVTYPE } from "./d3d9-consts.ts";
import { fmt9, FORMATS9 } from "./formats9.ts";
import { Device9, SwapChain9, StateBlock9 } from "./d3d9-dev.ts";
import { BaseTexture9, Buffer9, CubeTexture9, IndexBuffer9, Query9, Shader9, Surface9, Texture9, VertexBuffer9, VertexDecl9, VolumeTexture9 } from "./d3d9-res.ts";
import { COM } from "./gen/com-tables.ts";

void [BaseTexture9, Buffer9, CubeTexture9, IndexBuffer9, Query9, Shader9, Surface9, Texture9, VertexBuffer9, VertexDecl9, VolumeTexture9, StateBlock9, SwapChain9, COM];

export class Direct3D9 extends ComObject {
  p!: Process;
  gpu: Gpu | null = null;
  isEx = false;
  deviceCount = 0;

  GetAdapterCount(): number { return 1; }
  GetAdapterIdentifier(c: Cpu): number {
    if (c.arg(1) !== 0) return D3DERR.INVALIDCALL;
    const a = c.arg(3), m = this.p.mem;
    m.fill(a, 0, 1104);
    m.wcstr(a, "chromeexe_d3d9.dll", 512);
    m.wcstr(a + 512, "Chrome.EXE WebGPU Adapter", 512);
    m.wcstr(a + 1024, "\\\\.\\DISPLAY1", 32);
    m.w32(a + 1056, 0x00010001); m.w32(a + 1060, 0x00090000 | 0x1); // DriverVersion
    m.w32(a + 1064, 0x10de); m.w32(a + 1068, 0x2684); m.w32(a + 1072, 0); m.w32(a + 1076, 1); // NVIDIA-style ids (applications switch on vendor)
    m.w32(a + 1080, 0xc0ffee01); m.w16(a + 1084, 0xd3d9); m.w16(a + 1086, 0x0001);
    m.w32(a + 1096, 1);
    return S_OK;
  }
  GetAdapterModeCount(c: Cpu): number { return c.arg(1) === 0 ? 8 : 0; }
  private static modes: [number, number][] = [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1600, 900], [1920, 1080], [2560, 1440]];
  EnumAdapterModes(c: Cpu): number {
    const i = c.arg(3), a = c.arg(4), m = this.p.mem;
    const modes = Direct3D9.modes;
    if (i >= modes.length) return D3DERR.INVALIDCALL;
    m.w32(a, modes[i][0]); m.w32(a + 4, modes[i][1]); m.w32(a + 8, 60); m.w32(a + 12, c.arg(2) || D3DFMT.X8R8G8B8);
    return S_OK;
  }
  GetAdapterDisplayMode(c: Cpu): number {
    const a = c.arg(2), m = this.p.mem, h = this.p.host;
    m.w32(a, h.screenWidth); m.w32(a + 4, h.screenHeight); m.w32(a + 8, h.refreshRate); m.w32(a + 12, D3DFMT.X8R8G8B8);
    return S_OK;
  }
  CheckDeviceType(): number { return S_OK; }
  CheckDeviceFormat(c: Cpu): number {
    const usage = c.arg(4), rtype = c.arg(5), fid = c.arg(6);
    const f = fmt9(fid);
    if (!f) return D3DERR.NOTAVAILABLE;
    if (usage & D3DUSAGE.DEPTHSTENCIL) return f.depth || f.stencil ? S_OK : D3DERR.NOTAVAILABLE;
    if (usage & D3DUSAGE.RENDERTARGET) { if (!f.renderable || f.compressed) return D3DERR.NOTAVAILABLE; }
    if (f.depth && rtype !== D3DRTYPE.SURFACE && !(fid > 0xffff)) return D3DERR.NOTAVAILABLE; // plain depth formats are not textures; INTZ/DF* are
    if (usage & D3DUSAGE.QUERY_VERTEXTEXTURE) { if (!(f.gpu.includes("32float") || f.gpu.includes("16float") || f.gpu.includes("8unorm"))) return D3DERR.NOTAVAILABLE; }
    if (usage & D3DUSAGE.AUTOGENMIPMAP) { if (!f.renderable) return D3DERR.NOTAVAILABLE; }
    if ((usage & D3DUSAGE.QUERY_POSTPIXELSHADER_BLENDING) && /32float/.test(f.gpu)) return D3DERR.NOTAVAILABLE;
    if ((usage & D3DUSAGE.QUERY_FILTER) && !f.filterable) return D3DERR.NOTAVAILABLE;
    if (rtype === D3DRTYPE.VOLUMETEXTURE && (f.depth || f.compressed)) return D3DERR.NOTAVAILABLE;
    return S_OK;
  }
  CheckDeviceMultiSampleType(c: Cpu): number {
    const ms = c.arg(5);
    if (c.arg(7)) this.p.mem.w32(c.arg(7), 1);
    return ms <= 1 ? S_OK : D3DERR.NOTAVAILABLE;
  }
  CheckDepthStencilMatch(c: Cpu): number { const f = fmt9(c.arg(5)); return f && (f.depth || f.stencil) ? S_OK : D3DERR.NOTAVAILABLE; }
  CheckDeviceFormatConversion(): number { return S_OK; }
  RegisterSoftwareDevice(): number { return D3DERR.INVALIDCALL; }
  GetAdapterMonitor(): number { return 0x7001; }
  GetAdapterLUID(c: Cpu): number { this.p.mem.w64(c.arg(2), 0x1234n); return S_OK; }
  GetAdapterModeCountEx(c: Cpu): number { return c.arg(1) === 0 ? 8 : 0; }
  EnumAdapterModesEx(c: Cpu): number {
    const i = c.arg(3), a = c.arg(4), m = this.p.mem;
    if (i >= Direct3D9.modes.length) return D3DERR.INVALIDCALL;
    m.w32(a, 24); m.w32(a + 4, Direct3D9.modes[i][0]); m.w32(a + 8, Direct3D9.modes[i][1]); m.w32(a + 12, 60); m.w32(a + 16, D3DFMT.X8R8G8B8); m.w32(a + 20, 0);
    return S_OK;
  }
  GetAdapterDisplayModeEx(c: Cpu): number {
    const a = c.arg(2), m = this.p.mem, h = this.p.host;
    m.w32(a, 24); m.w32(a + 4, h.screenWidth); m.w32(a + 8, h.screenHeight); m.w32(a + 12, h.refreshRate); m.w32(a + 16, D3DFMT.X8R8G8B8); m.w32(a + 20, 0);
    return S_OK;
  }
  GetDeviceCaps(c: Cpu): number { return this.writeCaps(c.arg(3)); }

  writeCaps(a: number): number {
    const m = this.p.mem;
    m.fill(a, 0, 304);
    const w = (o: number, v: number) => m.w32(a + o, v >>> 0);
    const wf = (o: number, v: number) => m.wf32(a + o, v);
    w(0, D3DDEVTYPE.HAL); w(4, 0);
    w(8, 0x20000); // Caps: READ_SCANLINE
    w(12, 0x40000000 | 0x20000000 | 0x20000 | 0x10000000); // CANAUTOGENMIPMAP | DYNAMICTEXTURES | FULLSCREENGAMMA | CANMANAGERESOURCE
    w(16, 0x20 | 0x80 | 0x100 | 0x200);
    w(20, 1 | 2 | 4 | 8 | 0x80000000); // presentation intervals
    w(24, 3); // cursor caps
    w(28, 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x80000 | 0x100000);
    w(32, 2 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x4000 | 0x8000 | 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000);
    w(36, 0x1 | 0x10 | 0x80 | 0x100 | 0x400 | 0x2000 | 0x20000 | 0x100000 | 0x200000 | 0x400000 | 0x1000000 | 0x2000000 | 0x4000000 | 0x8000000);
    w(40, 0xff); // ZCmpCaps
    w(44, 0x3fff); w(48, 0x3fff); // blend caps
    w(52, 0xff); // AlphaCmpCaps
    w(56, 0x8 | 0x20 | 0x80 | 0x200); // ShadeCaps
    w(60, 0x1 | 0x4 | 0x400 | 0x800 | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x40000 | 0x20000 | 0x1000 | 0x80); // TextureCaps (no POW2 limits)
    const filt = 0x100 | 0x200 | 0x400 | 0x800 | 0x1000000 | 0x2000000 | 0x4000000 | 0x8000000 | 0x10000000; // MINF/MIPF/MAGF point,linear,aniso
    w(64, filt); w(68, filt); w(72, filt);
    w(76, 0x1f); w(80, 0x1f); // address caps
    w(84, 0x7); // line caps TEXTURE|ZTEST|BLEND
    w(88, 16384); w(92, 16384); w(96, 2048); w(100, 8192); w(104, 8192); w(108, 16);
    wf(112, 1e10); wf(116, -1e8); wf(120, -1e8); wf(124, 1e8); wf(128, 1e8); wf(132, 0);
    w(136, 0xff); // stencil caps
    w(140, 8 | 0x10000 | 0x40); // FVFCaps: TEXCOORDCOUNTMASK=8 | DONOTSTRIPELEMENTS
    w(144, 0x03ffffff); // texture ops
    w(148, 8); w(152, 8);
    w(156, 1 | 2 | 8 | 0x10 | 0x20 | 0x40 | 0x100 | 0x200); // vertex processing caps
    w(160, 8); w(164, 6); w(168, 4); w(172, 255);
    wf(176, 8192); w(180, 0x1fffff); w(184, 0xffffff); w(188, 16); w(192, 508);
    w(196, 0xfffe0300); w(200, 256);
    w(204, 0xffff0300); wf(208, 65504);
    w(212, 0x1 | 0x2); wf(216, 0);
    w(236, 0x3ff); // DeclTypes
    w(240, 4); w(244, 0x03000300);
    w(248, 0x1 | 0x2 | 0x4 | 0x8); w(252, 24); w(256, 32); w(260, 4); // vs caps
    w(264, 0x1 | 0x2 | 0x4 | 0x8 | 0x10); w(268, 24); w(272, 32); w(276, 4); w(280, 512); // ps caps
    w(284, filt); w(288, 0xffff); w(292, 0xffff); w(296, 32768); w(300, 32768);
    return S_OK;
  }

  CreateDevice(c: Cpu): number { return this.createDevice(c, false); }
  CreateDeviceEx(c: Cpu): number { return this.createDevice(c, true); }
  private createDevice(c: Cpu, ex: boolean): number {
    const adapter = c.arg(1), type = c.arg(2), hwnd = c.arg(3), behavior = c.arg(4), pp = c.arg(5);
    const out = c.arg(ex ? 7 : 6);
    if (!this.gpu) { this.p.log("[d3d9] CreateDevice: WebGPU is not available"); return D3DERR.NOTAVAILABLE; }
    if (adapter !== 0) return D3DERR.INVALIDCALL;
    const dev = new Device9();
    this.rt.create(dev, ex ? ["IDirect3DDevice9Ex", "IDirect3DDevice9"] : ["IDirect3DDevice9", "IDirect3DDevice9Ex"]);
    dev.init(this.p, this.gpu, this);
    dev.debugShaders = !!this.p.ext.debugShaders;
    dev.adapter = adapter; dev.devType = type; dev.focusWindow = hwnd; dev.behavior = behavior;
    const params = dev.readPresentParams(pp);
    const ch = dev.makeSwapChain(params, true);
    if (!ch) return D3DERR.INVALIDCALL;
    // the application's parameter block is updated with the values actually used
    dev.writePresentParams(pp, ch.params);
    if (hwnd) { const w = this.p.win.win(hwnd); if (w) this.p.win.markGpuOwned(w); }
    this.refs++; // the device keeps its factory alive
    dev.releaseDevice = () => { this.releaseInternal(); };
    this.p.mem.wptr(out, dev.ptr);
    this.deviceCount++;
    return S_OK;
  }
  releaseInternal() {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0 && !this.destroyed) { this.destroyed = true; this.rt.free(this); }
  }
}

export function installD3D9(p: Process) {
  const k = p.hle.module("d3d9.dll");
  const create = (ex: boolean) => (c: Cpu) => {
    const d = new Direct3D9();
    p.com.create(d, ex ? ["IDirect3D9Ex", "IDirect3D9"] : ["IDirect3D9", "IDirect3D9Ex"]);
    d.p = p; d.gpu = p.ext.gpu ?? null; d.isEx = ex;
    if (ex) { p.mem.wptr(c.arg(1), d.ptr); return 0; }
    return d.ptr;
  };
  k.fn("Direct3DCreate9", create(false));
  k.fn("Direct3DCreate9Ex", create(true));
  k.fn("D3DPERF_BeginEvent", () => 0);
  k.fn("D3DPERF_EndEvent", () => 0);
  k.fn("D3DPERF_SetMarker", () => 0);
  k.fn("D3DPERF_SetRegion", () => 0);
  k.fn("D3DPERF_QueryRepeatFrame", () => 0);
  k.fn("D3DPERF_SetOptions", () => 0);
  k.fn("D3DPERF_GetStatus", () => 0);
  k.fn("DebugSetMute", () => 0);
  k.fn("Direct3D9EnableMaximizedWindowedModeShim", () => 0);
  k.fn("Direct3DShaderValidatorCreate9", () => 0);
  k.fn("PSGPError", () => 0);
  k.fn("PSGPSampleTexture", () => 0);
  void E_NOINTERFACE; void ComRuntime; void FORMATS9;
}
