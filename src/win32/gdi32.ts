// gdi32.dll exports on top of the software rasteriser in gdi.ts.
import type { Process } from "./process.ts";
import type { Cpu } from "./cpu.ts";
import { Bmp, rgbToColorref, colorrefToRgb } from "./gdi.ts";
import type { Brush, Pen, Font, Dc, Rect } from "./gdi.ts";
import { ERROR } from "./k32-core.ts";

export function installGdi32(p: Process) {
  const g = p.hle.module("gdi32.dll");
  const mem = p.mem;
  const gdi = p.gdi;
  const bool = (v: boolean) => (v ? 1 : 0);
  const D = (h: number) => gdi.dc(h);
  const rgb = (c: number) => colorrefToRgb(c);
  const rdRect = (a: number): Rect => ({ l: mem.ri32(a), t: mem.ri32(a + 4), r: mem.ri32(a + 8), b: mem.ri32(a + 12) });

  // ---- DCs ----
  g.fn("CreateCompatibleDC", (c) => gdi.createMemDc(D(c.arg(0))).hdc);
  const createDc = () => gdi.newDc({ isDisplay: true, bmp: null, win: null }).hdc;
  g.fn("CreateDCA", createDc);
  g.fn("CreateDCW", createDc);
  g.fn("CreateICA", createDc);
  g.fn("CreateICW", createDc);
  g.fn("DeleteDC", (c) => bool(gdi.delete(c.arg(0))));
  g.fn("DeleteObject", (c) => bool(gdi.delete(c.arg(0))));
  g.fn("SaveDC", (c) => { const d = D(c.arg(0)); if (!d) return 0; d.saved.push({ ...d, saved: [], winOrg: { ...d.winOrg }, vpOrg: { ...d.vpOrg }, winExt: { ...d.winExt }, vpExt: { ...d.vpExt } }); return d.saved.length; });
  g.fn("RestoreDC", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    let n = c.argI(1);
    if (n < 0) n = d.saved.length + n + 1;
    if (n < 1 || n > d.saved.length) return 0;
    const s = d.saved[n - 1];
    d.saved.length = n - 1;
    Object.assign(d, { ...s, saved: d.saved, hdc: d.hdc, bmp: s.bmp, win: d.win });
    return 1;
  });
  g.fn("GetStockObject", (c) => gdi.stock[c.arg(0)] ?? 0);
  g.fn("SelectObject", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const h = c.arg(1);
    const o = gdi.get(h);
    if (!o) return 0;
    switch (o.type) {
      case "pen": { const old = d.pen; d.pen = h; return old; }
      case "brush": { const old = d.brush; d.brush = h; return old; }
      case "font": { const old = d.font; d.font = h; return old; }
      case "bitmap": {
        if (!d.mem) return 0;
        const old = d.selBitmap; d.selBitmap = h; d.bmp = o.bmp; return old;
      }
      case "region": { d.clip = o.rect ? { ...o.rect } : null; return o.rect ? 2 : 1; }
      default: return 0;
    }
  });
  g.fn("GetCurrentObject", (c) => { const d = D(c.arg(0)); if (!d) return 0; switch (c.arg(1)) { case 1: return d.pen; case 2: return d.brush; case 6: return d.font; case 7: return d.selBitmap; default: return 0; } });
  g.fn("GetObjectType", (c) => { const o = gdi.get(c.arg(0)); if (!o) return 0; return { pen: 1, brush: 2, dc: o.type === "dc" && o.mem ? 10 : 3, bitmap: 7, region: 8, palette: 5, font: 6 }[o.type] ?? 0; });
  g.fn("GetDeviceCaps", (c) => {
    const d = D(c.arg(0));
    const W = p.win.sw, H = p.win.sh;
    switch (c.argI(1)) {
      case 0: return 0x0300; case 2: return 1; // DRIVERVERSION / TECHNOLOGY (DT_RASDISPLAY)
      case 4: return Math.round((W * 25.4) / 96); case 6: return Math.round((H * 25.4) / 96); case 8: return d?.mem && d.bmp ? d.bmp.w : W; case 10: return d?.mem && d.bmp ? d.bmp.h : H; // HORZSIZE VERTSIZE HORZRES VERTRES
      case 12: return d?.mem && d.bmp ? d.bmp.bpp : 32; case 14: return 1; case 24: return -1; case 26: return 0; case 40: return 0; // BITSPIXEL PLANES NUMCOLORS ...
      case 88: case 90: return 96; // LOGPIXELSX / Y
      case 104: return 0; case 108: return 0x7e07; // SIZEPALETTE / RASTERCAPS (BITBLT|STRETCHBLT|...)
      case 116: return p.host.refreshRate; // VREFRESH
      case 118: return W; case 117: return H; // DESKTOPHORZRES / VERTRES (117 = DESKTOPVERTRES, 118 = DESKTOPHORZRES)
      case 120: return 1; // ASPECTX? (approximation)
      default: return 0;
    }
  });
  g.fn("SetBkColor", (c) => { const d = D(c.arg(0)); if (!d) return 0xffffffff; const o = d.bkColor; d.bkColor = rgb(c.arg(1)); return rgbToColorref(o); });
  g.fn("GetBkColor", (c) => rgbToColorref(D(c.arg(0))?.bkColor ?? 0));
  g.fn("SetTextColor", (c) => { const d = D(c.arg(0)); if (!d) return 0xffffffff; const o = d.textColor; d.textColor = rgb(c.arg(1)); return rgbToColorref(o); });
  g.fn("GetTextColor", (c) => rgbToColorref(D(c.arg(0))?.textColor ?? 0));
  g.fn("SetBkMode", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.bkMode; d.bkMode = c.arg(1); return o; });
  g.fn("GetBkMode", (c) => D(c.arg(0))?.bkMode ?? 0);
  g.fn("SetROP2", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.rop2; d.rop2 = c.arg(1); return o; });
  g.fn("GetROP2", (c) => D(c.arg(0))?.rop2 ?? 0);
  g.fn("SetStretchBltMode", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.stretchMode; d.stretchMode = c.arg(1); return o; });
  g.fn("GetStretchBltMode", (c) => D(c.arg(0))?.stretchMode ?? 1);
  g.fn("SetPolyFillMode", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.polyFill; d.polyFill = c.arg(1); return o; });
  g.fn("GetPolyFillMode", (c) => D(c.arg(0))?.polyFill ?? 1);
  g.fn("SetMapMode", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.mapMode; d.mapMode = c.arg(1); return o; });
  g.fn("GetMapMode", (c) => D(c.arg(0))?.mapMode ?? 1);
  g.fn("SetGraphicsMode", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.graphicsMode; d.graphicsMode = c.arg(1); return o; });
  g.fn("GetGraphicsMode", (c) => D(c.arg(0))?.graphicsMode ?? 1);
  g.fn("SetTextAlign", (c) => { const d = D(c.arg(0)); if (!d) return 0xffffffff; const o = d.textAlign; d.textAlign = c.arg(1); return o; });
  g.fn("GetTextAlign", (c) => D(c.arg(0))?.textAlign ?? 0);
  g.fn("SetTextCharacterExtra", () => 0);
  g.fn("SetTextJustification", () => 1);
  g.fn("SetLayout", () => 0);
  g.fn("GetLayout", () => 0);
  g.fn("SetViewportOrgEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; if (c.arg(3)) { mem.w32(c.arg(3), d.vpOrg.x); mem.w32(c.arg(3) + 4, d.vpOrg.y); } d.vpOrg = { x: c.argI(1), y: c.argI(2) }; return 1; });
  g.fn("SetWindowOrgEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; if (c.arg(3)) { mem.w32(c.arg(3), d.winOrg.x); mem.w32(c.arg(3) + 4, d.winOrg.y); } d.winOrg = { x: c.argI(1), y: c.argI(2) }; return 1; });
  g.fn("SetViewportExtEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; d.vpExt = { x: c.argI(1), y: c.argI(2) }; return 1; });
  g.fn("SetWindowExtEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; d.winExt = { x: c.argI(1), y: c.argI(2) }; return 1; });
  g.fn("GetViewportOrgEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; mem.w32(c.arg(1), d.vpOrg.x); mem.w32(c.arg(1) + 4, d.vpOrg.y); return 1; });
  g.fn("GetWindowOrgEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; mem.w32(c.arg(1), d.winOrg.x); mem.w32(c.arg(1) + 4, d.winOrg.y); return 1; });
  g.fn("OffsetViewportOrgEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; d.vpOrg.x += c.argI(1); d.vpOrg.y += c.argI(2); return 1; });
  g.fn("SetBrushOrgEx", () => 1);
  g.fn("GetBrushOrgEx", (c) => { mem.w32(c.arg(1), 0); mem.w32(c.arg(1) + 4, 0); return 1; });
  g.fn("GetCurrentPositionEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; mem.w32(c.arg(1), d.x); mem.w32(c.arg(1) + 4, d.y); return 1; });
  g.fn("GdiFlush", () => 1);
  g.fn("GdiSetBatchLimit", () => 1);
  g.fn("GdiGetBatchLimit", () => 1);

  // ---- pens / brushes / fonts / regions ----
  g.fn("CreatePen", (c) => gdi.alloc({ type: "pen", style: c.arg(0), width: c.argI(1), color: rgb(c.arg(2)) } as Pen));
  g.fn("CreatePenIndirect", (c) => gdi.alloc({ type: "pen", style: mem.r32(c.arg(0)), width: mem.ri32(c.arg(0) + 4), color: rgb(mem.r32(c.arg(0) + 12)) } as Pen));
  g.fn("ExtCreatePen", (c) => gdi.alloc({ type: "pen", style: c.arg(0) & 0xf, width: c.argI(1), color: rgb(mem.r32(c.arg(2) + 4)) } as Pen));
  g.fn("CreateSolidBrush", (c) => gdi.alloc({ type: "brush", style: 0, color: rgb(c.arg(0)), hatch: 0, pattern: null } as Brush));
  g.fn("CreateHatchBrush", (c) => gdi.alloc({ type: "brush", style: 2, color: rgb(c.arg(1)), hatch: c.arg(0), pattern: null } as Brush));
  g.fn("CreateBrushIndirect", (c) => { const a = c.arg(0); return gdi.alloc({ type: "brush", style: mem.r32(a), color: rgb(mem.r32(a + 4)), hatch: mem.r32(a + 8), pattern: null } as Brush); });
  g.fn("CreatePatternBrush", (c) => { const o = gdi.get(c.arg(0)); return gdi.alloc({ type: "brush", style: 3, color: 0, hatch: 0, pattern: o && o.type === "bitmap" ? o.bmp : null } as Brush); });
  g.fn("CreateDIBPatternBrushPt", () => gdi.alloc({ type: "brush", style: 0, color: 0x808080, hatch: 0, pattern: null } as Brush));
  g.fn("GetSysColorBrush_", () => 0);
  const mkFont = (h: number, w: number, esc: number, weight: number, italic: number, ul: number, so: number, cs: number, q: number, face: string): Font => ({ type: "font", height: h, width: w, weight: weight || 400, italic: !!italic, underline: !!ul, strike: !!so, charset: cs, quality: q, face: face || "Arial", escapement: esc });
  g.fn("CreateFontA", (c) => gdi.alloc(mkFont(c.argI(0), c.argI(1), c.argI(2), c.argI(4), c.arg(5) & 0xff, c.arg(6) & 0xff, c.arg(7) & 0xff, c.arg(8) & 0xff, c.arg(11) & 0xff, mem.cstr(c.arg(13)))));
  g.fn("CreateFontW", (c) => gdi.alloc(mkFont(c.argI(0), c.argI(1), c.argI(2), c.argI(4), c.arg(5) & 0xff, c.arg(6) & 0xff, c.arg(7) & 0xff, c.arg(8) & 0xff, c.arg(11) & 0xff, mem.wstr(c.arg(13)))));
  g.fn("CreateFontIndirectA", (c) => { const a = c.arg(0); return gdi.alloc(mkFont(mem.ri32(a), mem.ri32(a + 4), mem.ri32(a + 8), mem.ri32(a + 16), mem.r8(a + 20), mem.r8(a + 21), mem.r8(a + 22), mem.r8(a + 23), mem.r8(a + 26), mem.cstr(a + 28, 32))); });
  g.fn("CreateFontIndirectW", (c) => { const a = c.arg(0); return gdi.alloc(mkFont(mem.ri32(a), mem.ri32(a + 4), mem.ri32(a + 8), mem.ri32(a + 16), mem.r8(a + 20), mem.r8(a + 21), mem.r8(a + 22), mem.r8(a + 23), mem.r8(a + 26), mem.wstr(a + 28, 32))); });
  g.fn("CreateFontIndirectExA", (c) => { const a = c.arg(0); return gdi.alloc(mkFont(mem.ri32(a), mem.ri32(a + 4), mem.ri32(a + 8), mem.ri32(a + 16), mem.r8(a + 20), mem.r8(a + 21), mem.r8(a + 22), mem.r8(a + 23), mem.r8(a + 26), mem.cstr(a + 28, 32))); });
  g.fn("CreateFontIndirectExW", (c) => { const a = c.arg(0); return gdi.alloc(mkFont(mem.ri32(a), mem.ri32(a + 4), mem.ri32(a + 8), mem.ri32(a + 16), mem.r8(a + 20), mem.r8(a + 21), mem.r8(a + 22), mem.r8(a + 23), mem.r8(a + 26), mem.wstr(a + 28, 32))); });
  g.fn("AddFontResourceA", () => 1);
  g.fn("AddFontResourceW", () => 1);
  g.fn("AddFontResourceExA", () => 1);
  g.fn("AddFontResourceExW", () => 1);
  g.fn("RemoveFontResourceA", () => 1);
  g.fn("RemoveFontResourceW", () => 1);
  g.fn("RemoveFontResourceExA", () => 1);
  g.fn("RemoveFontResourceExW", () => 1);
  g.fn("AddFontMemResourceEx", (c) => { if (c.arg(3)) mem.w32(c.arg(3), 1); return 0x3e11; });
  g.fn("RemoveFontMemResourceEx", () => 1);
  g.fn("EnumFontFamiliesA", () => 0);
  g.fn("EnumFontFamiliesW", () => 0);
  g.fn("EnumFontFamiliesExA", () => 0);
  g.fn("EnumFontFamiliesExW", () => 0);
  g.fn("EnumFontsA", () => 0);
  g.fn("EnumFontsW", () => 0);
  g.fn("GetFontData", () => 0xffffffff);
  g.fn("GetGlyphIndicesW", (c) => { for (let i = 0; i < c.argI(2); i++) mem.w16(c.arg(3) + i * 2, mem.r16(c.arg(1) + i * 2)); return c.arg(2); });
  g.fn("GetCharWidth32A", (c) => { for (let i = c.arg(1); i <= c.arg(2); i++) mem.w32(c.arg(3) + (i - c.arg(1)) * 4, charW(c.arg(0))); return 1; });
  g.fn("GetCharWidth32W", (c) => { for (let i = c.arg(1); i <= c.arg(2); i++) mem.w32(c.arg(3) + (i - c.arg(1)) * 4, charW(c.arg(0))); return 1; });
  g.fn("GetCharWidthA", (c) => { for (let i = c.arg(1); i <= c.arg(2); i++) mem.w32(c.arg(3) + (i - c.arg(1)) * 4, charW(c.arg(0))); return 1; });
  g.fn("GetCharWidthW", (c) => { for (let i = c.arg(1); i <= c.arg(2); i++) mem.w32(c.arg(3) + (i - c.arg(1)) * 4, charW(c.arg(0))); return 1; });
  g.fn("GetTextFaceA", (c) => { const d = D(c.arg(0)); const f = d && gdi.get(d.font); const n = f && f.type === "font" ? f.face : "Arial"; if (c.argI(1) > 0) mem.wcstr(c.arg(2), n, c.argI(1)); return n.length + 1; });
  g.fn("GetTextFaceW", (c) => { const d = D(c.arg(0)); const f = d && gdi.get(d.font); const n = f && f.type === "font" ? f.face : "Arial"; if (c.argI(1) > 0) mem.wwstr(c.arg(2), n, c.argI(1)); return n.length + 1; });
  const fontOf = (d: Dc | undefined): Font => { const f = d && gdi.get(d.font); return f && f.type === "font" ? f : (gdi.get(gdi.stock[17]) as Font); };
  const charW = (hdc: number) => { const f = fontOf(D(hdc)); const h = Math.abs(f.height) || 16; return f.width || Math.max(1, Math.round(h * 0.5)); };
  const measure = (hdc: number, s: string): { w: number; h: number } => {
    const f = fontOf(D(hdc));
    const h = Math.abs(f.height) || 16;
    const r = p.host.measureText?.(s, h, f.weight, f.face, f.italic);
    if (r) return r;
    return { w: s.length * (f.width || Math.max(1, Math.round(h * 0.5))), h };
  };
  const textExtent = (c: Cpu, wide: boolean) => {
    const n = c.argI(2);
    const s = wide ? mem.wstrn(c.arg(1), n) : String.fromCharCode(...mem.bytes(c.arg(1), n));
    const m = measure(c.arg(0), s);
    mem.w32(c.arg(3), m.w); mem.w32(c.arg(3) + 4, m.h);
    return 1;
  };
  g.fn("GetTextExtentPoint32A", (c) => textExtent(c, false));
  g.fn("GetTextExtentPoint32W", (c) => textExtent(c, true));
  g.fn("GetTextExtentPointA", (c) => textExtent(c, false));
  g.fn("GetTextExtentPointW", (c) => textExtent(c, true));
  g.fn("GetTextExtentExPointA", (c) => { textExtent({ arg: (i: number) => [c.arg(0), c.arg(1), c.arg(2), c.arg(7)][i], argI: (i: number) => [c.argI(0), c.argI(1), c.argI(2), c.argI(7)][i] } as any, false); return 1; });
  g.fn("GetTextExtentExPointW", (c) => { textExtent({ arg: (i: number) => [c.arg(0), c.arg(1), c.arg(2), c.arg(7)][i], argI: (i: number) => [c.argI(0), c.argI(1), c.argI(2), c.argI(7)][i] } as any, true); return 1; });
  const textMetrics = (c: Cpu, wide: boolean) => {
    const f = fontOf(D(c.arg(0)));
    const a = c.arg(1), h = Math.abs(f.height) || 16;
    const asc = Math.round(h * 0.8), w = f.width || Math.max(1, Math.round(h * 0.5));
    mem.fill(a, 0, wide ? 60 : 56);
    mem.w32(a, h); mem.w32(a + 4, asc); mem.w32(a + 8, h - asc); mem.w32(a + 12, 0); mem.w32(a + 16, 0); mem.w32(a + 20, w); mem.w32(a + 24, w * 2); mem.w32(a + 28, f.weight);
    mem.w32(a + 36, 96); mem.w32(a + 40, 96);
    if (wide) { mem.w16(a + 44, 32); mem.w16(a + 46, 0xffff); mem.w16(a + 48, 0x3f); mem.w16(a + 50, 32); mem.w8(a + 52, +f.italic); mem.w8(a + 55, 0x36); mem.w8(a + 56, f.charset); }
    else { mem.w8(a + 44, 32); mem.w8(a + 45, 255); mem.w8(a + 46, 0x3f); mem.w8(a + 47, 32); mem.w8(a + 48, +f.italic); mem.w8(a + 51, 0x36); mem.w8(a + 52, f.charset); }
    return 1;
  };
  g.fn("GetTextMetricsA", (c) => textMetrics(c, false));
  g.fn("GetTextMetricsW", (c) => textMetrics(c, true));
  const textOut = (c: Cpu, wide: boolean) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const n = c.argI(3);
    const s = wide ? mem.wstrn(c.arg(3), n) : String.fromCharCode(...mem.bytes(c.arg(3), n));
    drawString(d, c.argI(1), c.argI(2), s);
    return 1;
  };
  const drawString = (d: Dc, x: number, y: number, s: string) => {
    if (d.bkMode === 2 && d.bmp) { const m = measure(d.hdc, s); const lp = gdi.logical(d, x, y); gdi.fillRectRgb(d, { l: lp.x, t: lp.y, r: lp.x + m.w, b: lp.y + m.h }, d.bkColor); }
    (p.ext.textBlit as any)?.(d, x, y, s);
  };
  g.fn("TextOutA", (c) => { const d = D(c.arg(0)); if (!d) return 0; drawString(d, c.argI(1), c.argI(2), String.fromCharCode(...mem.bytes(c.arg(3), c.argI(4)))); return 1; });
  g.fn("TextOutW", (c) => { const d = D(c.arg(0)); if (!d) return 0; drawString(d, c.argI(1), c.argI(2), mem.wstrn(c.arg(3), c.argI(4))); return 1; });
  g.fn("ExtTextOutA", (c) => { const d = D(c.arg(0)); if (!d) return 0; if (c.arg(6)) drawString(d, c.argI(1), c.argI(2), String.fromCharCode(...mem.bytes(c.arg(5), c.argI(6)))); return 1; });
  g.fn("ExtTextOutW", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    if (c.arg(3) & 2 && c.arg(4)) gdi.fillRectRgb(d, rdRect(c.arg(4)), d.bkColor); // ETO_OPAQUE
    if (c.arg(6)) drawString(d, c.argI(1), c.argI(2), mem.wstrn(c.arg(5), c.argI(6)));
    return 1;
  });
  void textOut;
  g.fn("CreateRectRgn", (c) => gdi.alloc({ type: "region", rect: { l: c.argI(0), t: c.argI(1), r: c.argI(2), b: c.argI(3) } }));
  g.fn("CreateRectRgnIndirect", (c) => gdi.alloc({ type: "region", rect: rdRect(c.arg(0)) }));
  g.fn("CreateEllipticRgn", (c) => gdi.alloc({ type: "region", rect: { l: c.argI(0), t: c.argI(1), r: c.argI(2), b: c.argI(3) } }));
  g.fn("CreateRoundRectRgn", (c) => gdi.alloc({ type: "region", rect: { l: c.argI(0), t: c.argI(1), r: c.argI(2), b: c.argI(3) } }));
  g.fn("CreatePolygonRgn", () => gdi.alloc({ type: "region", rect: null }));
  g.fn("SetRectRgn", (c) => { const o = gdi.get(c.arg(0)); if (o?.type === "region") o.rect = { l: c.argI(1), t: c.argI(2), r: c.argI(3), b: c.argI(4) }; return 1; });
  g.fn("CombineRgn", (c) => {
    const d = gdi.get(c.arg(0)), a = gdi.get(c.arg(1)), b = gdi.get(c.arg(2));
    if (d?.type !== "region" || a?.type !== "region") return 0;
    const mode = c.arg(3);
    if (mode === 5) d.rect = a.rect ? { ...a.rect } : null; // RGN_COPY
    else if (b?.type === "region" && a.rect && b.rect) {
      if (mode === 1) d.rect = { l: Math.max(a.rect.l, b.rect.l), t: Math.max(a.rect.t, b.rect.t), r: Math.min(a.rect.r, b.rect.r), b: Math.min(a.rect.b, b.rect.b) }; // AND
      else d.rect = { l: Math.min(a.rect.l, b.rect.l), t: Math.min(a.rect.t, b.rect.t), r: Math.max(a.rect.r, b.rect.r), b: Math.max(a.rect.b, b.rect.b) };
    }
    return d.rect && (d.rect.r <= d.rect.l || d.rect.b <= d.rect.t) ? 1 : 2;
  });
  g.fn("GetRgnBox", (c) => { const o = gdi.get(c.arg(0)); if (o?.type !== "region" || !o.rect) return 0; mem.w32(c.arg(1), o.rect.l); mem.w32(c.arg(1) + 4, o.rect.t); mem.w32(c.arg(1) + 8, o.rect.r); mem.w32(c.arg(1) + 12, o.rect.b); return 2; });
  g.fn("PtInRegion", (c) => { const o = gdi.get(c.arg(0)); if (o?.type !== "region" || !o.rect) return 0; const x = c.argI(1), y = c.argI(2); return bool(x >= o.rect.l && x < o.rect.r && y >= o.rect.t && y < o.rect.b); });
  g.fn("EqualRgn", () => 1);
  g.fn("OffsetRgn", (c) => { const o = gdi.get(c.arg(0)); if (o?.type === "region" && o.rect) { o.rect.l += c.argI(1); o.rect.r += c.argI(1); o.rect.t += c.argI(2); o.rect.b += c.argI(2); } return 2; });
  g.fn("SelectClipRgn", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = gdi.get(c.arg(1)); d.clip = o?.type === "region" && o.rect ? { ...o.rect } : null; return 2; });
  g.fn("ExtSelectClipRgn", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = gdi.get(c.arg(1)); d.clip = o?.type === "region" && o.rect ? { ...o.rect } : null; return 2; });
  g.fn("IntersectClipRect", (c) => { const d = D(c.arg(0)); if (!d) return 0; const r = { l: c.argI(1), t: c.argI(2), r: c.argI(3), b: c.argI(4) }; d.clip = d.clip ? { l: Math.max(d.clip.l, r.l), t: Math.max(d.clip.t, r.t), r: Math.min(d.clip.r, r.r), b: Math.min(d.clip.b, r.b) } : r; return 2; });
  g.fn("ExcludeClipRect", () => 2);
  g.fn("OffsetClipRgn", () => 2);
  g.fn("GetClipRgn", () => 0);
  g.fn("GetClipBox", (c) => { const d = D(c.arg(0)); if (!d) return 0; const r = d.clip ?? { l: 0, t: 0, r: d.bmp?.w ?? 0, b: d.bmp?.h ?? 0 }; mem.w32(c.arg(1), r.l); mem.w32(c.arg(1) + 4, r.t); mem.w32(c.arg(1) + 8, r.r); mem.w32(c.arg(1) + 12, r.b); return 2; });
  g.fn("RectVisible", () => 1);
  g.fn("PtVisible", () => 1);
  g.fn("SetWindowRgn_", () => 1);

  // ---- drawing ----
  g.fn("MoveToEx", (c) => { const d = D(c.arg(0)); if (!d) return 0; if (c.arg(3)) { mem.w32(c.arg(3), d.x); mem.w32(c.arg(3) + 4, d.y); } d.x = c.argI(1); d.y = c.argI(2); return 1; });
  g.fn("LineTo", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const pen = gdi.get(d.pen) as Pen;
    const a = gdi.logical(d, d.x, d.y), b = gdi.logical(d, c.argI(1), c.argI(2));
    gdi.line(d, a.x, a.y, b.x, b.y, pen);
    d.x = c.argI(1); d.y = c.argI(2);
    return 1;
  });
  g.fn("SetPixel", (c) => { const d = D(c.arg(0)); if (!d) return 0xffffffff; const l = gdi.logical(d, c.argI(1), c.argI(2)); gdi.setPixel(d, l.x, l.y, rgb(c.arg(3))); d.bmp?.touch(); return c.arg(3); });
  g.fn("SetPixelV", (c) => { const d = D(c.arg(0)); if (!d) return 0; const l = gdi.logical(d, c.argI(1), c.argI(2)); gdi.setPixel(d, l.x, l.y, rgb(c.arg(3))); d.bmp?.touch(); return 1; });
  g.fn("GetPixel", (c) => { const d = D(c.arg(0)); if (!d || !d.bmp) return 0xffffffff; const l = gdi.logical(d, c.argI(1), c.argI(2)); return rgbToColorref(d.bmp.get(l.x, l.y)); });
  const penOf = (d: Dc) => gdi.get(d.pen) as Pen;
  const brushOf = (d: Dc) => gdi.get(d.brush) as Brush;
  const rectangle = (d: Dc, l: number, t: number, r: number, b: number) => {
    const a = gdi.logical(d, l, t), z = gdi.logical(d, r, b);
    gdi.fillWithBrush(d, { l: a.x, t: a.y, r: z.x, b: z.y }, brushOf(d));
    const pen = penOf(d);
    if (pen.style !== 5) {
      gdi.line(d, a.x, a.y, z.x - 1, a.y, pen); gdi.line(d, z.x - 1, a.y, z.x - 1, z.y - 1, pen);
      gdi.line(d, z.x - 1, z.y - 1, a.x, z.y - 1, pen); gdi.line(d, a.x, z.y - 1, a.x, a.y, pen);
    }
    d.bmp?.touch();
  };
  g.fn("Rectangle", (c) => { const d = D(c.arg(0)); if (!d) return 0; rectangle(d, c.argI(1), c.argI(2), c.argI(3), c.argI(4)); return 1; });
  g.fn("RoundRect", (c) => { const d = D(c.arg(0)); if (!d) return 0; rectangle(d, c.argI(1), c.argI(2), c.argI(3), c.argI(4)); return 1; });
  g.fn("Ellipse", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const a = gdi.logical(d, c.argI(1), c.argI(2)), z = gdi.logical(d, c.argI(3), c.argI(4));
    const pts = gdi.ellipsePoints(a.x, a.y, z.x, z.y);
    gdi.polygonFill(d, pts, brushOf(d));
    const pen = penOf(d);
    for (let i = 0; i < pts.length; i++) { const u = pts[i], v = pts[(i + 1) % pts.length]; gdi.line(d, u.x, u.y, v.x, v.y, pen); }
    return 1;
  });
  const readPts = (a: number, n: number, d: Dc) => { const pts: { x: number; y: number }[] = []; for (let i = 0; i < n; i++) pts.push(gdi.logical(d, mem.ri32(a + i * 8), mem.ri32(a + i * 8 + 4))); return pts; };
  g.fn("Polygon", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const pts = readPts(c.arg(1), c.argI(2), d);
    gdi.polygonFill(d, pts, brushOf(d));
    for (let i = 0; i < pts.length; i++) { const u = pts[i], v = pts[(i + 1) % pts.length]; gdi.line(d, u.x, u.y, v.x, v.y, penOf(d)); }
    return 1;
  });
  g.fn("Polyline", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    const pts = readPts(c.arg(1), c.argI(2), d);
    for (let i = 0; i + 1 < pts.length; i++) gdi.line(d, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, penOf(d));
    return 1;
  });
  g.fn("PolylineTo", (c) => { const d = D(c.arg(0)); if (!d) return 0; const pts = readPts(c.arg(1), c.argI(2), d); let cur = gdi.logical(d, d.x, d.y); for (const q of pts) { gdi.line(d, cur.x, cur.y, q.x, q.y, penOf(d)); cur = q; } return 1; });
  g.fn("Arc", () => 1);
  g.fn("Pie", () => 1);
  g.fn("Chord", () => 1);
  g.fn("AngleArc", () => 1);
  g.fn("ArcTo", () => 1);
  g.fn("PolyBezier", () => 1);
  g.fn("BeginPath", () => 1);
  g.fn("EndPath", () => 1);
  g.fn("CloseFigure", () => 1);
  g.fn("FillPath", () => 1);
  g.fn("StrokePath", () => 1);
  g.fn("StrokeAndFillPath", () => 1);
  g.fn("FloodFill", () => 1);
  g.fn("ExtFloodFill", () => 1);
  g.fn("PatBlt", (c) => {
    const d = D(c.arg(0)); if (!d) return 0;
    return bool(gdi.blit(d, c.argI(1), c.argI(2), c.argI(3), c.argI(4), null, 0, 0, 0, 0, c.arg(5)));
  });
  g.fn("BitBlt", (c) => {
    const dst = D(c.arg(0)); if (!dst) return 0;
    const src = D(c.arg(5));
    const w = c.argI(3), h = c.argI(4);
    return bool(gdi.blit(dst, c.argI(1), c.argI(2), w, h, src ?? null, c.argI(6), c.argI(7), w, h, c.arg(8)));
  });
  g.fn("StretchBlt", (c) => {
    const dst = D(c.arg(0)); if (!dst) return 0;
    const src = D(c.arg(5));
    return bool(gdi.blit(dst, c.argI(1), c.argI(2), c.argI(3), c.argI(4), src ?? null, c.argI(6), c.argI(7), c.argI(8), c.argI(9), c.arg(10)));
  });
  g.fn("MaskBlt", (c) => {
    const dst = D(c.arg(0)); if (!dst) return 0;
    return bool(gdi.blit(dst, c.argI(1), c.argI(2), c.argI(3), c.argI(4), D(c.arg(5)) ?? null, c.argI(6), c.argI(7), c.argI(3), c.argI(4), 0xcc0020));
  });
  g.fn("PlgBlt", () => 1);
  g.fn("TransparentBlt", (c) => {
    const dst = D(c.arg(0)), src = D(c.arg(5)); if (!dst || !src || !dst.bmp || !src.bmp) return 0;
    const key = rgb(c.arg(10));
    const dx = c.argI(1), dy = c.argI(2), dw = c.argI(3), dh = c.argI(4), sx = c.argI(6), sy = c.argI(7), sw = c.argI(8), sh = c.argI(9);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const px = src.bmp.get(sx + Math.floor((x * sw) / dw), sy + Math.floor((y * sh) / dh));
      if (px !== key) dst.bmp.set(dx + x, dy + y, px);
    }
    dst.bmp.touch();
    return 1;
  });
  g.fn("AlphaBlend", (c) => {
    const dst = D(c.arg(0)), src = D(c.arg(5)); if (!dst || !src) return 0;
    return bool(gdi.blit(dst, c.argI(1), c.argI(2), c.argI(3), c.argI(4), src, c.argI(6), c.argI(7), c.argI(8), c.argI(9), 0xcc0020));
  });

  // ---- bitmaps & DIBs ----
  g.fn("CreateCompatibleBitmap", (c) => {
    const d = D(c.arg(0));
    const bpp = d?.bmp && d.mem ? d.bmp.bpp : 32;
    const b = new Bmp(p, Math.max(1, c.argI(1)), Math.max(1, c.argI(2)), bpp === 1 ? 1 : 32, true);
    return gdi.alloc({ type: "bitmap", bmp: b });
  });
  g.fn("CreateBitmap", (c) => {
    const w = Math.max(1, c.argI(0)), h = Math.max(1, c.argI(1)), planes = c.arg(2) & 0xffff, bpp = c.arg(3) & 0xffff;
    void planes;
    const b = new Bmp(p, w, h, bpp === 1 ? 1 : 32, true);
    if (c.arg(4) && bpp === 32) { b.buf!.set(mem.bytes(c.arg(4), Math.min(b.buf!.length, w * h * 4))); }
    return gdi.alloc({ type: "bitmap", bmp: b });
  });
  g.fn("CreateBitmapIndirect", (c) => { const a = c.arg(0); const b = new Bmp(p, Math.max(1, mem.ri32(a + 4)), Math.max(1, mem.ri32(a + 8)), 32, true); return gdi.alloc({ type: "bitmap", bmp: b }); });
  g.fn("CreateDIBSection", (c) => {
    const bi = c.arg(1);
    const info = gdi.parseBitmapInfo(bi);
    const stride = (((info.w * info.bpp + 31) >> 5) << 2);
    const size = Math.max(stride * info.h, 16);
    const ptr = p.vm.alloc(size, { commit: true, tag: "dib" });
    const bmp = new Bmp(p, info.w, info.h, info.bpp, info.topDown, ptr);
    bmp.palette = info.palette;
    bmp.isDib = true;
    if (c.arg(3)) mem.wptr(c.arg(3), ptr);
    return gdi.alloc({ type: "bitmap", bmp });
  });
  g.fn("CreateDIBitmap", (c) => {
    const bi = c.arg(1);
    if (!bi) return gdi.alloc({ type: "bitmap", bmp: new Bmp(p, 1, 1, 32, true) });
    const info = gdi.parseBitmapInfo(bi);
    const b = new Bmp(p, info.w, info.h, 32, true);
    const bmp = gdi.alloc({ type: "bitmap", bmp: b });
    if ((c.arg(2) & 4) && c.arg(3)) setDIBits(b, c.arg(3), c.arg(4), 0, info.h);
    return bmp;
  });
  const setDIBits = (dst: Bmp, bits: number, bi: number, startScan: number, nScans: number) => {
    const info = gdi.parseBitmapInfo(bi);
    const src = new Bmp(p, info.w, info.h, info.bpp, info.topDown, bits);
    src.palette = info.palette;
    for (let sc = startScan; sc < startScan + nScans && sc < info.h; sc++) {
      const ty = info.topDown ? sc : info.h - 1 - sc;
      for (let x = 0; x < info.w && x < dst.w; x++) dst.set(x, ty, src.get(x, ty));
    }
    dst.touch();
  };
  g.fn("SetDIBits", (c) => {
    const o = gdi.get(c.arg(1)); if (o?.type !== "bitmap") return 0;
    setDIBits(o.bmp, c.arg(4), c.arg(5), c.arg(2), c.arg(3));
    return c.arg(3);
  });
  g.fn("SetDIBitsToDevice", (c) => {
    const d = D(c.arg(0)); if (!d || !d.bmp) return 0;
    const xDest = c.argI(1), yDest = c.argI(2), w = c.argI(3), h = c.argI(4), xSrc = c.argI(5), ySrc = c.argI(6), nScans = c.argI(8);
    const bits = c.arg(9), bi = c.arg(10);
    const info = gdi.parseBitmapInfo(bi);
    const src = new Bmp(p, info.w, info.h, info.bpp, info.topDown, bits);
    src.palette = info.palette;
    for (let row = 0; row < h; row++) {
      const ty = info.topDown ? ySrc + row : info.h - 1 - (ySrc + row);
      const dy = info.topDown ? yDest + row : yDest + (h - 1 - row);
      for (let col = 0; col < w; col++) {
        const l = gdi.logical(d, xDest + col, dy);
        d.bmp.set(l.x, l.y, src.get(xSrc + col, ty));
      }
    }
    d.bmp.touch();
    return nScans;
  });
  g.fn("StretchDIBits", (c) => {
    const d = D(c.arg(0)); if (!d || !d.bmp) return 0;
    const xD = c.argI(1), yD = c.argI(2), wD = c.argI(3), hD = c.argI(4), xS = c.argI(5), yS = c.argI(6), wS = c.argI(7), hS = c.argI(8);
    const bits = c.arg(9), bi = c.arg(10), rop = c.arg(12);
    const info = gdi.parseBitmapInfo(bi);
    const src = new Bmp(p, info.w, info.h, info.bpp, info.topDown, bits);
    src.palette = info.palette;
    const tmpDc = gdi.newDc({ mem: true, bmp: src });
    // StretchDIBits source coordinates use bottom-up origin for positive-height DIBs; convert to top-left
    const syTop = info.topDown ? yS : info.h - yS - hS;
    const ok = gdi.blit(d, xD, yD, wD, hD, tmpDc, xS, syTop, wS, hS, rop);
    gdi.objs.delete(tmpDc.hdc);
    return ok ? Math.abs(hS) : 0;
  });
  g.fn("GetDIBits", (c) => {
    const o = gdi.get(c.arg(1)); if (o?.type !== "bitmap") return 0;
    const b = o.bmp, bi = c.arg(5), bitsOut = c.arg(4);
    const start = c.arg(2), n = c.arg(3);
    if (!bitsOut) {
      // fill the header
      mem.w32(bi, 40); mem.w32(bi + 4, b.w); mem.w32(bi + 8, b.h); mem.w16(bi + 12, 1); mem.w16(bi + 14, 32); mem.w32(bi + 16, 0); mem.w32(bi + 20, b.w * b.h * 4);
      return b.h;
    }
    const info = gdi.parseBitmapInfo(bi);
    const bpp = info.bpp || 32;
    const out = new Bmp(p, b.w, b.h, bpp, info.topDown, bitsOut);
    out.palette = info.palette;
    for (let y = start; y < start + n && y < b.h; y++) for (let x = 0; x < b.w; x++) out.set(x, y, b.get(x, info.topDown ? y : b.h - 1 - y));
    return n;
  });
  g.fn("GetObjectA", (c) => getObject(c, false));
  g.fn("GetObjectW", (c) => getObject(c, true));
  const getObject = (c: Cpu, wide: boolean): number => {
    const o = gdi.get(c.arg(0)); if (!o) return 0;
    const out = c.arg(2), sz = c.argI(1);
    switch (o.type) {
      case "bitmap": {
        const b = o.bmp;
        if (!out) return b.isDib ? 104 : 32;
        mem.fill(out, 0, Math.min(sz, 104));
        mem.w32(out, 0); mem.w32(out + 4, b.w); mem.w32(out + 8, b.h); mem.w32(out + 12, b.stride); mem.w16(out + 16, 1); mem.w16(out + 18, b.bpp);
        mem.wptr(out + 24, b.ptr);
        if (b.isDib && sz >= 104) {
          const h = out + 32;
          mem.w32(h, 40); mem.w32(h + 4, b.w); mem.w32(h + 8, b.topDown ? -b.h : b.h); mem.w16(h + 12, 1); mem.w16(h + 14, b.bpp); mem.w32(h + 20, b.stride * b.h);
          return 104;
        }
        return 32;
      }
      case "brush": if (out) { mem.w32(out, o.style); mem.w32(out + 4, rgbToColorref(o.color)); mem.wptr(out + 8, o.hatch); } return 16;
      case "pen": if (out) { mem.w32(out, o.style); mem.w32(out + 4, o.width); mem.w32(out + 8, 0); mem.w32(out + 12, rgbToColorref(o.color)); } return 16;
      case "font": {
        if (!out) return wide ? 92 : 60;
        mem.fill(out, 0, wide ? 92 : 60);
        mem.w32(out, o.height); mem.w32(out + 4, o.width); mem.w32(out + 16, o.weight); mem.w8(out + 20, +o.italic); mem.w8(out + 23, o.charset);
        if (wide) mem.wwstr(out + 28, o.face, 32); else mem.wcstr(out + 28, o.face, 32);
        return wide ? 92 : 60;
      }
      default: return 0;
    }
  };
  g.fn("GetBitmapBits", (c) => {
    const o = gdi.get(c.arg(0)); if (o?.type !== "bitmap") return 0;
    const n = Math.min(c.argI(1), o.bmp.stride * o.bmp.h);
    for (let y = 0, off = 0; off < n; y++, off += o.bmp.stride) mem.write(c.arg(2) + off, o.bmp.bytes.subarray(o.bmp.rowOffset(y), o.bmp.rowOffset(y) + Math.min(o.bmp.stride, n - off)));
    return n;
  });
  g.fn("SetBitmapBits", (c) => { const o = gdi.get(c.arg(0)); if (o?.type !== "bitmap") return 0; const n = Math.min(c.argI(1), o.bmp.stride * o.bmp.h); for (let y = 0, off = 0; off < n; y++, off += o.bmp.stride) o.bmp.bytes.set(mem.bytes(c.arg(2) + off, Math.min(o.bmp.stride, n - off)), o.bmp.rowOffset(y)); o.bmp.touch(); return n; });
  g.fn("GetDIBColorTable", () => 0);
  g.fn("SetDIBColorTable", () => 0);

  // ---- palettes ----
  g.fn("CreatePalette", (c) => { const a = c.arg(0); const n = mem.r16(a + 2); const entries: number[] = []; for (let i = 0; i < n; i++) entries.push((mem.r8(a + 4 + i * 4) << 16) | (mem.r8(a + 5 + i * 4) << 8) | mem.r8(a + 6 + i * 4)); return gdi.alloc({ type: "palette", entries }); });
  g.fn("SelectPalette", (c) => { const d = D(c.arg(0)); if (!d) return 0; const o = d.palette; d.palette = c.arg(1); return o; });
  g.fn("RealizePalette", () => 0);
  g.fn("GetSystemPaletteEntries", () => 0);
  g.fn("GetPaletteEntries", () => 0);
  g.fn("SetPaletteEntries", () => 0);
  g.fn("GetNearestColor", (c) => c.arg(1));
  g.fn("GetNearestPaletteIndex", () => 0);
  g.fn("UpdateColors", () => 1);
  g.fn("AnimatePalette", () => 1);
  g.fn("GetColorAdjustment", () => 0);
  g.fn("SetColorAdjustment", () => 1);
  g.fn("SetICMMode", () => 1);
  g.fn("GetDeviceGammaRamp", (c) => { for (let i = 0; i < 256; i++) { mem.w16(c.arg(1) + i * 2, i * 257); mem.w16(c.arg(1) + 512 + i * 2, i * 257); mem.w16(c.arg(1) + 1024 + i * 2, i * 257); } return 1; });
  g.fn("SetDeviceGammaRamp", () => 1);
  g.fn("GetICMProfileA", () => 0);
  g.fn("GetICMProfileW", () => 0);
  g.fn("SetMiterLimit", () => 1);
  g.fn("GetNearestColor_", () => 0);

  // ---- OpenGL pixel format plumbing (windowed GL contexts are not supported; D3D swap chains do not need these) ----
  g.fn("ChoosePixelFormat", () => 1);
  g.fn("SetPixelFormat", () => 1);
  g.fn("GetPixelFormat", () => 1);
  g.fn("DescribePixelFormat", (c) => {
    const a = c.arg(3);
    if (a) {
      mem.fill(a, 0, 40);
      mem.w16(a, 40); mem.w16(a + 2, 1); mem.w32(a + 4, 0x25 | 0x1000 /* DRAW_TO_WINDOW|SUPPORT_OPENGL|DOUBLEBUFFER|... */); mem.w8(a + 8, 0); mem.w8(a + 9, 32);
      mem.w8(a + 23, 24); mem.w8(a + 24, 8);
    }
    return 1;
  });
  g.fn("SwapBuffers", () => 1);

  // ---- misc ----
  g.fn("GetEnhMetaFileA", () => 0);
  g.fn("StartDocA", () => -1);
  g.fn("StartDocW", () => -1);
  g.fn("EndDoc", () => 1);
  g.fn("GetCharacterPlacementW", () => 0);
  g.fn("GetKerningPairsW", () => 0);
  g.fn("GetOutlineTextMetricsA", () => 0);
  g.fn("GetCharABCWidthsW", (c) => { const w = charW(c.arg(0)); for (let i = c.arg(1); i <= c.arg(2); i++) { const o = c.arg(3) + (i - c.arg(1)) * 12; mem.w32(o, 0); mem.w32(o + 4, w); mem.w32(o + 8, 0); } return 1; });
  g.fn("GetCharABCWidthsA", (c) => { const w = charW(c.arg(0)); for (let i = c.arg(1); i <= c.arg(2); i++) { const o = c.arg(3) + (i - c.arg(1)) * 12; mem.w32(o, 0); mem.w32(o + 4, w); mem.w32(o + 8, 0); } return 1; });
  g.fn("GetGlyphOutlineW", () => 0xffffffff);
  g.fn("GetGlyphOutlineA", () => 0xffffffff);
  g.fn("SetWorldTransform", () => 1);
  g.fn("GetWorldTransform", () => 1);
  g.fn("ModifyWorldTransform", () => 1);
  g.fn("SetMapperFlags", () => 0);
  g.fn("GetFontLanguageInfo", () => 0);
  g.fn("CreateScalableFontResourceA", () => 0);
  g.fn("SetDCBrushColor", (c) => { const d = D(c.arg(0)); const b = d && gdi.get(d.brush); if (b && b.type === "brush" && b.stock) { /* DC_BRUSH */ } const old = 0; if (d) d.brush = gdi.alloc({ type: "brush", style: 0, color: rgb(c.arg(1)), hatch: 0, pattern: null }); return old; });
  g.fn("SetDCPenColor", (c) => { const d = D(c.arg(0)); if (d) d.pen = gdi.alloc({ type: "pen", style: 0, width: 1, color: rgb(c.arg(1)) }); return 0; });
  g.fn("GetDCBrushColor", () => 0xffffff);
  g.fn("GetDCPenColor", () => 0);
  g.fn("GetDCOrgEx", (c) => { mem.w32(c.arg(1), 0); mem.w32(c.arg(1) + 4, 0); return 1; });
  g.fn("GdiGetCharDimensions", () => 8);
  g.fn("D3DKMTOpenAdapterFromHdc", () => 0xc0000001);
  g.fn("D3DKMTCloseAdapter", () => 0);
  g.fn("D3DKMTQueryAdapterInfo", () => 0xc0000001);
  g.fn("D3DKMTEnumAdapters2", () => 0xc0000001);
  g.fn("D3DKMTOpenAdapterFromGdiDisplayName", () => 0xc0000001);
  void ERROR;
}
