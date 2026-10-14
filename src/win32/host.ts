// The embedder interface: everything the emulated machine needs from the outside world (display, input, audio, ...).
// The browser shell implements it with canvases and DOM events; tests implement it with plain objects.

export interface WindowInfo {
  hwnd: number;
  title: string;
  /** window rectangle in screen coordinates */
  x: number; y: number; w: number; h: number;
  /** client area size */
  cw: number; ch: number;
  visible: boolean;
  style: number;
  exStyle: number;
  topLevel: boolean;
  parent: number;
}

export type HostEvent =
  | { t: "key"; down: boolean; vk: number; scan: number; ext?: boolean; repeat?: boolean; text?: string; hwnd?: number }
  | { t: "mouse"; x: number; y: number; dx: number; dy: number; hwnd?: number; locked?: boolean }
  | { t: "button"; btn: 0 | 1 | 2 | 3 | 4; down: boolean; x: number; y: number; hwnd?: number }
  | { t: "wheel"; delta: number; horizontal?: boolean; x: number; y: number; hwnd?: number }
  | { t: "focus"; focused: boolean }
  | { t: "resize"; w: number; h: number; hwnd?: number }
  | { t: "close"; hwnd?: number }
  | { t: "text"; text: string };

export interface GamepadState {
  connected: boolean;
  buttons: number; // XINPUT_GAMEPAD_* bitmask
  lt: number; rt: number; // 0..255
  lx: number; ly: number; rx: number; ry: number; // -32768..32767
}

export interface Host {
  /** screen size reported to the application */
  screenWidth: number;
  screenHeight: number;
  refreshRate: number;
  createWindow?(info: WindowInfo): void;
  updateWindow?(info: WindowInfo): void;
  destroyWindow?(hwnd: number): void;
  /** the drawable surface (OffscreenCanvas) backing a top-level window, for WebGPU / 2D presentation */
  canvasFor?(hwnd: number): any;
  /** present a GDI-rendered client area (BGRA, w*h*4 bytes) */
  present2D?(hwnd: number, w: number, h: number, bgra: Uint8Array): void;
  /** how GPU frames are presented: "gpu" renders into the window's WebGPU canvas, "readback" copies pixels (headless browsers) */
  presentMode?: "gpu" | "readback";
  /** show raw pixels (bgra or rgba bytes) in the window's canvas */
  presentPixels?(hwnd: number, w: number, h: number, data: Uint8Array, bgra: boolean): void;
  /** drain pending input events */
  poll?(): HostEvent[];
  setCursor?(visible: boolean, shape?: string): void;
  setPointerLock?(on: boolean): void;
  setFullscreen?(on: boolean): void;
  /** the emulated display resolution changed */
  screenChanged?(w: number, h: number): void;
  messageBox?(title: string, text: string, type: number): number;
  readClipboard?(): string | null;
  writeClipboard?(s: string): void;
  gamepad?(index: number): GamepadState | null;
  /** rasterise text for GDI: alpha mask of the rendered string */
  drawText?(text: string, height: number, weight: number, face: string, italic: boolean): { w: number; h: number; alpha: Uint8Array } | null;
  measureText?(text: string, height: number, weight: number, face: string, italic: boolean): { w: number; h: number } | null;
  /** monotonically increasing wall clock in ms, defaults to performance.now() */
  now?(): number;
  /** called when the process terminates */
  exited?(code: number): void;
  log?(s: string): void;
  /** called by the machine when it presents a frame (frame pacing/statistics) */
  frame?(): void;
}

/** A host with no display, used by tests and headless runs. Events can be injected through `inject`. */
export class NullHost implements Host {
  screenWidth = 1920;
  screenHeight = 1080;
  refreshRate = 60;
  queue: HostEvent[] = [];
  windows = new Map<number, WindowInfo>();
  presents: { hwnd: number; w: number; h: number; bgra: Uint8Array }[] = [];
  messageBoxes: { title: string; text: string; type: number }[] = [];
  clipboard: string | null = null;
  pads: (GamepadState | null)[] = [null, null, null, null];
  createWindow(info: WindowInfo) { this.windows.set(info.hwnd, { ...info }); }
  updateWindow(info: WindowInfo) { this.windows.set(info.hwnd, { ...info }); }
  destroyWindow(hwnd: number) { this.windows.delete(hwnd); }
  present2D(hwnd: number, w: number, h: number, bgra: Uint8Array) { this.presents.push({ hwnd, w, h, bgra: bgra.slice() }); }
  poll(): HostEvent[] { const q = this.queue; this.queue = []; return q; }
  inject(e: HostEvent) { this.queue.push(e); }
  messageBox(title: string, text: string, type: number) { this.messageBoxes.push({ title, text, type }); return 1; }
  readClipboard() { return this.clipboard; }
  writeClipboard(s: string) { this.clipboard = s; }
  gamepad(i: number) { return this.pads[i] ?? null; }
}
