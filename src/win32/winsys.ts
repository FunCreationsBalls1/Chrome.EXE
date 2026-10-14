// Window manager: window tree, message queues, input state, timers and host-event translation.
// The user32 export surface (user32.ts) is a thin layer over this class.
import type { Process, Thread } from "./process.ts";
import type { Host, HostEvent, WindowInfo } from "./host.ts";

export const WM = {
  NULL: 0, CREATE: 1, DESTROY: 2, MOVE: 3, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, KILLFOCUS: 8, ENABLE: 0xa, SETREDRAW: 0xb,
  SETTEXT: 0xc, GETTEXT: 0xd, GETTEXTLENGTH: 0xe, PAINT: 0xf, CLOSE: 0x10, QUERYENDSESSION: 0x11, QUIT: 0x12, ERASEBKGND: 0x14,
  SYSCOLORCHANGE: 0x15, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1c, CANCELMODE: 0x1f, SETCURSOR: 0x20, MOUSEACTIVATE: 0x21,
  GETMINMAXINFO: 0x24, WINDOWPOSCHANGING: 0x46, WINDOWPOSCHANGED: 0x47, INPUT_DEVICE_CHANGE: 0xfe, INPUT: 0xff,
  GETICON: 0x7f, SETICON: 0x80, NCCREATE: 0x81, NCDESTROY: 0x82, NCCALCSIZE: 0x83, NCHITTEST: 0x84, NCPAINT: 0x85,
  NCACTIVATE: 0x86, GETDLGCODE: 0x87, NCMOUSEMOVE: 0xa0, NCLBUTTONDOWN: 0xa1, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102,
  DEADCHAR: 0x103, SYSKEYDOWN: 0x104, SYSKEYUP: 0x105, SYSCHAR: 0x106, UNICHAR: 0x109, INITDIALOG: 0x110, COMMAND: 0x111, SYSCOMMAND: 0x112,
  TIMER: 0x113, MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, LBUTTONDBLCLK: 0x203, RBUTTONDOWN: 0x204, RBUTTONUP: 0x205,
  RBUTTONDBLCLK: 0x206, MBUTTONDOWN: 0x207, MBUTTONUP: 0x208, MBUTTONDBLCLK: 0x209, MOUSEWHEEL: 0x20a, XBUTTONDOWN: 0x20b,
  XBUTTONUP: 0x20c, XBUTTONDBLCLK: 0x20d, MOUSEHWHEEL: 0x20e, SIZING: 0x214, CAPTURECHANGED: 0x215, MOVING: 0x216,
  ENTERSIZEMOVE: 0x231, EXITSIZEMOVE: 0x232, MOUSELEAVE: 0x2a3, DPICHANGED: 0x2e0, DISPLAYCHANGE: 0x7e, SETFONT: 0x30,
  GETFONT: 0x31, USER: 0x400, APP: 0x8000,
} as const;

export const WS = {
  OVERLAPPED: 0, POPUP: 0x80000000, CHILD: 0x40000000, MINIMIZE: 0x20000000, VISIBLE: 0x10000000, DISABLED: 0x8000000,
  CLIPSIBLINGS: 0x4000000, CLIPCHILDREN: 0x2000000, MAXIMIZE: 0x1000000, BORDER: 0x800000, DLGFRAME: 0x400000, CAPTION: 0xc00000,
  VSCROLL: 0x200000, HSCROLL: 0x100000, SYSMENU: 0x80000, THICKFRAME: 0x40000, MINIMIZEBOX: 0x20000, MAXIMIZEBOX: 0x10000,
  OVERLAPPEDWINDOW: 0xcf0000,
} as const;
export const WS_EX = {
  DLGMODALFRAME: 1, TOPMOST: 8, TOOLWINDOW: 0x80, WINDOWEDGE: 0x100, CLIENTEDGE: 0x200, APPWINDOW: 0x40000, LAYERED: 0x80000,
  NOACTIVATE: 0x8000000, STATICEDGE: 0x20000, TRANSPARENT: 0x20,
} as const;

export const SW = { HIDE: 0, SHOWNORMAL: 1, SHOWMINIMIZED: 2, SHOWMAXIMIZED: 3, SHOWNOACTIVATE: 4, SHOW: 5, MINIMIZE: 6, SHOWMINNOACTIVE: 7, SHOWNA: 8, RESTORE: 9, SHOWDEFAULT: 10 } as const;
export const SWP = { NOSIZE: 1, NOMOVE: 2, NOZORDER: 4, NOREDRAW: 8, NOACTIVATE: 0x10, FRAMECHANGED: 0x20, SHOWWINDOW: 0x40, HIDEWINDOW: 0x80, NOOWNERZORDER: 0x200, NOSENDCHANGING: 0x400 } as const;
export const CS = { VREDRAW: 1, HREDRAW: 2, DBLCLKS: 8, OWNDC: 0x20, CLASSDC: 0x40, PARENTDC: 0x80, SAVEBITS: 0x800 } as const;
export const CW_USEDEFAULT = 0x80000000;

export const ERR_CLASS_ALREADY_EXISTS = 1410, ERR_CANNOT_FIND_WND_CLASS = 1407, ERR_INVALID_WINDOW_HANDLE = 1400, ERR_INVALID_PARAMETER = 87;

export interface Rect { l: number; t: number; r: number; b: number }

export interface WndClass {
  atom: number;
  name: string; // original case
  key: string; // lowercase
  style: number;
  proc: number;
  clsExtra: number;
  wndExtra: number;
  hInstance: number;
  hIcon: number;
  hCursor: number;
  hbrBackground: number;
  menuName: number;
  hIconSm: number;
  unicode: boolean;
  extra: Uint8Array;
  system: boolean;
}

export interface Win {
  hwnd: number;
  cls: WndClass;
  parent: number;
  owner: number;
  /** children, topmost first */
  children: number[];
  style: number;
  exStyle: number;
  /** window rectangle in screen coordinates */
  x: number; y: number; w: number; h: number;
  text: string;
  proc: number;
  unicode: boolean;
  extra: Uint8Array;
  userData: bigint;
  id: number;
  tid: number;
  props: Map<string, bigint>;
  invalid: Rect | null;
  erase: boolean;
  menu: number;
  destroyed: boolean;
  /** GDI client-area surface (BGRA) */
  surface: { w: number; h: number; data: Uint8Array; dirty: boolean } | null;
  /** a GPU swap chain owns the client area */
  gpuOwned: boolean;
  hInstance: number;
  minimized: boolean;
  maximized: boolean;
  restore: Rect | null;
  alpha: number;
  hIcon: number;
  hIconSmall: number;
  /** DC bookkeeping */
  ownDc: number;
}

export interface Msg {
  hwnd: number;
  msg: number;
  wp: bigint;
  lp: bigint;
  time: number;
  x: number;
  y: number;
  /** pending WM_CHAR text for key-down messages */
  text?: string;
  /** raw input payload */
  raw?: { kind: "mouse" | "kbd"; flags: number; buttonFlags: number; buttonData: number; dx: number; dy: number; vk: number; scan: number; message: number; down: boolean };
}

export interface Timer { hwnd: number; id: number; interval: number; next: number; proc: number; tid: number; sys: boolean }

export interface ThreadQueue {
  tid: number;
  posted: Msg[];
  quit: { code: number } | null;
  /** last message returned to the application */
  cur: Msg | null;
  inSend: number;
}

export const VK = { LBUTTON: 1, RBUTTON: 2, CANCEL: 3, MBUTTON: 4, XBUTTON1: 5, XBUTTON2: 6, BACK: 8, TAB: 9, RETURN: 13, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, PAUSE: 0x13, CAPITAL: 0x14, ESCAPE: 0x1b, SPACE: 0x20, LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5, F10: 0x79 } as const;

const MK = { LBUTTON: 1, RBUTTON: 2, SHIFT: 4, CONTROL: 8, MBUTTON: 0x10, XBUTTON1: 0x20, XBUTTON2: 0x40 };

export interface SysMetrics { [k: number]: number }

export class WinSys {
  readonly p: Process;
  readonly host: Host;
  classes = new Map<string, WndClass>();
  atoms = new Map<number, WndClass>();
  nextAtom = 0xc000;
  wins = new Map<number, Win>();
  /** top-level windows, topmost first */
  zorder: number[] = [];
  nextHwnd = 0x10010;
  queues = new Map<number, ThreadQueue>();
  timers: Timer[] = [];
  nextTimerId = 0x100;
  desktop: Win;
  // input state
  keyState = new Uint8Array(256);
  asyncKeyState = new Uint8Array(256);
  cursorX = 0;
  cursorY = 0;
  cursorVisibleCount = 0;
  cursor = 0;
  clip: Rect | null = null;
  focus = 0;
  active = 0;
  foreground = 0;
  capture = 0;
  appActive = false;
  mouseButtons = 0;
  lastInput = 0;
  lastClick = { time: 0, btn: -1, x: 0, y: 0 };
  hoverTrack = new Map<number, number>();
  rawDevices: { usagePage: number; usage: number; flags: number; hwnd: number }[] = [];
  rawQueue = new Map<number, Msg>(); // handle -> message holding raw data
  nextRawHandle = 0x5000;
  registeredMessages = new Map<string, number>();
  nextRegMsg = 0xc000;
  pointerLocked = false;
  tickBase = performance.now();
  dpi = 96;
  dpiAware = false;
  hooks: { id: number; type: number; proc: number; tid: number }[] = [];
  nextHook = 1;
  lastError = (n: number) => this.p.setLastError(n);

  constructor(p: Process) {
    this.p = p;
    this.host = p.host;
    this.cursorX = this.host.screenWidth >> 1;
    this.cursorY = this.host.screenHeight >> 1;
    this.desktop = this.makeDesktop();
  }

  now(): number { return Math.floor(this.host.now ? this.host.now() : performance.now()); }
  tick(): number { return Math.floor(performance.now() - this.tickBase + 0x10000) >>> 0; }

  private makeDesktop(): Win {
    const cls = this.makeClass({ name: "#32769", style: 0, proc: 0, system: true });
    const w: Win = {
      hwnd: 0x10010, cls, parent: 0, owner: 0, children: [], style: WS.POPUP | WS.VISIBLE, exStyle: 0, x: 0, y: 0,
      w: this.host.screenWidth, h: this.host.screenHeight, text: "", proc: 0, unicode: true, extra: new Uint8Array(0), userData: 0n,
      id: 0, tid: 0, props: new Map(), invalid: null, erase: false, menu: 0, destroyed: false, surface: null, gpuOwned: false,
      hInstance: 0, minimized: false, maximized: false, restore: null, alpha: 255, hIcon: 0, hIconSmall: 0, ownDc: 0,
    };
    this.wins.set(w.hwnd, w);
    this.nextHwnd = 0x10020;
    return w;
  }

  // ---------------------------------------------------------------------------------------------
  // classes
  // ---------------------------------------------------------------------------------------------
  makeClass(d: Partial<WndClass> & { name: string }): WndClass {
    const c: WndClass = {
      atom: this.nextAtom++, name: d.name, key: d.name.toLowerCase(), style: d.style ?? 0, proc: d.proc ?? 0,
      clsExtra: d.clsExtra ?? 0, wndExtra: d.wndExtra ?? 0, hInstance: d.hInstance ?? 0, hIcon: d.hIcon ?? 0, hCursor: d.hCursor ?? 0,
      hbrBackground: d.hbrBackground ?? 0, menuName: d.menuName ?? 0, hIconSm: d.hIconSm ?? 0, unicode: d.unicode ?? true,
      extra: new Uint8Array(Math.max(d.clsExtra ?? 0, 0)), system: d.system ?? false,
    };
    this.classes.set(c.key, c);
    this.atoms.set(c.atom, c);
    return c;
  }
  findClass(name: string | number): WndClass | undefined {
    if (typeof name === "number") return this.atoms.get(name);
    return this.classes.get(name.toLowerCase());
  }

  // ---------------------------------------------------------------------------------------------
  // metrics
  // ---------------------------------------------------------------------------------------------
  get sw(): number { return this.host.screenWidth; }
  get sh(): number { return this.host.screenHeight; }

  metric(i: number): number {
    const W = this.sw, H = this.sh;
    switch (i) {
      case 0: return W; case 1: return H; case 2: return 17; case 3: return 17; case 4: return 23; case 5: return 1; case 6: return 1;
      case 7: return 3; case 8: return 3; case 9: return 17; case 10: return 17; case 11: return 32; case 12: return 32; case 13: return 32;
      case 14: return 32; case 15: return 20; case 16: return W; case 17: return H - 40; case 19: return 1; case 20: return 17; case 21: return 17;
      case 28: return 136; case 29: return 39; case 30: return 36; case 31: return 22; case 32: return 4; case 33: return 4; case 34: return 136;
      case 35: return 39; case 36: return 4; case 37: return 4; case 38: return 75; case 39: return 75; case 43: return 5; case 45: return 2;
      case 46: return 2; case 47: return 160; case 48: return 24; case 49: return 16; case 50: return 16; case 51: return 20; case 55: return 8;
      case 56: return 160; case 57: return 28; case 58: return W + 16; case 59: return H + 16; case 60: return W + 16; case 61: return H + 16;
      case 62: return 3; case 68: return 4; case 69: return 4; case 71: return 15; case 72: return 15; case 75: return 1; case 76: return 0;
      case 77: return 0; case 78: return W; case 79: return H; case 80: return 1; case 81: return 1; case 82: return 1; case 83: return 1;
      case 84: return 1; case 92: return 4; case 0x2000: return 0; case 0x1000: return 0;
      default: return 0;
    }
  }

  /** non-client insets for a style (frame + caption + menu) */
  ncInsets(style: number, exStyle: number, hasMenu: boolean): Rect {
    let frame = 0;
    if (style & WS.CHILD) frame = style & WS.BORDER ? 1 : 0;
    else if (style & WS.THICKFRAME) frame = 8;
    else if ((style & WS.DLGFRAME) || (exStyle & WS_EX.DLGMODALFRAME)) frame = 3;
    else if (style & WS.BORDER) frame = 1;
    if ((style & WS.CAPTION) === WS.CAPTION && !(style & WS.THICKFRAME) && !(style & WS.CHILD)) frame = Math.max(frame, 1);
    if (exStyle & WS_EX.CLIENTEDGE) frame += 2;
    const cap = (style & WS.CAPTION) === WS.CAPTION ? 23 : 0;
    const menu = hasMenu && !(style & WS.CHILD) ? 20 : 0;
    return { l: frame, t: frame + cap + menu, r: frame, b: frame };
  }
  adjustRect(r: Rect, style: number, exStyle: number, hasMenu: boolean): Rect {
    const i = this.ncInsets(style, exStyle, hasMenu);
    return { l: r.l - i.l, t: r.t - i.t, r: r.r + i.r, b: r.b + i.b };
  }
  insets(w: Win): Rect { return this.ncInsets(w.style, w.exStyle, w.menu !== 0); }
  clientOrigin(w: Win): { x: number; y: number } {
    if (w === this.desktop) return { x: 0, y: 0 };
    const i = this.insets(w);
    return { x: w.x + i.l, y: w.y + i.t };
  }
  clientSize(w: Win): { w: number; h: number } {
    if (w === this.desktop) return { w: w.w, h: w.h };
    const i = this.insets(w);
    return { w: Math.max(0, w.w - i.l - i.r), h: Math.max(0, w.h - i.t - i.b) };
  }

  // ---------------------------------------------------------------------------------------------
  // window lookup
  // ---------------------------------------------------------------------------------------------
  win(h: number): Win | undefined {
    const w = this.wins.get(h >>> 0);
    return w && !w.destroyed ? w : undefined;
  }
  isTopLevel(w: Win): boolean { return w.parent === this.desktop.hwnd || w.parent === 0; }
  rootOf(w: Win): Win {
    while (w.parent && w.parent !== this.desktop.hwnd) { const pw = this.wins.get(w.parent); if (!pw) break; w = pw; }
    return w;
  }
  isAncestor(anc: number, w: Win): boolean {
    let cur: Win | undefined = w;
    while (cur) { if (cur.parent === anc) return true; cur = this.wins.get(cur.parent); }
    return false;
  }
  isVisible(w: Win): boolean {
    let cur: Win | undefined = w;
    while (cur && cur !== this.desktop) {
      if (!(cur.style & WS.VISIBLE)) return false;
      cur = this.wins.get(cur.parent);
    }
    return true;
  }
  queue(tid: number): ThreadQueue {
    let q = this.queues.get(tid);
    if (!q) this.queues.set(tid, (q = { tid, posted: [], quit: null, cur: null, inSend: 0 }));
    return q;
  }
  get curTid(): number { return this.p.curThread.id; }

  // ---------------------------------------------------------------------------------------------
  // calling window procedures
  // ---------------------------------------------------------------------------------------------
  callProc(proc: number, hwnd: number, msg: number, wp: bigint, lp: bigint): bigint {
    return this.p.callGuest(proc, [hwnd, msg, wp, lp]);
  }
  send(hwnd: number, msg: number, wp: bigint | number = 0n, lp: bigint | number = 0n): bigint {
    const w = this.win(hwnd);
    if (!w) return 0n;
    return this.callProc(w.proc, w.hwnd, msg, BigInt(wp), BigInt(lp));
  }
  post(hwnd: number, msg: number, wp: bigint | number = 0n, lp: bigint | number = 0n, extra?: Partial<Msg>) {
    const w = hwnd ? this.win(hwnd) : undefined;
    const tid = w ? w.tid : this.curTid;
    this.queue(tid).posted.push({ hwnd: hwnd >>> 0, msg, wp: BigInt(wp), lp: BigInt(lp), time: this.tick(), x: this.cursorX, y: this.cursorY, ...extra });
  }

  // ---------------------------------------------------------------------------------------------
  // window creation / destruction
  // ---------------------------------------------------------------------------------------------
  createWindow(a: {
    exStyle: number; cls: WndClass; name: string; style: number; x: number; y: number; w: number; h: number; parent: number; menu: number;
    hInstance: number; param: number; unicode: boolean;
  }): number {
    const p = this.p, mem = p.mem;
    const cls = a.cls;
    let style = a.style >>> 0;
    const exStyle = a.exStyle >>> 0;
    let parentWin = a.parent ? this.win(a.parent) : undefined;
    const isChild = (style & WS.CHILD) !== 0;
    if (isChild && !parentWin) { this.lastError(1400); return 0; }
    if (!isChild && !parentWin) parentWin = undefined;
    const top = !isChild;
    // default geometry
    let x = a.x | 0, y = a.y | 0, w = a.w | 0, h = a.h | 0;
    const useX = (a.x >>> 0) === CW_USEDEFAULT, useW = (a.w >>> 0) === CW_USEDEFAULT;
    const hasMenu = a.menu !== 0 && !isChild;
    if (useX) { const n = this.zorder.length; x = 100 + 20 * (n % 8); y = 80 + 20 * (n % 8); if (!useW) { /* keep */ } }
    if ((a.y >>> 0) === CW_USEDEFAULT && !useX) y = 80;
    if (useW) { w = Math.min(Math.round(this.sw * 0.7), this.sw - x); h = Math.min(Math.round(this.sh * 0.7), this.sh - y); }
    if ((a.h >>> 0) === CW_USEDEFAULT) h = Math.min(Math.round(this.sh * 0.7), this.sh - y);
    // child coordinates are relative to the parent's client area: convert to screen
    if (isChild && parentWin) { const o = this.clientOrigin(parentWin); x += o.x; y += o.y; }
    const hwnd = this.nextHwnd; this.nextHwnd += 2;
    const win: Win = {
      hwnd, cls, parent: parentWin ? parentWin.hwnd : isChild ? 0 : this.desktop.hwnd, owner: !isChild && parentWin ? parentWin.hwnd : 0, children: [],
      style, exStyle, x, y, w, h, text: a.name, proc: cls.proc, unicode: cls.unicode, extra: new Uint8Array(Math.max(cls.wndExtra, 0)),
      userData: 0n, id: isChild ? a.menu : 0, tid: p.curThread.id, props: new Map(), invalid: null, erase: false, menu: hasMenu ? a.menu : 0,
      destroyed: false, surface: null, gpuOwned: false, hInstance: a.hInstance, minimized: false, maximized: false, restore: null, alpha: 255,
      hIcon: 0, hIconSmall: 0, ownDc: 0,
    };
    if (style & WS.MINIMIZE) win.minimized = true;
    if (style & WS.MAXIMIZE) win.maximized = true;
    // the WS_VISIBLE style is applied after creation via ShowWindow
    const wantVisible = (style & WS.VISIBLE) !== 0;
    win.style &= ~WS.VISIBLE;
    if (!isChild) {
      win.w = w; win.h = h;
      // x,y,w,h supplied by the caller describe the whole window rectangle
    }
    this.wins.set(hwnd, win);
    if (win.parent && this.wins.has(win.parent)) this.wins.get(win.parent)!.children.unshift(hwnd);
    if (top) this.zorder.unshift(hwnd);
    this.queue(win.tid);
    // CREATESTRUCT
    const cs = p.vm.alloc(0x1000, { commit: true, tag: "createstruct" });
    const nameBuf = p.vm.alloc(0x1000 + a.name.length * 2, { commit: true, tag: "wndname" });
    const clsBuf = p.vm.alloc(0x1000 + cls.name.length * 2, { commit: true, tag: "wndcls" });
    if (win.unicode) { mem.wwstr(nameBuf, a.name); mem.wwstr(clsBuf, cls.name); } else { mem.wcstr(nameBuf, a.name); mem.wcstr(clsBuf, cls.name); }
    mem.wptr(cs, a.param); mem.wptr(cs + 8, a.hInstance); mem.wptr(cs + 16, a.menu); mem.wptr(cs + 24, a.parent);
    mem.w32(cs + 32, h); mem.w32(cs + 36, w); mem.w32(cs + 40, isChild && parentWin ? y - this.clientOrigin(parentWin).y : y);
    mem.w32(cs + 44, isChild && parentWin ? x - this.clientOrigin(parentWin).x : x); mem.w32(cs + 48, style); mem.wptr(cs + 56, nameBuf);
    mem.wptr(cs + 64, clsBuf); mem.w32(cs + 72, exStyle);
    let ok = true;
    const cleanup = () => { p.vm.release(cs); p.vm.release(nameBuf); p.vm.release(clsBuf); };
    try {
      if (top) {
        // WM_GETMINMAXINFO
        const mm = p.vm.alloc(0x1000, { commit: true, tag: "minmax" });
        mem.w32(mm + 8, this.sw + 16); mem.w32(mm + 12, this.sh + 16); mem.w32(mm + 16, 0); mem.w32(mm + 20, 0);
        mem.w32(mm + 24, 136); mem.w32(mm + 28, 39); mem.w32(mm + 32, this.sw + 16); mem.w32(mm + 36, this.sh + 16);
        this.send(hwnd, WM.GETMINMAXINFO, 0, mm);
        p.vm.release(mm);
      }
      const r1 = this.send(hwnd, WM.NCCREATE, 0, cs);
      if (!r1) ok = false;
      if (ok) {
        const rc = p.vm.alloc(0x1000, { commit: true, tag: "nccalc" });
        mem.w32(rc, win.x); mem.w32(rc + 4, win.y); mem.w32(rc + 8, win.x + win.w); mem.w32(rc + 12, win.y + win.h);
        this.send(hwnd, WM.NCCALCSIZE, 0, rc);
        p.vm.release(rc);
        const r2 = this.send(hwnd, WM.CREATE, 0, cs);
        if ((Number(r2 & 0xffffffffn) | 0) === -1) ok = false;
      }
    } finally {
      cleanup();
    }
    if (!ok) {
      if (this.win(hwnd)) this.destroyWindowInternal(win, false);
      return 0;
    }
    if (!this.win(hwnd)) return 0;
    this.sendSizeMove(win);
    this.notifyHost(win, true);
    if (wantVisible) this.showWindow(win, win.maximized ? SW.SHOWMAXIMIZED : win.minimized ? SW.SHOWMINIMIZED : SW.SHOWNORMAL);
    return hwnd;
  }

  sendSizeMove(w: Win) {
    const cs = this.clientSize(w);
    const o = this.clientOrigin(w);
    const state = w.minimized ? 1 : w.maximized ? 2 : 0;
    const rel = this.relClient(w, o);
    this.send(w.hwnd, WM.MOVE, 0, BigInt((rel.y & 0xffff) << 16 | (rel.x & 0xffff)) & 0xffffffffn);
    this.send(w.hwnd, WM.SIZE, state, BigInt((cs.h & 0xffff) << 16 | (cs.w & 0xffff)) & 0xffffffffn);
  }
  private relClient(w: Win, o: { x: number; y: number }) {
    if (w.parent && w.parent !== this.desktop.hwnd) {
      const pw = this.wins.get(w.parent);
      if (pw) { const po = this.clientOrigin(pw); return { x: o.x - po.x, y: o.y - po.y }; }
    }
    return o;
  }

  info(w: Win): WindowInfo {
    const cs = this.clientSize(w);
    return {
      hwnd: w.hwnd, title: w.text, x: w.x, y: w.y, w: w.w, h: w.h, cw: cs.w, ch: cs.h, visible: this.isVisible(w), style: w.style, exStyle: w.exStyle,
      topLevel: this.isTopLevel(w), parent: w.parent,
    };
  }
  notifyHost(w: Win, create = false) {
    if (!this.isTopLevel(w)) return;
    if (create) this.host.createWindow?.(this.info(w)); else this.host.updateWindow?.(this.info(w));
  }

  destroyWindow(w: Win): boolean {
    if (w === this.desktop) return false;
    if (w.tid !== this.curTid && false) return false;
    this.destroyWindowInternal(w, true);
    return true;
  }
  private destroyWindowInternal(w: Win, notify: boolean) {
    if (w.destroyed) return;
    // children first
    for (const c of [...w.children]) { const cw = this.wins.get(c); if (cw) this.destroyWindowInternal(cw, notify); }
    if (notify) {
      if (this.isVisible(w) && !(w.style & WS.CHILD)) this.hideForDestroy(w);
      this.send(w.hwnd, WM.DESTROY, 0, 0);
      if (this.focus === w.hwnd) { this.focus = 0; }
      this.send(w.hwnd, WM.NCDESTROY, 0, 0);
    }
    w.destroyed = true;
    if (this.capture === w.hwnd) this.capture = 0;
    if (this.active === w.hwnd) this.active = 0;
    if (this.foreground === w.hwnd) this.foreground = 0;
    if (this.focus === w.hwnd) this.focus = 0;
    this.wins.delete(w.hwnd);
    this.zorder = this.zorder.filter((h) => h !== w.hwnd);
    const pw = this.wins.get(w.parent);
    if (pw) pw.children = pw.children.filter((h) => h !== w.hwnd);
    this.timers = this.timers.filter((t) => t.hwnd !== w.hwnd);
    const q = this.queues.get(w.tid);
    if (q) q.posted = q.posted.filter((m) => m.hwnd !== w.hwnd);
    for (const [h, m] of this.rawQueue) if (m.hwnd === w.hwnd) this.rawQueue.delete(h);
    if (this.isTopLevel(w)) this.host.destroyWindow?.(w.hwnd);
    // activate the next top-level window
    if (this.foreground === 0 && this.appActive) {
      const next = this.zorder.map((h) => this.win(h)).find((x) => x && this.isVisible(x) && !(x.exStyle & WS_EX.NOACTIVATE));
      if (next) this.activate(next);
    }
  }
  private hideForDestroy(w: Win) {
    w.style &= ~WS.VISIBLE;
    this.send(w.hwnd, WM.SHOWWINDOW, 0, 0);
    if (this.active === w.hwnd) {
      this.send(w.hwnd, WM.NCACTIVATE, 0, 0);
      this.send(w.hwnd, WM.ACTIVATE, 0, 0);
      this.active = 0;
      this.focus = 0;
      this.send(w.hwnd, WM.KILLFOCUS, 0, 0);
    }
    this.notifyHost(w);
  }

  // ---------------------------------------------------------------------------------------------
  // show / move / size / z-order
  // ---------------------------------------------------------------------------------------------
  showWindow(w: Win, cmd: number): boolean {
    const was = (w.style & WS.VISIBLE) !== 0;
    let show = true, activate = true;
    switch (cmd) {
      case SW.HIDE: show = false; break;
      case SW.SHOWNOACTIVATE: case SW.SHOWNA: case SW.SHOWMINNOACTIVE: activate = false; break;
      case SW.MINIMIZE: case SW.SHOWMINIMIZED: w.minimized = true; w.maximized = false; break;
      case SW.SHOWMAXIMIZED: w.maximized = true; w.minimized = false; break;
      case SW.RESTORE: case SW.SHOWNORMAL: case SW.SHOWDEFAULT: w.minimized = false; w.maximized = false; break;
      default: break;
    }
    if (!show) {
      if (!was) return false;
      w.style &= ~WS.VISIBLE;
      this.send(w.hwnd, WM.SHOWWINDOW, 0, 0);
      if (this.active === w.hwnd) this.deactivate(w);
      this.notifyHost(w);
      return true;
    }
    if (cmd === SW.SHOWMAXIMIZED && !w.restore) w.restore = { l: w.x, t: w.y, r: w.x + w.w, b: w.y + w.h };
    if (cmd === SW.SHOWMAXIMIZED && this.isTopLevel(w)) {
      // maximize to the work area
      w.restore = { l: w.x, t: w.y, r: w.x + w.w, b: w.y + w.h };
      w.x = -8; w.y = -8; w.w = this.sw + 16; w.h = this.sh - 40 + 16;
    }
    if (cmd === SW.RESTORE && w.restore) { const r = w.restore; w.x = r.l; w.y = r.t; w.w = r.r - r.l; w.h = r.b - r.t; w.restore = null; }
    w.style |= WS.VISIBLE;
    if (!was) {
      this.send(w.hwnd, WM.SHOWWINDOW, 1, 0);
      this.invalidateAll(w);
    }
    this.notifyHost(w);
    if (this.isTopLevel(w)) {
      if (!was || cmd === SW.RESTORE || cmd === SW.SHOWMAXIMIZED) {
        this.sendWindowPosChanged(w);
        if (cmd === SW.SHOWMAXIMIZED || cmd === SW.RESTORE) this.sendSizeMove(w);
      }
      if (activate && !(w.exStyle & WS_EX.NOACTIVATE) && !(w.style & WS.DISABLED)) this.activate(w);
    }
    return was;
  }
  sendWindowPosChanged(w: Win, flags = 0) {
    const p = this.p, mem = p.mem;
    const wp = p.vm.alloc(0x1000, { commit: true, tag: "windowpos" });
    mem.wptr(wp, w.hwnd); mem.wptr(wp + 8, 0); mem.w32(wp + 16, w.x); mem.w32(wp + 20, w.y); mem.w32(wp + 24, w.w); mem.w32(wp + 28, w.h); mem.w32(wp + 32, flags);
    this.send(w.hwnd, WM.WINDOWPOSCHANGED, 0, wp);
    p.vm.release(wp);
  }

  setWindowPos(w: Win, after: number, x: number, y: number, cx: number, cy: number, flags: number): boolean {
    const p = this.p, mem = p.mem;
    const isTop = this.isTopLevel(w);
    let nx = w.x, ny = w.y, nw = w.w, nh = w.h;
    const par = !isTop ? this.wins.get(w.parent) : undefined;
    const po = par ? this.clientOrigin(par) : { x: 0, y: 0 };
    if (!(flags & SWP.NOMOVE)) { nx = x + po.x; ny = y + po.y; }
    if (!(flags & SWP.NOSIZE)) { nw = Math.max(0, cx); nh = Math.max(0, cy); }
    if (!(flags & SWP.NOSENDCHANGING)) {
      const wp = p.vm.alloc(0x1000, { commit: true, tag: "windowpos" });
      mem.wptr(wp, w.hwnd); mem.wptr(wp + 8, after); mem.w32(wp + 16, nx - po.x); mem.w32(wp + 20, ny - po.y); mem.w32(wp + 24, nw); mem.w32(wp + 28, nh); mem.w32(wp + 32, flags);
      this.send(w.hwnd, WM.WINDOWPOSCHANGING, 0, wp);
      // the handler may have adjusted the proposal
      if (!(flags & SWP.NOMOVE)) { nx = mem.ri32(wp + 16) + po.x; ny = mem.ri32(wp + 20) + po.y; }
      if (!(flags & SWP.NOSIZE)) { nw = mem.ri32(wp + 24); nh = mem.ri32(wp + 28); }
      p.vm.release(wp);
    }
    const moved = nx !== w.x || ny !== w.y, sized = nw !== w.w || nh !== w.h;
    const dx = nx - w.x, dy = ny - w.y;
    w.x = nx; w.y = ny; w.w = nw; w.h = nh;
    if (moved && dx | dy) this.shiftChildren(w, dx, dy);
    if (sized) { w.surface = null; this.invalidateAll(w); }
    if (!(flags & SWP.NOZORDER) && isTop) {
      const i = this.zorder.indexOf(w.hwnd);
      if (i >= 0) this.zorder.splice(i, 1);
      if (after === 0 || after === 1) { if (after === 0) this.zorder.unshift(w.hwnd); else this.zorder.push(w.hwnd); } // HWND_TOP / HWND_BOTTOM
      else if (after === 0xffffffff || after === 0xfffffffe) this.zorder.unshift(w.hwnd); // TOPMOST / NOTOPMOST (-1,-2 as 32-bit)
      else { const j = this.zorder.indexOf(after); if (j >= 0) this.zorder.splice(j + 1, 0, w.hwnd); else this.zorder.unshift(w.hwnd); }
    }
    if (after === 0xffffffff && !(flags & SWP.NOZORDER)) w.exStyle |= WS_EX.TOPMOST;
    if (after === 0xfffffffe && !(flags & SWP.NOZORDER)) w.exStyle &= ~WS_EX.TOPMOST;
    if (flags & SWP.SHOWWINDOW) {
      if (!(w.style & WS.VISIBLE)) {
        w.style |= WS.VISIBLE;
        this.send(w.hwnd, WM.SHOWWINDOW, 1, 0);
        this.invalidateAll(w);
        if (isTop && !(flags & SWP.NOACTIVATE) && !(w.exStyle & WS_EX.NOACTIVATE)) this.activate(w);
      }
    }
    if (flags & SWP.HIDEWINDOW) {
      if (w.style & WS.VISIBLE) { w.style &= ~WS.VISIBLE; this.send(w.hwnd, WM.SHOWWINDOW, 0, 0); if (this.active === w.hwnd) this.deactivate(w); }
    }
    this.notifyHost(w);
    this.sendWindowPosChanged(w, flags);
    if (moved || sized || (flags & SWP.FRAMECHANGED)) {
      if (sized || (flags & SWP.FRAMECHANGED)) {
        const rc = p.vm.alloc(0x1000, { commit: true, tag: "nccalc" });
        mem.w32(rc, w.x); mem.w32(rc + 4, w.y); mem.w32(rc + 8, w.x + w.w); mem.w32(rc + 12, w.y + w.h);
        this.send(w.hwnd, WM.NCCALCSIZE, 0, rc);
        p.vm.release(rc);
      }
      const cs = this.clientSize(w);
      const o = this.relClient(w, this.clientOrigin(w));
      if (moved) this.send(w.hwnd, WM.MOVE, 0, BigInt(((o.y & 0xffff) << 16) | (o.x & 0xffff)) & 0xffffffffn);
      if (sized) this.send(w.hwnd, WM.SIZE, w.minimized ? 1 : w.maximized ? 2 : 0, BigInt(((cs.h & 0xffff) << 16) | (cs.w & 0xffff)) & 0xffffffffn);
    }
    return true;
  }
  private shiftChildren(w: Win, dx: number, dy: number) {
    for (const c of w.children) { const cw = this.wins.get(c); if (cw) { cw.x += dx; cw.y += dy; this.shiftChildren(cw, dx, dy); } }
  }

  setParent(w: Win, newParent: number): number {
    const old = w.parent;
    const o = this.wins.get(old);
    if (o) o.children = o.children.filter((h) => h !== w.hwnd);
    this.zorder = this.zorder.filter((h) => h !== w.hwnd);
    const np = newParent ? this.wins.get(newParent) : undefined;
    w.parent = np ? np.hwnd : this.desktop.hwnd;
    if (np && np !== this.desktop) np.children.unshift(w.hwnd);
    else this.zorder.unshift(w.hwnd);
    return old;
  }

  // ---------------------------------------------------------------------------------------------
  // activation / focus
  // ---------------------------------------------------------------------------------------------
  activate(w: Win): boolean {
    if (!w || w.destroyed) return false;
    const root = this.rootOf(w);
    if (this.active === root.hwnd) { if (!this.focus) this.setFocus(root); return true; }
    const oldActive = this.win(this.active);
    const wasAppActive = this.appActive;
    if (oldActive) {
      this.send(oldActive.hwnd, WM.NCACTIVATE, 0, 0);
      this.send(oldActive.hwnd, WM.ACTIVATE, 0, root.hwnd);
    }
    this.active = root.hwnd;
    this.foreground = root.hwnd;
    // raise
    const i = this.zorder.indexOf(root.hwnd);
    if (i > 0) { this.zorder.splice(i, 1); this.zorder.unshift(root.hwnd); }
    if (!wasAppActive) {
      this.appActive = true;
      for (const h of [...this.zorder]) { const t = this.win(h); if (t && t.tid === root.tid) this.send(h, WM.ACTIVATEAPP, 1, root.tid); }
    }
    this.send(root.hwnd, WM.NCACTIVATE, 1, 0);
    this.send(root.hwnd, WM.ACTIVATE, (root.minimized ? 0x10000 : 0) | 1, 0);
    if (this.active === root.hwnd && !this.focus) this.setFocus(root);
    return true;
  }
  deactivate(w: Win) {
    if (this.active !== w.hwnd) return;
    this.send(w.hwnd, WM.NCACTIVATE, 0, 0);
    this.send(w.hwnd, WM.ACTIVATE, 0, 0);
    this.active = 0;
    if (this.focus) { const f = this.focus; this.focus = 0; this.send(f, WM.KILLFOCUS, 0, 0); }
    const next = this.zorder.map((h) => this.win(h)).find((x) => x && x !== w && this.isVisible(x) && !(x.exStyle & WS_EX.NOACTIVATE));
    if (next) this.activate(next);
  }
  setFocus(w: Win | undefined): number {
    const old = this.focus;
    if (w && w.hwnd === old) return old;
    if (old) this.send(old, WM.KILLFOCUS, 0, w ? w.hwnd : 0);
    this.focus = w ? w.hwnd : 0;
    if (w) this.send(w.hwnd, WM.SETFOCUS, 0, old);
    return old;
  }
  /** application-level activation change from the host (browser tab focus) */
  hostFocus(on: boolean) {
    if (on === this.appActive) return;
    if (!on) {
      this.keyState.fill(0);
      const a = this.win(this.active);
      if (a) {
        this.send(a.hwnd, WM.NCACTIVATE, 0, 0);
        this.send(a.hwnd, WM.ACTIVATE, 0, 0);
        this.appActive = false;
        for (const h of [...this.zorder]) { const t = this.win(h); if (t) this.send(h, WM.ACTIVATEAPP, 0, 0); }
        if (this.focus) this.send(this.focus, WM.KILLFOCUS, 0, 0);
        this.foreground = 0;
      } else this.appActive = false;
    } else {
      const a = this.win(this.active) ?? this.zorder.map((h) => this.win(h)).find((x) => x && this.isVisible(x));
      if (a) {
        this.appActive = true;
        this.active = a.hwnd;
        this.foreground = a.hwnd;
        for (const h of [...this.zorder]) { const t = this.win(h); if (t) this.send(h, WM.ACTIVATEAPP, 1, a.tid); }
        this.send(a.hwnd, WM.NCACTIVATE, 1, 0);
        this.send(a.hwnd, WM.ACTIVATE, 1, 0);
        if (this.focus) this.send(this.focus, WM.SETFOCUS, 0, 0);
        else this.setFocus(a);
      } else this.appActive = true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // invalidation / painting
  // ---------------------------------------------------------------------------------------------
  invalidateAll(w: Win) {
    const cs = this.clientSize(w);
    w.invalid = { l: 0, t: 0, r: cs.w, b: cs.h };
    w.erase = true;
  }
  invalidate(w: Win, r: Rect | null, erase: boolean) {
    const cs = this.clientSize(w);
    const n = r ? { l: Math.max(0, r.l), t: Math.max(0, r.t), r: Math.min(cs.w, r.r), b: Math.min(cs.h, r.b) } : { l: 0, t: 0, r: cs.w, b: cs.h };
    if (n.r <= n.l || n.b <= n.t) return;
    if (w.invalid) w.invalid = { l: Math.min(w.invalid.l, n.l), t: Math.min(w.invalid.t, n.t), r: Math.max(w.invalid.r, n.r), b: Math.max(w.invalid.b, n.b) };
    else w.invalid = n;
    if (erase) w.erase = true;
  }
  validate(w: Win, r: Rect | null) {
    if (!w.invalid) return;
    if (!r) { w.invalid = null; w.erase = false; return; }
    const i = w.invalid;
    if (r.l <= i.l && r.t <= i.t && r.r >= i.r && r.b >= i.b) { w.invalid = null; w.erase = false; }
  }

  // ---------------------------------------------------------------------------------------------
  // message retrieval
  // ---------------------------------------------------------------------------------------------
  matchesFilter(m: Msg, hwnd: number, min: number, max: number): boolean {
    if (min || max) { if (m.msg < min || (max && m.msg > max)) return false; }
    if (hwnd === 0) return true;
    if (hwnd === 1) return m.hwnd === 0; // HWND_MESSAGE-ish / thread messages
    if (m.hwnd === hwnd) return true;
    const w = this.win(m.hwnd);
    return !!w && this.isAncestor(hwnd, w);
  }
  /** Find the next message for the current thread. When `remove` is false the message stays queued. */
  nextMessage(hwnd: number, min: number, max: number, remove: boolean, filterPaint = true): Msg | null {
    this.pump();
    const tid = this.curTid;
    const q = this.queue(tid);
    // posted + input
    for (let i = 0; i < q.posted.length; i++) {
      const m = q.posted[i];
      if (m.hwnd && !this.win(m.hwnd)) { q.posted.splice(i--, 1); continue; }
      if (this.matchesFilter(m, hwnd, min, max)) {
        if (remove) q.posted.splice(i, 1);
        return m;
      }
    }
    if (q.quit && (!(min || max) || (WM.QUIT >= min && (!max || WM.QUIT <= max)))) {
      const m: Msg = { hwnd: 0, msg: WM.QUIT, wp: BigInt(q.quit.code), lp: 0n, time: this.tick(), x: this.cursorX, y: this.cursorY };
      if (remove) q.quit = null;
      return m;
    }
    // paint
    if (filterPaint && (!(min || max) || (WM.PAINT >= min && (!max || WM.PAINT <= max)))) {
      for (const [, w] of this.wins) {
        if (w.tid !== tid || !w.invalid || !this.isVisible(w) || w.minimized || w.gpuOwned) continue;
        const m: Msg = { hwnd: w.hwnd, msg: WM.PAINT, wp: 0n, lp: 0n, time: this.tick(), x: this.cursorX, y: this.cursorY };
        if (this.matchesFilter(m, hwnd, min, max)) return m;
      }
    }
    // timers
    if (!(min || max) || (WM.TIMER >= min && (!max || WM.TIMER <= max))) {
      const now = performance.now();
      for (const t of this.timers) {
        if (t.tid !== tid || now < t.next) continue;
        const m: Msg = { hwnd: t.hwnd, msg: WM.TIMER, wp: BigInt(t.id), lp: BigInt(t.proc), time: this.tick(), x: this.cursorX, y: this.cursorY };
        if (!this.matchesFilter(m, hwnd, min, max)) continue;
        if (remove) { t.next = Math.max(t.next + t.interval, now - 0); if (t.next <= now) t.next = now + t.interval; }
        return m;
      }
    }
    return null;
  }
  /** earliest pending timer time (ms, performance.now base) or Infinity */
  nextTimerTime(tid: number): number {
    let d = Infinity;
    for (const t of this.timers) if (t.tid === tid && t.next < d) d = t.next;
    return d;
  }

  dispatch(m: Msg): bigint {
    if (m.msg === WM.TIMER && m.lp) {
      // TIMERPROC callback
      return this.p.callGuest(Number(m.lp), [m.hwnd, WM.TIMER, m.wp, this.tick()]) & 0n;
    }
    if (!m.hwnd) return 0n;
    const w = this.win(m.hwnd);
    if (!w) return 0n;
    if (m.msg === WM.PAINT) {
      return this.callProc(w.proc, w.hwnd, m.msg, m.wp, m.lp);
    }
    return this.callProc(w.proc, w.hwnd, m.msg, m.wp, m.lp);
  }

  translate(m: Msg): boolean {
    if (m.msg !== WM.KEYDOWN && m.msg !== WM.SYSKEYDOWN) return false;
    const vk = Number(m.wp & 0xffn);
    let ch: number | null = null;
    if (m.text && m.text.length) ch = m.text.codePointAt(0)!;
    else ch = this.vkToChar(vk);
    if (ch === null) return false;
    const w = this.win(m.hwnd);
    const sys = m.msg === WM.SYSKEYDOWN;
    let wp = BigInt(ch);
    if (w && !w.unicode && ch > 0x7f) wp = BigInt(ch & 0xff);
    this.post(m.hwnd, sys ? WM.SYSCHAR : WM.CHAR, wp, m.lp, { x: m.x, y: m.y });
    return true;
  }
  /** control characters generated by TranslateMessage without host text */
  vkToChar(vk: number): number | null {
    const ctrl = (this.keyState[VK.CONTROL] & 0x80) !== 0;
    if (vk === VK.BACK) return 8;
    if (vk === VK.TAB) return 9;
    if (vk === VK.RETURN) return 13;
    if (vk === VK.ESCAPE) return 27;
    if (vk === VK.SPACE) return 32;
    if (ctrl && vk >= 0x41 && vk <= 0x5a) return vk - 0x40;
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // timers
  // ---------------------------------------------------------------------------------------------
  setTimer(hwnd: number, id: number, ms: number, proc: number): number {
    ms = Math.max(ms, 10);
    if (hwnd) {
      const t = this.timers.find((x) => x.hwnd === hwnd && x.id === id);
      if (t) { t.interval = ms; t.next = performance.now() + ms; t.proc = proc; return id; }
    } else {
      id = this.nextTimerId++;
    }
    this.timers.push({ hwnd, id, interval: ms, next: performance.now() + ms, proc, tid: this.curTid, sys: false });
    return id;
  }
  killTimer(hwnd: number, id: number): boolean {
    const n = this.timers.length;
    this.timers = this.timers.filter((t) => !(t.hwnd === hwnd && t.id === id));
    return this.timers.length !== n;
  }

  // ---------------------------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------------------------
  keyMods(): number {
    let f = 0;
    if (this.mouseButtons & 1) f |= MK.LBUTTON;
    if (this.mouseButtons & 2) f |= MK.RBUTTON;
    if (this.mouseButtons & 4) f |= MK.MBUTTON;
    if (this.mouseButtons & 8) f |= MK.XBUTTON1;
    if (this.mouseButtons & 16) f |= MK.XBUTTON2;
    if (this.keyState[VK.SHIFT] & 0x80) f |= MK.SHIFT;
    if (this.keyState[VK.CONTROL] & 0x80) f |= MK.CONTROL;
    return f;
  }
  /** window receiving mouse input at the current virtual cursor position (or the captor) */
  mouseTarget(evHwnd?: number): Win | undefined {
    if (this.capture) { const c = this.win(this.capture); if (c) return c; }
    if (evHwnd) { const w = this.win(evHwnd); if (w) return this.childAt(w, this.cursorX, this.cursorY); }
    return this.childAt(this.win(this.active) ?? this.desktop, this.cursorX, this.cursorY);
  }
  childAt(w: Win, sx: number, sy: number): Win {
    for (const c of w.children) {
      const cw = this.win(c);
      if (!cw || !(cw.style & WS.VISIBLE)) continue;
      const o = this.clientOrigin(cw);
      void o;
      if (sx >= cw.x && sx < cw.x + cw.w && sy >= cw.y && sy < cw.y + cw.h) return this.childAt(cw, sx, sy);
    }
    return w;
  }
  toClient(w: Win, sx: number, sy: number) {
    const o = this.clientOrigin(w);
    return { x: sx - o.x, y: sy - o.y };
  }

  private applyKey(vk: number, down: boolean) {
    const set = (k: number, d: boolean) => { if (d) { this.keyState[k] |= 0x80; this.asyncKeyState[k] |= 0x81; } else { this.keyState[k] &= ~0x80; this.asyncKeyState[k] &= ~0x80; } };
    if (down && !(this.keyState[vk] & 0x80) && (vk === VK.CAPITAL || vk === 0x90 || vk === 0x91)) this.keyState[vk] ^= 1;
    set(vk, down);
    // generic modifier keys follow the sided ones
    if (vk === VK.LSHIFT || vk === VK.RSHIFT) set(VK.SHIFT, !!((this.keyState[VK.LSHIFT] | this.keyState[VK.RSHIFT]) & 0x80));
    if (vk === VK.LCONTROL || vk === VK.RCONTROL) set(VK.CONTROL, !!((this.keyState[VK.LCONTROL] | this.keyState[VK.RCONTROL]) & 0x80));
    if (vk === VK.LMENU || vk === VK.RMENU) set(VK.MENU, !!((this.keyState[VK.LMENU] | this.keyState[VK.RMENU]) & 0x80));
    if (vk === VK.SHIFT) { /* unsided shift from the host */ }
  }

  /** Translate queued host events into window messages. Called whenever the application polls for messages. */
  pump() {
    this.flushSurfaces();
    const evs = this.host.poll?.();
    if (!evs || !evs.length) return;
    for (const e of evs) this.handleHostEvent(e);
  }

  handleHostEvent(e: HostEvent) {
    this.lastInput = this.tick();
    switch (e.t) {
      case "focus": this.hostFocus(e.focused); break;
      case "close": {
        const w = (e.hwnd && this.win(e.hwnd)) || this.win(this.active) || this.win(this.zorder[0]);
        if (w) this.post(w.hwnd, WM.SYSCOMMAND, 0xf060, 0); // SC_CLOSE
        break;
      }
      case "resize": {
        const w = (e.hwnd && this.win(e.hwnd)) || this.win(this.active);
        if (!w) break;
        const i = this.insets(w);
        this.setWindowPos(w, 0, w.x, w.y, e.w + i.l + i.r, e.h + i.t + i.b, SWP.NOMOVE | SWP.NOZORDER | SWP.NOACTIVATE);
        break;
      }
      case "key": this.hostKey(e); break;
      case "text": break;
      case "mouse": this.hostMouse(e); break;
      case "button": this.hostButton(e); break;
      case "wheel": this.hostWheel(e); break;
    }
  }

  private focusTarget(): number {
    return this.focus || this.active;
  }

  private hostKey(e: Extract<HostEvent, { t: "key" }>) {
    const target = this.focusTarget();
    const w = this.win(target);
    if (!w) return;
    if (!this.appActive) this.hostFocus(true);
    let vk = e.vk & 0xff;
    // sided modifiers: browsers give location info through the scan code mapping done by the shell
    const was = (this.keyState[vk] & 0x80) !== 0;
    this.applyKey(vk, e.down);
    const alt = (this.keyState[VK.MENU] & 0x80) !== 0;
    const sys = alt || vk === VK.F10 || (vk === VK.MENU || vk === VK.LMENU || vk === VK.RMENU);
    const lp = (e.down ? (was ? 1 : 1) : 1) | ((e.scan & 0xff) << 16) | ((e.ext ? 1 : 0) << 24) | ((alt ? 1 : 0) << 29) | ((e.down ? (was ? 1 : 0) : 1) << 30) | ((e.down ? 0 : 1) << 31);
    let wpVk = vk;
    if (vk === VK.LSHIFT || vk === VK.RSHIFT) wpVk = VK.SHIFT;
    if (vk === VK.LCONTROL || vk === VK.RCONTROL) wpVk = VK.CONTROL;
    if (vk === VK.LMENU || vk === VK.RMENU) wpVk = VK.MENU;
    const msg = e.down ? (sys ? WM.SYSKEYDOWN : WM.KEYDOWN) : sys ? WM.SYSKEYUP : WM.KEYUP;
    this.post(w.hwnd, msg, wpVk, BigInt(lp >>> 0), { text: e.down ? e.text : undefined });
    // raw keyboard input
    const reg = this.rawDevices.find((d) => d.usagePage === 1 && d.usage === 6 && !(d.flags & 1));
    if (reg) {
      const tw = this.win(reg.hwnd) ?? w;
      this.queueRaw(tw, { kind: "kbd", flags: e.down ? 0 : 1, buttonFlags: 0, buttonData: 0, dx: 0, dy: 0, vk, scan: e.scan, message: msg, down: e.down });
    }
  }

  private queueRaw(w: Win, raw: NonNullable<Msg["raw"]>) {
    const h = this.nextRawHandle; this.nextRawHandle += 8; if (this.nextRawHandle > 0x7fff0000) this.nextRawHandle = 0x5000;
    const m: Msg = { hwnd: w.hwnd, msg: WM.INPUT, wp: 0n, lp: BigInt(h), time: this.tick(), x: this.cursorX, y: this.cursorY, raw };
    this.rawQueue.set(h, m);
    if (this.rawQueue.size > 4096) this.rawQueue.delete(this.rawQueue.keys().next().value!);
    this.queue(w.tid).posted.push(m);
  }

  private clampCursor() {
    const c = this.clip;
    let l = 0, t = 0, r = this.sw - 1, b = this.sh - 1;
    if (c) { l = Math.max(l, c.l); t = Math.max(t, c.t); r = Math.min(r, c.r - 1); b = Math.min(b, c.b - 1); }
    this.cursorX = Math.min(Math.max(this.cursorX, l), r);
    this.cursorY = Math.min(Math.max(this.cursorY, t), b);
  }

  private hostMouse(e: Extract<HostEvent, { t: "mouse" }>) {
    const base = (e.hwnd && this.win(e.hwnd)) || this.win(this.active) || undefined;
    if (e.locked) {
      this.cursorX += e.dx; this.cursorY += e.dy;
    } else if (base) {
      const o = this.clientOrigin(base);
      this.cursorX = o.x + e.x; this.cursorY = o.y + e.y;
    }
    this.clampCursor();
    const raw = this.rawDevices.find((d) => d.usagePage === 1 && d.usage === 2);
    if (raw && (e.dx || e.dy)) {
      const rw = this.win(raw.hwnd) ?? base;
      if (rw) this.queueRaw(rw, { kind: "mouse", flags: 0, buttonFlags: 0, buttonData: 0, dx: e.dx, dy: e.dy, vk: 0, scan: 0, message: 0, down: false });
    }
    const t = this.mouseTarget(e.hwnd);
    if (!t) return;
    const c = this.toClient(t, this.cursorX, this.cursorY);
    // coalesce consecutive mouse moves
    const q = this.queue(t.tid);
    const last = q.posted[q.posted.length - 1];
    const lp = BigInt(((c.y & 0xffff) << 16) | (c.x & 0xffff)) & 0xffffffffn;
    if (last && last.msg === WM.MOUSEMOVE && last.hwnd === t.hwnd) { last.lp = lp; last.wp = BigInt(this.keyMods()); last.x = this.cursorX; last.y = this.cursorY; }
    else this.post(t.hwnd, WM.MOUSEMOVE, this.keyMods(), lp);
  }

  private hostButton(e: Extract<HostEvent, { t: "button" }>) {
    const base = (e.hwnd && this.win(e.hwnd)) || this.win(this.active) || undefined;
    if (base && !this.pointerLocked) { const o = this.clientOrigin(base); this.cursorX = o.x + e.x; this.cursorY = o.y + e.y; this.clampCursor(); }
    const t = this.mouseTarget(e.hwnd);
    if (!t) return;
    // btn: 0 left, 1 middle, 2 right, 3 x1, 4 x2 (DOM order) -> Windows MK_/mask bits
    const winBit = [1, 4, 2, 8, 16][e.btn];
    if (e.down) this.mouseButtons |= winBit; else this.mouseButtons &= ~winBit;
    const key = [VK.LBUTTON, VK.MBUTTON, VK.RBUTTON, VK.XBUTTON1, VK.XBUTTON2][e.btn];
    if (e.down) { this.keyState[key] |= 0x80; this.asyncKeyState[key] |= 0x80; } else { this.keyState[key] &= ~0x80; this.asyncKeyState[key] &= ~0x80; }
    if (e.down && this.isTopLevel(this.rootOf(t)) ) {
      const root = this.rootOf(t);
      if (this.active !== root.hwnd && !(root.exStyle & WS_EX.NOACTIVATE)) {
        const r = this.send(t.hwnd, WM.MOUSEACTIVATE, root.hwnd, BigInt(1 | (WM.LBUTTONDOWN << 16)));
        if (Number(r) !== 3 && Number(r) !== 4) this.activate(root);
      }
    }
    const c = this.toClient(t, this.cursorX, this.cursorY);
    const lp = BigInt(((c.y & 0xffff) << 16) | (c.x & 0xffff)) & 0xffffffffn;
    const downMsgs = [WM.LBUTTONDOWN, WM.MBUTTONDOWN, WM.RBUTTONDOWN, WM.XBUTTONDOWN, WM.XBUTTONDOWN];
    const upMsgs = [WM.LBUTTONUP, WM.MBUTTONUP, WM.RBUTTONUP, WM.XBUTTONUP, WM.XBUTTONUP];
    const dblMsgs = [WM.LBUTTONDBLCLK, WM.MBUTTONDBLCLK, WM.RBUTTONDBLCLK, WM.XBUTTONDBLCLK, WM.XBUTTONDBLCLK];
    let msg: number = e.down ? downMsgs[e.btn] : upMsgs[e.btn];
    let wp = BigInt(this.keyMods());
    if (e.btn >= 3) wp |= BigInt(e.btn === 3 ? 1 : 2) << 16n;
    if (e.down && (t.cls.style & CS.DBLCLKS)) {
      const now = performance.now();
      const lc = this.lastClick;
      if (lc.btn === e.btn && now - lc.time < 500 && Math.abs(lc.x - this.cursorX) < 4 && Math.abs(lc.y - this.cursorY) < 4) {
        msg = dblMsgs[e.btn];
        this.lastClick = { time: 0, btn: -1, x: 0, y: 0 };
      } else this.lastClick = { time: now, btn: e.btn, x: this.cursorX, y: this.cursorY };
    }
    this.post(t.hwnd, msg, wp, lp);
    const raw = this.rawDevices.find((d) => d.usagePage === 1 && d.usage === 2);
    if (raw) {
      const rw = this.win(raw.hwnd) ?? t;
      const flagsDown = [1, 16, 4, 64, 256][e.btn], flagsUp = [2, 32, 8, 128, 512][e.btn];
      this.queueRaw(rw, { kind: "mouse", flags: 0, buttonFlags: e.down ? flagsDown : flagsUp, buttonData: 0, dx: 0, dy: 0, vk: 0, scan: 0, message: 0, down: e.down });
    }
  }

  private hostWheel(e: Extract<HostEvent, { t: "wheel" }>) {
    const t = this.mouseTarget(e.hwnd);
    if (!t) return;
    // wheel messages go to the focus window with screen coordinates
    const tgt = this.win(this.focus) ?? t;
    const delta = Math.max(-32768, Math.min(32767, Math.round(e.delta)));
    const wp = (BigInt(delta & 0xffff) << 16n) | BigInt(this.keyMods());
    const lp = BigInt(((this.cursorY & 0xffff) << 16) | (this.cursorX & 0xffff)) & 0xffffffffn;
    this.post(tgt.hwnd, e.horizontal ? WM.MOUSEHWHEEL : WM.MOUSEWHEEL, wp, lp);
    const raw = this.rawDevices.find((d) => d.usagePage === 1 && d.usage === 2);
    if (raw) {
      const rw = this.win(raw.hwnd) ?? tgt;
      this.queueRaw(rw, { kind: "mouse", flags: 0, buttonFlags: e.horizontal ? 0x1000 : 0x400, buttonData: delta & 0xffff, dx: 0, dy: 0, vk: 0, scan: 0, message: 0, down: false });
    }
  }

  setCursorPos(x: number, y: number) {
    this.cursorX = x; this.cursorY = y;
    this.clampCursor();
  }

  // ---------------------------------------------------------------------------------------------
  // GDI client surfaces
  // ---------------------------------------------------------------------------------------------
  surfaceOf(w: Win): NonNullable<Win["surface"]> {
    const cs = this.clientSize(w);
    if (!w.surface || w.surface.w !== cs.w || w.surface.h !== cs.h) {
      const old = w.surface;
      const s = { w: Math.max(cs.w, 1), h: Math.max(cs.h, 1), data: new Uint8Array(Math.max(cs.w, 1) * Math.max(cs.h, 1) * 4), dirty: true };
      if (old) { const n = Math.min(old.w, s.w); for (let y = 0; y < Math.min(old.h, s.h); y++) s.data.set(old.data.subarray(y * old.w * 4, y * old.w * 4 + n * 4), y * s.w * 4); }
      w.surface = s;
    }
    return w.surface;
  }
  flushSurfaces() {
    for (const w of this.wins.values()) {
      const s = w.surface;
      if (s && s.dirty && !w.gpuOwned && this.isTopLevel(w) && (w.style & WS.VISIBLE)) {
        s.dirty = false;
        for (let i = 3; i < s.data.length; i += 4) s.data[i] = 255;
        this.host.present2D?.(w.hwnd, s.w, s.h, s.data);
      } else if (s && s.dirty && !this.isTopLevel(w)) {
        // child window drawing is composited into the root surface by the application's own DC use; nothing to present
        s.dirty = false;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // window procedure defaults
  // ---------------------------------------------------------------------------------------------
  defWindowProc(hwnd: number, msg: number, wp: bigint, lp: bigint): bigint {
    const w = this.win(hwnd);
    const p = this.p, mem = p.mem;
    switch (msg) {
      case WM.NCCREATE: return 1n;
      case WM.CREATE: return 0n;
      case WM.NCCALCSIZE: return 0n;
      case WM.NCHITTEST: {
        if (!w) return 0n;
        const x = Number(BigInt.asIntN(16, lp & 0xffffn)), y = Number(BigInt.asIntN(16, (lp >> 16n) & 0xffffn));
        const o = this.clientOrigin(w), cs = this.clientSize(w);
        if (x >= o.x && x < o.x + cs.w && y >= o.y && y < o.y + cs.h) return 1n; // HTCLIENT
        if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return 2n; // HTCAPTION (approx.)
        return 0xffffffffn; // HTNOWHERE... (-1 = HTTRANSPARENT? -2); keep client semantics
      }
      case WM.SETCURSOR: return 1n;
      case WM.MOUSEACTIVATE: return 1n; // MA_ACTIVATE
      case WM.CLOSE: if (w) this.destroyWindow(w); return 0n;
      case WM.SYSCOMMAND: {
        const cmd = Number(wp & 0xfff0n);
        if (cmd === 0xf060) { this.send(hwnd, WM.CLOSE, 0, 0); return 0n; }
        if (w && cmd === 0xf020) { this.showWindow(w, SW.MINIMIZE); return 0n; }
        if (w && cmd === 0xf030) { this.showWindow(w, SW.SHOWMAXIMIZED); return 0n; }
        if (w && cmd === 0xf120) { this.showWindow(w, SW.RESTORE); return 0n; }
        return 0n;
      }
      case WM.ERASEBKGND: {
        if (!w) return 0n;
        const s = this.surfaceOf(w);
        const brush = w.cls.hbrBackground;
        const gdi = this.p.gdi;
        const color = gdi ? gdi.brushColorFor(brush) : 0;
        if (color !== null && color !== undefined) {
          const b = color & 0xff, g = (color >> 8) & 0xff, r = (color >> 16) & 0xff; // 0x00RRGGBB passed as BGR already normalised by gdi
          for (let i = 0; i < s.data.length; i += 4) { s.data[i] = b; s.data[i + 1] = g; s.data[i + 2] = r; s.data[i + 3] = 255; }
          s.dirty = true;
        }
        return 1n;
      }
      case WM.PAINT: if (w) this.validate(w, null); return 0n;
      case WM.SETTEXT: {
        if (!w) return 0n;
        w.text = w.unicode ? mem.wstr(Number(lp)) : mem.cstr(Number(lp));
        this.notifyHost(w);
        return 1n;
      }
      case WM.GETTEXT: {
        if (!w) return 0n;
        const cap = Number(wp);
        if (!cap) return 0n;
        const dst = Number(lp);
        const n = w.unicode ? mem.wwstr(dst, w.text, cap) : mem.wcstr(dst, w.text, cap);
        return BigInt(n - 1);
      }
      case WM.GETTEXTLENGTH: return BigInt(w ? w.text.length : 0);
      case WM.GETICON: return BigInt(w ? (Number(wp) === 0 ? w.hIconSmall : w.hIcon) : 0);
      case WM.SETICON: { if (!w) return 0n; const old = Number(wp) === 0 ? w.hIconSmall : w.hIcon; if (Number(wp) === 0) w.hIconSmall = Number(lp); else w.hIcon = Number(lp); return BigInt(old); }
      case WM.ACTIVATE: {
        if ((Number(wp) & 0xffff) !== 0 && w) { if (!(this.focus)) this.setFocus(w); }
        return 0n;
      }
      case WM.QUERYENDSESSION: return 1n;
      case WM.NCACTIVATE: return 1n;
      case WM.NCDESTROY: return 0n;
      case WM.WINDOWPOSCHANGED: return 0n;
      case WM.GETMINMAXINFO: return 0n;
      case WM.GETDLGCODE: return 0n;
      case WM.SHOWWINDOW: return 0n;
      case WM.SYSKEYDOWN: case WM.SYSKEYUP: case WM.SYSCHAR: return 0n;
      case WM.INPUT: return 0n;
      case WM.DPICHANGED: return 0n;
      default: return 0n;
    }
  }
}

declare module "./process.ts" {
  interface Process {
    win: WinSys;
  }
}
export type { Thread };
