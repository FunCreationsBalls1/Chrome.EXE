// kernel32: code pages, string conversion, locale information, string comparison and classification.
import type { Process } from "./process.ts";
import { ERROR } from "./k32-core.ts";

export const CP_ACP = 0, CP_OEMCP = 1, CP_UTF8 = 65001, CP_UTF7 = 65000;
const MB_ERR_INVALID_CHARS = 8, WC_NO_BEST_FIT_CHARS = 0x400;

// windows-1252 0x80..0x9f
const CP1252_HI = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const CP1252_REV = new Map<number, number>();
CP1252_HI.forEach((u, i) => CP1252_REV.set(u, 0x80 + i));

export function decodeAnsi(cp: number, bytes: Uint8Array): string {
  if (cp === CP_UTF8) return new TextDecoder("utf-8").decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += String.fromCharCode(b >= 0x80 && b < 0xa0 && cp !== CP_OEMCP && cp !== 437 ? CP1252_HI[b - 0x80] : b);
  }
  return s;
}
export function encodeAnsi(cp: number, s: string): { bytes: Uint8Array; usedDefault: boolean } {
  if (cp === CP_UTF8) return { bytes: new TextEncoder().encode(s), usedDefault: false };
  const out: number[] = [];
  let used = false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c < 0x100)) out.push(c);
    else if (CP1252_REV.has(c) && cp !== CP_OEMCP && cp !== 437) out.push(CP1252_REV.get(c)!);
    else { out.push(0x3f); used = true; }
  }
  return { bytes: Uint8Array.from(out), usedDefault: used };
}

const LOCALE_EN_US: Record<number, string> = {
  0x1: "0409", 0x2: "English (United States)", 0x3: "ENU", 0x4: "English (United States)", 0x5: "1", 0x6: "United States", 0x7: "USA",
  0x8: "United States", 0x9: "ENU", 0xa: "English", 0xb: "437", 0xc: ",", 0xd: "1", 0xe: ".", 0xf: ",", 0x10: "3;0", 0x11: "2", 0x12: "1",
  0x13: "0123456789", 0x14: "$", 0x15: "USD", 0x16: ".", 0x17: ",", 0x18: "3;0", 0x19: "2", 0x1a: "0", 0x1b: "0", 0x1c: "0", 0x1d: "/", 0x1e: ":",
  0x1f: "M/d/yyyy", 0x20: "dddd, MMMM d, yyyy", 0x21: "0", 0x22: "0", 0x23: "0", 0x24: "1", 0x25: "0", 0x26: "0", 0x27: "0", 0x28: "AM", 0x29: "PM",
  0x2a: "Monday", 0x2b: "Tuesday", 0x2c: "Wednesday", 0x2d: "Thursday", 0x2e: "Friday", 0x2f: "Saturday", 0x30: "Sunday",
  0x31: "Mon", 0x32: "Tue", 0x33: "Wed", 0x34: "Thu", 0x35: "Fri", 0x36: "Sat", 0x37: "Sun",
  0x38: "January", 0x39: "February", 0x3a: "March", 0x3b: "April", 0x3c: "May", 0x3d: "June", 0x3e: "July", 0x3f: "August", 0x40: "September",
  0x41: "October", 0x42: "November", 0x43: "December", 0x44: "Jan", 0x45: "Feb", 0x46: "Mar", 0x47: "Apr", 0x48: "May", 0x49: "Jun", 0x4a: "Jul",
  0x4b: "Aug", 0x4c: "Sep", 0x4d: "Oct", 0x4e: "Nov", 0x4f: "Dec", 0x50: "", 0x51: "-", 0x52: "3", 0x53: "0", 0x54: "1", 0x55: "0", 0x56: "1", 0x57: "0",
  0x58: "0", 0x59: "en", 0x5a: "US", 0x5b: "ENU", 0x5c: "en-US", 0x1001: "English", 0x1002: "United States", 0x1003: "h:mm:ss tt", 0x1004: "1252",
  0x1005: "437", 0x1006: "10000", 0x100b: "1", 0x100c: "6", 0x100d: "0", 0x1010: "1", 0x1011: "10000", 0x1014: "en-US", 0x1015: "en",
  0x1016: "0", 0x1017: "0", 0x1018: "USA", 0x1019: "US", 0x101a: "0409", 0x2000: "ENU", 0x2001: "1", 0x2002: "0", 0x2003: "0", 0x2004: "0",
  0x2005: "0", 0x2006: "0", 0x2007: "0", 0x2008: "0", 0x2009: "0", 0x200a: "0", 0x200b: "0", 0x200c: "0", 0x200d: "0", 0x200e: "0",
  0x200f: "0", 0x2010: "0", 0x2011: "0", 0x2012: "0", 0x2013: "0", 0x2014: "0", 0x2015: "0", 0x2016: "0", 0x2017: "0", 0x2018: "0", 0x2019: "0",
};

export function installKernel32Strings(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;

  const cpOf = (cp: number) => (cp === CP_ACP ? 1252 : cp === CP_OEMCP ? 437 : cp);
  k.fn("GetACP", () => 1252);
  k.fn("GetOEMCP", () => 437);
  k.fn("IsValidCodePage", (c) => ([437, 850, 1252, 28591, 65001, 1250, 1251, 932, 936, 949, 950, 20127].includes(c.arg(0)) ? 1 : 0));
  k.fn("GetCPInfo", (c) => {
    const a = c.arg(1);
    mem.fill(a, 0, 20);
    mem.w32(a, c.arg(0) === CP_UTF8 ? 4 : 1);
    mem.w8(a + 4, 0x3f);
    return 1;
  });
  k.fn("GetCPInfoExA", (c) => { mem.fill(c.arg(2), 0, 20); mem.w32(c.arg(2), 1); return 1; });
  k.fn("IsDBCSLeadByte", () => 0);
  k.fn("IsDBCSLeadByteEx", () => 0);
  k.fn("IsValidLocale", () => 1);
  k.fn("IsValidLocaleName", () => 1);
  k.fn("IsNLSDefinedString", () => 1);

  k.fn("MultiByteToWideChar", (c) => {
    const cp = cpOf(c.arg(0)), flags = c.arg(1), src = c.arg(2);
    let n = c.argI(3);
    const dst = c.arg(4), cap = c.argI(5);
    if (!src) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    const withNul = n === -1;
    if (withNul) { n = 0; while (mem.r8(src + n)) n++; n++; }
    const bytes = mem.bytes(src, n);
    let str: string;
    if (cp === CP_UTF8 && (flags & MB_ERR_INVALID_CHARS)) {
      try { str = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { p.setLastError(ERROR.NO_UNICODE_TRANSLATION); return 0; }
    } else str = decodeAnsi(cp, bytes);
    if (cap === 0) return str.length;
    if (str.length > cap) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
    for (let i = 0; i < str.length; i++) mem.w16(dst + i * 2, str.charCodeAt(i));
    return str.length;
  });
  k.fn("WideCharToMultiByte", (c) => {
    const cp = cpOf(c.arg(0)), src = c.arg(2);
    let n = c.argI(3);
    const dst = c.arg(4), cap = c.argI(5), usedDef = c.arg(7);
    if (!src) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    const withNul = n === -1;
    if (withNul) { n = 0; while (mem.r16(src + n * 2)) n++; n++; }
    const str = mem.wstrn(src, n);
    const { bytes, usedDefault } = encodeAnsi(cp, str);
    if (usedDef) mem.w32(usedDef, usedDefault ? 1 : 0);
    if (cap === 0) return bytes.length;
    if (bytes.length > cap) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
    mem.write(dst, bytes);
    return bytes.length;
  });

  k.fn("lstrlenA", (c) => (c.arg(0) ? mem.cstr(c.arg(0)).length : 0));
  k.fn("lstrlenW", (c) => (c.arg(0) ? mem.wstr(c.arg(0)).length : 0));
  k.fn("lstrcpyA", (c) => { mem.wcstr(c.arg(0), mem.cstr(c.arg(1))); return c.arg(0); });
  k.fn("lstrcpyW", (c) => { mem.wwstr(c.arg(0), mem.wstr(c.arg(1))); return c.arg(0); });
  k.fn("lstrcpynA", (c) => { mem.wcstr(c.arg(0), mem.cstr(c.arg(1)), c.argI(2)); return c.arg(0); });
  k.fn("lstrcpynW", (c) => { mem.wwstr(c.arg(0), mem.wstr(c.arg(1)), c.argI(2)); return c.arg(0); });
  k.fn("lstrcatA", (c) => { mem.wcstr(c.arg(0), mem.cstr(c.arg(0)) + mem.cstr(c.arg(1))); return c.arg(0); });
  k.fn("lstrcatW", (c) => { mem.wwstr(c.arg(0), mem.wstr(c.arg(0)) + mem.wstr(c.arg(1))); return c.arg(0); });
  const cmp = (a: string, b: string, ic: boolean) => {
    if (ic) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  };
  k.fn("lstrcmpA", (c) => cmp(mem.cstr(c.arg(0)), mem.cstr(c.arg(1)), false));
  k.fn("lstrcmpW", (c) => cmp(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), false));
  k.fn("lstrcmpiA", (c) => cmp(mem.cstr(c.arg(0)), mem.cstr(c.arg(1)), true));
  k.fn("lstrcmpiW", (c) => cmp(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), true));

  // CompareString family (CSTR_LESS_THAN=1, EQUAL=2, GREATER_THAN=3)
  const compareW = (flags: number, a: string, b: string) => {
    if (flags & 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (flags & 0x10000000) { a = a.replace(/[^\p{L}\p{N}]/gu, ""); b = b.replace(/[^\p{L}\p{N}]/gu, ""); }
    return a < b ? 1 : a > b ? 3 : 2;
  };
  const rdA = (ptr: number, n: number) => {
    if (n === -1) return mem.cstr(ptr);
    return decodeAnsi(1252, mem.bytes(ptr, n));
  };
  const rdW = (ptr: number, n: number) => (n === -1 ? mem.wstr(ptr) : mem.wstrn(ptr, n));
  k.fn("CompareStringA", (c) => compareW(c.arg(1), rdA(c.arg(2), c.argI(3)), rdA(c.arg(4), c.argI(5))));
  k.fn("CompareStringW", (c) => compareW(c.arg(1), rdW(c.arg(2), c.argI(3)), rdW(c.arg(4), c.argI(5))));
  k.fn("CompareStringEx", (c) => compareW(c.arg(1), rdW(c.arg(2), c.argI(3)), rdW(c.arg(4), c.argI(5))));
  k.fn("CompareStringOrdinal", (c) => compareW(c.arg(4) ? 1 : 0, rdW(c.arg(0), c.argI(1)), rdW(c.arg(2), c.argI(3))));

  const LCMAP_LOWERCASE = 0x100, LCMAP_UPPERCASE = 0x200, LCMAP_SORTKEY = 0x400;
  const lcmap = (flags: number, s: string, dst: number, cap: number, wide: boolean) => {
    if (flags & LCMAP_SORTKEY) {
      const key = new TextEncoder().encode(s.toLowerCase());
      const out = [...key, 1, 1, 1, 0];
      if (cap === 0) return out.length;
      if (out.length > cap) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
      mem.write(dst, out);
      return out.length;
    }
    let r = s;
    if (flags & LCMAP_LOWERCASE) r = s.toLowerCase();
    else if (flags & LCMAP_UPPERCASE) r = s.toUpperCase();
    if (cap === 0) return r.length;
    if (r.length > cap) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
    if (wide) for (let i = 0; i < r.length; i++) mem.w16(dst + i * 2, r.charCodeAt(i));
    else for (let i = 0; i < r.length; i++) mem.w8(dst + i, r.charCodeAt(i) & 0xff);
    return r.length;
  };
  k.fn("LCMapStringW", (c) => lcmap(c.arg(1), rdW(c.arg(2), c.argI(3)), c.arg(4), c.argI(5), true));
  k.fn("LCMapStringA", (c) => lcmap(c.arg(1), rdA(c.arg(2), c.argI(3)), c.arg(4), c.argI(5), false));
  k.fn("LCMapStringEx", (c) => lcmap(c.arg(1), rdW(c.arg(2), c.argI(3)), c.arg(4), c.argI(5), true));

  // GetStringType: CT_CTYPE1 bits
  const ctype1 = (ch: number): number => {
    const s = String.fromCharCode(ch);
    let m = 0;
    if (/\p{Lu}/u.test(s)) m |= 1 | 0x100;
    if (/\p{Ll}/u.test(s)) m |= 2 | 0x100;
    if (/\p{Lo}|\p{Lt}|\p{Lm}/u.test(s)) m |= 0x100;
    if (/\p{Nd}/u.test(s)) m |= 4;
    if (/\s/u.test(s) && ch !== 0x1c) m |= 8;
    if (/[\p{P}\p{S}]/u.test(s)) m |= 0x10;
    if (ch < 0x20 || ch === 0x7f || (ch >= 0x80 && ch < 0xa0)) m |= 0x20;
    if (ch === 0x20 || ch === 9) m |= 0x40;
    if (/[0-9a-fA-F]/.test(s)) m |= 0x80;
    if (!m) m = 0;
    else m |= 0x200 & 0;
    return m;
  };
  const stringType = (type: number, src: number, n: number, out: number, wide: boolean) => {
    if (n === -1) { n = 0; if (wide) while (mem.r16(src + n * 2)) n++; else while (mem.r8(src + n)) n++; n++; }
    for (let i = 0; i < n; i++) {
      const ch = wide ? mem.r16(src + i * 2) : mem.r8(src + i);
      let v = 0;
      if (type === 1) v = ctype1(ch);
      else if (type === 2) v = ch >= 0x20 ? 1 : 0; // C2_LEFTTORIGHT
      else if (type === 4) { v = 0; if (/\p{M}/u.test(String.fromCharCode(ch))) v |= 2; if (/\p{L}/u.test(String.fromCharCode(ch))) v |= 0x40; }
      mem.w16(out + i * 2, v);
    }
    return 1;
  };
  k.fn("GetStringTypeW", (c) => stringType(c.arg(0), c.arg(1), c.argI(2), c.arg(3), true));
  k.fn("GetStringTypeA", (c) => stringType(c.arg(1), c.arg(2), c.argI(3), c.arg(4), false));
  k.fn("GetStringTypeExA", (c) => stringType(c.arg(1), c.arg(2), c.argI(3), c.arg(4), false));
  k.fn("GetStringTypeExW", (c) => stringType(c.arg(1), c.arg(2), c.argI(3), c.arg(4), true));

  // ---- locale ----
  const LOCALE_RETURN_NUMBER = 0x20000000;
  const localeInfo = (type: number, buf: number, cap: number, wide: boolean) => {
    const num = (type & LOCALE_RETURN_NUMBER) !== 0;
    type &= ~LOCALE_RETURN_NUMBER & ~0x80000000;
    let s = LOCALE_EN_US[type];
    if (s === undefined) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    if (num) {
      mem.w32(buf, parseInt(s, 10) || 0);
      return 2;
    }
    if (cap === 0) return s.length + 1;
    if (s.length + 1 > cap) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
    if (wide) mem.wwstr(buf, s); else mem.wcstr(buf, s);
    return s.length + 1;
  };
  k.fn("GetLocaleInfoA", (c) => localeInfo(c.arg(1), c.arg(2), c.argI(3), false));
  k.fn("GetLocaleInfoW", (c) => localeInfo(c.arg(1), c.arg(2), c.argI(3), true));
  k.fn("GetLocaleInfoEx", (c) => localeInfo(c.arg(1), c.arg(2), c.argI(3), true));
  k.fn("SetLocaleInfoA", () => 1);
  k.fn("SetLocaleInfoW", () => 1);
  k.fn("GetUserDefaultLCID", () => 0x409);
  k.fn("GetSystemDefaultLCID", () => 0x409);
  k.fn("GetUserDefaultLangID", () => 0x409);
  k.fn("GetSystemDefaultLangID", () => 0x409);
  k.fn("GetThreadLocale", () => 0x409);
  k.fn("SetThreadLocale", () => 1);
  k.fn("GetUserDefaultUILanguage", () => 0x409);
  k.fn("GetSystemDefaultUILanguage", () => 0x409);
  k.fn("GetUserDefaultLocaleName", (c) => { mem.wwstr(c.arg(0), "en-US", c.argI(1)); return 6; });
  k.fn("GetSystemDefaultLocaleName", (c) => { mem.wwstr(c.arg(0), "en-US", c.argI(1)); return 6; });
  k.fn("LCIDToLocaleName", (c) => { if (c.arg(2) >= 6) mem.wwstr(c.arg(1), "en-US"); return 6; });
  k.fn("LocaleNameToLCID", () => 0x409);
  k.fn("GetUserPreferredUILanguages", (c) => { mem.w32(c.arg(1), 1); const need = "en-US".length + 2 + 1; if (c.arg(2)) { if (mem.r32(c.arg(3)) >= need) { mem.wwstr(c.arg(2), "en-US"); mem.w16(c.arg(2) + 12, 0); } mem.w32(c.arg(3), need); } return 1; });
  k.fn("GetThreadPreferredUILanguages", (c) => { mem.w32(c.arg(1), 1); mem.w32(c.arg(3), 0); return 1; });
  k.fn("EnumSystemLocalesA", () => 1);
  k.fn("EnumSystemLocalesW", () => 1);
  k.fn("EnumSystemLocalesEx", (c) => { const fn = c.arg(0); const buf = p.vm.alloc(0x1000, { commit: true }); mem.wwstr(buf, "en-US"); p.callGuest(fn, [buf, 0, c.arg64(3)]); return 1; });
  k.fn("EnumSystemCodePagesA", () => 1);
  k.fn("EnumSystemCodePagesW", () => 1);
  k.fn("EnumSystemLanguageGroupsA", () => 1);
  k.fn("GetGeoInfoA", () => 0);
  k.fn("GetUserGeoID", () => 244);
  k.fn("GetNumberFormatW", (c) => {
    const s = mem.wstr(c.arg(2));
    if (c.arg(4) && c.argI(5) > s.length) mem.wwstr(c.arg(4), s);
    return s.length + 1;
  });
  k.fn("GetCurrencyFormatW", (c) => {
    const s = "$" + mem.wstr(c.arg(2));
    if (c.arg(4) && c.argI(5) > s.length) mem.wwstr(c.arg(4), s);
    return s.length + 1;
  });
  k.fn("FormatMessageW", (c) => {
    const flags = c.arg(0), id = c.arg(2);
    let text = `Error ${id}\r\n`;
    if (flags & 0x400) { /* FROM_STRING handled below */ }
    if (flags & 0x100) text = text; // ALLOCATE_BUFFER
    if (flags & 0x800 && c.arg(1)) text = mem.wstr(c.arg(1)); // FROM_STRING
    if (flags & 0x100) {
      const a = p.processHeap.alloc((text.length + 1) * 2);
      mem.wwstr(a, text);
      mem.wptr(c.arg(4), a);
    } else {
      if (c.arg(5) < text.length + 1) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
      mem.wwstr(c.arg(4), text);
    }
    return text.length;
  });
  k.fn("FormatMessageA", (c) => {
    const flags = c.arg(0), id = c.arg(2);
    let text = `Error ${id}\r\n`;
    if (flags & 0x800 && c.arg(1)) text = mem.cstr(c.arg(1));
    if (flags & 0x100) {
      const a = p.processHeap.alloc(text.length + 1);
      mem.wcstr(a, text);
      mem.wptr(c.arg(4), a);
    } else {
      if (c.arg(5) < text.length + 1) { p.setLastError(ERROR.INSUFFICIENT_BUFFER); return 0; }
      mem.wcstr(c.arg(4), text);
    }
    return text.length;
  });
  k.fn("MulDiv", (c) => {
    const a = BigInt(c.argI(0)), b = BigInt(c.argI(1)), d = BigInt(c.argI(2));
    if (d === 0n) return -1;
    let r = a * b;
    const half = (d < 0n ? -d : d) / 2n;
    r = (r >= 0n) === (d > 0n) ? (r + (r >= 0n ? half : -half)) / d : (r - (r >= 0n ? -half : half)) / d;
    return Number(BigInt.asIntN(32, r));
  });
  void CP_UTF7; void WC_NO_BEST_FIT_CHARS;
}
