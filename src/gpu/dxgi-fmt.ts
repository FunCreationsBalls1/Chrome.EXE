// DXGI_FORMAT table: sizes, WebGPU equivalents, typeless families, vertex formats, and CPU conversions for formats WebGPU lacks.

export const DXGI = {
  UNKNOWN: 0,
  R32G32B32A32_TYPELESS: 1, R32G32B32A32_FLOAT: 2, R32G32B32A32_UINT: 3, R32G32B32A32_SINT: 4,
  R32G32B32_TYPELESS: 5, R32G32B32_FLOAT: 6, R32G32B32_UINT: 7, R32G32B32_SINT: 8,
  R16G16B16A16_TYPELESS: 9, R16G16B16A16_FLOAT: 10, R16G16B16A16_UNORM: 11, R16G16B16A16_UINT: 12, R16G16B16A16_SNORM: 13, R16G16B16A16_SINT: 14,
  R32G32_TYPELESS: 15, R32G32_FLOAT: 16, R32G32_UINT: 17, R32G32_SINT: 18,
  R32G8X24_TYPELESS: 19, D32_FLOAT_S8X24_UINT: 20, R32_FLOAT_X8X24_TYPELESS: 21, X32_TYPELESS_G8X24_UINT: 22,
  R10G10B10A2_TYPELESS: 23, R10G10B10A2_UNORM: 24, R10G10B10A2_UINT: 25, R11G11B10_FLOAT: 26,
  R8G8B8A8_TYPELESS: 27, R8G8B8A8_UNORM: 28, R8G8B8A8_UNORM_SRGB: 29, R8G8B8A8_UINT: 30, R8G8B8A8_SNORM: 31, R8G8B8A8_SINT: 32,
  R16G16_TYPELESS: 33, R16G16_FLOAT: 34, R16G16_UNORM: 35, R16G16_UINT: 36, R16G16_SNORM: 37, R16G16_SINT: 38,
  R32_TYPELESS: 39, D32_FLOAT: 40, R32_FLOAT: 41, R32_UINT: 42, R32_SINT: 43,
  R24G8_TYPELESS: 44, D24_UNORM_S8_UINT: 45, R24_UNORM_X8_TYPELESS: 46, X24_TYPELESS_G8_UINT: 47,
  R8G8_TYPELESS: 48, R8G8_UNORM: 49, R8G8_UINT: 50, R8G8_SNORM: 51, R8G8_SINT: 52,
  R16_TYPELESS: 53, R16_FLOAT: 54, D16_UNORM: 55, R16_UNORM: 56, R16_UINT: 57, R16_SNORM: 58, R16_SINT: 59,
  R8_TYPELESS: 60, R8_UNORM: 61, R8_UINT: 62, R8_SNORM: 63, R8_SINT: 64, A8_UNORM: 65, R1_UNORM: 66,
  R9G9B9E5_SHAREDEXP: 67, R8G8_B8G8_UNORM: 68, G8R8_G8B8_UNORM: 69,
  BC1_TYPELESS: 70, BC1_UNORM: 71, BC1_UNORM_SRGB: 72, BC2_TYPELESS: 73, BC2_UNORM: 74, BC2_UNORM_SRGB: 75, BC3_TYPELESS: 76, BC3_UNORM: 77, BC3_UNORM_SRGB: 78,
  BC4_TYPELESS: 79, BC4_UNORM: 80, BC4_SNORM: 81, BC5_TYPELESS: 82, BC5_UNORM: 83, BC5_SNORM: 84,
  B5G6R5_UNORM: 85, B5G5R5A1_UNORM: 86, B8G8R8A8_UNORM: 87, B8G8R8X8_UNORM: 88, R10G10B10_XR_BIAS_A2_UNORM: 89,
  B8G8R8A8_TYPELESS: 90, B8G8R8A8_UNORM_SRGB: 91, B8G8R8X8_TYPELESS: 92, B8G8R8X8_UNORM_SRGB: 93,
  BC6H_TYPELESS: 94, BC6H_UF16: 95, BC6H_SF16: 96, BC7_TYPELESS: 97, BC7_UNORM: 98, BC7_UNORM_SRGB: 99,
  B4G4R4A4_UNORM: 115,
} as const;

export type FmtKind = "float" | "unorm" | "snorm" | "uint" | "sint" | "srgb" | "depth" | "typeless";

export interface Fmt11 {
  id: number;
  name: string;
  /** bytes per texel in application memory (per block for compressed formats) */
  bytes: number;
  /** block dimensions (1 for uncompressed, 4 for BC) */
  block: number;
  kind: FmtKind;
  comps: number;
  /** WebGPU texture format used for storage (typeless: the default concrete format) */
  gpu: GPUTextureFormat | null;
  /** bytes per texel of `gpu` */
  gpuBytes: number;
  /** typeless formats that may be used as depth/stencil: concrete depth format */
  depthGpu?: GPUTextureFormat;
  /** the format's id when viewed as depth/stencil aspect of a combined texture */
  aspect?: "depth" | "stencil";
  depth?: boolean;
  stencil?: boolean;
  srgbGpu?: GPUTextureFormat;
  /** the typeless family this format belongs to */
  family: number;
  compressed?: string;
  /** application layout -> gpu layout, row by row (absent when identical) */
  convert?: (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => void;
  /** gpu layout -> application layout (readback) */
  unconvert?: (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => void;
  /** the gpu format needs a device feature (texture-formats-tier1 etc.); `fallback` is used otherwise */
  needs?: string;
  fallback?: { gpu: GPUTextureFormat; gpuBytes: number; convert: Fmt11["convert"]; unconvert?: Fmt11["unconvert"] };
  /** channel layout for typed-buffer loads: component type and count */
  vertex?: { fmt: GPUVertexFormat; kind: "f" | "u" | "i" };
  /** texture format unsupported by the WebGPU back-end */
  unsupported?: boolean;
}

const T: Record<number, Fmt11> = {};
function def(id: number, name: string, bytes: number, kind: FmtKind, comps: number, gpu: GPUTextureFormat | null, o: Partial<Fmt11> = {}) {
  T[id] = { id, name, bytes, block: 1, kind, comps, gpu, gpuBytes: bytes, family: id, ...o };
}
const fam = (members: number[], family: number) => { for (const m of members) T[m].family = family; };

// ---- float conversion helpers ----------------------------------------------------------------------------------------
const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer);
export function toHalf(v: number): number {
  f32buf[0] = v;
  const x = u32buf[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
  if (e >= 31) return sign | 0x7c00 | (m ? 0x200 : 0);
  return sign | (e << 10) | ((m + 0x1000) >> 13);
}
export function fromHalf(h: number): number {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

const e5 = (v: number) => (v << 3) | (v >> 2);
const e6 = (v: number) => (v << 2) | (v >> 4);
const e4 = (v: number) => (v << 4) | v;
const r5 = (v: number) => (v * 31 + 127) / 255 | 0;
const r6 = (v: number) => (v * 63 + 127) / 255 | 0;
const r4 = (v: number) => (v * 15 + 127) / 255 | 0;

function rows(w: number, h: number, sb: number, db: number, f: (s: number, d: number) => void, sp: number, dp: number) {
  for (let y = 0; y < h; y++) { let s = y * sp, d = y * dp; for (let x = 0; x < w; x++, s += sb, d += db) f(s, d); }
}
const conv565 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 2, 4, (s, d) => { const v = src[s] | (src[s + 1] << 8); dst[d] = e5(v >> 11); dst[d + 1] = e6((v >> 5) & 63); dst[d + 2] = e5(v & 31); dst[d + 3] = 255; }, sp, dp);
const unconv565 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 4, 2, (s, d) => { const v = (r5(src[s]) << 11) | (r6(src[s + 1]) << 5) | r5(src[s + 2]); dst[d] = v & 255; dst[d + 1] = v >> 8; }, sp, dp);
const conv5551 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 2, 4, (s, d) => { const v = src[s] | (src[s + 1] << 8); dst[d] = e5((v >> 10) & 31); dst[d + 1] = e5((v >> 5) & 31); dst[d + 2] = e5(v & 31); dst[d + 3] = v & 0x8000 ? 255 : 0; }, sp, dp);
const unconv5551 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 4, 2, (s, d) => { const v = (src[s + 3] >= 128 ? 0x8000 : 0) | (r5(src[s]) << 10) | (r5(src[s + 1]) << 5) | r5(src[s + 2]); dst[d] = v & 255; dst[d + 1] = v >> 8; }, sp, dp);
const conv4444 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 2, 4, (s, d) => { const v = src[s] | (src[s + 1] << 8); dst[d] = e4((v >> 8) & 15); dst[d + 1] = e4((v >> 4) & 15); dst[d + 2] = e4(v & 15); dst[d + 3] = e4(v >> 12); }, sp, dp);
const unconv4444 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 4, 2, (s, d) => { const v = (r4(src[s + 3]) << 12) | (r4(src[s]) << 8) | (r4(src[s + 1]) << 4) | r4(src[s + 2]); dst[d] = v & 255; dst[d + 1] = v >> 8; }, sp, dp);
const convA8 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 1, 4, (s, d) => { dst[d] = 0; dst[d + 1] = 0; dst[d + 2] = 0; dst[d + 3] = src[s]; }, sp, dp);
const unconvA8 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 4, 1, (s, d) => { dst[d] = src[s + 3]; }, sp, dp);
const convX8 = (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) =>
  rows(w, h, 4, 4, (s, d) => { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; }, sp, dp);
/** n 16-bit normalised components -> n half floats (fallback when the device lacks 16-bit normalised texture formats) */
const convNorm16 = (n: number, signed: boolean) => (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  const sv = new DataView(src.buffer, src.byteOffset, src.byteLength), dv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * n; x++) {
    const raw = signed ? sv.getInt16(y * sp + x * 2, true) : sv.getUint16(y * sp + x * 2, true);
    dv.setUint16(y * dp + x * 2, toHalf(signed ? Math.max(raw / 32767, -1) : raw / 65535), true);
  }
};
const unconvNorm16 = (n: number, signed: boolean) => (src: Uint8Array, sp: number, dst: Uint8Array, dp: number, w: number, h: number) => {
  const sv = new DataView(src.buffer, src.byteOffset, src.byteLength), dv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * n; x++) {
    const f = fromHalf(sv.getUint16(y * sp + x * 2, true));
    if (signed) dv.setInt16(y * dp + x * 2, Math.round(Math.max(-1, Math.min(1, f)) * 32767), true);
    else dv.setUint16(y * dp + x * 2, Math.round(Math.max(0, Math.min(1, f)) * 65535), true);
  }
};

// ---- 128/96/64-bit ---------------------------------------------------------------------------------------------------
def(DXGI.R32G32B32A32_TYPELESS, "R32G32B32A32_TYPELESS", 16, "typeless", 4, "rgba32float");
def(DXGI.R32G32B32A32_FLOAT, "R32G32B32A32_FLOAT", 16, "float", 4, "rgba32float", { vertex: { fmt: "float32x4", kind: "f" } });
def(DXGI.R32G32B32A32_UINT, "R32G32B32A32_UINT", 16, "uint", 4, "rgba32uint", { vertex: { fmt: "uint32x4", kind: "u" } });
def(DXGI.R32G32B32A32_SINT, "R32G32B32A32_SINT", 16, "sint", 4, "rgba32sint", { vertex: { fmt: "sint32x4", kind: "i" } });
fam([2, 3, 4], 1);
def(DXGI.R32G32B32_TYPELESS, "R32G32B32_TYPELESS", 12, "typeless", 3, null, { unsupported: true });
def(DXGI.R32G32B32_FLOAT, "R32G32B32_FLOAT", 12, "float", 3, null, { unsupported: true, vertex: { fmt: "float32x3", kind: "f" } });
def(DXGI.R32G32B32_UINT, "R32G32B32_UINT", 12, "uint", 3, null, { unsupported: true, vertex: { fmt: "uint32x3", kind: "u" } });
def(DXGI.R32G32B32_SINT, "R32G32B32_SINT", 12, "sint", 3, null, { unsupported: true, vertex: { fmt: "sint32x3", kind: "i" } });
fam([6, 7, 8], 5);
def(DXGI.R16G16B16A16_TYPELESS, "R16G16B16A16_TYPELESS", 8, "typeless", 4, "rgba16float");
def(DXGI.R16G16B16A16_FLOAT, "R16G16B16A16_FLOAT", 8, "float", 4, "rgba16float", { vertex: { fmt: "float16x4", kind: "f" } });
def(DXGI.R16G16B16A16_UNORM, "R16G16B16A16_UNORM", 8, "unorm", 4, "rgba16unorm", { needs: "texture-formats-tier1", fallback: { gpu: "rgba16float", gpuBytes: 8, convert: convNorm16(4, false), unconvert: unconvNorm16(4, false) }, vertex: { fmt: "unorm16x4", kind: "f" } });
def(DXGI.R16G16B16A16_UINT, "R16G16B16A16_UINT", 8, "uint", 4, "rgba16uint", { vertex: { fmt: "uint16x4", kind: "u" } });
def(DXGI.R16G16B16A16_SNORM, "R16G16B16A16_SNORM", 8, "snorm", 4, "rgba16snorm", { needs: "texture-formats-tier1", fallback: { gpu: "rgba16float", gpuBytes: 8, convert: convNorm16(4, true), unconvert: unconvNorm16(4, true) }, vertex: { fmt: "snorm16x4", kind: "f" } });
def(DXGI.R16G16B16A16_SINT, "R16G16B16A16_SINT", 8, "sint", 4, "rgba16sint", { vertex: { fmt: "sint16x4", kind: "i" } });
fam([10, 11, 12, 13, 14], 9);
def(DXGI.R32G32_TYPELESS, "R32G32_TYPELESS", 8, "typeless", 2, "rg32float");
def(DXGI.R32G32_FLOAT, "R32G32_FLOAT", 8, "float", 2, "rg32float", { vertex: { fmt: "float32x2", kind: "f" } });
def(DXGI.R32G32_UINT, "R32G32_UINT", 8, "uint", 2, "rg32uint", { vertex: { fmt: "uint32x2", kind: "u" } });
def(DXGI.R32G32_SINT, "R32G32_SINT", 8, "sint", 2, "rg32sint", { vertex: { fmt: "sint32x2", kind: "i" } });
fam([16, 17, 18], 15);
// ---- depth/stencil combos --------------------------------------------------------------------------------------------
def(DXGI.R32G8X24_TYPELESS, "R32G8X24_TYPELESS", 8, "typeless", 2, "rg32float", { depthGpu: "depth32float-stencil8" });
def(DXGI.D32_FLOAT_S8X24_UINT, "D32_FLOAT_S8X24_UINT", 8, "depth", 2, "depth32float-stencil8", { depth: true, stencil: true });
def(DXGI.R32_FLOAT_X8X24_TYPELESS, "R32_FLOAT_X8X24_TYPELESS", 8, "float", 1, "depth32float-stencil8", { aspect: "depth", depth: true });
def(DXGI.X32_TYPELESS_G8X24_UINT, "X32_TYPELESS_G8X24_UINT", 8, "uint", 1, "depth32float-stencil8", { aspect: "stencil", stencil: true });
fam([20, 21, 22], 19);
// ---- 32-bit ----------------------------------------------------------------------------------------------------------
def(DXGI.R10G10B10A2_TYPELESS, "R10G10B10A2_TYPELESS", 4, "typeless", 4, "rgb10a2unorm");
def(DXGI.R10G10B10A2_UNORM, "R10G10B10A2_UNORM", 4, "unorm", 4, "rgb10a2unorm", { vertex: { fmt: "unorm10-10-10-2", kind: "f" } });
def(DXGI.R10G10B10A2_UINT, "R10G10B10A2_UINT", 4, "uint", 4, "rgb10a2uint", { vertex: { fmt: "uint32", kind: "u" } });
fam([24, 25], 23);
def(DXGI.R11G11B10_FLOAT, "R11G11B10_FLOAT", 4, "float", 3, "rg11b10ufloat");
def(DXGI.R8G8B8A8_TYPELESS, "R8G8B8A8_TYPELESS", 4, "typeless", 4, "rgba8unorm", { srgbGpu: "rgba8unorm-srgb" });
def(DXGI.R8G8B8A8_UNORM, "R8G8B8A8_UNORM", 4, "unorm", 4, "rgba8unorm", { srgbGpu: "rgba8unorm-srgb", vertex: { fmt: "unorm8x4", kind: "f" } });
def(DXGI.R8G8B8A8_UNORM_SRGB, "R8G8B8A8_UNORM_SRGB", 4, "srgb", 4, "rgba8unorm-srgb", { vertex: { fmt: "unorm8x4", kind: "f" } });
def(DXGI.R8G8B8A8_UINT, "R8G8B8A8_UINT", 4, "uint", 4, "rgba8uint", { vertex: { fmt: "uint8x4", kind: "u" } });
def(DXGI.R8G8B8A8_SNORM, "R8G8B8A8_SNORM", 4, "snorm", 4, "rgba8snorm", { vertex: { fmt: "snorm8x4", kind: "f" } });
def(DXGI.R8G8B8A8_SINT, "R8G8B8A8_SINT", 4, "sint", 4, "rgba8sint", { vertex: { fmt: "sint8x4", kind: "i" } });
fam([28, 29, 30, 31, 32], 27);
def(DXGI.R16G16_TYPELESS, "R16G16_TYPELESS", 4, "typeless", 2, "rg16float");
def(DXGI.R16G16_FLOAT, "R16G16_FLOAT", 4, "float", 2, "rg16float", { vertex: { fmt: "float16x2", kind: "f" } });
def(DXGI.R16G16_UNORM, "R16G16_UNORM", 4, "unorm", 2, "rg16unorm", { needs: "texture-formats-tier1", fallback: { gpu: "rg16float", gpuBytes: 4, convert: convNorm16(2, false), unconvert: unconvNorm16(2, false) }, vertex: { fmt: "unorm16x2", kind: "f" } });
def(DXGI.R16G16_UINT, "R16G16_UINT", 4, "uint", 2, "rg16uint", { vertex: { fmt: "uint16x2", kind: "u" } });
def(DXGI.R16G16_SNORM, "R16G16_SNORM", 4, "snorm", 2, "rg16snorm", { needs: "texture-formats-tier1", fallback: { gpu: "rg16float", gpuBytes: 4, convert: convNorm16(2, true), unconvert: unconvNorm16(2, true) }, vertex: { fmt: "snorm16x2", kind: "f" } });
def(DXGI.R16G16_SINT, "R16G16_SINT", 4, "sint", 2, "rg16sint", { vertex: { fmt: "sint16x2", kind: "i" } });
fam([34, 35, 36, 37, 38], 33);
def(DXGI.R32_TYPELESS, "R32_TYPELESS", 4, "typeless", 1, "r32float", { depthGpu: "depth32float" });
def(DXGI.D32_FLOAT, "D32_FLOAT", 4, "depth", 1, "depth32float", { depth: true });
def(DXGI.R32_FLOAT, "R32_FLOAT", 4, "float", 1, "r32float", { vertex: { fmt: "float32", kind: "f" } });
def(DXGI.R32_UINT, "R32_UINT", 4, "uint", 1, "r32uint", { vertex: { fmt: "uint32", kind: "u" } });
def(DXGI.R32_SINT, "R32_SINT", 4, "sint", 1, "r32sint", { vertex: { fmt: "sint32", kind: "i" } });
fam([40, 41, 42, 43], 39);
def(DXGI.R24G8_TYPELESS, "R24G8_TYPELESS", 4, "typeless", 2, "rgba8unorm", { depthGpu: "depth24plus-stencil8" });
def(DXGI.D24_UNORM_S8_UINT, "D24_UNORM_S8_UINT", 4, "depth", 2, "depth24plus-stencil8", { depth: true, stencil: true });
def(DXGI.R24_UNORM_X8_TYPELESS, "R24_UNORM_X8_TYPELESS", 4, "unorm", 1, "depth24plus-stencil8", { aspect: "depth", depth: true });
def(DXGI.X24_TYPELESS_G8_UINT, "X24_TYPELESS_G8_UINT", 4, "uint", 1, "depth24plus-stencil8", { aspect: "stencil", stencil: true });
fam([45, 46, 47], 44);
// ---- 16-bit ----------------------------------------------------------------------------------------------------------
def(DXGI.R8G8_TYPELESS, "R8G8_TYPELESS", 2, "typeless", 2, "rg8unorm");
def(DXGI.R8G8_UNORM, "R8G8_UNORM", 2, "unorm", 2, "rg8unorm", { vertex: { fmt: "unorm8x2", kind: "f" } });
def(DXGI.R8G8_UINT, "R8G8_UINT", 2, "uint", 2, "rg8uint", { vertex: { fmt: "uint8x2", kind: "u" } });
def(DXGI.R8G8_SNORM, "R8G8_SNORM", 2, "snorm", 2, "rg8snorm", { vertex: { fmt: "snorm8x2", kind: "f" } });
def(DXGI.R8G8_SINT, "R8G8_SINT", 2, "sint", 2, "rg8sint", { vertex: { fmt: "sint8x2", kind: "i" } });
fam([49, 50, 51, 52], 48);
def(DXGI.R16_TYPELESS, "R16_TYPELESS", 2, "typeless", 1, "r16float", { depthGpu: "depth16unorm" });
def(DXGI.R16_FLOAT, "R16_FLOAT", 2, "float", 1, "r16float", { vertex: { fmt: "float16" as GPUVertexFormat, kind: "f" } });
def(DXGI.D16_UNORM, "D16_UNORM", 2, "depth", 1, "depth16unorm", { depth: true });
def(DXGI.R16_UNORM, "R16_UNORM", 2, "unorm", 1, "r16unorm", { needs: "texture-formats-tier1", fallback: { gpu: "r16float", gpuBytes: 2, convert: convNorm16(1, false), unconvert: unconvNorm16(1, false) }, vertex: { fmt: "unorm16" as GPUVertexFormat, kind: "f" } });
def(DXGI.R16_UINT, "R16_UINT", 2, "uint", 1, "r16uint", { vertex: { fmt: "uint16" as GPUVertexFormat, kind: "u" } });
def(DXGI.R16_SNORM, "R16_SNORM", 2, "snorm", 1, "r16snorm", { needs: "texture-formats-tier1", fallback: { gpu: "r16float", gpuBytes: 2, convert: convNorm16(1, true), unconvert: unconvNorm16(1, true) }, vertex: { fmt: "snorm16" as GPUVertexFormat, kind: "f" } });
def(DXGI.R16_SINT, "R16_SINT", 2, "sint", 1, "r16sint", { vertex: { fmt: "sint16" as GPUVertexFormat, kind: "i" } });
fam([54, 55, 56, 57, 58, 59], 53);
// ---- 8-bit -----------------------------------------------------------------------------------------------------------
def(DXGI.R8_TYPELESS, "R8_TYPELESS", 1, "typeless", 1, "r8unorm");
def(DXGI.R8_UNORM, "R8_UNORM", 1, "unorm", 1, "r8unorm", { vertex: { fmt: "unorm8" as GPUVertexFormat, kind: "f" } });
def(DXGI.R8_UINT, "R8_UINT", 1, "uint", 1, "r8uint", { vertex: { fmt: "uint8" as GPUVertexFormat, kind: "u" } });
def(DXGI.R8_SNORM, "R8_SNORM", 1, "snorm", 1, "r8snorm", { vertex: { fmt: "snorm8" as GPUVertexFormat, kind: "f" } });
def(DXGI.R8_SINT, "R8_SINT", 1, "sint", 1, "r8sint", { vertex: { fmt: "sint8" as GPUVertexFormat, kind: "i" } });
fam([61, 62, 63, 64], 60);
def(DXGI.A8_UNORM, "A8_UNORM", 1, "unorm", 1, "rgba8unorm", { gpuBytes: 4, convert: convA8, unconvert: unconvA8 });
def(DXGI.R9G9B9E5_SHAREDEXP, "R9G9B9E5_SHAREDEXP", 4, "float", 3, "rgb9e5ufloat");
// ---- block compressed ------------------------------------------------------------------------------------------------
const bc = (typeless: number, unorm: number, srgb: number | null, name: string, bytes: number, gpu: GPUTextureFormat, gpuSrgb: GPUTextureFormat | null, comps: number, snorm?: number, gpuSnorm?: GPUTextureFormat) => {
  def(typeless, name + "_TYPELESS", bytes, "typeless", comps, gpu, { block: 4, compressed: name.toLowerCase(), srgbGpu: gpuSrgb ?? undefined });
  def(unorm, name + "_UNORM", bytes, "unorm", comps, gpu, { block: 4, compressed: name.toLowerCase(), srgbGpu: gpuSrgb ?? undefined });
  const members = [unorm];
  if (srgb !== null) { def(srgb, name + "_UNORM_SRGB", bytes, "srgb", comps, gpuSrgb!, { block: 4, compressed: name.toLowerCase() }); members.push(srgb); }
  if (snorm !== undefined) { def(snorm, name + (name === "BC6H" ? "_SF16" : "_SNORM"), bytes, "snorm", comps, gpuSnorm!, { block: 4, compressed: name.toLowerCase() }); members.push(snorm); }
  fam(members, typeless);
};
bc(DXGI.BC1_TYPELESS, DXGI.BC1_UNORM, DXGI.BC1_UNORM_SRGB, "BC1", 8, "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", 4);
bc(DXGI.BC2_TYPELESS, DXGI.BC2_UNORM, DXGI.BC2_UNORM_SRGB, "BC2", 16, "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", 4);
bc(DXGI.BC3_TYPELESS, DXGI.BC3_UNORM, DXGI.BC3_UNORM_SRGB, "BC3", 16, "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", 4);
bc(DXGI.BC4_TYPELESS, DXGI.BC4_UNORM, null, "BC4", 8, "bc4-r-unorm", null, 1, DXGI.BC4_SNORM, "bc4-r-snorm");
bc(DXGI.BC5_TYPELESS, DXGI.BC5_UNORM, null, "BC5", 16, "bc5-rg-unorm", null, 2, DXGI.BC5_SNORM, "bc5-rg-snorm");
bc(DXGI.BC6H_TYPELESS, DXGI.BC6H_UF16, null, "BC6H", 16, "bc6h-rgb-ufloat", null, 3, DXGI.BC6H_SF16, "bc6h-rgb-float");
T[DXGI.BC6H_UF16].name = "BC6H_UF16";
bc(DXGI.BC7_TYPELESS, DXGI.BC7_UNORM, DXGI.BC7_UNORM_SRGB, "BC7", 16, "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", 4);
// ---- 16-bit packed / BGRA --------------------------------------------------------------------------------------------
def(DXGI.B5G6R5_UNORM, "B5G6R5_UNORM", 2, "unorm", 3, "rgba8unorm", { gpuBytes: 4, convert: conv565, unconvert: unconv565 });
def(DXGI.B5G5R5A1_UNORM, "B5G5R5A1_UNORM", 2, "unorm", 4, "rgba8unorm", { gpuBytes: 4, convert: conv5551, unconvert: unconv5551 });
def(DXGI.B4G4R4A4_UNORM, "B4G4R4A4_UNORM", 2, "unorm", 4, "rgba8unorm", { gpuBytes: 4, convert: conv4444, unconvert: unconv4444 });
def(DXGI.B8G8R8A8_TYPELESS, "B8G8R8A8_TYPELESS", 4, "typeless", 4, "bgra8unorm", { srgbGpu: "bgra8unorm-srgb" });
def(DXGI.B8G8R8A8_UNORM, "B8G8R8A8_UNORM", 4, "unorm", 4, "bgra8unorm", { srgbGpu: "bgra8unorm-srgb", vertex: { fmt: "unorm8x4-bgra" as GPUVertexFormat, kind: "f" } });
def(DXGI.B8G8R8A8_UNORM_SRGB, "B8G8R8A8_UNORM_SRGB", 4, "srgb", 4, "bgra8unorm-srgb");
fam([87, 91], 90);
def(DXGI.B8G8R8X8_TYPELESS, "B8G8R8X8_TYPELESS", 4, "typeless", 3, "bgra8unorm", { srgbGpu: "bgra8unorm-srgb", convert: convX8 });
def(DXGI.B8G8R8X8_UNORM, "B8G8R8X8_UNORM", 4, "unorm", 3, "bgra8unorm", { srgbGpu: "bgra8unorm-srgb", convert: convX8 });
def(DXGI.B8G8R8X8_UNORM_SRGB, "B8G8R8X8_UNORM_SRGB", 4, "srgb", 3, "bgra8unorm-srgb", { convert: convX8 });
fam([88, 93], 92);
def(DXGI.R10G10B10_XR_BIAS_A2_UNORM, "R10G10B10_XR_BIAS_A2_UNORM", 4, "unorm", 4, "rgb10a2unorm");

const EXTRA_FAMILY_VIEWS: Record<number, number[]> = {};
void EXTRA_FAMILY_VIEWS;

export function fmt11(id: number): Fmt11 | undefined { return T[id]; }
export function isDepthFormat(id: number): boolean { return !!T[id]?.depth; }
export function isTypeless(id: number): boolean { return T[id]?.kind === "typeless"; }

/** Concrete WebGPU format for a resource created with this DXGI format and bind flags (resolves typeless formats). */
export function resolveGpuFormat(f: Fmt11, bindDepth: boolean, caps: { tier1: boolean }): { gpu: GPUTextureFormat; convert?: Fmt11["convert"]; unconvert?: Fmt11["unconvert"]; gpuBytes: number } | null {
  if (f.unsupported || !f.gpu) return null;
  if (f.kind === "typeless" && bindDepth && f.depthGpu) return { gpu: f.depthGpu, gpuBytes: f.bytes };
  if (f.needs === "texture-formats-tier1" && !caps.tier1 && f.fallback) return { gpu: f.fallback.gpu, convert: f.fallback.convert, unconvert: f.fallback.unconvert, gpuBytes: f.fallback.gpuBytes };
  return { gpu: f.gpu, convert: f.convert, unconvert: f.unconvert, gpuBytes: f.gpuBytes };
}

/** bytes per row of a tightly packed subresource in application memory */
export function rowBytes(f: Fmt11, w: number): number { return f.block > 1 ? Math.ceil(w / f.block) * f.bytes : w * f.bytes; }
export function rowCount(f: Fmt11, h: number): number { return f.block > 1 ? Math.ceil(h / f.block) : h; }

export function mipDim(v: number, level: number): number { return Math.max(1, v >> level); }
export function mipCount(w: number, h: number, d = 1): number { let n = 1, m = Math.max(w, h, d); while (m > 1) { m >>= 1; n++; } return n; }

export interface SubLayout { offset: number; rowPitch: number; slicePitch: number; w: number; h: number; d: number; size: number }
/** layout of every subresource (array-major: index = array * mips + mip) in a tightly packed application-side shadow */
export function subresourceLayouts(f: Fmt11, w: number, h: number, d: number, mips: number, arrays: number): { subs: SubLayout[]; total: number } {
  const subs: SubLayout[] = [];
  let off = 0;
  for (let a = 0; a < arrays; a++) {
    for (let m = 0; m < mips; m++) {
      const mw = mipDim(w, m), mh = mipDim(h, m), md = mipDim(d, m);
      const rp = rowBytes(f, mw), rc = rowCount(f, mh);
      const sp = rp * rc, size = sp * md;
      subs.push({ offset: off, rowPitch: rp, slicePitch: sp, w: mw, h: mh, d: md, size });
      off += (size + 15) & ~15;
    }
  }
  return { subs, total: off };
}

/** WebGPU vertex format for an input-layout element (null when the format cannot be fetched by the input assembler) */
export function vertexFormat(id: number): { fmt: GPUVertexFormat; kind: "f" | "u" | "i" } | null {
  return T[id]?.vertex ?? null;
}

export function bytesPerVertexFormat(fmt: string): number {
  const m = /^(\w+?)(\d+)(?:x(\d+))?(-bgra)?$/.exec(fmt);
  if (fmt === "unorm10-10-10-2") return 4;
  if (!m) return 4;
  return (parseInt(m[2]) / 8) * (m[3] ? parseInt(m[3]) : 1);
}
