// Pipeline state held by a Direct3D 11 device context.
import type { Buf11, DSV11, DepthStencilState11, InputLayout11, RTV11, RasterizerState11, SRV11, SamplerState11, Shader11, UAV11, BlendState11, ShaderStage } from "./d3d11-res.ts";

export const STAGES: ShaderStage[] = ["vs", "ps", "gs", "hs", "ds", "cs"];
export const STAGE_PREFIX: Record<ShaderStage, string> = { vs: "VS", ps: "PS", gs: "GS", hs: "HS", ds: "DS", cs: "CS" };

export interface CbBinding { buf: Buf11 | null; first: number; num: number }
export interface VbBinding { buf: Buf11 | null; stride: number; offset: number }
export interface Viewport { x: number; y: number; w: number; h: number; minZ: number; maxZ: number }
export interface Rect { l: number; t: number; r: number; b: number }

export class State11 {
  topology = 0;
  layout: InputLayout11 | null = null;
  vb: VbBinding[] = Array.from({ length: 16 }, () => ({ buf: null, stride: 0, offset: 0 }));
  ib: { buf: Buf11 | null; format: number; offset: number } = { buf: null, format: 0, offset: 0 };
  sh: Record<ShaderStage, Shader11 | null> = { vs: null, ps: null, gs: null, hs: null, ds: null, cs: null };
  cb: Record<ShaderStage, CbBinding[]> = Object.fromEntries(["vs", "ps", "gs", "hs", "ds", "cs"].map((s) => [s, Array.from({ length: 14 }, () => ({ buf: null, first: 0, num: 4096 }))])) as any;
  srv: Record<ShaderStage, (SRV11 | null)[]> = Object.fromEntries(["vs", "ps", "gs", "hs", "ds", "cs"].map((s) => [s, new Array(128).fill(null)])) as any;
  smp: Record<ShaderStage, (SamplerState11 | null)[]> = Object.fromEntries(["vs", "ps", "gs", "hs", "ds", "cs"].map((s) => [s, new Array(16).fill(null)])) as any;
  rtv: (RTV11 | null)[] = new Array(8).fill(null);
  dsv: DSV11 | null = null;
  uavPs: (UAV11 | null)[] = new Array(8).fill(null);
  uavCs: (UAV11 | null)[] = new Array(8).fill(null);
  blend: BlendState11 | null = null;
  blendFactor: [number, number, number, number] = [1, 1, 1, 1];
  sampleMask = 0xffffffff;
  ds: DepthStencilState11 | null = null;
  stencilRef = 0;
  raster: RasterizerState11 | null = null;
  viewports: Viewport[] = [];
  scissors: Rect[] = [];
  predicate: unknown = null;
  predicateValue = false;

  clone(): State11 {
    const n = new State11();
    n.topology = this.topology; n.layout = this.layout;
    n.vb = this.vb.map((v) => ({ ...v })); n.ib = { ...this.ib };
    for (const s of STAGES) { n.sh[s] = this.sh[s]; n.cb[s] = this.cb[s].map((c) => ({ ...c })); n.srv[s] = this.srv[s].slice(); n.smp[s] = this.smp[s].slice(); }
    n.rtv = this.rtv.slice(); n.dsv = this.dsv; n.uavPs = this.uavPs.slice(); n.uavCs = this.uavCs.slice();
    n.blend = this.blend; n.blendFactor = [...this.blendFactor]; n.sampleMask = this.sampleMask; n.ds = this.ds; n.stencilRef = this.stencilRef; n.raster = this.raster;
    n.viewports = this.viewports.map((v) => ({ ...v })); n.scissors = this.scissors.map((r) => ({ ...r }));
    return n;
  }
}
