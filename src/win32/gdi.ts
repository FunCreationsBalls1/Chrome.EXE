// GDI: device contexts, bitmaps/DIB sections, brushes/pens, and software rasterisation into guest or host-side pixel buffers.
import type { Process } from "./process.ts";
import type { Win } from "./winsys.ts";

export interface Rect { l: number; t: number; r: number; b: number }

/** A pixel surface. Either host-owned (`buf`) or living in guest memory (`ptr`). */
export class Bmp {
  w: number;
  h: number;
  bpp: number;
  stride: number;
  topDown: boolean;
  ptr = 0;
  buf: Uint8Array | null = null;
  palette: number[] | null = null; // 0xRRGGBB entries for bpp <= 8
  /** called after pixels change */
  onWrite: (() => void) | null = null;
  readonly p: Process;
  isDib = false;
  planes = 1;
  constructor(p: Process, w: number, h: number, bpp: number, topDown: boolean, ptr = 0) {
    this.p = p; this.w = w; this.h = h; this.bpp = bpp; this.topDown = topDown;
    this.stride = (((w * bpp + 31) >> 5) << 2) | 0;
    if (ptr) this.ptr = ptr; else this.buf = new Uint8Array(this.stride * Math.max(h, 1));
  }
  get bytes(): Uint8Array {
    return this.buf ?? this.p.m.u8;
  }
  rowOffset(y: number): number {
    const r = this.topDown ? y : this.h - 1 - y;
    return (this.buf ? 0 : this.ptr) + r * this.stride;
  }
  /** pixel as 0xRRGGBB */
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const u = this.bytes;
    const o = this.rowOffset(y);
    switch (this.bpp) {
      case 32: { const i = o + x * 4; return (u[i + 2] << 16) | (u[i + 1] << 8) | u[i]; }
      case 24: { const i = o + x * 3; return (u[i + 2] << 16) | (u[i + 1] << 8) | u[i]; }
      case 16: { const v = u[o + x * 2] | (u[o + x * 2 + 1] << 8); return (((v >> 10) & 31) * 255 / 31 << 16 | ((v >> 5) & 31) * 255 / 31 << 8 | (v & 31) * 255 / 31) >>> 0; }
      case 8: { const i = u[o + x]; return this.palette ? this.palette[i] ?? 0 : (i << 16) | (i << 8) | i; }
      case 4: { const b = u[o + (x >> 1)]; const i = x & 1 ? b & 15 : b >> 4; return this.palette ? this.palette[i] ?? 0 : 0; }
      case 1: { const b = (u[o + (x >> 3)] >> (7 - (x & 7))) & 1; return this.palette ? this.palette[b] ?? (b ? 0xffffff : 0) : b ? 0xffffff : 0; }
      default: return 0;
    }
  }
  set(x: number, y: number, rgb: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const u = this.bytes;
    const o = this.rowOffset(y);
    const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
    switch (this.bpp) {
      case 32: { const i = o + x * 4; u[i] = b; u[i + 1] = g; u[i + 2] = r; u[i + 3] = 255; break; }
      case 24: { const i = o + x * 3; u[i] = b; u[i + 1] = g; u[i + 2] = r; break; }
      case 16: { const v = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); u[o + x * 2] = v & 255; u[o + x * 2 + 1] = v >> 8; break; }
      case 8: {
        let idx = 0;
        if (this.palette) { let best = Infinity; for (let i = 0; i < this.palette.length; i++) { const c = this.palette[i]; const d = ((c >> 16) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2; if (d < best) { best = d; idx = i; } } }
        else idx = (r * 77 + g * 151 + b * 28) >> 8;
        u[o + x] = idx; break;
      }
      case 1: { const bit = ((r * 77 + g * 151 + b * 28) >> 8) >= 128 ? 1 : 0; const i = o + (x >> 3), m = 0x80 >> (x & 7); u[i] = bit ? u[i] | m : u[i] & ~m; break; }
      default: break;
    }
  }
  touch() { if (this.onWrite) this.onWrite(); }
}

export interface Pen { type: "pen"; style: number; width: number; color: number }
export interface Brush { type: "brush"; style: number; color: number; hatch: number; pattern: Bmp | null; stock?: boolean; sysColor?: number }
export interface Font { type: "font"; height: number; width: number; weight: number; italic: boolean; face: string; charset: number; escapement: number; underline: boolean; strike: boolean; quality: number }
export interface Region { type: "region"; rect: Rect | null }
export interface Palette { type: "palette"; entries: number[] }
export interface BitmapObj { type: "bitmap"; bmp: Bmp }
export interface Dc {
  type: "dc";
  hdc: number;
  hwnd: number;
  /** window-owned DC: draws into this window's client surface */
  win: Win | null;
  bmp: Bmp | null;
  mem: boolean;
  selBitmap: number;
  pen: number; brush: number; font: number; palette: number;
  textColor: number; bkColor: number; bkMode: number; rop2: number;
  x: number; y: number;
  clip: Rect | null;
  mapMode: number;
  winOrg: { x: number; y: number }; vpOrg: { x: number; y: number };
  winExt: { x: number; y: number }; vpExt: { x: number; y: number };
  textAlign: number;
  polyFill: number;
  stretchMode: number;
  graphicsMode: number;
  isDisplay: boolean;
  /** the DC was created by BeginPaint */
  ps: boolean;
  saved: Dc[];
}
type GdiObj = Pen | Brush | Font | Region | Palette | BitmapObj | Dc;

export const SRCCOPY = 0xcc0020, SRCPAINT = 0xee0086, SRCAND = 0x8800c6, SRCINVERT = 0x660046, SRCERASE = 0x440328, NOTSRCCOPY = 0x330008, NOTSRCERASE = 0x1100a6,
  MERGECOPY = 0xc000ca, MERGEPAINT = 0xbb0226, PATCOPY = 0xf00021, PATPAINT = 0xfb0a09, PATINVERT = 0x5a0049, DSTINVERT = 0x550009, BLACKNESS = 0x42, WHITENESS = 0xff0062;

const SYS_COLORS: number[] = [
  0xc8c8c8, 0x6a6a6a, 0x99b4d1, 0xbfcddb, 0xf0f0f0, 0xffffff, 0x646464, 0x000000, 0x000000, 0x000000, 0xb4b4b4, 0xf4f7fc, 0xababab, 0x3399ff, 0xffffff,
  0xf0f0f0, 0xa0a0a0, 0x808080, 0x000000, 0x000000, 0xffffff, 0x696969, 0xe3e3e3, 0x000000, 0xffffe1, 0xb9d1ea, 0xd7e4f2, 0x0066cc, 0x3399ff, 0xf0f0f0,
]; // indexed by COLOR_*, 0xRRGGBB

export const colorrefToRgb = (c: number) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
export const rgbToColorref = (c: number) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);

export class Gdi {
  readonly p: Process;
  objs = new Map<number, GdiObj>();
  next = 0x0a010004;
  stock: number[] = [];
  deskDc = 0;

  constructor(p: Process) {
    this.p = p;
    const mk = (o: GdiObj, h?: number) => { const hh = h ?? this.alloc(o); if (h !== undefined) this.objs.set(h, o); return hh; };
    void mk;
    const solid = (c: number): Brush => ({ type: "brush", style: 0, color: c, hatch: 0, pattern: null, stock: true });
    // stock objects in GetStockObject order
    const list: GdiObj[] = [
      solid(0xffffff), solid(0xc0c0c0), solid(0x808080), solid(0x404040), solid(0x000000), { type: "brush", style: 1, color: 0, hatch: 0, pattern: null, stock: true },
      { type: "pen", style: 0, width: 1, color: 0xffffff }, { type: "pen", style: 0, width: 1, color: 0x000000 }, { type: "pen", style: 5, width: 1, color: 0 },
      { type: "pen", style: 0, width: 1, color: 0 }, // 9: unused
      this.defFont("Terminal", 12, 400), this.defFont("Courier New", 12, 400), this.defFont("Arial", 12, 400), this.defFont("System", 16, 700), this.defFont("System", 16, 400),
      { type: "palette", entries: [] }, this.defFont("Fixedsys", 16, 400), this.defFont("Segoe UI", 12, 400), solid(0xffffff), { type: "pen", style: 0, width: 1, color: 0 },
    ];
    list.forEach((o, i) => { const h = 0x01900010 + i * 4; this.objs.set(h, o); this.stock[i] = h; });
  }
  private defFont(face: string, height: number, weight: number): Font {
    return { type: "font", height, width: 0, weight, italic: false, face, charset: 1, escapement: 0, underline: false, strike: false, quality: 0 };
  }
  alloc(o: GdiObj): number { const h = this.next; this.next += 4; this.objs.set(h, o); return h; }
  get(h: number): GdiObj | undefined { return this.objs.get(h >>> 0); }
  dc(h: number): Dc | undefined { const o = this.objs.get(h >>> 0); return o && o.type === "dc" ? o : undefined; }
  delete(h: number): boolean {
    h = h >>> 0;
    if (this.stock.includes(h)) return true;
    return this.objs.delete(h);
  }

  sysColor(i: number): number { return SYS_COLORS[i] ?? 0; }
  /** colour (0xRRGGBB) a class background brush paints with, or null for none */
  brushColorFor(brush: number): number | null {
    if (!brush) return null;
    if (brush > 0 && brush <= 31) return this.sysColor(brush - 1);
    const o = this.get(brush);
    if (o && o.type === "brush") { if (o.style === 1) return null; return o.color; }
    return null;
  }

  // ---- DC creation ----
  newDc(init: Partial<Dc>): Dc {
    const dc: Dc = {
      type: "dc", hdc: 0, hwnd: 0, win: null, bmp: null, mem: false, selBitmap: 0, pen: this.stock[7], brush: this.stock[0], font: this.stock[17], palette: this.stock[15],
      textColor: 0x000000, bkColor: 0xffffff, bkMode: 2, rop2: 13, x: 0, y: 0, clip: null, mapMode: 1,
      winOrg: { x: 0, y: 0 }, vpOrg: { x: 0, y: 0 }, winExt: { x: 1, y: 1 }, vpExt: { x: 1, y: 1 }, textAlign: 0, polyFill: 1, stretchMode: 1, graphicsMode: 1,
      isDisplay: false, ps: false, saved: [], ...init,
    };
    dc.hdc = this.alloc(dc);
    return dc;
  }
  createMemDc(ref?: Dc): Dc {
    const dc = this.newDc({ mem: true, isDisplay: false });
    // default 1x1 monochrome bitmap
    const b = new Bmp(this.p, 1, 1, 1, true);
    const h = this.alloc({ type: "bitmap", bmp: b });
    dc.selBitmap = h; dc.bmp = b;
    void ref;
    return dc;
  }
  /** a DC drawing into a window's client surface */
  windowDc(w: Win | null): Dc {
    const ws = this.p.win;
    if (!w) return this.newDc({ isDisplay: true, hwnd: 0 });
    // surfaces for GDI are exposed as 32bpp top-down Bmp views over the window's surface
    const dc = this.newDc({ win: w, hwnd: w.hwnd, isDisplay: true });
    this.bindWindow(dc);
    void ws;
    return dc;
  }
  bindWindow(dc: Dc) {
    const w = dc.win;
    if (!w) return;
    const s = this.p.win.surfaceOf(w);
    const b = new Bmp(this.p, s.w, s.h, 32, true);
    b.buf = s.data;
    b.stride = s.w * 4;
    b.onWrite = () => { s.dirty = true; };
    dc.bmp = b;
  }
  releaseDc(h: number): boolean {
    const dc = this.dc(h);
    if (!dc) return false;
    if (dc.mem) return false;
    this.objs.delete(dc.hdc);
    return true;
  }

  // ---- drawing helpers ----
  logical(dc: Dc, x: number, y: number) {
    if (dc.mapMode === 1) return { x: x - dc.winOrg.x + dc.vpOrg.x, y: y - dc.winOrg.y + dc.vpOrg.y };
    const sx = dc.vpExt.x / (dc.winExt.x || 1), sy = dc.vpExt.y / (dc.winExt.y || 1);
    return { x: Math.round((x - dc.winOrg.x) * sx + dc.vpOrg.x), y: Math.round((y - dc.winOrg.y) * sy + dc.vpOrg.y) };
  }
  private clipOf(dc: Dc): Rect {
    const b = dc.bmp;
    const r: Rect = { l: 0, t: 0, r: b ? b.w : 0, b: b ? b.h : 0 };
    if (dc.clip) { r.l = Math.max(r.l, dc.clip.l); r.t = Math.max(r.t, dc.clip.t); r.r = Math.min(r.r, dc.clip.r); r.b = Math.min(r.b, dc.clip.b); }
    return r;
  }
  fillRectRgb(dc: Dc, r: Rect, rgb: number) {
    const b = dc.bmp;
    if (!b) return;
    const c = this.clipOf(dc);
    const l = Math.max(r.l, c.l), t = Math.max(r.t, c.t), rr = Math.min(r.r, c.r), bb = Math.min(r.b, c.b);
    if (l >= rr || t >= bb) return;
    if (b.bpp === 32) {
      const u = b.bytes;
      const rv = (rgb >> 16) & 255, gv = (rgb >> 8) & 255, bv = rgb & 255;
      for (let y = t; y < bb; y++) {
        let i = b.rowOffset(y) + l * 4;
        for (let x = l; x < rr; x++, i += 4) { u[i] = bv; u[i + 1] = gv; u[i + 2] = rv; u[i + 3] = 255; }
      }
    } else {
      for (let y = t; y < bb; y++) for (let x = l; x < rr; x++) b.set(x, y, rgb);
    }
    b.touch();
  }
  /** colour of a brush at a pixel (supports solid, hatch, and pattern brushes) */
  brushPixel(br: Brush, x: number, y: number): number | null {
    switch (br.style) {
      case 0: return br.color;
      case 1: return null;
      case 2: { // hatch
        const h = br.hatch;
        const on = h === 0 ? y % 8 === 0 : h === 1 ? x % 8 === 0 : h === 2 ? (x + y) % 8 === 0 : h === 3 ? (x - y) % 8 === 0 : h === 4 ? (x % 8 === 0 || y % 8 === 0) : ((x + y) % 8 === 0 || (x - y) % 8 === 0);
        return on ? br.color : null;
      }
      case 3: return br.pattern ? br.pattern.get(((x % 8) + 8) % 8, ((y % 8) + 8) % 8) : br.color;
      default: return br.color;
    }
  }
  fillWithBrush(dc: Dc, r: Rect, brush: Brush | undefined) {
    if (!brush || brush.style === 1) return;
    if (brush.style === 0) { this.fillRectRgb(dc, r, brush.color); return; }
    const b = dc.bmp;
    if (!b) return;
    const c = this.clipOf(dc);
    for (let y = Math.max(r.t, c.t); y < Math.min(r.b, c.b); y++) for (let x = Math.max(r.l, c.l); x < Math.min(r.r, c.r); x++) {
      const px = this.brushPixel(brush, x, y);
      if (px !== null) b.set(x, y, px);
    }
    b.touch();
  }
  setPixel(dc: Dc, x: number, y: number, rgb: number) {
    const c = this.clipOf(dc);
    if (x < c.l || y < c.t || x >= c.r || y >= c.b) return;
    dc.bmp?.set(x, y, rgb);
  }
  line(dc: Dc, x0: number, y0: number, x1: number, y1: number, pen: Pen) {
    const b = dc.bmp;
    if (!b || pen.style === 5) return;
    const w = Math.max(1, pen.width);
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let n = 0;
    for (;;) {
      const dash = pen.style === 1 ? (n % 12) < 8 : pen.style === 2 ? (n % 4) < 2 : pen.style === 3 ? (n % 10) < 3 || ((n % 10) >= 5 && (n % 10) < 7) : true;
      if (dash) {
        if (w === 1) this.setPixel(dc, x0, y0, pen.color);
        else for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) this.setPixel(dc, x0 + i - (w >> 1), y0 + j - (w >> 1), pen.color);
      }
      n++;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    b.touch();
  }
  polygonFill(dc: Dc, pts: { x: number; y: number }[], brush: Brush | undefined) {
    if (!brush || brush.style === 1 || pts.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const c = this.clipOf(dc);
    minY = Math.max(minY, c.t); maxY = Math.min(maxY, c.b - 1);
    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((u, v) => u - v);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.max(Math.ceil(xs[i]), c.l), x1 = Math.min(Math.floor(xs[i + 1]), c.r - 1);
        for (let x = x0; x <= x1; x++) { const px = this.brushPixel(brush, x, y); if (px !== null) dc.bmp!.set(x, y, px); }
      }
    }
    dc.bmp?.touch();
  }
  ellipsePoints(l: number, t: number, r: number, b: number): { x: number; y: number }[] {
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
    const n = Math.max(16, Math.ceil(Math.max(rx, ry) * 2));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push({ x: Math.round(cx + rx * Math.cos(a)), y: Math.round(cy + ry * Math.sin(a)) }); }
    return pts;
  }

  // ---- blits ----
  /** ternary raster operation on 0xRRGGBB values */
  private rop(rop: number, s: number, d: number, p: number): number {
    switch (rop >>> 0) {
      case SRCCOPY: return s;
      case SRCPAINT: return s | d;
      case SRCAND: return s & d;
      case SRCINVERT: return s ^ d;
      case SRCERASE: return s & ~d & 0xffffff;
      case NOTSRCCOPY: return ~s & 0xffffff;
      case NOTSRCERASE: return ~(s | d) & 0xffffff;
      case MERGECOPY: return s & p;
      case MERGEPAINT: return (~s & 0xffffff) | d;
      case PATCOPY: return p;
      case PATPAINT: return ((~s & 0xffffff) | d) | p;
      case PATINVERT: return p ^ d;
      case DSTINVERT: return ~d & 0xffffff;
      case BLACKNESS: return 0;
      case WHITENESS: return 0xffffff;
      default: return s;
    }
  }
  blit(dst: Dc, dx: number, dy: number, dw: number, dh: number, src: Dc | null, sx: number, sy: number, sw: number, sh: number, rop: number): boolean {
    const db = dst.bmp;
    if (!db) return true;
    const sb = src?.bmp ?? null;
    const needsSrc = ![PATCOPY, PATINVERT, DSTINVERT, BLACKNESS, WHITENESS].includes(rop >>> 0);
    if (needsSrc && !sb) return false;
    const d0 = this.logical(dst, dx, dy);
    const s0 = src ? this.logical(src, sx, sy) : { x: sx, y: sy };
    const flipX = dw < 0 !== sw < 0, flipY = dh < 0 !== sh < 0;
    const adw = Math.abs(dw), adh = Math.abs(dh), asw = Math.abs(sw), ash = Math.abs(sh);
    const c = this.clipOf(dst);
    const brush = this.get(dst.brush) as Brush | undefined;
    const x0 = dw < 0 ? d0.x + dw : d0.x, y0 = dh < 0 ? d0.y + dh : d0.y;
    // fast path: unscaled 32bpp SRCCOPY
    if (sb && rop >>> 0 === SRCCOPY && adw === asw && adh === ash && !flipX && !flipY && db.bpp === 32 && sb.bpp === 32) {
      const ox = x0, oy = y0;
      const sx0 = (sw < 0 ? s0.x + sw : s0.x), sy0 = (sh < 0 ? s0.y + sh : s0.y);
      const xa = Math.max(c.l, ox, ox - sx0), xb = Math.min(c.r, ox + adw, ox + (sb.w - sx0));
      const du = db.bytes, su = sb.bytes;
      for (let y = Math.max(c.t, oy, oy - sy0); y < Math.min(c.b, oy + adh, oy + (sb.h - sy0)); y++) {
        const sy1 = sy0 + (y - oy);
        if (xb <= xa) break;
        const so = sb.rowOffset(sy1) + (sx0 + (xa - ox)) * 4;
        const dof = db.rowOffset(y) + xa * 4;
        if (du === su && so < dof + (xb - xa) * 4 && dof < so + (xb - xa) * 4) du.copyWithin(dof, so, so + (xb - xa) * 4);
        else du.set(su.subarray(so, so + (xb - xa) * 4), dof);
        // opaque alpha for 24-bit sources promoted into 32 bpp targets is handled by the generic path
        if (!(sb.buf === null || true)) break;
      }
      db.touch();
      return true;
    }
    for (let y = Math.max(y0, c.t); y < Math.min(y0 + adh, c.b); y++) {
      for (let x = Math.max(x0, c.l); x < Math.min(x0 + adw, c.r); x++) {
        let sxp = 0, syp = 0, s = 0;
        if (sb) {
          let fx = x - x0, fy = y - y0;
          if (flipX) fx = adw - 1 - fx;
          if (flipY) fy = adh - 1 - fy;
          sxp = (sw < 0 ? s0.x + sw : s0.x) + (asw === adw ? fx : Math.floor((fx * asw) / adw));
          syp = (sh < 0 ? s0.y + sh : s0.y) + (ash === adh ? fy : Math.floor((fy * ash) / adh));
          s = sb.get(sxp, syp);
        }
        const dcol = db.get(x, y);
        let pcol = 0;
        if (brush && [PATCOPY, PATINVERT, MERGECOPY, PATPAINT].includes(rop >>> 0)) pcol = this.brushPixel(brush, x, y) ?? 0;
        db.set(x, y, this.rop(rop, s, dcol, pcol));
      }
    }
    db.touch();
    return true;
  }

  // ---- DIB parsing ----
  /** Parse a BITMAPINFO at `bi` into geometry; pixels live at `bits`. */
  parseBitmapInfo(bi: number): { w: number; h: number; topDown: boolean; bpp: number; compression: number; palette: number[] | null; headerSize: number; clrUsed: number; imageSize: number } {
    const mem = this.p.mem;
    const size = mem.r32(bi);
    let w: number, h: number, bpp: number, comp = 0, clrUsed = 0, imageSize = 0;
    if (size === 12) { w = mem.r16(bi + 4); h = mem.r16(bi + 6); bpp = mem.r16(bi + 10); }
    else { w = mem.ri32(bi + 4); h = mem.ri32(bi + 8); bpp = mem.r16(bi + 14); comp = mem.r32(bi + 16); imageSize = mem.r32(bi + 20); clrUsed = mem.r32(bi + 32); }
    const topDown = h < 0;
    let palette: number[] | null = null;
    if (bpp <= 8) {
      const n = clrUsed || 1 << bpp;
      palette = [];
      const po = bi + size;
      for (let i = 0; i < n; i++) palette.push(size === 12 ? (mem.r8(po + i * 3 + 2) << 16) | (mem.r8(po + i * 3 + 1) << 8) | mem.r8(po + i * 3) : (mem.r8(po + i * 4 + 2) << 16) | (mem.r8(po + i * 4 + 1) << 8) | mem.r8(po + i * 4));
    }
    return { w, h: Math.abs(h), topDown, bpp, compression: comp, palette, headerSize: size, clrUsed, imageSize };
  }
}

declare module "./process.ts" {
  interface Process {
    gdi: Gdi;
  }
}
