// Direct3D 11 enumerations and conversions to WebGPU state.
export const E = {
  S_OK: 0, S_FALSE: 1,
  INVALIDARG: 0x80070057 | 0, OUTOFMEMORY: 0x8007000e | 0, NOTIMPL: 0x80004001 | 0, FAIL: 0x80004005 | 0, NOINTERFACE: 0x80004002 | 0,
  DXGI_ERROR_NOT_FOUND: 0x887a0002 | 0, DXGI_ERROR_INVALID_CALL: 0x887a0001 | 0, DXGI_ERROR_UNSUPPORTED: 0x887a0004 | 0, DXGI_ERROR_WAS_STILL_DRAWING: 0x887a000a | 0,
  DXGI_ERROR_MORE_DATA: 0x887a0003 | 0, DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: 0x887a0022 | 0,
  D3D11_ERROR_FILE_NOT_FOUND: 0x887c0002 | 0, D3D11_ERROR_TOO_MANY_UNIQUE_STATE_OBJECTS: 0x887c0001 | 0,
} as const;

export const USAGE = { DEFAULT: 0, IMMUTABLE: 1, DYNAMIC: 2, STAGING: 3 } as const;
export const BIND = { VERTEX_BUFFER: 1, INDEX_BUFFER: 2, CONSTANT_BUFFER: 4, SHADER_RESOURCE: 8, STREAM_OUTPUT: 0x10, RENDER_TARGET: 0x20, DEPTH_STENCIL: 0x40, UNORDERED_ACCESS: 0x80 } as const;
export const CPU = { WRITE: 0x10000, READ: 0x20000 } as const;
export const MISC = { GENERATE_MIPS: 1, SHARED: 2, TEXTURECUBE: 4, DRAWINDIRECT_ARGS: 0x10, RAW_VIEWS: 0x20, STRUCTURED: 0x40, RESOURCE_CLAMP: 0x80 } as const;
export const MAP = { READ: 1, WRITE: 2, READ_WRITE: 3, WRITE_DISCARD: 4, WRITE_NO_OVERWRITE: 5 } as const;

export const SRV_DIM = { UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE1DARRAY: 3, TEXTURE2D: 4, TEXTURE2DARRAY: 5, TEXTURE2DMS: 6, TEXTURE2DMSARRAY: 7, TEXTURE3D: 8, TEXTURECUBE: 9, TEXTURECUBEARRAY: 10, BUFFEREX: 11 } as const;
export const RTV_DIM = { UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE1DARRAY: 3, TEXTURE2D: 4, TEXTURE2DARRAY: 5, TEXTURE2DMS: 6, TEXTURE2DMSARRAY: 7, TEXTURE3D: 8 } as const;
export const DSV_DIM = { UNKNOWN: 0, TEXTURE1D: 1, TEXTURE1DARRAY: 2, TEXTURE2D: 3, TEXTURE2DARRAY: 4, TEXTURE2DMS: 5, TEXTURE2DMSARRAY: 6 } as const;
export const UAV_DIM = { UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE1DARRAY: 3, TEXTURE2D: 4, TEXTURE2DARRAY: 5, TEXTURE3D: 8 } as const;

export const RESOURCE_DIM = { UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE3D: 4 } as const;

export const APPEND_ALIGNED_ELEMENT = 0xffffffff;

export const CMP: GPUCompareFunction[] = ["always", "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
export const STENCIL_OP: GPUStencilOperation[] = ["keep", "keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
export const BLEND_OP: GPUBlendOperation[] = ["add", "add", "subtract", "reverse-subtract", "min", "max"];

/** D3D11_BLEND -> GPUBlendFactor for the color channels and the alpha channel */
export function blendFactor(b: number, alpha: boolean): GPUBlendFactor {
  switch (b) {
    case 1: return "zero";
    case 2: return "one";
    case 3: return alpha ? "src-alpha" : "src";
    case 4: return alpha ? "one-minus-src-alpha" : "one-minus-src";
    case 5: return "src-alpha";
    case 6: return "one-minus-src-alpha";
    case 7: return "dst-alpha";
    case 8: return "one-minus-dst-alpha";
    case 9: return alpha ? "dst-alpha" : "dst";
    case 10: return alpha ? "one-minus-dst-alpha" : "one-minus-dst";
    case 11: return "src-alpha-saturated";
    case 14: return "constant";
    case 15: return "one-minus-constant";
    case 16: return alpha ? "src1-alpha" as GPUBlendFactor : "src1" as GPUBlendFactor;
    case 17: return alpha ? "one-minus-src1-alpha" as GPUBlendFactor : "one-minus-src1" as GPUBlendFactor;
    case 18: return "src1-alpha" as GPUBlendFactor;
    case 19: return "one-minus-src1-alpha" as GPUBlendFactor;
    default: return "one";
  }
}

export const TOPO = { POINTLIST: 1, LINELIST: 2, LINESTRIP: 3, TRIANGLELIST: 4, TRIANGLESTRIP: 5, LINELIST_ADJ: 10, LINESTRIP_ADJ: 11, TRIANGLELIST_ADJ: 12, TRIANGLESTRIP_ADJ: 13 } as const;

export function topologyInfo(t: number): { topology: GPUPrimitiveTopology; strip: boolean } | null {
  switch (t) {
    case TOPO.POINTLIST: return { topology: "point-list", strip: false };
    case TOPO.LINELIST: return { topology: "line-list", strip: false };
    case TOPO.LINESTRIP: return { topology: "line-strip", strip: true };
    case TOPO.TRIANGLELIST: return { topology: "triangle-list", strip: false };
    case TOPO.TRIANGLESTRIP: return { topology: "triangle-strip", strip: true };
    default: return null;
  }
}

export const QUERY = { EVENT: 0, OCCLUSION: 1, TIMESTAMP: 2, TIMESTAMP_DISJOINT: 3, PIPELINE_STATISTICS: 4, OCCLUSION_PREDICATE: 5, SO_STATISTICS: 6, SO_OVERFLOW_PREDICATE: 7 } as const;

export const FEATURE_LEVEL = { L9_1: 0x9100, L9_2: 0x9200, L9_3: 0x9300, L10_0: 0xa000, L10_1: 0xa100, L11_0: 0xb000, L11_1: 0xb100, L12_0: 0xc000, L12_1: 0xc100 } as const;

// D3D11_FORMAT_SUPPORT bits
export const FS = {
  BUFFER: 1, IA_VERTEX_BUFFER: 2, IA_INDEX_BUFFER: 4, SO_BUFFER: 8, TEXTURE1D: 0x10, TEXTURE2D: 0x20, TEXTURE3D: 0x40, TEXTURECUBE: 0x80, SHADER_LOAD: 0x100, SHADER_SAMPLE: 0x200,
  SHADER_SAMPLE_COMPARISON: 0x400, SHADER_SAMPLE_MONO_TEXT: 0x800, MIP: 0x1000, MIP_AUTOGEN: 0x2000, RENDER_TARGET: 0x4000, BLENDABLE: 0x8000, DEPTH_STENCIL: 0x10000, CPU_LOCKABLE: 0x20000,
  MULTISAMPLE_RESOLVE: 0x40000, DISPLAY: 0x80000, CAST_WITHIN_BIT_LAYOUT: 0x100000, MULTISAMPLE_RENDERTARGET: 0x200000, MULTISAMPLE_LOAD: 0x400000, SHADER_GATHER: 0x800000,
  BACK_BUFFER_CAST: 0x1000000, TYPED_UNORDERED_ACCESS_VIEW: 0x2000000, SHADER_GATHER_COMPARISON: 0x4000000,
} as const;

export function sampleTypeName(k: string): string { return k; }
