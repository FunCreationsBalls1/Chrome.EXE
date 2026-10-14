// Build a minimal in-memory PE image for an HLE module so that guest code which walks export tables by hand keeps working.
export interface SynthExport {
  name: string | null;
  ordinal: number;
  /** guest address that the export resolves to (a stub jumps there) */
  target: number;
}

/** Returns the image bytes (SizeOfImage long) laid out for loading at `base`. */
export function buildSyntheticDll(dllName: string, base: number, exports: SynthExport[]): Uint8Array {
  const named = exports.filter((e) => e.name !== null).sort((a, b) => (a.name! < b.name! ? -1 : a.name! > b.name! ? 1 : 0));
  const maxOrd = Math.max(0, ...exports.map((e) => e.ordinal));
  const minOrd = Math.min(...exports.map((e) => e.ordinal), 1);
  const nFuncs = maxOrd - minOrd + 1;
  const enc = new TextEncoder();
  const HDRSZ = 0x200;
  // layout inside the single section (RVA = 0x1000 + offset)
  let off = 0;
  const stubOff = off;
  off += exports.length * 16;
  const expDirOff = off; off += 40;
  const funcsOff = off; off += nFuncs * 4;
  const namesOff = off; off += named.length * 4;
  const ordsOff = off; off += named.length * 2;
  const dllNameOff = off; off += dllName.length + 1;
  const strOffs: number[] = [];
  for (const e of named) { strOffs.push(off); off += e.name!.length + 1; }
  const secSize = Math.ceil(off / 16) * 16;
  const size = 0x1000 + Math.ceil(secSize / 0x1000) * 0x1000;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x4d; out[1] = 0x5a; dv.setUint32(0x3c, 0x80, true);
  const pe = 0x80;
  dv.setUint32(pe, 0x4550, true);
  dv.setUint16(pe + 4, 0x8664, true);
  dv.setUint16(pe + 6, 1, true);
  dv.setUint16(pe + 20, 240, true);
  dv.setUint16(pe + 22, 0x2022, true); // DLL | executable | large address aware
  const opt = pe + 24;
  dv.setUint16(opt, 0x20b, true);
  dv.setUint32(opt + 16, 0x1000, true);
  dv.setBigUint64(opt + 24, BigInt(base), true);
  dv.setUint32(opt + 32, 0x1000, true);
  dv.setUint32(opt + 36, 0x200, true);
  dv.setUint16(opt + 40, 6, true); dv.setUint16(opt + 48, 6, true);
  dv.setUint32(opt + 56, size, true);
  dv.setUint32(opt + 60, HDRSZ, true);
  dv.setUint16(opt + 68, 3, true);
  dv.setUint32(opt + 108, 16, true);
  const expRva = 0x1000 + expDirOff;
  dv.setUint32(opt + 112, expRva, true);
  dv.setUint32(opt + 116, 40 + nFuncs * 4 + named.length * 6, true);
  const sec = opt + 240 - 112 + 112 - 112; // opt header is 240 bytes
  const s = pe + 24 + 240;
  void sec;
  enc.encodeInto(".text", out.subarray(s, s + 8));
  dv.setUint32(s + 8, secSize, true);
  dv.setUint32(s + 12, 0x1000, true);
  dv.setUint32(s + 16, secSize, true);
  dv.setUint32(s + 20, 0x200, true);
  dv.setUint32(s + 36, 0xe0000060, true);
  const S = 0x1000; // section base within our flat image
  // stubs: mov rax, imm64 ; jmp rax
  const stubRva = new Map<SynthExport, number>();
  exports.forEach((e, i) => {
    const o = S + stubOff + i * 16;
    out[o] = 0x48; out[o + 1] = 0xb8;
    dv.setBigUint64(o + 2, BigInt(e.target), true);
    out[o + 10] = 0xff; out[o + 11] = 0xe0;
    stubRva.set(e, 0x1000 + stubOff + i * 16);
  });
  // export directory
  const d = S + expDirOff;
  dv.setUint32(d + 12, 0x1000 + dllNameOff, true);
  dv.setUint32(d + 16, minOrd, true);
  dv.setUint32(d + 20, nFuncs, true);
  dv.setUint32(d + 24, named.length, true);
  dv.setUint32(d + 28, 0x1000 + funcsOff, true);
  dv.setUint32(d + 32, 0x1000 + namesOff, true);
  dv.setUint32(d + 36, 0x1000 + ordsOff, true);
  for (const e of exports) dv.setUint32(S + funcsOff + (e.ordinal - minOrd) * 4, stubRva.get(e)!, true);
  enc.encodeInto(dllName + "\0", out.subarray(S + dllNameOff));
  named.forEach((e, i) => {
    dv.setUint32(S + namesOff + i * 4, 0x1000 + strOffs[i], true);
    dv.setUint16(S + ordsOff + i * 2, e.ordinal - minOrd, true);
    enc.encodeInto(e.name! + "\0", out.subarray(S + strOffs[i]));
  });
  return out;
}
