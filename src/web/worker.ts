// Emulator worker: owns the Process, runs the guest, and talks to the page through postMessage.
import { createProcess } from "../win32/index.ts";
import { Vfs } from "../win32/vfs.ts";
import { runAsync } from "../win32/driver.ts";
import type { GamepadState, Host, HostEvent, WindowInfo } from "../win32/host.ts";
import { FileTreeSource, HttpDirSource } from "./vfs.ts";
import { Gpu } from "../gpu/gpu.ts";
import type { FromWorker, InitMsg, ToWorker } from "./protocol.ts";

const post = (m: FromWorker, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? []);

class BrowserHost implements Host {
  screenWidth: number;
  screenHeight: number;
  refreshRate: number;
  events: HostEvent[] = [];
  pads: (GamepadState | null)[] = [null, null, null, null];
  private pool: OffscreenCanvas[];
  private assigned = new Map<number, number>();
  private free: number[];
  private wake: (() => void) | null = null;
  private measureCtx: OffscreenCanvasRenderingContext2D | null = null;
  clipboardText: string | null = null;
  presentMode: "gpu" | "readback" = "gpu";
  gpu: Gpu | null = null;
  private frames = 0;
  private lastStats = performance.now();

  constructor(init: InitMsg) {
    this.presentMode = init.opts.present ?? "gpu";
    this.screenWidth = init.screen.w;
    this.screenHeight = init.screen.h;
    this.refreshRate = init.screen.refresh;
    this.pool = init.canvases;
    this.free = this.pool.map((_, i) => i);
  }
  /** resolves the next time the page sends something */
  waitForEvent(): Promise<void> {
    return new Promise((r) => { this.wake = r; });
  }
  push(evs: HostEvent[]) {
    for (const e of evs) {
      // coalesce mouse moves
      const last = this.events[this.events.length - 1];
      if (e.t === "mouse" && last && last.t === "mouse" && last.hwnd === e.hwnd && last.locked === e.locked) {
        last.x = e.x; last.y = e.y; last.dx += e.dx; last.dy += e.dy;
      } else this.events.push(e);
    }
    this.wake?.();
    this.wake = null;
  }
  poll(): HostEvent[] {
    const e = this.events;
    if (!e.length) return e;
    this.events = [];
    return e;
  }
  createWindow(info: WindowInfo) {
    if (!info.topLevel) return;
    let idx = this.assigned.get(info.hwnd);
    if (idx === undefined) {
      idx = this.free.shift();
      if (idx === undefined) { this.pool.push(new OffscreenCanvas(info.cw || 1, info.ch || 1)); idx = this.pool.length - 1; }
      this.assigned.set(info.hwnd, idx);
    }
    post({ type: "window", op: "create", info, canvas: idx });
  }
  updateWindow(info: WindowInfo) {
    const idx = this.assigned.get(info.hwnd);
    if (idx === undefined) return this.createWindow(info);
    post({ type: "window", op: "update", info, canvas: idx });
  }
  destroyWindow(hwnd: number) {
    const idx = this.assigned.get(hwnd);
    if (idx === undefined) return;
    this.assigned.delete(hwnd);
    post({ type: "window", op: "destroy", info: { hwnd } as WindowInfo, canvas: idx });
    // canvases that already had a context cannot be reused for a different context type; keep it simple and do not recycle
  }
  canvasFor(hwnd: number): OffscreenCanvas | null {
    const idx = this.assigned.get(hwnd);
    return idx === undefined ? null : this.pool[idx];
  }
  present2D(hwnd: number, w: number, h: number, bgra: Uint8Array) { this.presentPixels(hwnd, w, h, bgra, true); }
  presentPixels(hwnd: number, w: number, h: number, px: Uint8Array, bgra: boolean) {
    const c = this.canvasFor(hwnd);
    if (!c) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    if (bgra) for (let i = 0; i < d.length; i += 4) { d[i] = px[i + 2]; d[i + 1] = px[i + 1]; d[i + 2] = px[i]; d[i + 3] = 255; }
    else for (let i = 0; i < d.length; i += 4) { d[i] = px[i]; d[i + 1] = px[i + 1]; d[i + 2] = px[i + 2]; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }
  setCursor(visible: boolean, shape?: string) { post({ type: "cursor", visible, shape }); }
  setPointerLock(on: boolean) { post({ type: "lock", on }); }
  setFullscreen(on: boolean) { post({ type: "fullscreen", on }); }
  messageBox(title: string, text: string, _type: number): number { post({ type: "messagebox", title, text }); return 1; }
  readClipboard(): string | null { return this.clipboardText; }
  writeClipboard(s: string) { this.clipboardText = s; post({ type: "clipboard", text: s }); }
  gamepad(i: number): GamepadState | null { return this.pads[i] ?? null; }
  frame() {
    if (this.gpu) for (const e of this.gpu.drainErrors().slice(0, 10)) post({ type: "log", text: "[gpu] " + e });
    this.frames++;
    const now = performance.now();
    if (now - this.lastStats > 1000) {
      post({ type: "stats", fps: (this.frames * 1000) / (now - this.lastStats), jit: {} });
      this.frames = 0;
      this.lastStats = now;
    }
  }
  private ctx(): OffscreenCanvasRenderingContext2D {
    if (!this.measureCtx) this.measureCtx = new OffscreenCanvas(8, 8).getContext("2d") as OffscreenCanvasRenderingContext2D;
    return this.measureCtx;
  }
  private font(h: number, weight: number, face: string, italic: boolean) {
    return `${italic ? "italic " : ""}${weight >= 600 ? "bold " : ""}${Math.max(h, 6)}px "${face}", Arial, sans-serif`;
  }
  measureText(text: string, h: number, weight: number, face: string, italic: boolean) {
    const ctx = this.ctx();
    ctx.font = this.font(h, weight, face, italic);
    return { w: Math.ceil(ctx.measureText(text).width), h: Math.ceil(h * 1.2) };
  }
  drawText(text: string, h: number, weight: number, face: string, italic: boolean) {
    const m = this.measureText(text, h, weight, face, italic)!;
    if (m.w <= 0) return null;
    const c = new OffscreenCanvas(m.w + 2, m.h + 2);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.font = this.font(h, weight, face, italic);
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff";
    ctx.fillText(text, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const alpha = new Uint8Array(c.width * c.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img[i * 4 + 3];
    return { w: c.width, h: c.height, alpha };
  }
}

let host: BrowserHost | null = null;

async function start(init: InitMsg) {
  host = new BrowserHost(init);
  const vfs = new Vfs();
  const root = "C:\\game";
  vfs.mount(root, new FileTreeSource(init.tree));
  if (init.sysdll) vfs.mount("C:\\Windows\\System32", new HttpDirSource(init.sysdll.base, init.sysdll.manifest));
  const exeRel = init.exe.replace(/\//g, "\\");
  const exePath = root + "\\" + exeRel;
  const exeDir = exePath.slice(0, exePath.lastIndexOf("\\"));
  const p = createProcess({
    vfs, host, exePath, cwd: exeDir,
    cmdline: `"${exePath}"${init.args ? " " + init.args : ""}`,
    stdout: (b) => post({ type: "stdout", stream: "out", bytes: b.slice() }),
    stderr: (b) => post({ type: "stdout", stream: "err", bytes: b.slice() }),
    log: (s) => post({ type: "log", text: s }),
    strictImports: !!init.opts.strict,
  });
  (self as any).__proc = p;
  p.ext.debugShaders = !!init.opts.debugShaders;
  try {
    const gpu = await Gpu.create();
    if (gpu) { p.ext.gpu = gpu; host.gpu = gpu; } else post({ type: "log", text: "[gpu] WebGPU is not available; Direct3D applications cannot render" });
  } catch (e: any) { post({ type: "log", text: "[gpu] initialisation failed: " + e.message }); }
  const data = vfs.readAll(exePath);
  if (!data) { post({ type: "crash", message: `cannot read ${exePath}` }); return; }
  try {
    p.loadExe(exePath, data);
  } catch (e: any) {
    post({ type: "crash", message: `failed to load ${init.exe}: ${e?.message ?? e}`, stack: e?.stack });
    return;
  }
  post({ type: "ready" });
  try {
    const code = await runAsync(p, { wake: () => host!.waitForEvent() });
    post({ type: "exit", code });
  } catch (e: any) {
    post({ type: "crash", message: e?.message ?? String(e), stack: e?.stack });
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": void start(m); break;
    case "event": host?.push([m.ev]); break;
    case "events": host?.push(m.evs); break;
    case "gamepads": if (host) host.pads = m.pads; break;
    case "screen": if (host) { host.screenWidth = m.w; host.screenHeight = m.h; } break;
    case "stop": close(); break;
  }
};
