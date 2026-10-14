// Direct3D 9 surface formats: sizes, WebGPU equivalents, and CPU conversions for formats WebGPU has no native counterpart for.
import { D3DFMT, FOURCC } from "./d3d9-consts.ts";

export interface Fmt9 {
  id: number;
  name: string;
  /** bytes per pixel (or per block for compressed formats) in guest memory */
  bytes: number;
  /** block width/height in pixels (1 for uncompressed) */
  block: number;
  /** WebGPU format used on the GPU (uncompressed conversions upload into this) */
  gpu: GPUTextureFormat;
  /** bytes per pixel of `gpu` (per block for BC formats uploaded natively) */
  gpuBytes: number;
  depth?: boolean;
  stencil?: boolean;
  /** has a meaningful alpha channel */
  alpha?: boolean;
  /** convert tightly-or-pitched guest rows into gpu rows; absent when the layout is identical */
  convert?: (src: Uint8Array, srcPitch: number, dst: Uint8Array, dstPitch: number, w: number, h: number) => void;
  compressed?: "bc1" | "bc2" | "bc3" | "bc4" | "bc5";
  renderable?: boolean;
  /** srgb variant of the gpu format, if any */
  srgb?: GPUTextureFormat;
  /** the format can be a vertex-texture / filterable */
  filterable?: boolean;
}

const e5 = (v: number) => (v << 3) | (v >> 2);
const e6 = (v: number) => (v << 2) | (v >> 4);
const e4 = (v: number) => (v << 4) | v;

function conv16(f: (v: number) => [number, number, number, number]) {
  return (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
    for (let y = 0; y < h; y++) {
      let s = y * sp, d = y * dp;
      for (let x = 0; x < w; x++, s += 2, d += 4) {
        const [r, g, b, a] = f(src[s] | (src[s + 1] << 8));
        dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a;
      }
    }
  };
}
function conv8(f: (v: number) => [number, number, number, number]) {
  return (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
    for (let y = 0; y < h; y++) {
      let s = y * sp, d = y * dp;
      for (let x = 0; x < w; x++, s++, d += 4) {
        const [r, g, b, a] = f(src[s]);
        dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a;
      }
    }
  };
}

/** BGRA bytes in guest memory -> bgra8 with opaque alpha */
const forceOpaqueBgra = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  for (let y = 0; y < h; y++) {
    let s = y * sp, d = y * dp;
    for (let x = 0; x < w; x++, s += 4, d += 4) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; }
  }
};

// D3DFMT_R8G8B8: 24-bit BGR
const conv24 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  for (let y = 0; y < h; y++) {
    let s = y * sp, d = y * dp;
    for (let x = 0; x < w; x++, s += 3, d += 4) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; }
  }
};

const half = (() => {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return (v: number): number => {
    f[0] = v;
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    let m = (x >>> 13) & 0x3ff;
    if (e <= 0) { if (e < -10) return sign; m = (m | 0x400) >> (1 - e); return sign | m; }
    if (e >= 31) return sign | 0x7c00;
    return sign | (e << 10) | m;
  };
})();

const convU16x4ToHalf = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  const sv = new DataView(src.buffer, src.byteOffset, src.byteLength), dv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) dv.setUint16(y * dp + x * 8 + c * 2, half(sv.getUint16(y * sp + x * 8 + c * 2, true) / 65535), true);
};
const convG16R16 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * dp + x * 4, s = y * sp + x * 4;
    // D3DFMT_G16R16: R in the low word
    dst[o] = sv.getUint16(s, true) >> 8; dst[o + 1] = sv.getUint16(s + 2, true) >> 8; dst[o + 2] = 0; dst[o + 3] = 255;
  }
};
const convL16 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * sp + x * 2, o = y * dp + x * 4;
    const v = src[s + 1];
    dst[o] = v; dst[o + 1] = v; dst[o + 2] = v; dst[o + 3] = 255;
  }
};

function mk(id: number, name: string, bytes: number, gpu: GPUTextureFormat, gpuBytes: number, extra: Partial<Fmt9> = {}): Fmt9 {
  return { id, name, bytes, block: 1, gpu, gpuBytes, ...extra };
}

export const FORMATS9: Fmt9[] = [
  mk(D3DFMT.A8R8G8B8, "A8R8G8B8", 4, "bgra8unorm", 4, { alpha: true, renderable: true, srgb: "bgra8unorm-srgb", filterable: true }),
  mk(D3DFMT.X8R8G8B8, "X8R8G8B8", 4, "bgra8unorm", 4, { renderable: true, srgb: "bgra8unorm-srgb", convert: forceOpaqueBgra, filterable: true }),
  mk(D3DFMT.A8B8G8R8, "A8B8G8R8", 4, "rgba8unorm", 4, { alpha: true, renderable: true, srgb: "rgba8unorm-srgb", filterable: true }),
  mk(D3DFMT.X8B8G8R8, "X8B8G8R8", 4, "rgba8unorm", 4, { renderable: true, srgb: "rgba8unorm-srgb", filterable: true, convert: forceOpaqueBgra }),
  mk(D3DFMT.R8G8B8, "R8G8B8", 3, "bgra8unorm", 4, { convert: conv24, srgb: "bgra8unorm-srgb", filterable: true }),
  mk(D3DFMT.R5G6B5, "R5G6B5", 2, "rgba8unorm", 4, { renderable: true, filterable: true, srgb: "rgba8unorm-srgb", convert: conv16((v) => [e5((v >> 11) & 31), e6((v >> 5) & 63), e5(v & 31), 255]) }),
  mk(D3DFMT.X1R5G5B5, "X1R5G5B5", 2, "rgba8unorm", 4, { renderable: true, filterable: true, srgb: "rgba8unorm-srgb", convert: conv16((v) => [e5((v >> 10) & 31), e5((v >> 5) & 31), e5(v & 31), 255]) }),
  mk(D3DFMT.A1R5G5B5, "A1R5G5B5", 2, "rgba8unorm", 4, { alpha: true, renderable: true, filterable: true, srgb: "rgba8unorm-srgb", convert: conv16((v) => [e5((v >> 10) & 31), e5((v >> 5) & 31), e5(v & 31), v & 0x8000 ? 255 : 0]) }),
  mk(D3DFMT.A4R4G4B4, "A4R4G4B4", 2, "rgba8unorm", 4, { alpha: true, renderable: true, filterable: true, srgb: "rgba8unorm-srgb", convert: conv16((v) => [e4((v >> 8) & 15), e4((v >> 4) & 15), e4(v & 15), e4((v >> 12) & 15)]) }),
  mk(D3DFMT.X4R4G4B4, "X4R4G4B4", 2, "rgba8unorm", 4, { renderable: true, filterable: true, srgb: "rgba8unorm-srgb", convert: conv16((v) => [e4((v >> 8) & 15), e4((v >> 4) & 15), e4(v & 15), 255]) }),
  mk(D3DFMT.R3G3B2, "R3G3B2", 1, "rgba8unorm", 4, { filterable: true, convert: conv8((v) => [(((v >> 5) & 7) * 255) / 7, (((v >> 2) & 7) * 255) / 7, ((v & 3) * 255) / 3, 255]) }),
  mk(D3DFMT.A8R3G3B2, "A8R3G3B2", 2, "rgba8unorm", 4, { alpha: true, filterable: true, convert: conv16((v) => [(((v >> 5) & 7) * 255) / 7, (((v >> 2) & 7) * 255) / 7, ((v & 3) * 255) / 3, v >> 8]) }),
  mk(D3DFMT.A8, "A8", 1, "rgba8unorm", 4, { alpha: true, filterable: true, convert: conv8((v) => [0, 0, 0, v]) }),
  mk(D3DFMT.L8, "L8", 1, "rgba8unorm", 4, { filterable: true, convert: conv8((v) => [v, v, v, 255]) }),
  mk(D3DFMT.A8L8, "A8L8", 2, "rgba8unorm", 4, { alpha: true, filterable: true, convert: conv16((v) => [v & 255, v & 255, v & 255, v >> 8]) }),
  mk(D3DFMT.A4L4, "A4L4", 1, "rgba8unorm", 4, { alpha: true, filterable: true, convert: conv8((v) => [e4(v & 15), e4(v & 15), e4(v & 15), e4(v >> 4)]) }),
  mk(D3DFMT.L16, "L16", 2, "rgba8unorm", 4, { filterable: true, convert: convL16 }),
  mk(D3DFMT.G16R16, "G16R16", 4, "rgba8unorm", 4, { filterable: true, renderable: true, convert: convG16R16 }),
  mk(D3DFMT.A16B16G16R16, "A16B16G16R16", 8, "rgba16float", 8, { alpha: true, filterable: true, renderable: true, convert: convU16x4ToHalf }),
  mk(D3DFMT.A2B10G10R10, "A2B10G10R10", 4, "rgb10a2unorm", 4, { alpha: true, renderable: true, filterable: true }),
  mk(D3DFMT.A2R10G10B10, "A2R10G10B10", 4, "rgb10a2unorm", 4, { alpha: true, renderable: true, filterable: true, convert: (src, sp, dst, dp, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = y * sp + x * 4, o = y * dp + x * 4;
      const v = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) >>> 0;
      const b = v & 1023, g = (v >> 10) & 1023, r = (v >> 20) & 1023, a = v >>> 30;
      const o32 = (r | (g << 10) | (b << 20) | (a << 30)) >>> 0;
      dst[o] = o32 & 255; dst[o + 1] = (o32 >> 8) & 255; dst[o + 2] = (o32 >> 16) & 255; dst[o + 3] = o32 >>> 24;
    }
  } }),
  mk(D3DFMT.R16F, "R16F", 2, "r16float", 2, { renderable: true, filterable: true }),
  mk(D3DFMT.G16R16F, "G16R16F", 4, "rg16float", 4, { renderable: true, filterable: true }),
  mk(D3DFMT.A16B16G16R16F, "A16B16G16R16F", 8, "rgba16float", 8, { alpha: true, renderable: true, filterable: true }),
  mk(D3DFMT.R32F, "R32F", 4, "r32float", 4, { renderable: true }),
  mk(D3DFMT.G32R32F, "G32R32F", 8, "rg32float", 8, { renderable: true }),
  mk(D3DFMT.A32B32G32R32F, "A32B32G32R32F", 16, "rgba32float", 16, { alpha: true, renderable: true }),
  mk(D3DFMT.V8U8, "V8U8", 2, "rg8snorm", 2, { filterable: true }),
  mk(D3DFMT.Q8W8V8U8, "Q8W8V8U8", 4, "rgba8snorm", 4, { alpha: true, filterable: true }),
  mk(D3DFMT.A8P8, "A8P8", 2, "rgba8unorm", 4, { alpha: true }),
  mk(D3DFMT.P8, "P8", 1, "rgba8unorm", 4),
  // depth/stencil
  mk(D3DFMT.D16, "D16", 2, "depth16unorm", 2, { depth: true }),
  mk(D3DFMT.D16_LOCKABLE, "D16_LOCKABLE", 2, "depth16unorm", 2, { depth: true }),
  mk(D3DFMT.D32, "D32", 4, "depth32float", 4, { depth: true }),
  mk(D3DFMT.D32F_LOCKABLE, "D32F_LOCKABLE", 4, "depth32float", 4, { depth: true }),
  mk(D3DFMT.D24X8, "D24X8", 4, "depth24plus", 4, { depth: true }),
  mk(D3DFMT.D24S8, "D24S8", 4, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(D3DFMT.D24FS8, "D24FS8", 4, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(D3DFMT.D24X4S4, "D24X4S4", 4, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(D3DFMT.D15S1, "D15S1", 2, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(D3DFMT.S8_LOCKABLE, "S8_LOCKABLE", 1, "stencil8", 1, { stencil: true }),
  // FOURCC
  { id: FOURCC.DXT1, name: "DXT1", bytes: 8, block: 4, gpu: "bc1-rgba-unorm", gpuBytes: 8, alpha: true, compressed: "bc1", srgb: "bc1-rgba-unorm-srgb", filterable: true },
  { id: FOURCC.DXT2, name: "DXT2", bytes: 16, block: 4, gpu: "bc2-rgba-unorm", gpuBytes: 16, alpha: true, compressed: "bc2", srgb: "bc2-rgba-unorm-srgb", filterable: true },
  { id: FOURCC.DXT3, name: "DXT3", bytes: 16, block: 4, gpu: "bc2-rgba-unorm", gpuBytes: 16, alpha: true, compressed: "bc2", srgb: "bc2-rgba-unorm-srgb", filterable: true },
  { id: FOURCC.DXT4, name: "DXT4", bytes: 16, block: 4, gpu: "bc3-rgba-unorm", gpuBytes: 16, alpha: true, compressed: "bc3", srgb: "bc3-rgba-unorm-srgb", filterable: true },
  { id: FOURCC.DXT5, name: "DXT5", bytes: 16, block: 4, gpu: "bc3-rgba-unorm", gpuBytes: 16, alpha: true, compressed: "bc3", srgb: "bc3-rgba-unorm-srgb", filterable: true },
  { id: FOURCC.ATI1, name: "ATI1", bytes: 8, block: 4, gpu: "bc4-r-unorm", gpuBytes: 8, compressed: "bc4", filterable: true },
  { id: FOURCC.ATI2, name: "ATI2", bytes: 16, block: 4, gpu: "bc5-rg-unorm", gpuBytes: 16, compressed: "bc5", filterable: true },
  // depth textures exposed through FOURCC formats
  mk(FOURCC.INTZ, "INTZ", 4, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(FOURCC.DF24, "DF24", 4, "depth24plus", 4, { depth: true }),
  mk(FOURCC.DF16, "DF16", 2, "depth16unorm", 2, { depth: true }),
  mk(FOURCC.RAWZ, "RAWZ", 4, "depth24plus-stencil8", 4, { depth: true, stencil: true }),
  mk(FOURCC.NULL, "NULL", 4, "rgba8unorm", 4, { renderable: true }),
];
const BY_ID = new Map<number, Fmt9>(FORMATS9.map((f) => [f.id, f]));
export function fmt9(id: number): Fmt9 | undefined { return BY_ID.get(id); }

// ---------------------------------------------------------------------------------------------------------------
// BC1/BC2/BC3 software decoder (used when the device lacks texture-compression-bc)
// ---------------------------------------------------------------------------------------------------------------
function decodeBc1Color(src: Uint8Array, o: number, out: Uint8Array, base: number, stride: number, transparent: boolean) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  const pal = new Uint8Array(16);
  const rgb = (c: number, i: number) => { pal[i * 4] = e5((c >> 11) & 31); pal[i * 4 + 1] = e6((c >> 5) & 63); pal[i * 4 + 2] = e5(c & 31); pal[i * 4 + 3] = 255; };
  rgb(c0, 0); rgb(c1, 1);
  if (c0 > c1 || !transparent) {
    for (let k = 0; k < 3; k++) { pal[8 + k] = ((2 * pal[k] + pal[4 + k]) / 3) | 0; pal[12 + k] = ((pal[k] + 2 * pal[4 + k]) / 3) | 0; }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k++) { pal[8 + k] = (pal[k] + pal[4 + k]) >> 1; pal[12 + k] = 0; }
    pal[11] = 255; pal[15] = 0;
  }
  const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const idx = (bits >>> (i * 2)) & 3;
    const d = base + (i >> 2) * stride + (i & 3) * 4;
    out[d] = pal[idx * 4]; out[d + 1] = pal[idx * 4 + 1]; out[d + 2] = pal[idx * 4 + 2]; out[d + 3] = pal[idx * 4 + 3];
  }
}
function decodeAlphaBlock(src: Uint8Array, o: number, out: Uint8Array, base: number, stride: number, ch: number) {
  const a0 = src[o], a1 = src[o + 1];
  const pal = new Uint8Array(8);
  pal[0] = a0; pal[1] = a1;
  if (a0 > a1) for (let i = 1; i < 7; i++) pal[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
  else { for (let i = 1; i < 5; i++) pal[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0; pal[6] = 0; pal[7] = 255; }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(src[o + 2 + i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) out[base + (i >> 2) * stride + (i & 3) * 4 + ch] = pal[Number((bits >> BigInt(i * 3)) & 7n)];
}
export function decodeBc(kind: "bc1" | "bc2" | "bc3" | "bc4" | "bc5", src: Uint8Array, srcPitch: number, w: number, h: number): { data: Uint8Array; pitch: number } {
  const pitch = w * 4;
  const out = new Uint8Array(pitch * h);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bsz = kind === "bc1" || kind === "bc4" ? 8 : 16;
  // decode into a padded buffer then crop
  const pw = bw * 4, ph = bh * 4;
  const tmp = new Uint8Array(pw * ph * 4);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = by * srcPitch + bx * bsz;
    const base = (by * 4 * pw + bx * 4) * 4;
    switch (kind) {
      case "bc1": decodeBc1Color(src, o, tmp, base, pw * 4, true); break;
      case "bc2": {
        decodeBc1Color(src, o + 8, tmp, base, pw * 4, false);
        for (let i = 0; i < 16; i++) { const v = (src[o + (i >> 1)] >> ((i & 1) * 4)) & 15; tmp[base + (i >> 2) * pw * 4 + (i & 3) * 4 + 3] = e4(v); }
        break;
      }
      case "bc3": decodeBc1Color(src, o + 8, tmp, base, pw * 4, false); decodeAlphaBlock(src, o, tmp, base, pw * 4, 3); break;
      case "bc4": decodeAlphaBlock(src, o, tmp, base, pw * 4, 0); for (let i = 0; i < 16; i++) { const d = base + (i >> 2) * pw * 4 + (i & 3) * 4; tmp[d + 3] = 255; } break;
      case "bc5": decodeAlphaBlock(src, o, tmp, base, pw * 4, 0); decodeAlphaBlock(src, o + 8, tmp, base, pw * 4, 1); for (let i = 0; i < 16; i++) tmp[base + (i >> 2) * pw * 4 + (i & 3) * 4 + 3] = 255; break;
    }
  }
  for (let y = 0; y < h; y++) out.set(tmp.subarray(y * pw * 4, y * pw * 4 + w * 4), y * pitch);
  return { data: out, pitch };
}
