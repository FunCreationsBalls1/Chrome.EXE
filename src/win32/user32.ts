// user32.dll: window manager, messages, input, system metrics, cursors/icons, menus (stubs), clipboard, misc.
import type { Process } from "./process.ts";
import type { Cpu } from "./cpu.ts";
import { WinSys, WM, WS, SW, SWP, CW_USEDEFAULT, VK } from "./winsys.ts";
import type { Msg, Rect, Win } from "./winsys.ts";
import { Gdi, Bmp, colorrefToRgb } from "./gdi.ts";
import { ERROR } from "./k32-core.ts";
import { INFINITE } from "./k32-sync.ts";
import { formatPrintf, ArrayArgs, VaList } from "./printf.ts";
import type { HostEvent } from "./host.ts";

const WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff;

export function installUser32(p: Process) {
  const u = p.hle.module("user32.dll");
  const mem = p.mem;
  const gdi = new Gdi(p);
  p.gdi = gdi;
  const ws = new WinSys(p);
  p.win = ws;
  p.ext.win = ws;
  p.ext.gdi = gdi;

  // ---- helpers ------------------------------------------------------------------------------
  /** register an A/W pair; the handler receives wide=true for the W variant */
  const wa = (name: string, f: (c: Cpu, wide: boolean) => any) => {
    u.fn(name + "A", (c) => f(c, false));
    u.fn(name + "W", (c) => f(c, true));
  };
  const str = (ptr: number, wide: boolean) => (wide ? mem.wstr(ptr) : mem.cstr(ptr));
  const putStr = (dst: number, s: string, cap: number, wide: boolean) => (wide ? mem.wwstr(dst, s, cap) : mem.wcstr(dst, s, cap));
  const rdRect = (a: number): Rect => ({ l: mem.ri32(a), t: mem.ri32(a + 4), r: mem.ri32(a + 8), b: mem.ri32(a + 12) });
  const wrRect = (a: number, r: Rect) => { mem.w32(a, r.l); mem.w32(a + 4, r.t); mem.w32(a + 8, r.r); mem.w32(a + 12, r.b); };
  const lpFromPtr = (ptr: number) => BigInt(ptr >>> 0);
  const classNameArg = (ptr: number, wide: boolean): string | number => (ptr < 0x10000 ? ptr : str(ptr, wide));
  const W = (h: number): Win | undefined => (h ? ws.win(h) : undefined);
  const setErr = (e: number) => p.setLastError(e);
  const bool = (v: boolean) => (v ? 1 : 0);

  // ---- system window classes ------------------------------------------------------------------
  const defProcAddr = u.fn("DefWindowProcW", (c) => ws.defWindowProc(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3)));
  const defProcA = u.fn("DefWindowProcA", (c) => defProcWithAnsi(c));
  function defProcWithAnsi(c: Cpu): bigint {
    const hwnd = c.arg(0), msg = c.arg(1);
    return ws.defWindowProc(hwnd, msg, c.arg64(2), c.arg64(3));
  }
  void defProcA;
  for (const [name, style] of [["Button", 8], ["Static", 0], ["Edit", 8], ["ComboBox", 8], ["ListBox", 8], ["ScrollBar", 8], ["#32770", 8], ["tooltips_class32", 0], ["SysListView32", 8], ["SysTreeView32", 8], ["msctls_trackbar32", 0], ["msctls_progress32", 0], ["SysTabControl32", 0], ["msctls_updown32", 0], ["MDIClient", 0], ["IME", 0]] as [string, number][]) {
    ws.makeClass({ name, style, proc: defProcAddr, system: true, unicode: true, wndExtra: name === "#32770" ? 30 * 8 : 8 });
  }

  // ---- class registration ----------------------------------------------------------------------
  const regClass = (c: Cpu, wide: boolean, ex: boolean): number => {
    const a = c.arg(0);
    const o = ex ? 0 : -8; // WNDCLASSW lacks cbSize (4) + hIconSm; offsets differ by 8 up to hIcon
    const style = mem.r32(a + 4 + (ex ? 0 : -4)), proc = mem.r32(a + 8 + (ex ? 0 : -8));
    void o;
    const base = ex ? a : a - 8; // normalise so that +8 = lpfnWndProc, +16 = cbClsExtra ...
    const clsExtra = mem.ri32(base + 16), wndExtra = mem.ri32(base + 20), hInst = mem.r32(base + 24), hIcon = mem.r32(base + 32), hCursor = mem.r32(base + 40);
    const hbr = mem.r32(base + 48), menu = mem.r32(base + 56), namePtr = mem.r32(base + 64);
    const hIconSm = ex ? mem.r32(a + 72) : 0;
    const name = namePtr < 0x10000 ? "#" + namePtr : str(namePtr, wide);
    if (ws.findClass(name) && !ws.findClass(name)!.system) { setErr(1410); return 0; }
    const cls = ws.makeClass({ name, style, proc, clsExtra, wndExtra, hInstance: hInst, hIcon, hCursor, hbrBackground: hbr, menuName: menu, hIconSm, unicode: wide });
    return cls.atom;
  };
  wa("RegisterClass", (c, w) => regClass(c, w, false));
  wa("RegisterClassEx", (c, w) => regClass(c, w, true));
  wa("UnregisterClass", (c, w) => {
    const n = classNameArg(c.arg(0), w);
    const cls = ws.findClass(typeof n === "number" ? n : n);
    if (!cls) { setErr(ERR_CLASS_NF); return 0; }
    ws.classes.delete(cls.key); ws.atoms.delete(cls.atom);
    return 1;
  });
  const ERR_CLASS_NF = 1411;
  const getClassInfo = (c: Cpu, wide: boolean, ex: boolean) => {
    const n = classNameArg(c.arg(1), wide);
    const cls = ws.findClass(n);
    if (!cls) { setErr(ERR_CLASS_NF); return 0; }
    const out = c.arg(2);
    const base = ex ? out : out - 8;
    if (ex) { mem.w32(out, 80); }
    mem.w32(base + 4, cls.style); mem.wptr(base + 8, cls.proc); mem.w32(base + 16, cls.clsExtra); mem.w32(base + 20, cls.wndExtra);
    mem.wptr(base + 24, cls.hInstance); mem.wptr(base + 32, cls.hIcon); mem.wptr(base + 40, cls.hCursor); mem.wptr(base + 48, cls.hbrBackground);
    mem.wptr(base + 56, cls.menuName); mem.wptr(base + 64, c.arg(1));
    if (ex) mem.wptr(out + 72, cls.hIconSm);
    return cls.atom;
  };
  wa("GetClassInfo", (c, w) => getClassInfo(c, w, false));
  wa("GetClassInfoEx", (c, w) => getClassInfo(c, w, true));
  wa("GetClassName", (c, w) => { const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; } return putStr(c.arg(1), x.cls.name, c.argI(2), w) - 1; });
  const getClassLong = (c: Cpu, ptr: boolean) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const i = c.argI(1);
    switch (i) {
      case -26: return x.cls.style; case -24: return x.cls.proc; case -20: return x.cls.hbrBackground; case -12: return x.cls.hCursor; case -14: return x.cls.hIcon;
      case -16: return x.cls.hInstance; case -10: return x.cls.menuName; case -18: return x.cls.wndExtra; case -8: return x.cls.clsExtra; case -34: return x.cls.hIconSm; case -32: return x.cls.atom;
      default: if (i >= 0 && i + (ptr ? 8 : 4) <= x.cls.extra.length) return new DataView(x.cls.extra.buffer).getUint32(i, true); return 0;
    }
  };
  for (const n of ["GetClassLongA", "GetClassLongW", "GetClassLongPtrA", "GetClassLongPtrW"]) u.fn(n, (c) => getClassLong(c, n.includes("Ptr")));
  const setClassLong = (c: Cpu) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const i = c.argI(1), v = c.arg(2);
    const old = getClassLong(c, false);
    switch (i) {
      case -26: x.cls.style = v; break; case -24: x.cls.proc = v; break; case -20: x.cls.hbrBackground = v; break; case -12: x.cls.hCursor = v; break; case -14: x.cls.hIcon = v; break;
      case -34: x.cls.hIconSm = v; break;
      default: if (i >= 0 && i + 4 <= x.cls.extra.length) new DataView(x.cls.extra.buffer).setUint32(i, v, true);
    }
    return old;
  };
  for (const n of ["SetClassLongA", "SetClassLongW", "SetClassLongPtrA", "SetClassLongPtrW"]) u.fn(n, setClassLong);
  u.fn("GetClassWord", () => 0);

  // ---- windows ---------------------------------------------------------------------------------
  const createWindowEx = (c: Cpu, wide: boolean): number => {
    const cname = classNameArg(c.arg(1), wide);
    const cls = ws.findClass(cname);
    if (!cls) { setErr(1407); p.log(`[user32] CreateWindowEx: unknown class ${cname}`); return 0; }
    const namePtr = c.arg(2);
    const name = namePtr && namePtr >= 0x10000 ? str(namePtr, wide) : "";
    return ws.createWindow({
      exStyle: c.arg(0), cls, name, style: c.arg(3), x: c.argI(4), y: c.argI(5), w: c.argI(6), h: c.argI(7), parent: c.arg(8), menu: c.arg(9),
      hInstance: c.arg(10), param: c.arg(11), unicode: wide,
    });
  };
  u.fn("CreateWindowExA", (c) => createWindowEx(c, false));
  u.fn("CreateWindowExW", (c) => createWindowEx(c, true));
  u.fn("DestroyWindow", (c) => { const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; } return bool(ws.destroyWindow(x)); });
  u.fn("ShowWindow", (c) => { const x = W(c.arg(0)); if (!x) return 0; return bool(ws.showWindow(x, c.arg(1))); });
  u.fn("ShowWindowAsync", (c) => { const x = W(c.arg(0)); if (!x) return 0; return bool(ws.showWindow(x, c.arg(1))); });
  u.fn("ShowOwnedPopups", () => 1);
  u.fn("UpdateWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    if (x.invalid && ws.isVisible(x)) ws.send(x.hwnd, WM.PAINT, 0, 0);
    return 1;
  });
  u.fn("IsWindow", (c) => bool(!!W(c.arg(0))));
  u.fn("IsWindowVisible", (c) => { const x = W(c.arg(0)); return bool(!!x && ws.isVisible(x)); });
  u.fn("IsWindowEnabled", (c) => { const x = W(c.arg(0)); return bool(!!x && !(x.style & WS.DISABLED)); });
  u.fn("IsWindowUnicode", (c) => { const x = W(c.arg(0)); return bool(!!x && x.unicode); });
  u.fn("IsIconic", (c) => { const x = W(c.arg(0)); return bool(!!x && x.minimized); });
  u.fn("IsZoomed", (c) => { const x = W(c.arg(0)); return bool(!!x && x.maximized); });
  u.fn("IsChild", (c) => { const x = W(c.arg(1)); return bool(!!x && ws.isAncestor(c.arg(0), x)); });
  u.fn("IsHungAppWindow", () => 0);
  u.fn("EnableWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const was = (x.style & WS.DISABLED) !== 0;
    if (c.arg(1)) x.style &= ~WS.DISABLED; else x.style |= WS.DISABLED;
    if (was !== !c.arg(1)) ws.send(x.hwnd, WM.ENABLE, c.arg(1) ? 1 : 0, 0);
    return bool(was);
  });
  u.fn("GetDesktopWindow", () => ws.desktop.hwnd);
  u.fn("GetShellWindow", () => 0);
  u.fn("GetParent", (c) => { const x = W(c.arg(0)); if (!x) return 0; return x.parent === ws.desktop.hwnd ? x.owner : x.parent; });
  u.fn("GetAncestor", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const flag = c.arg(1);
    if (flag === 1) return x.parent === ws.desktop.hwnd ? 0 : x.parent;
    if (flag === 2) return ws.rootOf(x).hwnd;
    let r = ws.rootOf(x);
    while (r.owner) { const o = W(r.owner); if (!o) break; r = ws.rootOf(o); }
    return r.hwnd;
  });
  u.fn("SetParent", (c) => { const x = W(c.arg(0)); if (!x) return 0; return ws.setParent(x, c.arg(1)); });
  u.fn("GetWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const cmd = c.arg(1);
    const sibs = ws.isTopLevel(x) ? ws.zorder : W(x.parent)?.children ?? [];
    const i = sibs.indexOf(x.hwnd);
    switch (cmd) {
      case 0: return sibs[sibs.length - 1] ?? 0; // GW_HWNDFIRST? (0 = FIRST)
      case 1: return sibs[sibs.length - 1] ?? 0; // GW_HWNDLAST
      case 2: return sibs[i + 1] ?? 0; // GW_HWNDNEXT
      case 3: return sibs[i - 1] ?? 0; // GW_HWNDPREV
      case 4: return x.owner; // GW_OWNER
      case 5: return x.children[0] ?? 0; // GW_CHILD
      default: return 0;
    }
  });
  u.fn("GetTopWindow", (c) => { const x = c.arg(0) ? W(c.arg(0)) : ws.desktop; if (!x) return 0; return x === ws.desktop ? ws.zorder[0] ?? 0 : x.children[0] ?? 0; });
  u.fn("GetNextWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const sibs = ws.isTopLevel(x) ? ws.zorder : W(x.parent)?.children ?? [];
    const i = sibs.indexOf(x.hwnd);
    return (c.arg(1) === 2 ? sibs[i + 1] : sibs[i - 1]) ?? 0;
  });
  u.fn("GetLastActivePopup", (c) => c.arg(0));
  u.fn("GetWindowThreadProcessId", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    if (c.arg(1)) mem.w32(c.arg(1), p.pid);
    return x.tid;
  });
  u.fn("GetWindowRect", (c) => {
    const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; }
    wrRect(c.arg(1), { l: x.x, t: x.y, r: x.x + x.w, b: x.y + x.h });
    return 1;
  });
  u.fn("GetClientRect", (c) => {
    const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; }
    const cs = ws.clientSize(x);
    wrRect(c.arg(1), { l: 0, t: 0, r: cs.w, b: cs.h });
    return 1;
  });
  u.fn("ClientToScreen", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const o = ws.clientOrigin(x), pt = c.arg(1);
    mem.w32(pt, mem.ri32(pt) + o.x); mem.w32(pt + 4, mem.ri32(pt + 4) + o.y);
    return 1;
  });
  u.fn("ScreenToClient", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const o = ws.clientOrigin(x), pt = c.arg(1);
    mem.w32(pt, mem.ri32(pt) - o.x); mem.w32(pt + 4, mem.ri32(pt + 4) - o.y);
    return 1;
  });
  u.fn("MapWindowPoints", (c) => {
    const from = W(c.arg(0)), to = W(c.arg(1));
    const fo = from ? ws.clientOrigin(from) : { x: 0, y: 0 }, to_ = to ? ws.clientOrigin(to) : { x: 0, y: 0 };
    const dx = fo.x - to_.x, dy = fo.y - to_.y;
    const pts = c.arg(2), n = c.arg(3);
    for (let i = 0; i < n; i++) { mem.w32(pts + i * 8, mem.ri32(pts + i * 8) + dx); mem.w32(pts + i * 8 + 4, mem.ri32(pts + i * 8 + 4) + dy); }
    return ((dy & 0xffff) << 16) | (dx & 0xffff);
  });
  u.fn("AdjustWindowRect", (c) => {
    const r = rdRect(c.arg(0));
    wrRect(c.arg(0), ws.adjustRect(r, c.arg(1), 0, c.arg(2) !== 0));
    return 1;
  });
  u.fn("AdjustWindowRectEx", (c) => {
    const r = rdRect(c.arg(0));
    wrRect(c.arg(0), ws.adjustRect(r, c.arg(1), c.arg(3), c.arg(2) !== 0));
    return 1;
  });
  u.fn("AdjustWindowRectExForDpi", (c) => {
    const r = rdRect(c.arg(0));
    wrRect(c.arg(0), ws.adjustRect(r, c.arg(1), c.arg(3), c.arg(2) !== 0));
    return 1;
  });
  u.fn("MoveWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    ws.setWindowPos(x, 0, c.argI(1), c.argI(2), c.argI(3), c.argI(4), SWP.NOZORDER | SWP.NOACTIVATE);
    if (c.arg(5)) ws.invalidateAll(x);
    return 1;
  });
  u.fn("SetWindowPos", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    ws.setWindowPos(x, c.arg(1), c.argI(2), c.argI(3), c.argI(4), c.argI(5), c.arg(6));
    return 1;
  });
  u.fn("BringWindowToTop", (c) => { const x = W(c.arg(0)); if (!x) return 0; const i = ws.zorder.indexOf(x.hwnd); if (i > 0) { ws.zorder.splice(i, 1); ws.zorder.unshift(x.hwnd); } return 1; });
  u.fn("CloseWindow", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.showWindow(x, SW.MINIMIZE); return 1; });
  u.fn("OpenIcon", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.showWindow(x, SW.RESTORE); return 1; });
  u.fn("SetForegroundWindow", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.activate(x); return 1; });
  u.fn("GetForegroundWindow", () => ws.foreground);
  u.fn("SetActiveWindow", (c) => { const old = ws.active; const x = W(c.arg(0)); if (x) ws.activate(x); return old; });
  u.fn("GetActiveWindow", () => ws.active);
  u.fn("SetFocus", (c) => {
    const x = W(c.arg(0));
    if (!x) { const old = ws.focus; ws.setFocus(undefined); return old; }
    return ws.setFocus(x);
  });
  u.fn("GetFocus", () => ws.focus);
  u.fn("SwitchToThisWindow", (c) => { const x = W(c.arg(0)); if (x) ws.activate(x); });
  u.fn("AllowSetForegroundWindow", () => 1);
  u.fn("LockSetForegroundWindow", () => 1);
  u.fn("SetCapture", (c) => { const old = ws.capture; ws.capture = c.arg(0); return old; });
  u.fn("ReleaseCapture", () => { const old = ws.capture; ws.capture = 0; if (old) ws.send(old, WM.CAPTURECHANGED, 0, 0); return 1; });
  u.fn("GetCapture", () => ws.capture);
  u.fn("FlashWindow", () => 0);
  u.fn("FlashWindowEx", () => 0);
  u.fn("SetWindowRgn", () => 1);
  u.fn("GetWindowRgn", () => 0);
  u.fn("SetLayeredWindowAttributes", (c) => { const x = W(c.arg(0)); if (x) x.alpha = c.arg(2) & 0xff; return 1; });
  u.fn("UpdateLayeredWindow", () => 1);
  u.fn("SetWindowDisplayAffinity", () => 1);
  u.fn("GetWindowPlacement", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const a = c.arg(1);
    mem.w32(a, 44); mem.w32(a + 4, 0); mem.w32(a + 8, x.minimized ? 2 : x.maximized ? 3 : 1);
    mem.w32(a + 12, -1); mem.w32(a + 16, -1); mem.w32(a + 20, -1); mem.w32(a + 24, -1);
    const r = x.restore ?? { l: x.x, t: x.y, r: x.x + x.w, b: x.y + x.h };
    wrRect(a + 28, r);
    return 1;
  });
  u.fn("SetWindowPlacement", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const a = c.arg(1);
    const r = rdRect(a + 28);
    ws.setWindowPos(x, 0, r.l, r.t, r.r - r.l, r.b - r.t, SWP.NOZORDER | SWP.NOACTIVATE);
    ws.showWindow(x, mem.r32(a + 8));
    return 1;
  });
  u.fn("GetWindowInfo", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const a = c.arg(1);
    mem.w32(a, 60);
    wrRect(a + 4, { l: x.x, t: x.y, r: x.x + x.w, b: x.y + x.h });
    const o = ws.clientOrigin(x), cs = ws.clientSize(x);
    wrRect(a + 20, { l: o.x, t: o.y, r: o.x + cs.w, b: o.y + cs.h });
    mem.w32(a + 36, x.style); mem.w32(a + 40, x.exStyle); mem.w32(a + 44, ws.active === x.hwnd ? 1 : 0);
    const i = ws.insets(x);
    mem.w32(a + 48, i.l); mem.w32(a + 52, i.t); mem.w32(a + 56, 0x58);
    return 1;
  });
  u.fn("GetTitleBarInfo", () => 0);
  u.fn("GetGUIThreadInfo", (c) => {
    const a = c.arg(1);
    mem.w32(a, 72); mem.w32(a + 4, 0);
    mem.wptr(a + 8, ws.active); mem.wptr(a + 16, ws.focus); mem.wptr(a + 24, ws.capture);
    return 1;
  });

  // GetWindowLong / SetWindowLong
  const getWindowLong = (c: Cpu, ptr: boolean, wide: boolean): number | bigint => {
    const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; }
    const i = c.argI(1);
    switch (i) {
      case -4: return x.proc;
      case -6: return x.hInstance;
      case -8: return x.parent === ws.desktop.hwnd ? x.owner : x.parent;
      case -12: return x.id;
      case -16: return x.style;
      case -20: return x.exStyle;
      case -21: return ptr ? x.userData : Number(x.userData & 0xffffffffn);
      default:
        if (i >= 0 && i + (ptr ? 8 : 4) <= x.extra.length) {
          const dv = new DataView(x.extra.buffer, x.extra.byteOffset);
          return ptr ? dv.getBigUint64(i, true) : dv.getUint32(i, true);
        }
        setErr(1413); return 0;
    }
    void wide;
  };
  const setWindowLong = (c: Cpu, ptr: boolean): number | bigint => {
    const x = W(c.arg(0)); if (!x) { setErr(1400); return 0; }
    const i = c.argI(1);
    const v = ptr ? c.arg64(2) : BigInt(c.arg(2));
    const old = getWindowLong(c, ptr, true);
    switch (i) {
      case -4: x.proc = Number(v & 0xffffffffn); break;
      case -6: x.hInstance = Number(v & 0xffffffffn); break;
      case -8: x.owner = Number(v & 0xffffffffn); break;
      case -12: x.id = Number(v & 0xffffffffn); break;
      case -16: {
        const nv = Number(v & 0xffffffffn) >>> 0;
        const oldS = x.style;
        x.style = nv;
        ws.send(x.hwnd, 0x7c, 0xfffffff0 >>> 0, 0); // WM_STYLECHANGING-ish no-op
        if ((oldS ^ nv) & (WS.THICKFRAME | WS.CAPTION | WS.BORDER)) { ws.notifyHost(x); }
        break;
      }
      case -20: x.exStyle = Number(v & 0xffffffffn) >>> 0; break;
      case -21: x.userData = v; break;
      default:
        if (i >= 0 && i + (ptr ? 8 : 4) <= x.extra.length) {
          const dv = new DataView(x.extra.buffer, x.extra.byteOffset);
          if (ptr) dv.setBigUint64(i, v, true); else dv.setUint32(i, Number(v & 0xffffffffn), true);
        } else { setErr(1413); return 0; }
    }
    return old;
  };
  for (const n of ["GetWindowLongA", "GetWindowLongW"]) u.fn(n, (c) => getWindowLong(c, false, n.endsWith("W")) as number);
  for (const n of ["GetWindowLongPtrA", "GetWindowLongPtrW"]) u.fn(n, (c) => getWindowLong(c, true, n.endsWith("W")));
  for (const n of ["SetWindowLongA", "SetWindowLongW"]) u.fn(n, (c) => setWindowLong(c, false) as number);
  for (const n of ["SetWindowLongPtrA", "SetWindowLongPtrW"]) u.fn(n, (c) => setWindowLong(c, true));
  u.fn("GetWindowWord", () => 0);
  u.fn("SetWindowWord", () => 0);

  wa("SetWindowText", (c, w) => { const x = W(c.arg(0)); if (!x) return 0; x.text = str(c.arg(1), w); ws.notifyHost(x); return 1; });
  wa("GetWindowText", (c, w) => { const x = W(c.arg(0)); if (!x || !c.argI(2)) return 0; return putStr(c.arg(1), x.text, c.argI(2), w) - 1; });
  wa("GetWindowTextLength", (c) => W(c.arg(0))?.text.length ?? 0);
  wa("GetWindowModuleFileName", (c, w) => { const x = W(c.arg(0)); void x; return putStr(c.arg(1), p.exePath, c.arg(2), w) - 1; });
  wa("FindWindow", (c, w) => {
    const cn = c.arg(0) ? classNameArg(c.arg(0), w) : null, wn = c.arg(1) ? str(c.arg(1), w) : null;
    for (const h of ws.zorder) {
      const x = W(h); if (!x) continue;
      if (cn !== null && (typeof cn === "number" ? x.cls.atom !== cn : x.cls.key !== cn.toLowerCase())) continue;
      if (wn !== null && x.text !== wn) continue;
      return x.hwnd;
    }
    return 0;
  });
  wa("FindWindowEx", (c, w) => {
    const parent = W(c.arg(0)) ?? ws.desktop;
    const list = parent === ws.desktop ? ws.zorder : parent.children;
    const after = c.arg(1);
    const cn = c.arg(2) ? classNameArg(c.arg(2), w) : null, wn = c.arg(3) ? str(c.arg(3), w) : null;
    let started = after === 0;
    for (const h of list) {
      if (!started) { if (h === after) started = true; continue; }
      const x = W(h); if (!x) continue;
      if (cn !== null && (typeof cn === "number" ? x.cls.atom !== cn : x.cls.key !== cn.toLowerCase())) continue;
      if (wn !== null && x.text !== wn) continue;
      return x.hwnd;
    }
    return 0;
  });
  const enumList = (list: number[], proc: number, lp: bigint): number => {
    for (const h of [...list]) { if (!W(h)) continue; const r = Number(p.callGuest(proc, [h, lp]) & 0xffffffffn); if (!r) return 0; }
    return 1;
  };
  u.fn("EnumWindows", (c) => enumList(ws.zorder, c.arg(0), c.arg64(1)));
  u.fn("EnumDesktopWindows", (c) => enumList(ws.zorder, c.arg(1), c.arg64(2)));
  u.fn("EnumThreadWindows", (c) => enumList(ws.zorder.filter((h) => W(h)?.tid === c.arg(0)), c.arg(1), c.arg64(2)));
  u.fn("EnumChildWindows", (c) => { const x = W(c.arg(0)); if (!x) return 0; return enumList(x.children, c.arg(1), c.arg64(2)); });
  u.fn("GetDlgCtrlID", (c) => W(c.arg(0))?.id ?? 0);
  u.fn("GetDlgItem", (c) => { const x = W(c.arg(0)); if (!x) return 0; for (const h of x.children) if (W(h)?.id === c.arg(1)) return h; return 0; });
  u.fn("SetPropA", (c) => { const x = W(c.arg(0)); if (!x) return 0; x.props.set(c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.cstr(c.arg(1)), c.arg64(2)); return 1; });
  u.fn("SetPropW", (c) => { const x = W(c.arg(0)); if (!x) return 0; x.props.set(c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.wstr(c.arg(1)), c.arg64(2)); return 1; });
  u.fn("GetPropA", (c) => W(c.arg(0))?.props.get(c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.cstr(c.arg(1))) ?? 0n);
  u.fn("GetPropW", (c) => W(c.arg(0))?.props.get(c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.wstr(c.arg(1))) ?? 0n);
  u.fn("RemovePropA", (c) => { const x = W(c.arg(0)); const k = c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.cstr(c.arg(1)); const v = x?.props.get(k) ?? 0n; x?.props.delete(k); return v; });
  u.fn("RemovePropW", (c) => { const x = W(c.arg(0)); const k = c.arg(1) < 0x10000 ? "#" + c.arg(1) : mem.wstr(c.arg(1)); const v = x?.props.get(k) ?? 0n; x?.props.delete(k); return v; });

  // ---- messages --------------------------------------------------------------------------------
  const writeMsg = (a: number, m: Msg) => {
    mem.wptr(a, m.hwnd); mem.w32(a + 8, m.msg); mem.w64(a + 16, m.wp); mem.w64(a + 24, m.lp); mem.w32(a + 32, m.time);
    mem.w32(a + 36, m.x); mem.w32(a + 40, m.y); mem.w32(a + 44, 0);
  };
  const readMsg = (a: number): Msg => ({ hwnd: mem.r32(a), msg: mem.r32(a + 8), wp: mem.r64(a + 16), lp: mem.r64(a + 24), time: mem.r32(a + 32), x: mem.ri32(a + 36), y: mem.ri32(a + 40) });
  const curMsgs = new Map<number, Msg>(); // thread id -> message last returned (for GetMessagePos etc.)
  const track = (m: Msg, mm: Msg & { _wide?: boolean }) => { curMsgs.set(p.curThread.id, mm); void m; };
  const getMessage = (c: Cpu, wide: boolean): number => {
    const a = c.arg(0), hwnd = c.arg(1), min = c.arg(2), max = c.arg(3);
    // the A variant converts nothing for non-text messages; text carriers are handled at dispatch
    void wide;
    p.win.flushSurfaces();
    p.waitUntil(() => ws.nextMessage(hwnd, min, max, false) !== null, INFINITE, "GetMessage");
    const m = ws.nextMessage(hwnd, min, max, true)!;
    writeMsg(a, m);
    track(m, m);
    ws.queue(p.curThread.id).cur = m;
    return m.msg === WM.QUIT ? 0 : 1;
  };
  u.fn("GetMessageA", (c) => getMessage(c, false));
  u.fn("GetMessageW", (c) => getMessage(c, true));
  const peekMessage = (c: Cpu): number => {
    const a = c.arg(0), hwnd = c.arg(1), min = c.arg(2), max = c.arg(3), flags = c.arg(4);
    const remove = (flags & 1) !== 0;
    const m = ws.nextMessage(hwnd, min, max, remove);
    if (!m) {
      // an idle poll: give other threads and the host a chance to run
      ws.flushSurfaces();
      p.sleep(0);
      return 0;
    }
    writeMsg(a, m);
    track(m, m);
    ws.queue(p.curThread.id).cur = m;
    return 1;
  };
  u.fn("PeekMessageA", peekMessage);
  u.fn("PeekMessageW", peekMessage);
  u.fn("WaitMessage", () => { p.waitUntil(() => ws.nextMessage(0, 0, 0, false) !== null, INFINITE, "WaitMessage"); return 1; });
  u.fn("TranslateMessage", (c) => bool(ws.translate(readMsgWithText(c.arg(0)))));
  const readMsgWithText = (a: number): Msg => {
    const m = readMsg(a);
    const cur = curMsgs.get(p.curThread.id);
    if (cur && cur.hwnd === m.hwnd && cur.msg === m.msg && cur.lp === m.lp) m.text = cur.text;
    return m;
  };
  u.fn("TranslateMessageEx", (c) => bool(ws.translate(readMsgWithText(c.arg(0)))));
  u.fn("DispatchMessageA", (c) => ws.dispatch(readMsg(c.arg(0))));
  u.fn("DispatchMessageW", (c) => ws.dispatch(readMsg(c.arg(0))));
  u.fn("PostMessageA", (c) => postMessage(c));
  u.fn("PostMessageW", (c) => postMessage(c));
  const postMessage = (c: Cpu): number => {
    const hwnd = c.arg(0), msg = c.arg(1);
    if (hwnd === 0xffff) { for (const h of [...ws.zorder]) ws.post(h, msg, c.arg64(2), c.arg64(3)); return 1; }
    if (hwnd && !W(hwnd)) { setErr(1400); return 0; }
    ws.post(hwnd, msg, c.arg64(2), c.arg64(3));
    return 1;
  };
  u.fn("PostThreadMessageA", (c) => { ws.queue(c.arg(0)).posted.push({ hwnd: 0, msg: c.arg(1), wp: c.arg64(2), lp: c.arg64(3), time: ws.tick(), x: ws.cursorX, y: ws.cursorY }); return 1; });
  u.fn("PostThreadMessageW", (c) => { ws.queue(c.arg(0)).posted.push({ hwnd: 0, msg: c.arg(1), wp: c.arg64(2), lp: c.arg64(3), time: ws.tick(), x: ws.cursorX, y: ws.cursorY }); return 1; });
  u.fn("PostQuitMessage", (c) => { ws.queue(p.curThread.id).quit = { code: c.argI(0) }; });
  // text messages sent through the A API to Unicode windows (and vice versa) are converted
  const sendMsg = (c: Cpu, ansi: boolean): bigint => {
    const hwnd = c.arg(0), msg = c.arg(1);
    let wp = c.arg64(2), lp = c.arg64(3);
    if (hwnd === 0xffff) { for (const h of [...ws.zorder]) ws.send(h, msg, wp, lp); return 0n; }
    const x = W(hwnd);
    if (!x) { setErr(1400); return 0n; }
    if (ansi !== !x.unicode && (msg === WM.SETTEXT || msg === WM.GETTEXT)) {
      if (msg === WM.SETTEXT) {
        const s = ansi ? mem.cstr(Number(lp)) : mem.wstr(Number(lp));
        const tmp = p.vm.alloc(0x1000 + s.length * 2, { commit: true, tag: "msgtext" });
        if (x.unicode) mem.wwstr(tmp, s); else mem.wcstr(tmp, s);
        const r = ws.send(hwnd, msg, wp, BigInt(tmp));
        p.vm.release(tmp);
        return r;
      }
      const cap = Number(wp);
      const tmp = p.vm.alloc(0x1000 + cap * 2, { commit: true, tag: "msgtext" });
      const r = ws.send(hwnd, msg, wp, BigInt(tmp));
      const s = x.unicode ? mem.wstr(tmp) : mem.cstr(tmp);
      if (ansi) mem.wcstr(Number(lp), s, cap); else mem.wwstr(Number(lp), s, cap);
      p.vm.release(tmp);
      return r;
    }
    void wp; void lp;
    return ws.send(hwnd, msg, wp, lp);
  };
  u.fn("SendMessageA", (c) => sendMsg(c, true));
  u.fn("SendMessageW", (c) => sendMsg(c, false));
  u.fn("SendNotifyMessageA", (c) => { ws.send(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3)); return 1; });
  u.fn("SendNotifyMessageW", (c) => { ws.send(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3)); return 1; });
  const sendTimeout = (c: Cpu) => {
    const r = ws.send(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3));
    if (c.arg(6)) mem.w64(c.arg(6), r);
    return 1;
  };
  u.fn("SendMessageTimeoutA", sendTimeout);
  u.fn("SendMessageTimeoutW", sendTimeout);
  u.fn("SendMessageCallbackA", (c) => { ws.send(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3)); return 1; });
  u.fn("SendMessageCallbackW", (c) => { ws.send(c.arg(0), c.arg(1), c.arg64(2), c.arg64(3)); return 1; });
  u.fn("BroadcastSystemMessageA", () => 1);
  u.fn("BroadcastSystemMessageW", () => 1);
  u.fn("InSendMessage", () => 0);
  u.fn("InSendMessageEx", () => 0);
  u.fn("ReplyMessage", () => 1);
  u.fn("CallWindowProcA", (c) => p.callGuest(c.arg(0), [c.arg(1), c.arg(2), c.arg64(3), c.arg64(4)]));
  u.fn("CallWindowProcW", (c) => p.callGuest(c.arg(0), [c.arg(1), c.arg(2), c.arg64(3), c.arg64(4)]));
  u.fn("GetMessageTime", () => curMsgs.get(p.curThread.id)?.time ?? ws.tick());
  u.fn("GetMessagePos", () => { const m = curMsgs.get(p.curThread.id); const x = m?.x ?? ws.cursorX, y = m?.y ?? ws.cursorY; return ((y & 0xffff) << 16) | (x & 0xffff); });
  u.fn("GetMessageExtraInfo", () => 0);
  u.fn("SetMessageExtraInfo", () => 0);
  u.fn("GetQueueStatus", () => (ws.nextMessage(0, 0, 0, false) ? 0x001f001f : 0));
  u.fn("RegisterWindowMessageA", (c) => regMsg(mem.cstr(c.arg(0))));
  u.fn("RegisterWindowMessageW", (c) => regMsg(mem.wstr(c.arg(0))));
  const regMsg = (n: string) => { n = n.toLowerCase(); let v = ws.registeredMessages.get(n); if (!v) ws.registeredMessages.set(n, (v = ws.nextRegMsg++)); return v; };
  u.fn("SetTimer", (c) => { const id = ws.setTimer(c.arg(0), c.argN(1), c.arg(2), c.arg(3)); return id; });
  u.fn("SetCoalescableTimer", (c) => ws.setTimer(c.arg(0), c.argN(1), c.arg(2), c.arg(3)));
  u.fn("KillTimer", (c) => bool(ws.killTimer(c.arg(0), c.argN(1))));
  u.fn("InSendMessage", () => 0);
  u.fn("MsgWaitForMultipleObjects", (c) => msgWait(c, c.arg(0), c.arg(1), c.arg(2) !== 0, c.arg(3)));
  u.fn("MsgWaitForMultipleObjectsEx", (c) => msgWait(c, c.arg(0), c.arg(1), (c.arg(5) & 1) !== 0, c.arg(2)));
  const msgWait = (c: Cpu, n: number, arr: number, all: boolean, ms: number): number => {
    const objs: any[] = [];
    for (let i = 0; i < n; i++) { const o = p.handles.get(mem.r32(arr + i * 8)); if (!o) { setErr(ERROR.INVALID_HANDLE); return WAIT_FAILED; } objs.push(o); }
    let result = WAIT_TIMEOUT;
    const attempt = (): boolean => {
      if (ws.nextMessage(0, 0, 0, false) !== null) { result = WAIT_OBJECT_0 + n; return true; }
      if (all) { return false; }
      for (let i = 0; i < n; i++) if (p.tryAcquire(objs[i])) { result = WAIT_OBJECT_0 + i; return true; }
      return false;
    };
    void c;
    if (attempt()) return result;
    if (ms === 0) return WAIT_TIMEOUT;
    return p.waitUntil(attempt, ms, "MsgWait") ? result : WAIT_TIMEOUT;
  };

  // ---- painting / DCs --------------------------------------------------------------------------
  u.fn("GetDC", (c) => {
    const x = c.arg(0) ? W(c.arg(0)) : undefined;
    if (c.arg(0) && !x) return 0;
    if (x && x.ownDc && gdi.dc(x.ownDc)) { gdi.bindWindow(gdi.dc(x.ownDc)!); return x.ownDc; }
    const dc = gdi.windowDc(x ?? null);
    if (x && (x.cls.style & 0x20)) x.ownDc = dc.hdc;
    return dc.hdc;
  });
  u.fn("GetDCEx", (c) => { const x = c.arg(0) ? W(c.arg(0)) : undefined; return gdi.windowDc(x ?? null).hdc; });
  u.fn("GetWindowDC", (c) => { const x = c.arg(0) ? W(c.arg(0)) : undefined; return gdi.windowDc(x ?? null).hdc; });
  u.fn("ReleaseDC", (c) => { const h = c.arg(1); const x = W(c.arg(0)); if (x && x.ownDc === h) return 1; return bool(gdi.releaseDc(h)); });
  u.fn("BeginPaint", (c) => {
    const x = W(c.arg(0)); const ps = c.arg(1);
    if (!x) return 0;
    const dc = gdi.windowDc(x);
    dc.ps = true;
    const inv = x.invalid ?? { l: 0, t: 0, r: 0, b: 0 };
    mem.wptr(ps, dc.hdc); mem.w32(ps + 8, bool(x.erase)); wrRect(ps + 12, inv);
    mem.w32(ps + 28, 0); mem.w32(ps + 32, 0); mem.fill(ps + 36, 0, 32);
    if (x.erase) { ws.send(x.hwnd, WM.ERASEBKGND, dc.hdc, 0); x.erase = false; }
    x.invalid = null;
    return dc.hdc;
  });
  u.fn("EndPaint", (c) => { const ps = c.arg(1); gdi.releaseDc(mem.r32(ps)); return 1; });
  u.fn("InvalidateRect", (c) => {
    const rp = c.arg(1);
    if (!c.arg(0)) { for (const w of ws.wins.values()) if (w !== ws.desktop) ws.invalidate(w, null, c.arg(2) !== 0); return 1; }
    const x = W(c.arg(0)); if (!x) return 0;
    ws.invalidate(x, rp ? rdRect(rp) : null, c.arg(2) !== 0);
    return 1;
  });
  u.fn("InvalidateRgn", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.invalidate(x, null, c.arg(2) !== 0); return 1; });
  u.fn("ValidateRect", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.validate(x, c.arg(1) ? rdRect(c.arg(1)) : null); return 1; });
  u.fn("ValidateRgn", (c) => { const x = W(c.arg(0)); if (!x) return 0; ws.validate(x, null); return 1; });
  u.fn("GetUpdateRect", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    if (c.arg(1)) wrRect(c.arg(1), x.invalid ?? { l: 0, t: 0, r: 0, b: 0 });
    return bool(!!x.invalid);
  });
  u.fn("GetUpdateRgn", (c) => { const x = W(c.arg(0)); return x && x.invalid ? 2 : 1; });
  u.fn("RedrawWindow", (c) => {
    const x = W(c.arg(0)); if (!x) return 0;
    const flags = c.arg(3);
    if (flags & 1) ws.invalidate(x, c.arg(1) ? rdRect(c.arg(1)) : null, (flags & 4) !== 0);
    if (flags & 2) ws.validate(x, null);
    if ((flags & 0x100) && x.invalid) ws.send(x.hwnd, WM.PAINT, 0, 0);
    return 1;
  });
  u.fn("LockWindowUpdate", () => 1);
  u.fn("SetWindowsHookExA", (c) => { const id = ws.nextHook++; ws.hooks.push({ id, type: c.argI(0), proc: c.arg(1), tid: c.arg(3) }); return id; });
  u.fn("SetWindowsHookExW", (c) => { const id = ws.nextHook++; ws.hooks.push({ id, type: c.argI(0), proc: c.arg(1), tid: c.arg(3) }); return id; });
  u.fn("UnhookWindowsHookEx", (c) => { ws.hooks = ws.hooks.filter((h) => h.id !== c.arg(0)); return 1; });
  u.fn("CallNextHookEx", () => 0);
  u.fn("SetWinEventHook", () => 1);
  u.fn("UnhookWinEvent", () => 1);
  u.fn("NotifyWinEvent", () => 0);
  u.fn("DrawFocusRect", () => 1);
  u.fn("DisableProcessWindowsGhosting", () => 0);
  u.fn("SetProcessDefaultLayout", () => 1);
  u.fn("SetThreadDesktop", () => 1);
  u.fn("GetThreadDesktop", () => 0x40);
  u.fn("OpenInputDesktop", () => 0x40);
  u.fn("OpenDesktopA", () => 0x40);
  u.fn("OpenDesktopW", () => 0x40);
  u.fn("CloseDesktop", () => 1);
  u.fn("GetProcessWindowStation", () => 0x44);
  u.fn("OpenWindowStationA", () => 0x44);
  u.fn("OpenWindowStationW", () => 0x44);
  u.fn("CloseWindowStation", () => 1);
  u.fn("SetProcessWindowStation", () => 1);
  u.fn("GetUserObjectInformationW", (c) => { const i = c.argI(1); if (i === 1 && c.arg(3) >= 12) { mem.w32(c.arg(2), 0); mem.w32(c.arg(2) + 4, 1); mem.w32(c.arg(2) + 8, 0); if (c.arg(4)) mem.w32(c.arg(4), 12); return 1; } if (i === 2) { if (c.arg(3) >= 16) mem.wwstr(c.arg(2), "WinSta0"); if (c.arg(4)) mem.w32(c.arg(4), 16); return 1; } return 1; });
  u.fn("GetUserObjectInformationA", () => 1);
  u.fn("GetUserObjectSecurity", () => 0);
  u.fn("RegisterDeviceNotificationA", () => 0x77);
  u.fn("RegisterDeviceNotificationW", () => 0x77);
  u.fn("UnregisterDeviceNotification", () => 1);
  u.fn("RegisterPowerSettingNotification", () => 0x78);
  u.fn("UnregisterPowerSettingNotification", () => 1);
  u.fn("IsGUIThread", () => 1);

  // ---- input -----------------------------------------------------------------------------------
  u.fn("GetKeyState", (c) => { const k = c.arg(0) & 0xff; return ((ws.keyState[k] & 0x80) ? 0xff80 : 0) | (ws.keyState[k] & 1); });
  u.fn("GetAsyncKeyState", (c) => {
    const k = c.arg(0) & 0xff;
    const s = ws.asyncKeyState[k];
    ws.asyncKeyState[k] &= ~1;
    return ((s & 0x80) ? 0x8000 : 0) | (s & 1);
  });
  u.fn("GetKeyboardState", (c) => { mem.write(c.arg(0), ws.keyState); return 1; });
  u.fn("SetKeyboardState", (c) => { ws.keyState.set(mem.bytes(c.arg(0), 256)); return 1; });
  u.fn("GetKeyboardType", (c) => (c.arg(0) === 0 ? 4 : c.arg(0) === 1 ? 0 : 12));
  u.fn("GetKeyboardLayout", () => 0x04090409);
  u.fn("GetKeyboardLayoutList", (c) => { if (c.arg(0) >= 1) mem.w32(c.arg(1), 0x04090409); return 1; });
  u.fn("GetKeyboardLayoutNameA", (c) => { mem.wcstr(c.arg(0), "00000409"); return 1; });
  u.fn("GetKeyboardLayoutNameW", (c) => { mem.wwstr(c.arg(0), "00000409"); return 1; });
  u.fn("ActivateKeyboardLayout", () => 0x04090409);
  u.fn("LoadKeyboardLayoutA", () => 0x04090409);
  u.fn("LoadKeyboardLayoutW", () => 0x04090409);
  u.fn("UnloadKeyboardLayout", () => 1);
  u.fn("GetCurrentInputMessageSource", () => 0);
  // virtual-key <-> scan code (US layout)
  const SCAN_ROW = "\x00\x1b1234567890-=\b\tqwertyuiop[]\r\x00asdfghjkl;'`\x00\\zxcvbnm,./\x00*\x00 ";
  const scanToVk = (sc: number): number => {
    const t: Record<number, number> = { 1: 0x1b, 14: 8, 15: 9, 28: 13, 29: 0x11, 42: 0x10, 54: 0x10, 56: 0x12, 57: 0x20, 58: 0x14, 59: 0x70, 60: 0x71, 61: 0x72, 62: 0x73, 63: 0x74, 64: 0x75, 65: 0x76, 66: 0x77, 67: 0x78, 68: 0x79, 87: 0x7a, 88: 0x7b, 71: 0x24, 72: 0x26, 73: 0x21, 75: 0x25, 77: 0x27, 79: 0x23, 80: 0x28, 81: 0x22, 82: 0x2d, 83: 0x2e, 69: 0x90, 70: 0x91 };
    if (t[sc]) return t[sc];
    const ch = SCAN_ROW[sc];
    if (!ch) return 0;
    if (/[a-z]/.test(ch)) return ch.toUpperCase().charCodeAt(0);
    if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
    const oem: Record<string, number> = { "-": 0xbd, "=": 0xbb, "[": 0xdb, "]": 0xdd, ";": 0xba, "'": 0xde, "`": 0xc0, "\\": 0xdc, ",": 0xbc, ".": 0xbe, "/": 0xbf };
    return oem[ch] ?? 0;
  };
  const vkToScan = (vk: number): number => { for (let s = 1; s < 128; s++) if (scanToVk(s) === vk) return s; return 0; };
  const mapVk = (c: Cpu) => {
    const code = c.arg(0), type = c.arg(1);
    switch (type) {
      case 0: return vkToScan(code);
      case 1: return scanToVk(code & 0xff);
      case 2: { const ch = SCAN_ROW[vkToScan(code)]; return ch && ch.length ? ch.toUpperCase().charCodeAt(0) : 0; }
      case 3: return scanToVk(code & 0xff);
      default: return 0;
    }
  };
  u.fn("MapVirtualKeyA", mapVk); u.fn("MapVirtualKeyW", mapVk); u.fn("MapVirtualKeyExA", mapVk); u.fn("MapVirtualKeyExW", mapVk);
  const vkKeyScan = (c: Cpu, wide: boolean) => {
    const ch = wide ? String.fromCharCode(c.arg(0) & 0xffff) : String.fromCharCode(c.arg(0) & 0xff);
    if (/[a-z]/.test(ch)) return ch.toUpperCase().charCodeAt(0);
    if (/[A-Z]/.test(ch)) return 0x100 | ch.charCodeAt(0);
    if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
    if (ch === " ") return 0x20;
    const i = SCAN_ROW.indexOf(ch);
    return i > 0 ? scanToVk(i) : 0xffff;
  };
  u.fn("VkKeyScanA", (c) => vkKeyScan(c, false)); u.fn("VkKeyScanW", (c) => vkKeyScan(c, true));
  u.fn("VkKeyScanExA", (c) => vkKeyScan(c, false)); u.fn("VkKeyScanExW", (c) => vkKeyScan(c, true));
  const toUnicode = (c: Cpu, wide: boolean) => {
    const vk = c.arg(0), sc = c.arg(1), ks = c.arg(2);
    const shift = (mem.r8(ks + 0x10) & 0x80) !== 0, ctrl = (mem.r8(ks + 0x11) & 0x80) !== 0, caps = (mem.r8(ks + 0x14) & 1) !== 0;
    let ch = "";
    if (vk >= 0x41 && vk <= 0x5a) ch = String.fromCharCode(vk + ((shift !== caps) ? 0 : 32));
    else if (vk >= 0x30 && vk <= 0x39) ch = shift ? ")!@#$%^&*(" [vk - 0x30] : String.fromCharCode(vk);
    else if (vk === 0x20) ch = " ";
    else if (vk === 13) ch = "\r"; else if (vk === 9) ch = "\t"; else if (vk === 8) ch = "\b"; else if (vk === 27) ch = "\x1b";
    else { const o: Record<number, [string, string]> = { 0xbd: ["-", "_"], 0xbb: ["=", "+"], 0xdb: ["[", "{"], 0xdd: ["]", "}"], 0xba: [";", ":"], 0xde: ["'", '"'], 0xc0: ["`", "~"], 0xdc: ["\\", "|"], 0xbc: [",", "<"], 0xbe: [".", ">"], 0xbf: ["/", "?"] }; if (o[vk]) ch = o[vk][shift ? 1 : 0]; }
    void sc;
    if (ctrl && ch && /[a-z]/i.test(ch)) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64);
    if (!ch) return 0;
    if (wide) mem.w16(c.arg(3), ch.charCodeAt(0)); else mem.w8(c.arg(3), ch.charCodeAt(0));
    return 1;
  };
  u.fn("ToUnicode", (c) => toUnicode(c, true)); u.fn("ToUnicodeEx", (c) => toUnicode(c, true));
  u.fn("ToAscii", (c) => toUnicode(c, false)); u.fn("ToAsciiEx", (c) => toUnicode(c, false));
  wa("GetKeyNameText", (c, w) => {
    const lp = c.arg(0), sc = (lp >> 16) & 0xff;
    const vk = scanToVk(sc);
    let name = vk >= 0x41 && vk <= 0x5a ? String.fromCharCode(vk) : vk >= 0x30 && vk <= 0x39 ? String.fromCharCode(vk) : vk >= 0x70 && vk <= 0x87 ? "F" + (vk - 0x6f) : ({ 8: "Backspace", 9: "Tab", 13: "Enter", 27: "Esc", 32: "Space", 0x10: "Shift", 0x11: "Ctrl", 0x12: "Alt", 0x14: "Caps Lock" } as Record<number, string>)[vk] ?? "Key" + sc;
    return putStr(c.arg(1), name, c.argI(2), w) - 1;
  });
  u.fn("GetCursorPos", (c) => { mem.w32(c.arg(0), ws.cursorX); mem.w32(c.arg(0) + 4, ws.cursorY); return 1; });
  u.fn("GetPhysicalCursorPos", (c) => { mem.w32(c.arg(0), ws.cursorX); mem.w32(c.arg(0) + 4, ws.cursorY); return 1; });
  u.fn("SetCursorPos", (c) => { ws.setCursorPos(c.argI(0), c.argI(1)); return 1; });
  u.fn("SetPhysicalCursorPos", (c) => { ws.setCursorPos(c.argI(0), c.argI(1)); return 1; });
  u.fn("ShowCursor", (c) => {
    ws.cursorVisibleCount += c.arg(0) ? 1 : -1;
    const vis = ws.cursorVisibleCount >= 0;
    p.host.setCursor?.(vis);
    return ws.cursorVisibleCount;
  });
  u.fn("SetCursor", (c) => { const old = ws.cursor; ws.cursor = c.arg(0); p.host.setCursor?.(ws.cursorVisibleCount >= 0, ws.cursor ? "default" : "none"); return old; });
  u.fn("GetCursor", () => ws.cursor);
  u.fn("ClipCursor", (c) => {
    const rp = c.arg(0);
    ws.clip = rp ? rdRect(rp) : null;
    ws.setCursorPos(ws.cursorX, ws.cursorY);
    p.host.setPointerLock?.(ws.clip !== null && ws.cursorVisibleCount < 0);
    ws.pointerLocked = ws.clip !== null && ws.cursorVisibleCount < 0;
    return 1;
  });
  u.fn("GetClipCursor", (c) => { wrRect(c.arg(0), ws.clip ?? { l: 0, t: 0, r: ws.sw, b: ws.sh }); return 1; });
  u.fn("GetCursorInfo", (c) => {
    const a = c.arg(0);
    mem.w32(a, 24); mem.w32(a + 4, ws.cursorVisibleCount >= 0 ? 1 : 0); mem.wptr(a + 8, ws.cursor); mem.w32(a + 16, ws.cursorX); mem.w32(a + 20, ws.cursorY);
    return 1;
  });
  u.fn("TrackMouseEvent", () => 1);
  u.fn("GetDoubleClickTime", () => 500);
  u.fn("SetDoubleClickTime", () => 1);
  u.fn("GetCaretBlinkTime", () => 530);
  u.fn("SwapMouseButton", () => 0);
  u.fn("GetLastInputInfo", (c) => { mem.w32(c.arg(0) + 4, ws.lastInput || ws.tick()); return 1; });
  u.fn("BlockInput", () => 1);
  u.fn("EnableMouseInPointer", () => 1);
  u.fn("GetPointerType", () => 0);
  u.fn("RegisterTouchWindow", () => 1);
  u.fn("IsTouchWindow", () => 0);
  u.fn("GetTouchInputInfo", () => 0);
  u.fn("CloseTouchInputHandle", () => 1);
  u.fn("GetSystemMetricsForDpi", (c) => ws.metric(c.argI(0)));
  u.fn("mouse_event", (c) => {
    const fl = c.arg(0), dx = c.argI(1), dy = c.argI(2), data = c.argI(3);
    if (fl & 1) ws.handleHostEvent({ t: "mouse", x: fl & 0x8000 ? (dx * ws.sw) / 65535 : ws.cursorX + dx, y: fl & 0x8000 ? (dy * ws.sh) / 65535 : ws.cursorY + dy, dx, dy, locked: !(fl & 0x8000) });
    const btn = (mask: number, b: 0 | 1 | 2, down: boolean) => { if (fl & mask) ws.handleHostEvent({ t: "button", btn: b, down, x: ws.cursorX, y: ws.cursorY }); };
    btn(2, 0, true); btn(4, 0, false); btn(8, 2, true); btn(0x10, 2, false); btn(0x20, 1, true); btn(0x40, 1, false);
    if (fl & 0x800) ws.handleHostEvent({ t: "wheel", delta: data, x: ws.cursorX, y: ws.cursorY });
  });
  u.fn("keybd_event", (c) => { ws.handleHostEvent({ t: "key", down: !(c.arg(2) & 2), vk: c.arg(0) & 0xff, scan: c.arg(1) & 0xff, ext: (c.arg(2) & 1) !== 0 }); });
  u.fn("SendInput", (c) => {
    const n = c.arg(0), a = c.arg(1), cb = c.arg(2);
    for (let i = 0; i < n; i++) {
      const o = a + i * cb, type = mem.r32(o);
      if (type === 0) {
        const dx = mem.ri32(o + 8), dy = mem.ri32(o + 12), data = mem.ri32(o + 16), fl = mem.r32(o + 20);
        if (fl & 1) { const abs = (fl & 0x8000) !== 0; ws.handleHostEvent({ t: "mouse", x: abs ? (dx * ws.sw) / 65535 : ws.cursorX + dx, y: abs ? (dy * ws.sh) / 65535 : ws.cursorY + dy, dx, dy, locked: !abs }); }
        const btn = (mask: number, b: 0 | 1 | 2, down: boolean) => { if (fl & mask) ws.handleHostEvent({ t: "button", btn: b, down, x: ws.cursorX, y: ws.cursorY }); };
        btn(2, 0, true); btn(4, 0, false); btn(8, 2, true); btn(0x10, 2, false); btn(0x20, 1, true); btn(0x40, 1, false);
        if (fl & 0x800) ws.handleHostEvent({ t: "wheel", delta: data, x: ws.cursorX, y: ws.cursorY });
      } else if (type === 1) {
        const vk = mem.r16(o + 8), scan = mem.r16(o + 10), fl = mem.r32(o + 12);
        ws.handleHostEvent({ t: "key", down: !(fl & 2), vk: (fl & 8) ? scanToVk(scan) : vk, scan, ext: (fl & 1) !== 0 });
      }
    }
    return n;
  });
  // raw input
  u.fn("RegisterRawInputDevices", (c) => {
    const a = c.arg(0), n = c.arg(1), cb = c.arg(2);
    for (let i = 0; i < n; i++) {
      const o = a + i * cb;
      const d = { usagePage: mem.r16(o), usage: mem.r16(o + 2), flags: mem.r32(o + 4), hwnd: mem.r32(o + 8) };
      ws.rawDevices = ws.rawDevices.filter((x) => !(x.usagePage === d.usagePage && x.usage === d.usage));
      if (!(d.flags & 1)) ws.rawDevices.push(d); // RIDEV_REMOVE
    }
    return 1;
  });
  u.fn("GetRegisteredRawInputDevices", (c) => {
    const n = ws.rawDevices.length;
    if (!c.arg(0)) { mem.w32(c.arg(1), n); return 0; }
    ws.rawDevices.forEach((d, i) => { const o = c.arg(0) + i * 16; mem.w16(o, d.usagePage); mem.w16(o + 2, d.usage); mem.w32(o + 4, d.flags); mem.wptr(o + 8, d.hwnd); });
    return n;
  });
  u.fn("GetRawInputDeviceList", (c) => {
    if (!c.arg(0)) { mem.w32(c.arg(1), 2); return 0; }
    // two devices: mouse (type 0) and keyboard (type 1)
    mem.wptr(c.arg(0), 0x1001); mem.w32(c.arg(0) + 8, 0); mem.wptr(c.arg(0) + 16, 0x1002); mem.w32(c.arg(0) + 24, 1);
    return 2;
  });
  u.fn("GetRawInputDeviceInfoW", (c) => {
    const cmd = c.arg(1);
    if (cmd === 0x20000007) { if (c.arg(2)) mem.wwstr(c.arg(2), "\\\\?\\HID#VID_0000&PID_0000"); mem.w32(c.arg(3), 26); return 26; }
    if (c.arg(2) && cmd === 0x2000000b) { const o = c.arg(2); mem.w32(o, 32); mem.w32(o + 4, c.arg(0) === 0x1001 ? 0 : 1); if (c.arg(0) === 0x1001) { mem.w32(o + 8, 1); mem.w32(o + 12, 5); mem.w32(o + 16, 8); mem.w32(o + 20, 0); } else { mem.w32(o + 8, 4); mem.w32(o + 12, 0); mem.w32(o + 16, 12); mem.w32(o + 20, 12); mem.w32(o + 24, 12); } }
    if (c.arg(3)) mem.w32(c.arg(3), 32);
    return 32;
  });
  u.fn("GetRawInputDeviceInfoA", () => 0);
  u.fn("GetRawInputData", (c) => {
    const h = c.arg(0), cmd = c.arg(1), out = c.arg(2), psz = c.arg(3);
    const m = ws.rawQueue.get(h);
    if (!m || !m.raw) { setErr(ERROR.INVALID_HANDLE); return 0xffffffff; }
    const total = m.raw.kind === "mouse" ? 48 : 40;
    if (cmd === 0x10000005) { // RID_HEADER
      if (!out) { mem.w32(psz, 24); return 0; }
    }
    if (!out) { mem.w32(psz, total); return 0; }
    if (mem.r32(psz) < total) { mem.w32(psz, total); setErr(ERROR.INSUFFICIENT_BUFFER); return 0xffffffff; }
    mem.fill(out, 0, total);
    mem.w32(out, m.raw.kind === "mouse" ? 0 : 1); mem.w32(out + 4, total); mem.wptr(out + 8, m.raw.kind === "mouse" ? 0x1001 : 0x1002); mem.wptr(out + 16, 0);
    if (m.raw.kind === "mouse") {
      mem.w16(out + 24, 0); mem.w16(out + 28, m.raw.buttonFlags); mem.w16(out + 30, m.raw.buttonData);
      mem.w32(out + 36, m.raw.dx); mem.w32(out + 40, m.raw.dy);
    } else {
      mem.w16(out + 24, m.raw.scan); mem.w16(out + 26, m.raw.flags); mem.w16(out + 30, m.raw.vk); mem.w32(out + 32, m.raw.message);
    }
    mem.w32(psz, total);
    return total;
  });
  u.fn("GetRawInputBuffer", () => 0);
  u.fn("DefRawInputProc", () => 0);

  // ---- system information ----------------------------------------------------------------------
  u.fn("GetSystemMetrics", (c) => ws.metric(c.argI(0)));
  u.fn("GetSysColor", (c) => { const v = gdi.sysColor(c.argI(0)); return ((v & 0xff) << 16) | (v & 0xff00) | (v >> 16); });
  u.fn("GetSysColorBrush", (c) => { const col = gdi.sysColor(c.argI(0)); return gdi.alloc({ type: "brush", style: 0, color: col, hatch: 0, pattern: null }); });
  u.fn("SetSysColors", () => 1);
  u.fn("SystemParametersInfoW", (c) => spi(c, true));
  u.fn("SystemParametersInfoA", (c) => spi(c, false));
  const spi = (c: Cpu, wide: boolean): number => {
    const act = c.arg(0), ui = c.arg(1), pv = c.arg(2);
    void wide;
    switch (act) {
      case 0x30: wrRect(pv, { l: 0, t: 0, r: ws.sw, b: ws.sh - 40 }); return 1; // SPI_GETWORKAREA
      case 0x01: case 0x0a: case 0x0e: return 1;
      case 0x04: return 1;
      case 0x0d: return 1;
      case 0x61: mem.w32(pv, 1); return 1; // SPI_GETACTIVEWINDOWTRACKING etc
      case 0x66: mem.w32(pv, 0); return 1;
      case 0x0b: mem.w32(pv, 500); return 1; // keyboard delay
      case 0x0a + 0x0: return 1;
      case 0x0003: mem.w32(pv, 6); mem.w32(pv + 4, 10); mem.w32(pv + 8, 1); return 1; // SPI_GETMOUSE
      case 0x0070: mem.w32(pv, 10); return 1;
      case 0x0072: mem.w32(pv, 3); return 1;
      case 0x0047: return 1;
      case 0x0010: case 0x0011: mem.w32(pv, 0); return 1;
      case 0x0014: case 0x0015: return 1;
      case 0x0016: mem.w32(pv, 0); return 1;
      case 0x0012: return 1;
      case 0x0029: { // SPI_GETNONCLIENTMETRICS
        mem.fill(pv, 0, ui); mem.w32(pv, ui); mem.w32(pv + 4, 1); mem.w32(pv + 8, 17); mem.w32(pv + 12, 17); mem.w32(pv + 16, 23); mem.w32(pv + 20, 23); return 1;
      }
      case 0x0049: mem.w32(pv, 0); return 1;
      case 0x0098: return 1;
      case 0x1000: case 0x1002: case 0x1004: case 0x1006: case 0x1008: case 0x100a: case 0x100c: case 0x1012: case 0x101a: case 0x1022: mem.w32(pv, 0); return 1;
      case 0x1001: case 0x1003: case 0x1005: case 0x1007: case 0x1009: case 0x100b: case 0x100d: case 0x1013: return 1;
      case 0x1010: mem.w32(pv, 1); return 1;
      case 0x101c: mem.w32(pv, 500); return 1; // SPI_GETKEYBOARDDELAY? approx
      default: return 1;
    }
  };
  u.fn("GetMonitorInfoA", (c) => monInfo(c, false));
  u.fn("GetMonitorInfoW", (c) => monInfo(c, true));
  const monInfo = (c: Cpu, wide: boolean) => {
    const a = c.arg(1), cb = mem.r32(a);
    wrRect(a + 4, { l: 0, t: 0, r: ws.sw, b: ws.sh }); wrRect(a + 20, { l: 0, t: 0, r: ws.sw, b: ws.sh - 40 }); mem.w32(a + 36, 1);
    if (cb >= 72) { if (wide) mem.wwstr(a + 40, "\\\\.\\DISPLAY1", 32); else mem.wcstr(a + 40, "\\\\.\\DISPLAY1", 32); }
    return 1;
  };
  u.fn("MonitorFromWindow", () => 0x7001);
  u.fn("MonitorFromPoint", () => 0x7001);
  u.fn("MonitorFromRect", () => 0x7001);
  u.fn("EnumDisplayMonitors", (c) => {
    const proc = c.arg(2);
    const rc = p.vm.alloc(0x1000, { commit: true });
    wrRect(rc, { l: 0, t: 0, r: ws.sw, b: ws.sh });
    const r = p.callGuest(proc, [0x7001, c.arg(0), rc, c.arg64(3)]);
    p.vm.release(rc);
    return Number(r & 0xffffffffn) ? 1 : 0;
  });
  // display modes
  const modes: [number, number][] = [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1366, 768], [1600, 900], [1920, 1080]];
  const fillDevMode = (a: number, w: number, h: number, wide: boolean) => {
    const sz = wide ? 220 : 156;
    mem.fill(a, 0, sz);
    const nm = "Display";
    if (wide) mem.wwstr(a, nm, 32); else mem.wcstr(a, nm, 32);
    const base = wide ? 0 : -32; // ANSI device names are 32 bytes, the rest shifts back by 32
    mem.w16(a + 64 + base, 0x401); mem.w16(a + 68 + base, sz); mem.w32(a + 72 + base, 0x5c0000 | 0x80000 | 0x100000 | 0x400000 | 0x20000);
    // dmFields: bits per pel, width, height, frequency
    mem.w32(a + 72 + base, 0x00040000 | 0x00080000 | 0x00100000 | 0x00400000);
    const o = wide ? 168 : 168 - 32 - 32 + 32;
    void o;
    const bp = wide ? 168 : 104 + 32 + 4; // see below; computed per layout
    void bp;
    // DEVMODEW offsets: bpp 168, width 172, height 176, frequency 184. DEVMODEA: names are 32 bytes so offsets are 32 (+32) smaller for the name and 32 smaller for dmFormName
    const off = wide ? 0 : -64;
    mem.w32(a + 168 + off, 32); mem.w32(a + 172 + off, w); mem.w32(a + 176 + off, h); mem.w32(a + 184 + off, ws.host.refreshRate);
  };
  const enumDisplaySettings = (c: Cpu, wide: boolean) => {
    const i = c.argI(1);
    if (i === -1 || i === -2) { fillDevMode(c.arg(2), ws.sw, ws.sh, wide); return 1; }
    const list = [...modes.filter(([w, h]) => w <= ws.sw && h <= ws.sh)];
    if (!list.some(([w, h]) => w === ws.sw && h === ws.sh)) list.push([ws.sw, ws.sh]);
    if (i >= list.length) return 0;
    fillDevMode(c.arg(2), list[i][0], list[i][1], wide);
    return 1;
  };
  u.fn("EnumDisplaySettingsA", (c) => enumDisplaySettings(c, false));
  u.fn("EnumDisplaySettingsW", (c) => enumDisplaySettings(c, true));
  u.fn("EnumDisplaySettingsExA", (c) => enumDisplaySettings(c, false));
  u.fn("EnumDisplaySettingsExW", (c) => enumDisplaySettings(c, true));
  const changeDisplay = (c: Cpu, wide: boolean, ex: boolean) => {
    const dm = c.arg(ex ? 1 : 0);
    if (dm) {
      const off = wide ? 0 : -64;
      const w = mem.r32(dm + 172 + off), h = mem.r32(dm + 176 + off);
      if (w && h && (w !== ws.host.screenWidth || h !== ws.host.screenHeight)) {
        // exclusive fullscreen mode switch: the emulated screen takes the requested size
        ws.host.screenWidth = w; ws.host.screenHeight = h; ws.desktop.w = w; ws.desktop.h = h;
        for (const h2 of [...ws.zorder]) ws.send(h2, WM.DISPLAYCHANGE, 32, BigInt((h << 16) | w));
      }
    }
    return 0; // DISP_CHANGE_SUCCESSFUL
  };
  u.fn("ChangeDisplaySettingsA", (c) => changeDisplay(c, false, false));
  u.fn("ChangeDisplaySettingsW", (c) => changeDisplay(c, true, false));
  u.fn("ChangeDisplaySettingsExA", (c) => changeDisplay(c, false, true));
  u.fn("ChangeDisplaySettingsExW", (c) => changeDisplay(c, true, true));
  const enumDisplayDevices = (c: Cpu, wide: boolean) => {
    const idx = c.arg(1), a = c.arg(2);
    if (idx > 0) return 0;
    mem.fill(a + 4, 0, 4);
    if (wide) { mem.w32(a, 840); mem.wwstr(a + 4, c.arg(0) ? "\\\\.\\DISPLAY1\\Monitor0" : "\\\\.\\DISPLAY1", 32); mem.wwstr(a + 68, "Chrome.EXE Virtual Display", 128); mem.w32(a + 324, 5); }
    else { mem.w32(a, 424); mem.wcstr(a + 4, c.arg(0) ? "\\\\.\\DISPLAY1\\Monitor0" : "\\\\.\\DISPLAY1", 32); mem.wcstr(a + 36, "Chrome.EXE Virtual Display", 128); mem.w32(a + 164, 5); }
    return 1;
  };
  u.fn("EnumDisplayDevicesA", (c) => enumDisplayDevices(c, false));
  u.fn("EnumDisplayDevicesW", (c) => enumDisplayDevices(c, true));
  u.fn("GetDpiForSystem", () => ws.dpi);
  u.fn("GetDpiForWindow", () => ws.dpi);
  u.fn("GetSystemDpiForProcess", () => ws.dpi);
  u.fn("SetProcessDPIAware", () => { ws.dpiAware = true; return 1; });
  u.fn("IsProcessDPIAware", () => bool(ws.dpiAware));
  u.fn("SetProcessDpiAwarenessContext", () => { ws.dpiAware = true; return 1; });
  u.fn("SetThreadDpiAwarenessContext", () => 0x12);
  u.fn("GetThreadDpiAwarenessContext", () => 0x12);
  u.fn("GetAwarenessFromDpiAwarenessContext", () => 2);
  u.fn("AreDpiAwarenessContextsEqual", () => 1);
  u.fn("IsValidDpiAwarenessContext", () => 1);
  u.fn("EnableNonClientDpiScaling", () => 1);
  u.fn("GetDisplayConfigBufferSizes", (c) => { mem.w32(c.arg(1), 0); mem.w32(c.arg(2), 0); return 0; });
  u.fn("QueryDisplayConfig", () => 87);
  u.fn("DisplayConfigGetDeviceInfo", () => 87);
  u.fn("GetAutoRotationState", () => 0);
  u.fn("SetProcessRestrictionExemption", () => 1);
  u.fn("SoundSentry", () => 1);
  u.fn("IsWinEventHookInstalled", () => 0);
  u.fn("SetGestureConfig", () => 1);
  u.fn("GetForegroundWindowInfo", () => 0);
  u.fn("UserHandleGrantAccess", () => 1);
  u.fn("GetProcessDefaultLayout", (c) => { mem.w32(c.arg(0), 0); return 1; });
  u.fn("GetGuiResources", () => 0);
  u.fn("SetThreadDpiHostingBehavior", () => 0);

  // ---- messages boxes / dialogs ----------------------------------------------------------------
  const messageBox = (c: Cpu, wide: boolean) => {
    const text = c.arg(1) ? str(c.arg(1), wide) : "", title = c.arg(2) ? str(c.arg(2), wide) : "", type = c.arg(3);
    p.log(`[user32] MessageBox: ${title}: ${text}`);
    return p.host.messageBox ? p.host.messageBox(title, text, type) : (type & 0xf) === 4 ? 6 : (type & 0xf) === 1 ? 1 : 1;
  };
  u.fn("MessageBoxA", (c) => messageBox(c, false));
  u.fn("MessageBoxW", (c) => messageBox(c, true));
  u.fn("MessageBoxExA", (c) => messageBox(c, false));
  u.fn("MessageBoxExW", (c) => messageBox(c, true));
  u.fn("MessageBoxTimeoutA", (c) => messageBox(c, false));
  u.fn("MessageBoxTimeoutW", (c) => messageBox(c, true));
  u.fn("MessageBoxIndirectA", () => 1);
  u.fn("MessageBoxIndirectW", () => 1);
  u.fn("MessageBeep", () => 1);
  u.fn("DialogBoxParamA", () => -1);
  u.fn("DialogBoxParamW", () => -1);
  u.fn("DialogBoxIndirectParamA", () => -1);
  u.fn("DialogBoxIndirectParamW", () => -1);
  u.fn("CreateDialogParamA", () => 0);
  u.fn("CreateDialogParamW", () => 0);
  u.fn("CreateDialogIndirectParamA", () => 0);
  u.fn("CreateDialogIndirectParamW", () => 0);
  u.fn("EndDialog", () => 1);
  u.fn("IsDialogMessageA", () => 0);
  u.fn("IsDialogMessageW", () => 0);
  u.fn("SetDlgItemTextA", () => 1);
  u.fn("SetDlgItemTextW", () => 1);
  u.fn("GetDlgItemTextA", () => 0);
  u.fn("GetDlgItemTextW", () => 0);
  u.fn("CheckDlgButton", () => 1);
  u.fn("CheckRadioButton", () => 1);
  u.fn("IsDlgButtonChecked", () => 0);
  u.fn("GetDialogBaseUnits", () => 0x0008_0004 | 0);
  u.fn("MapDialogRect", () => 1);
  u.fn("SetFocus_", () => 0);

  // ---- menus (structure only; no rendering) ---------------------------------------------------
  let nextMenu = 0x8000;
  const menus = new Map<number, { items: { id: number; text: string; flags: number; sub: number }[] }>();
  const newMenu = () => { const h = nextMenu; nextMenu += 4; menus.set(h, { items: [] }); return h; };
  u.fn("CreateMenu", newMenu);
  u.fn("CreatePopupMenu", newMenu);
  u.fn("DestroyMenu", (c) => bool(menus.delete(c.arg(0))));
  u.fn("SetMenu", (c) => { const x = W(c.arg(0)); if (x) { x.menu = c.arg(1); ws.notifyHost(x); } return 1; });
  u.fn("GetMenu", (c) => W(c.arg(0))?.menu ?? 0);
  u.fn("GetSubMenu", (c) => menus.get(c.arg(0))?.items[c.argI(1)]?.sub ?? 0);
  u.fn("GetMenuItemCount", (c) => menus.get(c.arg(0))?.items.length ?? -1);
  u.fn("GetMenuItemID", (c) => menus.get(c.arg(0))?.items[c.argI(1)]?.id ?? -1);
  u.fn("GetMenuState", () => 0);
  u.fn("GetMenuStringA", () => 0);
  u.fn("GetMenuStringW", () => 0);
  const appendMenu = (c: Cpu, wide: boolean) => {
    const m = menus.get(c.arg(0)); if (!m) return 0;
    const flags = c.arg(1), id = c.argN(2);
    m.items.push({ id: flags & 0x10 ? 0 : id, text: flags & 0x1100 ? "" : c.arg(3) ? str(c.arg(3), wide) : "", flags, sub: flags & 0x10 ? id : 0 });
    return 1;
  };
  u.fn("AppendMenuA", (c) => appendMenu(c, false));
  u.fn("AppendMenuW", (c) => appendMenu(c, true));
  const insertMenu = (c: Cpu, wide: boolean) => {
    const m = menus.get(c.arg(0)); if (!m) return 0;
    const flags = c.arg(2), id = c.argN(3);
    const pos = c.argI(1);
    const it = { id: flags & 0x10 ? 0 : id, text: flags & 0x1100 ? "" : c.arg(4) ? str(c.arg(4), wide) : "", flags, sub: flags & 0x10 ? id : 0 };
    if (pos < 0 || pos > m.items.length) m.items.push(it); else m.items.splice(pos, 0, it);
    return 1;
  };
  u.fn("InsertMenuA", (c) => insertMenu(c, false));
  u.fn("InsertMenuW", (c) => insertMenu(c, true));
  u.fn("InsertMenuItemA", () => 1);
  u.fn("InsertMenuItemW", () => 1);
  u.fn("RemoveMenu", () => 1);
  u.fn("DeleteMenu", () => 1);
  u.fn("ModifyMenuA", () => 1);
  u.fn("ModifyMenuW", () => 1);
  u.fn("EnableMenuItem", () => 0);
  u.fn("CheckMenuItem", () => 0);
  u.fn("CheckMenuRadioItem", () => 1);
  u.fn("SetMenuItemInfoA", () => 1);
  u.fn("SetMenuItemInfoW", () => 1);
  u.fn("GetMenuItemInfoA", () => 0);
  u.fn("GetMenuItemInfoW", () => 0);
  u.fn("SetMenuDefaultItem", () => 1);
  u.fn("GetMenuDefaultItem", () => -1);
  u.fn("DrawMenuBar", () => 1);
  u.fn("HiliteMenuItem", () => 1);
  u.fn("TrackPopupMenu", () => 0);
  u.fn("TrackPopupMenuEx", () => 0);
  u.fn("GetSystemMenu", (c) => (c.arg(1) ? 0 : newMenu()));
  u.fn("EnableMenuItem_", () => 0);
  u.fn("LoadMenuA", () => newMenu());
  u.fn("LoadMenuW", () => newMenu());
  u.fn("LoadMenuIndirectA", () => newMenu());
  u.fn("LoadMenuIndirectW", () => newMenu());
  u.fn("SetMenuInfo", () => 1);
  u.fn("GetMenuInfo", () => 0);
  u.fn("IsMenu", (c) => bool(menus.has(c.arg(0))));
  u.fn("LoadAcceleratorsA", () => 0x9001);
  u.fn("LoadAcceleratorsW", () => 0x9001);
  u.fn("CreateAcceleratorTableA", () => 0x9001);
  u.fn("CreateAcceleratorTableW", () => 0x9001);
  u.fn("DestroyAcceleratorTable", () => 1);
  u.fn("TranslateAcceleratorA", () => 0);
  u.fn("TranslateAcceleratorW", () => 0);

  // ---- icons / cursors / images ----------------------------------------------------------------
  let nextIcon = 0x7e000100;
  u.fn("LoadCursorA", (c) => 0x7e000000 + (c.arg(1) < 0x10000 ? c.arg(1) : 0x7f));
  u.fn("LoadCursorW", (c) => 0x7e000000 + (c.arg(1) < 0x10000 ? c.arg(1) : 0x7f));
  u.fn("LoadCursorFromFileA", () => nextIcon++);
  u.fn("LoadCursorFromFileW", () => nextIcon++);
  u.fn("LoadIconA", (c) => (c.arg(1) < 0x10000 ? 0x7e100000 + c.arg(1) : nextIcon++));
  u.fn("LoadIconW", (c) => (c.arg(1) < 0x10000 ? 0x7e100000 + c.arg(1) : nextIcon++));
  u.fn("CreateIcon", () => nextIcon++);
  u.fn("CreateIconIndirect", () => nextIcon++);
  u.fn("CreateIconFromResource", () => nextIcon++);
  u.fn("CreateIconFromResourceEx", () => nextIcon++);
  u.fn("CreateCursor", () => nextIcon++);
  u.fn("CopyIcon", (c) => c.arg(0));
  u.fn("CopyCursor", (c) => c.arg(0));
  u.fn("DestroyIcon", () => 1);
  u.fn("DestroyCursor", () => 1);
  u.fn("GetIconInfo", (c) => { const a = c.arg(1); mem.w32(a, 1); mem.w32(a + 4, 0); mem.w32(a + 8, 0); mem.wptr(a + 16, 0); mem.wptr(a + 24, 0); return 1; });
  u.fn("GetIconInfoExA", () => 0);
  u.fn("GetIconInfoExW", () => 0);
  u.fn("DrawIcon", () => 1);
  u.fn("DrawIconEx", () => 1);
  u.fn("LookupIconIdFromDirectory", () => 1);
  u.fn("LookupIconIdFromDirectoryEx", () => 1);
  u.fn("SetSystemCursor", () => 1);
  u.fn("SetCaretPos", () => 1);
  u.fn("CreateCaret", () => 1);
  u.fn("DestroyCaret", () => 1);
  u.fn("ShowCaret", () => 1);
  u.fn("HideCaret", () => 1);
  u.fn("GetCaretPos", (c) => { mem.w32(c.arg(0), 0); mem.w32(c.arg(0) + 4, 0); return 1; });
  const loadImage = (c: Cpu, wide: boolean): number => {
    const hinst = c.arg(0), name = c.arg(1), type = c.arg(2), cx = c.argI(3), cy = c.argI(4), flags = c.arg(5);
    if (type === 1 || type === 2) return type === 2 ? 0x7e000000 + (name < 0x10000 ? name : 0x7f) : name < 0x10000 ? 0x7e100000 + name : nextIcon++;
    // IMAGE_BITMAP
    let data: Uint8Array | null = null;
    if (flags & 0x10) { data = p.vfs.readAll(wide ? mem.wstr(name) : mem.cstr(name)); }
    else {
      const m = hinst ? p.moduleByHandle(hinst) : p.exe;
      if (m) { const r = p.findResource(m, 2, name < 0x10000 ? name : (wide ? mem.wstr(name) : mem.cstr(name))); if (r) data = new Uint8Array(14 + r.size), data.set([0x42, 0x4d], 0), data.set(mem.bytes(r.addr, r.size), 14); }
    }
    if (!data || data.length < 54) { setErr(ERROR.FILE_NOT_FOUND); return 0; }
    return bitmapFromBmpFile(data, cx, cy);
  };
  /** build an HBITMAP (a DIB section in guest memory) from an in-memory .bmp file image */
  const bitmapFromBmpFile = (data: Uint8Array, _cx = 0, _cy = 0): number => {
    const tmp = p.vm.alloc(Math.max(data.length, 0x1000), { commit: true, tag: "bmp" });
    mem.write(tmp, data);
    const bi = tmp + 14;
    const info = gdi.parseBitmapInfo(bi);
    const offBits = new DataView(data.buffer, data.byteOffset).getUint32(10, true) || 14 + info.headerSize + (info.palette ? info.palette.length * 4 : 0);
    const bits = info.w * 4; void bits;
    const bmp = new Bmp(p, info.w, info.h, info.bpp === 32 ? 32 : info.bpp, info.topDown);
    bmp.palette = info.palette;
    bmp.isDib = true;
    const src = data.subarray(offBits);
    bmp.buf = new Uint8Array(bmp.stride * info.h);
    bmp.buf.set(src.subarray(0, Math.min(src.length, bmp.buf.length)));
    p.vm.release(tmp);
    return gdi.alloc({ type: "bitmap", bmp });
  };
  u.fn("LoadImageA", (c) => loadImage(c, false));
  u.fn("LoadImageW", (c) => loadImage(c, true));
  u.fn("LoadBitmapA", (c) => loadImage({ arg: (i: number) => [c.arg(0), c.arg(1), 0, 0, 0, 0][i] } as any, false));
  u.fn("LoadBitmapW", (c) => loadImage({ arg: (i: number) => [c.arg(0), c.arg(1), 0, 0, 0, 0][i], argI: (i: number) => 0 } as any, true));
  u.fn("CopyImage", (c) => c.arg(0));
  u.fn("LoadStringW", (c) => {
    const m = c.arg(0) ? p.moduleByHandle(c.arg(0)) : p.exe;
    const id = c.arg(1), buf = c.arg(2), cch = c.argI(3);
    const s = m ? p.loadString(m, id) : null;
    if (s === null) return 0;
    if (cch === 0) { // return a read-only pointer to the string itself
      const r = p.findResource(m!, 6, (id >> 4) + 1)!;
      let a = r.addr; for (let i = 0; i < (id & 15); i++) a += 2 + mem.r16(a) * 2;
      mem.wptr(buf, a + 2); return s.length;
    }
    if (cch <= 0) return 0;
    const n = Math.min(s.length, cch - 1);
    mem.wwstr(buf, s.slice(0, n), cch);
    return n;
  });
  u.fn("LoadStringA", (c) => {
    const m = c.arg(0) ? p.moduleByHandle(c.arg(0)) : p.exe;
    const s = m ? p.loadString(m, c.arg(1)) : null;
    if (s === null) return 0;
    const cch = c.argI(3);
    if (cch <= 0) return 0;
    const n = Math.min(s.length, cch - 1);
    mem.wcstr(c.arg(2), s.slice(0, n), cch);
    return n;
  });

  // ---- clipboard -------------------------------------------------------------------------------
  let clipOpen = false;
  const clip = new Map<number, number>();
  u.fn("OpenClipboard", () => { clipOpen = true; return 1; });
  u.fn("CloseClipboard", () => { clipOpen = false; return 1; });
  u.fn("EmptyClipboard", () => { clip.clear(); return 1; });
  u.fn("SetClipboardData", (c) => { clip.set(c.arg(0), c.arg(1)); if (c.arg(0) === 13 && c.arg(1)) p.host.writeClipboard?.(mem.wstr(c.arg(1))); else if (c.arg(0) === 1 && c.arg(1)) p.host.writeClipboard?.(mem.cstr(c.arg(1))); return c.arg(1); });
  u.fn("GetClipboardData", (c) => {
    const have = clip.get(c.arg(0));
    if (have) return have;
    const t = p.host.readClipboard?.();
    if (t && (c.arg(0) === 13 || c.arg(0) === 1)) {
      const buf = p.vm.alloc(0x1000 + t.length * 2, { commit: true, tag: "clipboard" });
      if (c.arg(0) === 13) mem.wwstr(buf, t); else mem.wcstr(buf, t);
      clip.set(c.arg(0), buf);
      return buf;
    }
    return 0;
  });
  u.fn("IsClipboardFormatAvailable", (c) => bool(clip.has(c.arg(0)) || ((c.arg(0) === 13 || c.arg(0) === 1) && !!p.host.readClipboard?.())));
  u.fn("CountClipboardFormats", () => clip.size);
  u.fn("EnumClipboardFormats", () => 0);
  u.fn("GetClipboardOwner", () => 0);
  u.fn("GetClipboardSequenceNumber", () => 1);
  u.fn("RegisterClipboardFormatA", (c) => regMsg("cf:" + mem.cstr(c.arg(0))));
  u.fn("RegisterClipboardFormatW", (c) => regMsg("cf:" + mem.wstr(c.arg(0))));
  u.fn("AddClipboardFormatListener", () => 1);
  u.fn("RemoveClipboardFormatListener", () => 1);
  u.fn("SetClipboardViewer", () => 0);
  u.fn("ChangeClipboardChain", () => 1);

  // ---- rect / point helpers --------------------------------------------------------------------
  u.fn("SetRect", (c) => { wrRect(c.arg(0), { l: c.argI(1), t: c.argI(2), r: c.argI(3), b: c.argI(4) }); return 1; });
  u.fn("SetRectEmpty", (c) => { wrRect(c.arg(0), { l: 0, t: 0, r: 0, b: 0 }); return 1; });
  u.fn("CopyRect", (c) => { wrRect(c.arg(0), rdRect(c.arg(1))); return 1; });
  u.fn("InflateRect", (c) => { const r = rdRect(c.arg(0)); wrRect(c.arg(0), { l: r.l - c.argI(1), t: r.t - c.argI(2), r: r.r + c.argI(1), b: r.b + c.argI(2) }); return 1; });
  u.fn("OffsetRect", (c) => { const r = rdRect(c.arg(0)); wrRect(c.arg(0), { l: r.l + c.argI(1), t: r.t + c.argI(2), r: r.r + c.argI(1), b: r.b + c.argI(2) }); return 1; });
  u.fn("IsRectEmpty", (c) => { const r = rdRect(c.arg(0)); return bool(r.r <= r.l || r.b <= r.t); });
  u.fn("EqualRect", (c) => { const a = rdRect(c.arg(0)), b = rdRect(c.arg(1)); return bool(a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b); });
  u.fn("PtInRect", (c) => { const r = rdRect(c.arg(0)); const x = c.argI(1), y = c.argI(2); return bool(x >= r.l && x < r.r && y >= r.t && y < r.b); });
  u.fn("IntersectRect", (c) => {
    const a = rdRect(c.arg(1)), b = rdRect(c.arg(2));
    const r = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
    if (r.r <= r.l || r.b <= r.t) { wrRect(c.arg(0), { l: 0, t: 0, r: 0, b: 0 }); return 0; }
    wrRect(c.arg(0), r); return 1;
  });
  u.fn("UnionRect", (c) => {
    const a = rdRect(c.arg(1)), b = rdRect(c.arg(2));
    const ea = a.r <= a.l || a.b <= a.t, eb = b.r <= b.l || b.b <= b.t;
    if (ea && eb) { wrRect(c.arg(0), { l: 0, t: 0, r: 0, b: 0 }); return 0; }
    wrRect(c.arg(0), ea ? b : eb ? a : { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });
    return 1;
  });
  u.fn("SubtractRect", (c) => { wrRect(c.arg(0), rdRect(c.arg(1))); return 1; });

  // ---- char functions --------------------------------------------------------------------------
  const charUp = (ch: number) => (ch >= 97 && ch <= 122 ? ch - 32 : ch);
  const charLow = (ch: number) => (ch >= 65 && ch <= 90 ? ch + 32 : ch);
  u.fn("CharUpperA", (c) => { if (c.arg(0) < 0x10000) return charUp(c.arg(0) & 0xff); let a = c.arg(0); while (mem.r8(a)) { mem.w8(a, charUp(mem.r8(a))); a++; } return c.arg(0); });
  u.fn("CharLowerA", (c) => { if (c.arg(0) < 0x10000) return charLow(c.arg(0) & 0xff); let a = c.arg(0); while (mem.r8(a)) { mem.w8(a, charLow(mem.r8(a))); a++; } return c.arg(0); });
  u.fn("CharUpperW", (c) => { if (c.arg(0) < 0x10000) return String.fromCharCode(c.arg(0)).toUpperCase().charCodeAt(0); let a = c.arg(0); while (mem.r16(a)) { mem.w16(a, String.fromCharCode(mem.r16(a)).toUpperCase().charCodeAt(0)); a += 2; } return c.arg(0); });
  u.fn("CharLowerW", (c) => { if (c.arg(0) < 0x10000) return String.fromCharCode(c.arg(0)).toLowerCase().charCodeAt(0); let a = c.arg(0); while (mem.r16(a)) { mem.w16(a, String.fromCharCode(mem.r16(a)).toLowerCase().charCodeAt(0)); a += 2; } return c.arg(0); });
  u.fn("CharUpperBuffA", (c) => { for (let i = 0; i < c.arg(1); i++) mem.w8(c.arg(0) + i, charUp(mem.r8(c.arg(0) + i))); return c.arg(1); });
  u.fn("CharLowerBuffA", (c) => { for (let i = 0; i < c.arg(1); i++) mem.w8(c.arg(0) + i, charLow(mem.r8(c.arg(0) + i))); return c.arg(1); });
  u.fn("CharUpperBuffW", (c) => { for (let i = 0; i < c.arg(1); i++) mem.w16(c.arg(0) + i * 2, String.fromCharCode(mem.r16(c.arg(0) + i * 2)).toUpperCase().charCodeAt(0)); return c.arg(1); });
  u.fn("CharLowerBuffW", (c) => { for (let i = 0; i < c.arg(1); i++) mem.w16(c.arg(0) + i * 2, String.fromCharCode(mem.r16(c.arg(0) + i * 2)).toLowerCase().charCodeAt(0)); return c.arg(1); });
  u.fn("CharNextA", (c) => (mem.r8(c.arg(0)) ? c.arg(0) + 1 : c.arg(0)));
  u.fn("CharNextW", (c) => (mem.r16(c.arg(0)) ? c.arg(0) + 2 : c.arg(0)));
  u.fn("CharPrevA", (c) => (c.arg(1) > c.arg(0) ? c.arg(1) - 1 : c.arg(0)));
  u.fn("CharPrevW", (c) => (c.arg(1) > c.arg(0) ? c.arg(1) - 2 : c.arg(0)));
  u.fn("CharNextExA", (c) => (mem.r8(c.arg(1)) ? c.arg(1) + 1 : c.arg(1)));
  u.fn("CharPrevExA", (c) => (c.arg(2) > c.arg(1) ? c.arg(2) - 1 : c.arg(1)));
  u.fn("IsCharAlphaA", (c) => bool(/[A-Za-z]/.test(String.fromCharCode(c.arg(0) & 0xff))));
  u.fn("IsCharAlphaW", (c) => bool(/\p{L}/u.test(String.fromCharCode(c.arg(0) & 0xffff))));
  u.fn("IsCharAlphaNumericA", (c) => bool(/[A-Za-z0-9]/.test(String.fromCharCode(c.arg(0) & 0xff))));
  u.fn("IsCharAlphaNumericW", (c) => bool(/[\p{L}\p{N}]/u.test(String.fromCharCode(c.arg(0) & 0xffff))));
  u.fn("IsCharUpperA", (c) => bool(/[A-Z]/.test(String.fromCharCode(c.arg(0) & 0xff))));
  u.fn("IsCharUpperW", (c) => bool(/\p{Lu}/u.test(String.fromCharCode(c.arg(0) & 0xffff))));
  u.fn("IsCharLowerA", (c) => bool(/[a-z]/.test(String.fromCharCode(c.arg(0) & 0xff))));
  u.fn("IsCharLowerW", (c) => bool(/\p{Ll}/u.test(String.fromCharCode(c.arg(0) & 0xffff))));
  u.fn("CharToOemA", (c) => { mem.wcstr(c.arg(1), mem.cstr(c.arg(0))); return 1; });
  u.fn("OemToCharA", (c) => { mem.wcstr(c.arg(1), mem.cstr(c.arg(0))); return 1; });
  u.fn("CharToOemBuffA", (c) => { mem.copy(c.arg(1), c.arg(0), c.arg(2)); return 1; });
  u.fn("OemToCharBuffA", (c) => { mem.copy(c.arg(1), c.arg(0), c.arg(2)); return 1; });
  // wsprintf family
  const wsprintf = (c: Cpu, wide: boolean) => {
    const fmtIdx = 1;
    const vals: bigint[] = [];
    for (let i = fmtIdx + 1; i < fmtIdx + 1 + 16; i++) vals.push(c.arg64(i));
    const s = formatPrintf(mem, wide ? mem.wstr(c.arg(fmtIdx)) : mem.cstr(c.arg(fmtIdx)), new ArrayArgs(vals), wide);
    if (wide) mem.wwstr(c.arg(0), s); else mem.wcstr(c.arg(0), s);
    return s.length;
  };
  u.fn("wsprintfA", (c) => wsprintf(c, false));
  u.fn("wsprintfW", (c) => wsprintf(c, true));
  u.fn("wvsprintfA", (c) => { const s = formatPrintf(mem, mem.cstr(c.arg(1)), new VaList(mem, c.arg(2)), false); mem.wcstr(c.arg(0), s); return s.length; });
  u.fn("wvsprintfW", (c) => { const s = formatPrintf(mem, mem.wstr(c.arg(1)), new VaList(mem, c.arg(2)), true); mem.wwstr(c.arg(0), s); return s.length; });
  u.fn("CharLowerBuff_", () => 0);

  // ---- misc ------------------------------------------------------------------------------------
  u.fn("GetLastInputInfo_", () => 0);
  u.fn("ExitWindowsEx", () => 0);
  u.fn("LockWorkStation", () => 0);
  u.fn("SetSysColors_", () => 1);
  u.fn("GetComboBoxInfo", () => 0);
  u.fn("GetScrollInfo", () => 0);
  u.fn("SetScrollInfo", () => 0);
  u.fn("SetScrollPos", () => 0);
  u.fn("GetScrollPos", () => 0);
  u.fn("SetScrollRange", () => 1);
  u.fn("GetScrollRange", () => 0);
  u.fn("ShowScrollBar", () => 1);
  u.fn("EnableScrollBar", () => 1);
  u.fn("ScrollWindow", () => 1);
  u.fn("ScrollWindowEx", () => 1);
  u.fn("ScrollDC", () => 1);
  u.fn("ChildWindowFromPoint", (c) => c.arg(0));
  u.fn("ChildWindowFromPointEx", (c) => c.arg(0));
  u.fn("WindowFromPoint", () => ws.zorder[0] ?? 0);
  u.fn("RealChildWindowFromPoint", (c) => c.arg(0));
  u.fn("WindowFromDC", (c) => gdi.dc(c.arg(0))?.hwnd ?? 0);
  u.fn("GetSystemMenu_", () => 0);
  u.fn("SetShellWindow", () => 1);
  u.fn("GetInputState", () => bool(ws.nextMessage(0, 0, 0, false) !== null));
  u.fn("IsWow64Message", () => 0);
  u.fn("GetThreadDpiHostingBehavior", () => 0);
  u.fn("InternalGetWindowText", (c) => { const x = W(c.arg(0)); if (!x) return 0; return mem.wwstr(c.arg(1), x.text, c.argI(2)) - 1; });
  u.fn("PrivateExtractIconsW", () => 0);
  u.fn("ExtractIconA", () => 0);
  u.fn("ExtractIconW", () => 0);
  u.fn("DrawTextA", (c) => drawText(c, false));
  u.fn("DrawTextW", (c) => drawText(c, true));
  u.fn("DrawTextExA", (c) => drawText(c, false));
  u.fn("DrawTextExW", (c) => drawText(c, true));
  u.fn("FillRect", (c) => {
    const dc = gdi.dc(c.arg(0)); if (!dc) return 0;
    const r = rdRect(c.arg(1));
    const br = c.arg(2);
    const col = gdi.brushColorFor(br);
    const o = gdi.get(br);
    const lo = gdi.logical(dc, r.l, r.t), hi = gdi.logical(dc, r.r, r.b);
    const rr = { l: lo.x, t: lo.y, r: hi.x, b: hi.y };
    if (o && o.type === "brush") gdi.fillWithBrush(dc, rr, o);
    else if (col !== null) gdi.fillRectRgb(dc, rr, col);
    return 1;
  });
  u.fn("FrameRect", (c) => {
    const dc = gdi.dc(c.arg(0)); if (!dc) return 0;
    const r = rdRect(c.arg(1)); const col = gdi.brushColorFor(c.arg(2)); if (col === null) return 1;
    const lo = gdi.logical(dc, r.l, r.t), hi = gdi.logical(dc, r.r, r.b);
    gdi.fillRectRgb(dc, { l: lo.x, t: lo.y, r: hi.x, b: lo.y + 1 }, col); gdi.fillRectRgb(dc, { l: lo.x, t: hi.y - 1, r: hi.x, b: hi.y }, col);
    gdi.fillRectRgb(dc, { l: lo.x, t: lo.y, r: lo.x + 1, b: hi.y }, col); gdi.fillRectRgb(dc, { l: hi.x - 1, t: lo.y, r: hi.x, b: hi.y }, col);
    return 1;
  });
  u.fn("InvertRect", (c) => {
    const dc = gdi.dc(c.arg(0)); if (!dc || !dc.bmp) return 0;
    const r = rdRect(c.arg(1));
    for (let y = r.t; y < r.b; y++) for (let x = r.l; x < r.r; x++) dc.bmp.set(x, y, ~dc.bmp.get(x, y) & 0xffffff);
    dc.bmp.touch();
    return 1;
  });
  u.fn("DrawEdge", () => 1);
  u.fn("DrawFrameControl", () => 1);
  u.fn("DrawCaption", () => 1);
  u.fn("GrayStringA", () => 1);
  u.fn("GrayStringW", () => 1);
  u.fn("DrawStateA", () => 1);
  u.fn("DrawStateW", () => 1);
  const drawText = (c: Cpu, wide: boolean) => {
    const dc = gdi.dc(c.arg(0));
    const n = c.argI(2);
    const s = n < 0 ? str(c.arg(1), wide) : wide ? mem.wstrn(c.arg(1), n) : String.fromCharCode(...mem.bytes(c.arg(1), n));
    const f = gdi.get(dc?.font ?? 0);
    const h = f && f.type === "font" ? Math.abs(f.height) || 16 : 16;
    if (dc && dc.bmp) {
      const fmt = c.arg(4);
      void fmt;
      const r = rdRect(c.arg(3));
      textBlit(dc, r.l, r.t, s);
    }
    return h;
  };
  const textBlit = (dc: import("./gdi.ts").Dc, x: number, y: number, s: string) => {
    const f = gdi.get(dc.font);
    const font = f && f.type === "font" ? f : null;
    const hh = font ? Math.abs(font.height) || 16 : 16;
    const r = p.host.drawText?.(s, hh, font?.weight ?? 400, font?.face ?? "Arial", font?.italic ?? false);
    if (!r || !dc.bmp) return;
    const lp = gdi.logical(dc, x, y);
    const col = dc.textColor;
    const rgb = ((col & 0xff) << 16) | (col & 0xff00) | ((col >> 16) & 0xff);
    for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
      const a = r.alpha[yy * r.w + xx];
      if (!a) continue;
      if (a >= 250) dc.bmp.set(lp.x + xx, lp.y + yy, rgb);
      else {
        const d = dc.bmp.get(lp.x + xx, lp.y + yy);
        const mix = (s_: number, d_: number) => Math.round((s_ * a + d_ * (255 - a)) / 255);
        dc.bmp.set(lp.x + xx, lp.y + yy, (mix((rgb >> 16) & 255, (d >> 16) & 255) << 16) | (mix((rgb >> 8) & 255, (d >> 8) & 255) << 8) | mix(rgb & 255, d & 255));
      }
    }
    dc.bmp.touch();
  };
  p.ext.textBlit = textBlit;

  // ---- idle hook: keep the host/timers moving when every thread is blocked -------------------
  p.idleHook = (until: number) => {
    ws.pump();
    const wait = Math.max(0, Math.min(until - performance.now(), 4));
    if (wait > 0) p.sched.spinWait(wait);
  };
  void colorrefToRgb;
  void CW_USEDEFAULT;
  void VK;
  void (null as unknown as HostEvent);
}
