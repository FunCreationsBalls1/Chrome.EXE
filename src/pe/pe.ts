// PE/COFF (PE32+) parser. Pure parsing, no memory mapping.

export interface Section {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawPtr: number;
  characteristics: number;
}

export interface ImportEntry {
  /** imported by name when set, else by ordinal */
  name: string | null;
  ordinal: number;
  hint: number;
  /** RVA of the IAT slot to patch */
  iatRva: number;
}
export interface ImportDescriptor {
  dll: string;
  entries: ImportEntry[];
}

export interface ExportEntry {
  name: string | null;
  ordinal: number;
  rva: number;
  /** "dll.func" or "dll.#ord" when the export is a forwarder */
  forwarder: string | null;
}

export interface RuntimeFunction {
  begin: number;
  end: number;
  unwind: number;
}

export interface PeImage {
  is64: boolean;
  machine: number;
  isDll: boolean;
  imageBase: bigint;
  entryRva: number;
  sizeOfImage: number;
  sizeOfHeaders: number;
  subsystem: number;
  dllCharacteristics: number;
  sections: Section[];
  dirs: { rva: number; size: number }[];
  sizeOfStackReserve: bigint;
  sizeOfStackCommit: bigint;
  sizeOfHeapReserve: bigint;
  checksum: number;
  timeDateStamp: number;
  majorOsVersion: number;
  minorOsVersion: number;
  hasRelocs: boolean;
}

export const DIR_EXPORT = 0, DIR_IMPORT = 1, DIR_RESOURCE = 2, DIR_EXCEPTION = 3, DIR_SECURITY = 4, DIR_BASERELOC = 5, DIR_DEBUG = 6,
  DIR_TLS = 9, DIR_LOAD_CONFIG = 10, DIR_BOUND_IMPORT = 11, DIR_IAT = 12, DIR_DELAY_IMPORT = 13, DIR_COM_DESCRIPTOR = 14;

export class PeError extends Error {}

export function parsePe(buf: Uint8Array): PeImage {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) throw new PeError("not a PE file (missing MZ header)");
  const peOff = dv.getUint32(0x3c, true);
  if (peOff + 24 > buf.length || dv.getUint32(peOff, true) !== 0x00004550) throw new PeError("missing PE signature");
  const machine = dv.getUint16(peOff + 4, true);
  const nSections = dv.getUint16(peOff + 6, true);
  const timeDateStamp = dv.getUint32(peOff + 8, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const characteristics = dv.getUint16(peOff + 22, true);
  const opt = peOff + 24;
  const magic = dv.getUint16(opt, true);
  if (magic !== 0x20b) {
    if (magic === 0x10b) throw new PeError("32-bit (PE32) executables are not supported yet: this image is 32-bit x86");
    throw new PeError("unknown optional header magic 0x" + magic.toString(16));
  }
  if (machine !== 0x8664) throw new PeError("unsupported machine type 0x" + machine.toString(16) + " (need x86-64)");
  const nDirs = dv.getUint32(opt + 108, true);
  const dirs: { rva: number; size: number }[] = [];
  for (let i = 0; i < 16; i++) {
    if (i < nDirs) dirs.push({ rva: dv.getUint32(opt + 112 + i * 8, true), size: dv.getUint32(opt + 116 + i * 8, true) });
    else dirs.push({ rva: 0, size: 0 });
  }
  const secBase = opt + optSize;
  const sections: Section[] = [];
  for (let i = 0; i < nSections; i++) {
    const o = secBase + i * 40;
    let name = "";
    for (let k = 0; k < 8 && buf[o + k]; k++) name += String.fromCharCode(buf[o + k]);
    sections.push({
      name,
      virtualSize: dv.getUint32(o + 8, true),
      virtualAddress: dv.getUint32(o + 12, true),
      rawSize: dv.getUint32(o + 16, true),
      rawPtr: dv.getUint32(o + 20, true),
      characteristics: dv.getUint32(o + 36, true),
    });
  }
  const dllChars = dv.getUint16(opt + 70, true);
  return {
    is64: true,
    machine,
    isDll: (characteristics & 0x2000) !== 0,
    imageBase: dv.getBigUint64(opt + 24, true),
    entryRva: dv.getUint32(opt + 16, true),
    sizeOfImage: dv.getUint32(opt + 56, true),
    sizeOfHeaders: dv.getUint32(opt + 60, true),
    subsystem: dv.getUint16(opt + 68, true),
    dllCharacteristics: dllChars,
    sections,
    dirs,
    sizeOfStackReserve: dv.getBigUint64(opt + 72, true),
    sizeOfStackCommit: dv.getBigUint64(opt + 80, true),
    sizeOfHeapReserve: dv.getBigUint64(opt + 88, true),
    checksum: dv.getUint32(opt + 64, true),
    timeDateStamp,
    majorOsVersion: dv.getUint16(opt + 40, true),
    minorOsVersion: dv.getUint16(opt + 42, true),
    hasRelocs: (characteristics & 1) === 0 && dirs[DIR_BASERELOC].size > 0,
  };
}

/** Convert RVA to a file offset using section table (headers map 1:1). */
export function rvaToOffset(img: PeImage, rva: number): number {
  if (rva < img.sizeOfHeaders) return rva;
  for (const s of img.sections) {
    const size = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
      const off = rva - s.virtualAddress;
      if (off >= s.rawSize) return -1; // zero-fill part
      return s.rawPtr + off;
    }
  }
  return -1;
}

function readCStr(buf: Uint8Array, off: number): string {
  let s = "";
  while (off < buf.length && buf[off]) s += String.fromCharCode(buf[off++]);
  return s;
}

/** Read helpers working on the raw file by RVA. */
export class RvaReader {
  buf: Uint8Array;
  img: PeImage;
  dv: DataView;
  constructor(buf: Uint8Array, img: PeImage) {
    this.buf = buf;
    this.img = img;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  off(rva: number): number {
    const o = rvaToOffset(this.img, rva);
    if (o < 0) throw new PeError("RVA 0x" + rva.toString(16) + " not backed by file data");
    return o;
  }
  u16(rva: number) { return this.dv.getUint16(this.off(rva), true); }
  u32(rva: number) { return this.dv.getUint32(this.off(rva), true); }
  u64(rva: number) { return this.dv.getBigUint64(this.off(rva), true); }
  str(rva: number) { return readCStr(this.buf, this.off(rva)); }
}

export function parseImports(buf: Uint8Array, img: PeImage): ImportDescriptor[] {
  const d = img.dirs[DIR_IMPORT];
  const out: ImportDescriptor[] = [];
  if (!d.rva) return out;
  const r = new RvaReader(buf, img);
  for (let p = d.rva; ; p += 20) {
    const oft = r.u32(p), nameRva = r.u32(p + 12), ft = r.u32(p + 16);
    if (!oft && !nameRva && !ft) break;
    out.push({ dll: r.str(nameRva), entries: readThunks(r, oft || ft, ft) });
  }
  return out;
}

function readThunks(r: RvaReader, lookupRva: number, iatRva: number): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (let i = 0; ; i++) {
    const v = r.u64(lookupRva + i * 8);
    if (v === 0n) break;
    if (v & 0x8000000000000000n) entries.push({ name: null, ordinal: Number(v & 0xffffn), hint: 0, iatRva: iatRva + i * 8 });
    else {
      const nrva = Number(v & 0x7fffffffn);
      entries.push({ name: r.str(nrva + 2), ordinal: 0, hint: r.u16(nrva), iatRva: iatRva + i * 8 });
    }
  }
  return entries;
}

export interface DelayImportDescriptor extends ImportDescriptor {
  /** RVA of the HMODULE slot */
  moduleSlotRva: number;
  attributes: number;
}
export function parseDelayImports(buf: Uint8Array, img: PeImage): DelayImportDescriptor[] {
  const d = img.dirs[DIR_DELAY_IMPORT];
  const out: DelayImportDescriptor[] = [];
  if (!d.rva) return out;
  const r = new RvaReader(buf, img);
  for (let p = d.rva; ; p += 32) {
    const attrs = r.u32(p), nameRva = r.u32(p + 4), modRva = r.u32(p + 8), iatRva = r.u32(p + 12), intRva = r.u32(p + 16);
    if (!nameRva) break;
    const rel = (attrs & 1) === 0 ? (v: number) => v : (v: number) => v; // RVA form assumed (attrs&1 set by modern linkers)
    out.push({ dll: r.str(rel(nameRva)), entries: readThunks(r, rel(intRva), rel(iatRva)), moduleSlotRva: modRva, attributes: attrs });
  }
  return out;
}

export function parseExports(buf: Uint8Array, img: PeImage): { name: string; entries: ExportEntry[]; ordinalBase: number } | null {
  const d = img.dirs[DIR_EXPORT];
  if (!d.rva) return null;
  const r = new RvaReader(buf, img);
  const name = r.str(r.u32(d.rva + 12));
  const base = r.u32(d.rva + 16);
  const nFuncs = r.u32(d.rva + 20), nNames = r.u32(d.rva + 24);
  const funcs = r.u32(d.rva + 28), names = r.u32(d.rva + 32), ords = r.u32(d.rva + 36);
  const byOrd = new Map<number, string>();
  for (let i = 0; i < nNames; i++) byOrd.set(r.u16(ords + i * 2), r.str(r.u32(names + i * 4)));
  const entries: ExportEntry[] = [];
  for (let i = 0; i < nFuncs; i++) {
    const rva = r.u32(funcs + i * 4);
    if (!rva) continue;
    const isFwd = rva >= d.rva && rva < d.rva + d.size;
    entries.push({ name: byOrd.get(i) ?? null, ordinal: base + i, rva, forwarder: isFwd ? r.str(rva) : null });
  }
  return { name, entries, ordinalBase: base };
}

export function parseRuntimeFunctions(buf: Uint8Array, img: PeImage): RuntimeFunction[] {
  const d = img.dirs[DIR_EXCEPTION];
  const out: RuntimeFunction[] = [];
  if (!d.rva) return out;
  const r = new RvaReader(buf, img);
  for (let p = d.rva; p + 12 <= d.rva + d.size; p += 12) out.push({ begin: r.u32(p), end: r.u32(p + 4), unwind: r.u32(p + 8) });
  return out;
}

export interface TlsInfo {
  startRaw: bigint;
  endRaw: bigint;
  indexAddr: bigint;
  callbacksAddr: bigint;
  zeroFill: number;
  characteristics: number;
}
export function parseTls(buf: Uint8Array, img: PeImage): TlsInfo | null {
  const d = img.dirs[DIR_TLS];
  if (!d.rva) return null;
  const r = new RvaReader(buf, img);
  return {
    startRaw: r.u64(d.rva), endRaw: r.u64(d.rva + 8), indexAddr: r.u64(d.rva + 16), callbacksAddr: r.u64(d.rva + 24),
    zeroFill: r.u32(d.rva + 32), characteristics: r.u32(d.rva + 36),
  };
}

export interface RelocBlock {
  pageRva: number;
  entries: { type: number; offset: number }[];
}
export function* iterRelocs(buf: Uint8Array, img: PeImage): Generator<{ rva: number; type: number }> {
  const d = img.dirs[DIR_BASERELOC];
  if (!d.rva) return;
  const r = new RvaReader(buf, img);
  let p = d.rva;
  const end = d.rva + d.size;
  while (p + 8 <= end) {
    const page = r.u32(p), size = r.u32(p + 4);
    if (size < 8) break;
    for (let q = p + 8; q + 2 <= p + size; q += 2) {
      const e = r.u16(q);
      yield { rva: page + (e & 0xfff), type: e >> 12 };
    }
    p += size;
  }
}

export interface ResourceEntry {
  type: number | string;
  id: number | string;
  lang: number;
  dataRva: number;
  size: number;
}
/** Walk the three-level resource directory. */
export function parseResources(buf: Uint8Array, img: PeImage): ResourceEntry[] {
  const d = img.dirs[DIR_RESOURCE];
  const out: ResourceEntry[] = [];
  if (!d.rva) return out;
  const r = new RvaReader(buf, img);
  const base = d.rva;
  const readName = (v: number): number | string => {
    if (v & 0x80000000) {
      const o = base + (v & 0x7fffffff);
      const n = r.u16(o);
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(r.u16(o + 2 + i * 2));
      return s;
    }
    return v;
  };
  const walk = (off: number, level: number, path: (number | string)[]) => {
    const nNamed = r.u16(off + 12), nId = r.u16(off + 14);
    for (let i = 0; i < nNamed + nId; i++) {
      const nm = r.u32(off + 16 + i * 8), tgt = r.u32(off + 20 + i * 8);
      const key = readName(nm);
      if (tgt & 0x80000000) {
        if (level < 3) walk(base + (tgt & 0x7fffffff), level + 1, [...path, key]);
      } else {
        const de = base + tgt;
        out.push({ type: path[0], id: path[1], lang: typeof key === "number" ? key : 0, dataRva: r.u32(de), size: r.u32(de + 4) });
      }
    }
  };
  walk(base, 1, []);
  return out;
}
