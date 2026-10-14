// dxgi.dll: factory, adapter, output and swap chain objects.
import { ComObject, guidToString } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import type { Process } from "../win32/process.ts";
import type { Gpu } from "./gpu.ts";
import { BIND, E, USAGE } from "./d3d11-consts.ts";
import { Tex11 } from "./d3d11-res.ts";
import type { Device11 } from "./d3d11-dev.ts";
import { DXGI, fmt11 } from "./dxgi-fmt.ts";

const DISPLAY_MODES: [number, number][] = [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 800], [1280, 1024], [1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];

export class DxgiAdapter extends ComObject {
  p!: Process;
  index = 0;
  output: DxgiOutput | null = null;
  factory!: DxgiFactory;
  GetParent(c: Cpu): number { return this.factory.QueryInterface({ arg: (i: number) => [this.factory.ptr, c.arg(1), c.arg(2)][i] } as any); }
  EnumOutputs(c: Cpu): number {
    if (c.arg(1) !== 0) { this.p.mem.wptr(c.arg(2), 0); return E.DXGI_ERROR_NOT_FOUND; }
    if (!this.output) {
      const o = new DxgiOutput();
      this.rt.create(o, ["IDXGIOutput1", "IDXGIOutput", "IDXGIObject"]);
      o.p = this.p; o.adapter = this;
      this.output = o;
    }
    this.p.mem.wptr(c.arg(2), this.output.ptrFor("IDXGIOutput"));
    this.output.refs++;
    return 0;
  }
  private descCommon(a: number) {
    const m = this.p.mem;
    m.fill(a, 0, 304);
    m.wwstr(a, "Chrome.EXE WebGPU Adapter", 128);
    m.w32(a + 256, 0x10de); m.w32(a + 260, 0x2684); m.w32(a + 264, 0); m.w32(a + 268, 0xa1);
    m.w64(a + 272, 4096n * 1024n * 1024n); // dedicated video memory
    m.w64(a + 280, 0n); m.w64(a + 288, 8192n * 1024n * 1024n);
    m.w32(a + 296, 0x1234); m.w32(a + 300, 0);
  }
  GetDesc(c: Cpu): number { this.descCommon(c.arg(1)); return 0; }
  GetDesc1(c: Cpu): number { this.descCommon(c.arg(1)); this.p.mem.w32(c.arg(1) + 304, 0); return 0; }
  GetDesc2(c: Cpu): number { this.descCommon(c.arg(1)); const m = this.p.mem; m.w32(c.arg(1) + 304, 0); m.w32(c.arg(1) + 308, 0); m.w32(c.arg(1) + 312, 0); return 0; }
  CheckInterfaceSupport(c: Cpu): number { if (c.arg(2)) this.p.mem.w64(c.arg(2), 0x000a000000010001n); return 0; }
  RegisterHardwareContentProtectionTeardownStatusEvent(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  QueryVideoMemoryInfo(c: Cpu): number {
    const a = c.arg(4), m = this.p.mem;
    m.w64(a, 3072n * 1024n * 1024n); m.w64(a + 8, 2048n * 1024n * 1024n); m.w64(a + 16, 0n); m.w64(a + 24, 0n);
    return 0;
  }
  SetVideoMemoryReservation(): number { return 0; }
  RegisterVideoMemoryBudgetChangeNotificationEvent(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  UnregisterVideoMemoryBudgetChangeNotification(): void {}
}

export class DxgiOutput extends ComObject {
  p!: Process;
  adapter!: DxgiAdapter;
  GetParent(c: Cpu): number { return this.adapter.QueryInterface({ arg: (i: number) => [this.adapter.ptr, c.arg(1), c.arg(2)][i] } as any); }
  GetDesc(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1), h = this.p.host;
    m.fill(a, 0, 96);
    m.wwstr(a, "\\\\.\\DISPLAY1", 32);
    m.w32(a + 64, 0); m.w32(a + 68, 0); m.w32(a + 72, h.screenWidth); m.w32(a + 76, h.screenHeight);
    m.w32(a + 80, 1); m.w32(a + 84, 1); m.wptr(a + 88, 0x7001);
    return 0;
  }
  private modes(): [number, number][] {
    const h = this.p.host;
    const list = DISPLAY_MODES.filter(([w, hh]) => w <= h.screenWidth && hh <= h.screenHeight);
    if (!list.some(([w, hh]) => w === h.screenWidth && hh === h.screenHeight)) list.push([h.screenWidth, h.screenHeight]);
    return list;
  }
  GetDisplayModeList(c: Cpu): number {
    const m = this.p.mem, pn = c.arg(3), out = c.arg(4), modes = this.modes(), rate = this.p.host.refreshRate || 60;
    const fmt = c.arg(1);
    if (!fmt11(fmt)) { m.w32(pn, 0); return 0; }
    if (!out) { m.w32(pn, modes.length); return 0; }
    const room = m.r32(pn);
    modes.slice(0, room).forEach(([w, h], i) => { const a = out + i * 28; m.w32(a, w); m.w32(a + 4, h); m.w32(a + 8, rate); m.w32(a + 12, 1); m.w32(a + 16, fmt); m.w32(a + 20, 0); m.w32(a + 24, 0); });
    m.w32(pn, Math.min(room, modes.length));
    return room < modes.length ? E.DXGI_ERROR_MORE_DATA : 0;
  }
  GetDisplayModeList1(c: Cpu): number {
    const m = this.p.mem, pn = c.arg(3), out = c.arg(4), modes = this.modes(), rate = this.p.host.refreshRate || 60;
    if (!out) { m.w32(pn, modes.length); return 0; }
    const room = m.r32(pn);
    modes.slice(0, room).forEach(([w, h], i) => { const a = out + i * 32; m.w32(a, w); m.w32(a + 4, h); m.w32(a + 8, rate); m.w32(a + 12, 1); m.w32(a + 16, c.arg(1)); m.w32(a + 20, 0); m.w32(a + 24, 0); m.w32(a + 28, 0); });
    m.w32(pn, Math.min(room, modes.length));
    return 0;
  }
  FindClosestMatchingMode(c: Cpu): number {
    const m = this.p.mem, want = c.arg(1), out = c.arg(2);
    const w = m.r32(want) || this.p.host.screenWidth, h = m.r32(want + 4) || this.p.host.screenHeight;
    let best = this.modes()[0], bd = Infinity;
    for (const md of this.modes()) { const d = Math.abs(md[0] - w) + Math.abs(md[1] - h); if (d < bd) { bd = d; best = md; } }
    m.w32(out, best[0]); m.w32(out + 4, best[1]); m.w32(out + 8, this.p.host.refreshRate || 60); m.w32(out + 12, 1);
    m.w32(out + 16, m.r32(want + 16)); m.w32(out + 20, 0); m.w32(out + 24, 0);
    return 0;
  }
  FindClosestMatchingMode1(c: Cpu): number { return this.FindClosestMatchingMode(c); }
  WaitForVBlank(): number { return 0; }
  TakeOwnership(): number { return 0; }
  ReleaseOwnership(): void {}
  GetGammaControlCapabilities(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    m.fill(a, 0, 4128);
    m.w32(a, 0); m.w32(a + 4, 0); m.wf32(a + 8, 0); m.wf32(a + 12, 1); m.w32(a + 16, 1025);
    for (let i = 0; i < 1025; i++) m.wf32(a + 20 + i * 4, i / 1024);
    return 0;
  }
  SetGammaControl(): number { return 0; }
  GetGammaControl(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    m.fill(a, 0, 12 + 12 + 1025 * 12);
    m.wf32(a, 1); m.wf32(a + 4, 1); m.wf32(a + 8, 1);
    for (let i = 0; i < 1025; i++) { const o = a + 24 + i * 12; m.wf32(o, i / 1024); m.wf32(o + 4, i / 1024); m.wf32(o + 8, i / 1024); }
    return 0;
  }
  SetDisplaySurface(): number { return 0; }
  GetDisplaySurfaceData(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  GetDisplaySurfaceData1(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  GetFrameStatistics(c: Cpu): number { this.p.mem.fill(c.arg(1), 0, 32); return 0; }
  DuplicateOutput(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  SupportsOverlays(): number { return 0; }
}

export class DxgiFactory extends ComObject {
  p!: Process;
  adapter: DxgiAdapter | null = null;
  assoc = 0;
  assocFlags = 0;
  private ensureAdapter(): DxgiAdapter {
    if (!this.adapter) {
      const a = new DxgiAdapter();
      this.rt.create(a, ["IDXGIAdapter3", "IDXGIAdapter2", "IDXGIAdapter1", "IDXGIAdapter", "IDXGIObject"]);
      a.p = this.p; a.factory = this;
      this.adapter = a;
    }
    return this.adapter;
  }
  getAdapter(): DxgiAdapter { return this.ensureAdapter(); }
  EnumAdapters(c: Cpu): number {
    if (c.arg(1) !== 0) { this.p.mem.wptr(c.arg(2), 0); return E.DXGI_ERROR_NOT_FOUND; }
    const a = this.ensureAdapter();
    this.p.mem.wptr(c.arg(2), a.ptrFor("IDXGIAdapter"));
    a.refs++;
    return 0;
  }
  EnumAdapters1(c: Cpu): number {
    if (c.arg(1) !== 0) { this.p.mem.wptr(c.arg(2), 0); return E.DXGI_ERROR_NOT_FOUND; }
    const a = this.ensureAdapter();
    this.p.mem.wptr(c.arg(2), a.ptrFor("IDXGIAdapter1"));
    a.refs++;
    return 0;
  }
  EnumAdapterByLuid(c: Cpu): number {
    void c;
    const a = this.ensureAdapter();
    return a.QueryInterface({ arg: (i: number) => [a.ptr, c.arg(3), c.arg(4)][i] } as any);
  }
  EnumWarpAdapter(c: Cpu): number { const a = this.ensureAdapter(); return a.QueryInterface({ arg: (i: number) => [a.ptr, c.arg(1), c.arg(2)][i] } as any); }
  MakeWindowAssociation(c: Cpu): number { this.assoc = c.arg(1); this.assocFlags = c.arg(2); return 0; }
  GetWindowAssociation(c: Cpu): number { this.p.mem.wptr(c.arg(1), this.assoc); return 0; }
  CreateSoftwareAdapter(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  IsCurrent(): number { return 1; }
  IsWindowedStereoEnabled(): number { return 0; }
  GetParent(c: Cpu): number { this.p.mem.wptr(c.arg(2), 0); return E.DXGI_ERROR_NOT_FOUND; }
  GetSharedResourceAdapterLuid(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  RegisterStereoStatusWindow(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  RegisterStereoStatusEvent(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  UnregisterStereoStatus(): void {}
  RegisterOcclusionStatusWindow(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  RegisterOcclusionStatusEvent(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  UnregisterOcclusionStatus(): void {}
  CheckFeatureSupport(c: Cpu): number { if (c.arg(2)) this.p.mem.w32(c.arg(2), 0); return 0; }
  GetCreationFlags(): number { return 0; }

  private resolveDevice(ptr: number): Device11 | null {
    const o = this.rt.objectAt(ptr);
    if (!o) return null;
    if ((o as any).immediate) return o as unknown as Device11;
    return null;
  }
  CreateSwapChain(c: Cpu): number {
    const dev = this.resolveDevice(c.arg(1)), d = c.arg(2), out = c.arg(3);
    if (!dev || !d) return E.DXGI_ERROR_INVALID_CALL;
    return this.createFromDesc(dev, d, out);
  }
  /** build a swap chain from a DXGI_SWAP_CHAIN_DESC in guest memory */
  createFromDesc(dev: Device11, d: number, out: number): number {
    const m = this.p.mem;
    const sc = new SwapChain11();
    this.rt.create(sc, ["IDXGISwapChain2", "IDXGISwapChain1", "IDXGISwapChain", "IDXGIDeviceSubObject", "IDXGIObject"]);
    sc.factory = this;
    sc.hwnd = m.r32(d + 48);
    sc.width = m.r32(d); sc.height = m.r32(d + 4); sc.format = m.r32(d + 16);
    sc.samples = Math.max(1, m.r32(d + 28)); sc.usage = m.r32(d + 36); sc.bufferCount = m.r32(d + 40);
    sc.windowed = m.r32(d + 56) !== 0; sc.swapEffect = m.r32(d + 60); sc.flags = m.r32(d + 64);
    const r = sc.init(dev);
    if (r) { sc.destroyed = true; this.rt.free(sc); return r; }
    m.wptr(out, sc.ptr);
    return 0;
  }
  CreateSwapChainForHwnd(c: Cpu): number {
    const dev = this.resolveDevice(c.arg(1)), m = this.p.mem, hwnd = c.arg(2), d = c.arg(3), fs = c.arg(4), out = c.arg(6);
    if (!dev || !d) return E.DXGI_ERROR_INVALID_CALL;
    const sc = new SwapChain11();
    this.rt.create(sc, ["IDXGISwapChain2", "IDXGISwapChain1", "IDXGISwapChain", "IDXGIDeviceSubObject", "IDXGIObject"]);
    sc.factory = this;
    sc.hwnd = hwnd;
    sc.width = m.r32(d); sc.height = m.r32(d + 4); sc.format = m.r32(d + 8);
    sc.samples = Math.max(1, m.r32(d + 16)); sc.usage = m.r32(d + 24); sc.bufferCount = m.r32(d + 28);
    sc.swapEffect = m.r32(d + 36); sc.flags = m.r32(d + 44);
    sc.windowed = fs ? m.r32(fs + 16) !== 0 : true;
    const r = sc.init(dev);
    if (r) { sc.destroyed = true; this.rt.free(sc); return r; }
    m.wptr(out, sc.ptr);
    return 0;
  }
  CreateSwapChainForCoreWindow(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  CreateSwapChainForComposition(): number { return E.DXGI_ERROR_UNSUPPORTED; }
}

export class SwapChain11 extends ComObject {
  factory!: DxgiFactory;
  dev!: Device11;
  hwnd = 0;
  width = 0; height = 0; format = 0; samples = 1; usage = 0x20; bufferCount = 1; windowed = true; swapEffect = 0; flags = 0;
  back: Tex11 | null = null;
  /** single-sample copy for multisampled swap chains */
  resolved: GPUTexture | null = null;
  fullscreen = false;
  frames = 0;
  private canvas: any = null;
  private ctx: GPUCanvasContext | null = null;
  private configured = "";
  private inflight = 0;
  private vsyncBase = 0;
  private paceTarget = 0;
  private maxLatency = 3;
  private get p() { return this.dev.p; }
  private get gpu(): Gpu { return this.dev.gpu; }

  init(dev: Device11): number {
    this.dev = dev;
    const ws = dev.p.win;
    const w = this.hwnd ? ws.win(this.hwnd) : undefined;
    if (w) { const cs = ws.clientSize(w); if (!this.width) this.width = cs.w; if (!this.height) this.height = cs.h; ws.markGpuOwned(w); }
    if (!this.width) this.width = 800;
    if (!this.height) this.height = 600;
    if (!this.format) this.format = DXGI.R8G8B8A8_UNORM;
    if (!this.bufferCount) this.bufferCount = 2;
    dev.refs++;
    this.onDestroy = () => { dev.Release(null as any); };
    return this.build();
  }
  private build(): number {
    const f = fmt11(this.format);
    if (!f || f.unsupported) return E.INVALIDARG;
    const t = new Tex11();
    this.rt.create(t, ["ID3D11Texture2D", "ID3D11Resource", "ID3D11DeviceChild", "IDXGISurface1", "IDXGISurface", "IDXGIResource", "IDXGIDeviceSubObject", "IDXGIObject"]);
    const r = t.init(this.dev, 2, this.width, this.height, 1, 1, this.format, USAGE.DEFAULT, BIND.RENDER_TARGET | BIND.SHADER_RESOURCE, 0, 0, this.samples);
    if (r) { t.destroyed = true; this.rt.free(t); return r; }
    t.backBuffer = true;
    this.back = t;
    this.resolved = null;
    if (t.gpuSamples > 1) {
      this.resolved = this.gpu.device.createTexture({ size: { width: t.gw, height: t.gh }, format: t.gpuFmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    }
    return 0;
  }
  destroy() {
    if (this.back) { const b = this.back; this.back = null; b.refs = 1; b.Release(null as any); }
  }
  GetParent(c: Cpu): number { return this.factory.QueryInterface({ arg: (i: number) => [this.factory.ptr, c.arg(1), c.arg(2)][i] } as any); }
  GetDevice(c: Cpu): number {
    const out = c.arg(2);
    const g = guidToString(this.p.mem, c.arg(1));
    void g;
    return this.dev.QueryInterface({ arg: (i: number) => [this.dev.ptr, c.arg(1), out][i] } as any);
  }
  GetBuffer(c: Cpu): number {
    const i = c.arg(1), riid = c.arg(2), out = c.arg(3);
    if (!this.back || i >= Math.max(1, this.bufferCount)) return E.DXGI_ERROR_INVALID_CALL;
    return this.back.QueryInterface({ arg: (k: number) => [this.back!.ptr, riid, out][k] } as any);
  }
  GetDesc(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    m.fill(a, 0, 72);
    m.w32(a, this.width); m.w32(a + 4, this.height); m.w32(a + 8, this.p.host.refreshRate || 60); m.w32(a + 12, 1); m.w32(a + 16, this.format);
    m.w32(a + 28, this.samples); m.w32(a + 36, this.usage); m.w32(a + 40, this.bufferCount); m.wptr(a + 48, this.hwnd); m.w32(a + 56, this.windowed ? 1 : 0); m.w32(a + 60, this.swapEffect); m.w32(a + 64, this.flags);
    return 0;
  }
  GetDesc1(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    m.fill(a, 0, 48);
    m.w32(a, this.width); m.w32(a + 4, this.height); m.w32(a + 8, this.format); m.w32(a + 16, this.samples); m.w32(a + 24, this.usage); m.w32(a + 28, this.bufferCount); m.w32(a + 36, this.swapEffect); m.w32(a + 44, this.flags);
    return 0;
  }
  GetFullscreenDesc(c: Cpu): number {
    const m = this.p.mem, a = c.arg(1);
    m.fill(a, 0, 20);
    m.w32(a, this.p.host.refreshRate || 60); m.w32(a + 4, 1); m.w32(a + 16, this.windowed ? 1 : 0);
    return 0;
  }
  GetHwnd(c: Cpu): number { this.p.mem.wptr(c.arg(1), this.hwnd); return 0; }
  GetCoreWindow(): number { return E.DXGI_ERROR_UNSUPPORTED; }
  SetFullscreenState(c: Cpu): number {
    const on = c.arg(1) !== 0;
    this.fullscreen = on;
    this.windowed = !on;
    if (on) {
      const ws = this.p.win, w = this.hwnd ? ws.win(this.hwnd) : undefined;
      if (w) ws.setWindowPos(w, 0, 0, 0, this.p.host.screenWidth, this.p.host.screenHeight, 0x40 | 0x10);
      this.p.host.setFullscreen?.(true);
    } else this.p.host.setFullscreen?.(false);
    return 0;
  }
  GetFullscreenState(c: Cpu): number {
    if (c.arg(1)) this.p.mem.w32(c.arg(1), this.fullscreen ? 1 : 0);
    if (c.arg(2)) this.p.mem.wptr(c.arg(2), 0);
    return 0;
  }
  ResizeBuffers(c: Cpu): number {
    const count = c.arg(1), w = c.arg(2), h = c.arg(3), fmt = c.arg(4), flags = c.arg(5);
    if (this.back && this.back.refs > 1) { this.p.log("[dxgi] ResizeBuffers called while the application still holds back-buffer references"); }
    this.gpu.flush();
    if (count) this.bufferCount = count;
    const ws = this.p.win, win = this.hwnd ? ws.win(this.hwnd) : undefined;
    this.width = w || (win ? ws.clientSize(win).w : this.width);
    this.height = h || (win ? ws.clientSize(win).h : this.height);
    if (fmt) this.format = fmt;
    this.flags = flags;
    const old = this.back;
    const r = this.build();
    if (old) { old.refs = 1; old.Release(null as any); }
    this.configured = "";
    return r;
  }
  ResizeBuffers1(c: Cpu): number { return this.ResizeBuffers(c); }
  ResizeTarget(c: Cpu): number {
    const m = this.p.mem, d = c.arg(1);
    if (d && this.fullscreen) {
      const w = m.r32(d), h = m.r32(d + 4);
      if (w && h) this.p.win.setScreenSize(w, h);
    }
    return 0;
  }
  GetContainingOutput(c: Cpu): number {
    const a = this.factory.getAdapter();
    this.p.mem.wptr(c.arg(1), 0);
    const tmp = { arg: (i: number) => [0, 0, c.arg(1)][i] };
    const r = a.EnumOutputs(tmp as any);
    return r;
  }
  GetFrameStatistics(c: Cpu): number { this.p.mem.fill(c.arg(1), 0, 24); return 0; }
  GetLastPresentCount(c: Cpu): number { this.p.mem.w32(c.arg(1), this.frames); return 0; }
  IsTemporaryMonoSupported(): number { return 0; }
  GetRestrictToOutput(c: Cpu): number { this.p.mem.wptr(c.arg(1), 0); return 0; }
  SetBackgroundColor(): number { return 0; }
  GetBackgroundColor(c: Cpu): number { this.p.mem.fill(c.arg(1), 0, 16); return 0; }
  SetRotation(): number { return 0; }
  GetRotation(c: Cpu): number { this.p.mem.w32(c.arg(1), 1); return 0; }
  SetSourceSize(): number { return 0; }
  GetSourceSize(c: Cpu): number { this.p.mem.w32(c.arg(1), this.width); this.p.mem.w32(c.arg(2), this.height); return 0; }
  SetMaximumFrameLatency(c: Cpu): number { this.maxLatency = c.arg(1) || 3; return 0; }
  GetMaximumFrameLatency(c: Cpu): number { this.p.mem.w32(c.arg(1), this.maxLatency); return 0; }
  GetFrameLatencyWaitableObject(): number { return 0; }
  SetMatrixTransform(): number { return 0; }
  GetMatrixTransform(): number { return 0; }

  Present(c: Cpu): number { return this.present(c.arg(1), c.arg(2)); }
  Present1(c: Cpu): number { return this.present(c.arg(1), c.arg(2)); }

  private pace(interval: number) {
    const p = this.p;
    if (this.inflight >= Math.min(3, this.maxLatency + 1)) p.waitUntil(() => this.inflight < Math.min(3, this.maxLatency + 1), 0xffffffff, "gpu frame pacing");
    if (interval === 0) return;
    const period = 1000 / Math.max(30, p.host.refreshRate || 60) * interval;
    if (!this.paceTarget) {
      const now = performance.now();
      if (!this.vsyncBase || now - this.vsyncBase > period * 8) this.vsyncBase = now;
      this.paceTarget = this.vsyncBase + Math.max(1, Math.ceil((now - this.vsyncBase) / period)) * period;
      if (this.paceTarget - now < 0.5) this.paceTarget += period;
    }
    const target = this.paceTarget;
    if (performance.now() < target - 0.5) p.waitUntil(() => performance.now() >= target - 0.5, Math.max(1, Math.ceil(target - performance.now())), "vsync");
    this.vsyncBase = target - Math.ceil((target - this.vsyncBase) / period) * period;
    this.paceTarget = 0;
  }

  present(interval: number, flags: number): number {
    if (flags & 1) return 0; // DXGI_PRESENT_TEST
    if (!this.back || !this.back.gpu) return E.DXGI_ERROR_INVALID_CALL;
    this.pace(interval);
    const gpu = this.gpu, p = this.p, host = p.host;
    const t = this.back;
    t.usedGen = gpu.stats.submits;
    gpu.resolveTexture(t.gpu!);
    gpu.endPass();
    this.dev.immediate.eng.invalidatePass();
    let src: GPUTexture = t.gpu!;
    if (t.gpuSamples > 1 && this.resolved) {
      gpu.resolveViews(t.gpu!.createView({ dimension: "2d" }), this.resolved.createView({ dimension: "2d" }));
      src = this.resolved;
    }
    const ws = p.win;
    let w = this.hwnd ? ws.win(this.hwnd) : undefined;
    if (w) w = ws.rootOf(w);
    const canvas = w ? host.canvasFor?.(w.hwnd) : null;
    if (canvas && w) {
      w.gpuOwned = true;
      const fmtName = src.format;
      if (host.presentMode === "readback") {
        const bgra = fmtName.startsWith("bgra");
        const bpp = t.gpuBytes;
        if (/^(rgba8|bgra8)/.test(fmtName)) {
          const hw = w.hwnd, tw = t.w, th = t.h;
          this.inflight++;
          gpu.readTexture(src, bpp, 0, 0, tw, th).then((px) => { host.presentPixels?.(hw, tw, th, px, bgra); }).catch((e) => p.log(`[dxgi] readback present failed: ${e}`)).finally(() => { this.inflight--; });
        } else this.dev.p.log(`[dxgi] readback presentation of ${fmtName} is not supported`);
      } else {
        try {
          if (canvas.width !== t.w || canvas.height !== t.h) { canvas.width = t.w; canvas.height = t.h; this.configured = ""; }
          if (this.canvas !== canvas) { this.canvas = canvas; this.ctx = null; this.configured = ""; }
          if (!this.ctx) this.ctx = canvas.getContext("webgpu");
          if (this.ctx && this.configured !== `${t.w}x${t.h}`) {
            this.ctx.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
            this.configured = `${t.w}x${t.h}`;
          }
          if (this.ctx) {
            const cur = this.ctx.getCurrentTexture();
            if (src.format === gpu.canvasFormat && cur.width === src.width && cur.height === src.height) gpu.cmd().copyTextureToTexture({ texture: src }, { texture: cur }, { width: cur.width, height: cur.height });
            else gpu.blit(src, null, cur, gpu.canvasFormat, null, !/32float/.test(fmtName));
          }
        } catch (e: any) { p.log(`[dxgi] present failed: ${e.message}`); }
        gpu.flush();
        this.inflight++;
        gpu.queue.onSubmittedWorkDone().then(() => { this.inflight--; }, () => { this.inflight = Math.max(0, this.inflight - 1); });
      }
    } else {
      gpu.flush();
    }
    this.frames++;
    host.frame?.();
    p.yieldRequested = true;
    return 0;
  }
}

export function installDxgi(p: Process) {
  const k = p.hle.module("dxgi.dll");
  const make = (ifaceSet: string[]) => (c: Cpu, riidIdx: number, outIdx: number): number => {
    const f = new DxgiFactory();
    p.com.create(f, ifaceSet);
    f.p = p;
    const out = c.arg(outIdx);
    p.mem.wptr(out, 0);
    const r = f.QueryInterface({ arg: (i: number) => [f.ptr, c.arg(riidIdx), out][i] } as any);
    f.refs--; // creation reference: the interface pointer handed out holds the only one
    return r;
  };
  const factoryIfaces = ["IDXGIFactory4", "IDXGIFactory3", "IDXGIFactory2", "IDXGIFactory1", "IDXGIFactory", "IDXGIObject"];
  k.fn("CreateDXGIFactory", (c) => make(factoryIfaces)(c, 0, 1));
  k.fn("CreateDXGIFactory1", (c) => make(factoryIfaces)(c, 0, 1));
  k.fn("CreateDXGIFactory2", (c) => make(factoryIfaces)(c, 1, 2));
  k.fn("DXGIGetDebugInterface1", () => E.DXGI_ERROR_UNSUPPORTED);
  k.fn("DXGIDeclareAdapterRemovalSupport", () => 0);
  k.fn("DXGID3D10CreateDevice", () => E.FAIL);
  k.fn("DXGID3D10CreateLayeredDevice", () => E.FAIL);
  k.fn("DXGID3D10GetLayeredDeviceSize", () => 0);
  k.fn("DXGID3D10RegisterLayers", () => E.FAIL);
  k.fn("DXGIReportAdapterConfiguration", () => 0);
}
