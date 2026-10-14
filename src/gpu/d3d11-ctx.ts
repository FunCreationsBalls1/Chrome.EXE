// ID3D11DeviceContext: state setting, draws, copies, maps and queries. One class serves immediate and deferred contexts.
import { ComObject } from "./com.ts";
import type { Cpu } from "../win32/cpu.ts";
import { BIND, CPU, E, MAP, QUERY, USAGE } from "./d3d11-consts.ts";
import { Buf11, CommandList11, DSV11, InputLayout11, Query11, RTV11, Resource11, SRV11, SamplerState11, Shader11, Tex11, UAV11, BlendState11, DepthStencilState11, RasterizerState11 } from "./d3d11-res.ts";
import type { ShaderStage } from "./d3d11-res.ts";
import { STAGES, STAGE_PREFIX, State11 } from "./d3d11-state.ts";
import { DrawEngine11 } from "./d3d11-draw.ts";
import type { Device11 } from "./d3d11-dev.ts";
import { rowBytes, rowCount } from "./dxgi-fmt.ts";

type Op = (c: Context11) => void;

const DO_NOT_WAIT = 0x100000;

export class Context11 extends ComObject {
  dev!: Device11;
  s = new State11();
  eng!: DrawEngine11;
  /** bumped when render-target / depth bindings change */
  omVersion = 0;
  deferred = false;
  rec: Op[] | null = null;
  private deferredMaps = new Map<Resource11, { ptr: number; sub: number; type: number; size: number }>();

  init(dev: Device11, deferred: boolean) {
    this.dev = dev;
    this.deferred = deferred;
    this.eng = new DrawEngine11(this);
    if (deferred) this.rec = [];
    dev.refs++;
    this.onDestroy = () => { dev.Release(null as any); };
  }
  private get gpu() { return this.dev.gpu; }
  get mem() { return this.dev.p.mem; }

  ob<T extends ComObject>(ptr: number): T | null { return ptr ? (this.rt.objectAt(ptr) as T | undefined) ?? null : null; }
  /** run a state change here (and record it when deferred) */
  state(f: Op) { f(this); this.rec?.push(f); }
  /** run an action now, or record it when deferred */
  act(f: Op) { if (this.rec) this.rec.push(f); else f(this); }
  private syncBefore(res: { usedGen: number }) { if (res.usedGen === this.gpu.stats.submits) this.gpu.flush(); }
  private touch(res: { usedGen: number }) { res.usedGen = this.gpu.stats.submits; }
  private endPassIfUses(tex: GPUTexture | null) {
    const g = this.gpu;
    if (!g.pass || !g.passTargets || !tex) return;
    const t = g.passTargets;
    if (t.colors.some((c) => c && c.tex === tex) || t.depth?.tex === tex) { g.endPass(); this.eng.invalidatePass(); }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // ID3D11DeviceChild
  // ------------------------------------------------------------------------------------------------------------------
  GetDevice(c: Cpu): void { this.mem.wptr(c.arg(1), this.dev.ptr); this.dev.refs++; }
  GetPrivateData(): number { return E.DXGI_ERROR_NOT_FOUND; }
  SetPrivateData(): number { return 0; }
  SetPrivateDataInterface(): number { return 0; }
  GetType(): number { return this.deferred ? 1 : 0; }
  GetContextFlags(): number { return 0; }

  // ID3DUserDefinedAnnotation
  BeginEvent(): number { return 0; }
  EndEvent(): number { return 0; }
  SetMarker(): void {}
  GetStatus(): number { return 0; }
  // ID3D11Multithread
  Enter(): void {}
  Leave(): void {}
  SetMultithreadProtected(): number { return 0; }
  GetMultithreadProtected(): number { return 1; }

  // ------------------------------------------------------------------------------------------------------------------
  // input assembler
  // ------------------------------------------------------------------------------------------------------------------
  IASetInputLayout(c: Cpu): void { const l = this.ob<InputLayout11>(c.arg(1)); this.state((x) => { x.s.layout = l; }); }
  IASetVertexBuffers(c: Cpu): void {
    const start = c.arg(1), n = c.arg(2), pb = c.arg(3), ps = c.arg(4), po = c.arg(5), m = this.mem;
    const items: { buf: Buf11 | null; stride: number; offset: number }[] = [];
    for (let i = 0; i < n; i++) items.push({ buf: pb ? this.ob<Buf11>(m.r32(pb + i * 8)) : null, stride: ps ? m.r32(ps + i * 4) : 0, offset: po ? m.r32(po + i * 4) : 0 });
    this.state((x) => { items.forEach((it, i) => { if (start + i < 16) x.s.vb[start + i] = it; }); });
  }
  IASetIndexBuffer(c: Cpu): void { const b = this.ob<Buf11>(c.arg(1)), f = c.arg(2), o = c.arg(3); this.state((x) => { x.s.ib = { buf: b, format: f, offset: o }; }); }
  IASetPrimitiveTopology(c: Cpu): void { const t = c.arg(1); this.state((x) => { x.s.topology = t; }); }
  IAGetInputLayout(c: Cpu): void { const l = this.s.layout; this.mem.wptr(c.arg(1), l ? l.ptr : 0); if (l) l.refs++; }
  IAGetVertexBuffers(c: Cpu): void {
    const start = c.arg(1), n = c.arg(2), m = this.mem;
    for (let i = 0; i < n; i++) {
      const v = this.s.vb[start + i];
      if (c.arg(3)) { m.wptr(c.arg(3) + i * 8, v.buf ? v.buf.ptr : 0); if (v.buf) v.buf.refs++; }
      if (c.arg(4)) m.w32(c.arg(4) + i * 4, v.stride);
      if (c.arg(5)) m.w32(c.arg(5) + i * 4, v.offset);
    }
  }
  IAGetIndexBuffer(c: Cpu): void {
    const ib = this.s.ib, m = this.mem;
    if (c.arg(1)) { m.wptr(c.arg(1), ib.buf ? ib.buf.ptr : 0); if (ib.buf) ib.buf.refs++; }
    if (c.arg(2)) m.w32(c.arg(2), ib.format);
    if (c.arg(3)) m.w32(c.arg(3), ib.offset);
  }
  IAGetPrimitiveTopology(c: Cpu): void { this.mem.w32(c.arg(1), this.s.topology); }

  // ------------------------------------------------------------------------------------------------------------------
  // output merger / rasterizer
  // ------------------------------------------------------------------------------------------------------------------
  OMSetRenderTargets(c: Cpu): void {
    const n = c.arg(1), pp = c.arg(2), dsv = this.ob<DSV11>(c.arg(3)), m = this.mem;
    const rtvs: (RTV11 | null)[] = new Array(8).fill(null);
    for (let i = 0; i < Math.min(n, 8); i++) rtvs[i] = pp ? this.ob<RTV11>(m.r32(pp + i * 8)) : null;
    this.state((x) => { x.s.rtv = rtvs; x.s.dsv = dsv; x.omVersion++; });
  }
  OMSetRenderTargetsAndUnorderedAccessViews(c: Cpu): void {
    const n = c.arg(1), pp = c.arg(2), dsv = this.ob<DSV11>(c.arg(3)), ustart = c.arg(4), un = c.arg(5), pu = c.arg(6), m = this.mem;
    const keepRt = n === 0xffffffff;
    const rtvs: (RTV11 | null)[] = new Array(8).fill(null);
    if (!keepRt) for (let i = 0; i < Math.min(n, 8); i++) rtvs[i] = pp ? this.ob<RTV11>(m.r32(pp + i * 8)) : null;
    const uavs: (UAV11 | null)[] = [];
    if (un !== 0xffffffff) for (let i = 0; i < un; i++) uavs.push(pu ? this.ob<UAV11>(m.r32(pu + i * 8)) : null);
    this.state((x) => {
      if (!keepRt) { x.s.rtv = rtvs; x.s.dsv = dsv; x.omVersion++; }
      if (un !== 0xffffffff) uavs.forEach((u, i) => { if (u || true) x.s.uavPs[ustart + i] = u; });
    });
  }
  OMGetRenderTargets(c: Cpu): void {
    const n = c.arg(1), pp = c.arg(2), m = this.mem;
    for (let i = 0; i < n; i++) if (pp) { const r = this.s.rtv[i]; m.wptr(pp + i * 8, r ? r.ptr : 0); if (r) r.refs++; }
    if (c.arg(3)) { const d = this.s.dsv; m.wptr(c.arg(3), d ? d.ptr : 0); if (d) d.refs++; }
  }
  OMGetRenderTargetsAndUnorderedAccessViews(c: Cpu): void {
    this.OMGetRenderTargets(c);
    const ustart = c.arg(4), un = c.arg(5), pu = c.arg(6), m = this.mem;
    for (let i = 0; i < un; i++) if (pu) { const u = this.s.uavPs[ustart + i]; m.wptr(pu + i * 8, u ? u.ptr : 0); if (u) u.refs++; }
  }
  OMSetBlendState(c: Cpu): void {
    const b = this.ob<BlendState11>(c.arg(1)), fp = c.arg(2), mask = c.arg(3), m = this.mem;
    const f: [number, number, number, number] = fp ? [m.rf32(fp), m.rf32(fp + 4), m.rf32(fp + 8), m.rf32(fp + 12)] : [1, 1, 1, 1];
    this.state((x) => { x.s.blend = b; x.s.blendFactor = f; x.s.sampleMask = mask; });
  }
  OMGetBlendState(c: Cpu): void {
    const m = this.mem, b = this.s.blend;
    if (c.arg(1)) { m.wptr(c.arg(1), b ? b.ptr : 0); if (b) b.refs++; }
    if (c.arg(2)) for (let i = 0; i < 4; i++) m.wf32(c.arg(2) + i * 4, this.s.blendFactor[i]);
    if (c.arg(3)) m.w32(c.arg(3), this.s.sampleMask);
  }
  OMSetDepthStencilState(c: Cpu): void { const d = this.ob<DepthStencilState11>(c.arg(1)), r = c.arg(2); this.state((x) => { x.s.ds = d; x.s.stencilRef = r; }); }
  OMGetDepthStencilState(c: Cpu): void { const d = this.s.ds, m = this.mem; if (c.arg(1)) { m.wptr(c.arg(1), d ? d.ptr : 0); if (d) d.refs++; } if (c.arg(2)) m.w32(c.arg(2), this.s.stencilRef); }
  RSSetState(c: Cpu): void { const r = this.ob<RasterizerState11>(c.arg(1)); this.state((x) => { x.s.raster = r; }); }
  RSGetState(c: Cpu): void { const r = this.s.raster; this.mem.wptr(c.arg(1), r ? r.ptr : 0); if (r) r.refs++; }
  RSSetViewports(c: Cpu): void {
    const n = c.arg(1), p = c.arg(2), m = this.mem;
    const vps: { x: number; y: number; w: number; h: number; minZ: number; maxZ: number }[] = [];
    for (let i = 0; i < n; i++) { const a = p + i * 24; vps.push({ x: m.rf32(a), y: m.rf32(a + 4), w: m.rf32(a + 8), h: m.rf32(a + 12), minZ: m.rf32(a + 16), maxZ: m.rf32(a + 20) }); }
    this.state((x) => { x.s.viewports = vps; });
  }
  RSGetViewports(c: Cpu): void {
    const m = this.mem, np = c.arg(1), p = c.arg(2), vps = this.s.viewports;
    if (p) for (let i = 0; i < Math.min(vps.length, m.r32(np)); i++) { const v = vps[i], a = p + i * 24; m.wf32(a, v.x); m.wf32(a + 4, v.y); m.wf32(a + 8, v.w); m.wf32(a + 12, v.h); m.wf32(a + 16, v.minZ); m.wf32(a + 20, v.maxZ); }
    m.w32(np, vps.length);
  }
  RSSetScissorRects(c: Cpu): void {
    const n = c.arg(1), p = c.arg(2), m = this.mem;
    const rs: { l: number; t: number; r: number; b: number }[] = [];
    for (let i = 0; i < n; i++) { const a = p + i * 16; rs.push({ l: m.ri32(a), t: m.ri32(a + 4), r: m.ri32(a + 8), b: m.ri32(a + 12) }); }
    this.state((x) => { x.s.scissors = rs; });
  }
  RSGetScissorRects(c: Cpu): void {
    const m = this.mem, np = c.arg(1), p = c.arg(2), rs = this.s.scissors;
    if (p) for (let i = 0; i < Math.min(rs.length, m.r32(np)); i++) { const r = rs[i], a = p + i * 16; m.w32(a, r.l); m.w32(a + 4, r.t); m.w32(a + 8, r.r); m.w32(a + 12, r.b); }
    m.w32(np, rs.length);
  }
  SOSetTargets(): void {}
  SOGetTargets(): void {}
  SetPredication(c: Cpu): void { const q = this.ob<Query11>(c.arg(1)); this.state((x) => { x.s.predicate = q; }); }
  GetPredication(c: Cpu): void { const q = this.s.predicate as Query11 | null; if (c.arg(1)) this.mem.wptr(c.arg(1), q ? q.ptr : 0); if (c.arg(2)) this.mem.w32(c.arg(2), 0); }

  // ------------------------------------------------------------------------------------------------------------------
  // compute-stage UAV binding
  // ------------------------------------------------------------------------------------------------------------------
  CSSetUnorderedAccessViews(c: Cpu): void {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    const items: (UAV11 | null)[] = [];
    for (let i = 0; i < n; i++) items.push(pp ? this.ob<UAV11>(m.r32(pp + i * 8)) : null);
    this.state((x) => { items.forEach((u, i) => { x.s.uavCs[start + i] = u; }); });
  }
  CSGetUnorderedAccessViews(c: Cpu): void {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3);
    for (let i = 0; i < n; i++) if (pp) { const u = this.s.uavCs[start + i]; this.mem.wptr(pp + i * 8, u ? u.ptr : 0); if (u) u.refs++; }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // draws
  // ------------------------------------------------------------------------------------------------------------------
  Draw(c: Cpu): void { const [a, b] = [c.arg(1), c.arg(2)]; this.act((x) => x.eng.draw("draw", a, 1, b, 0, 0)); }
  DrawIndexed(c: Cpu): void { const [a, b, d] = [c.arg(1), c.arg(2), c.argI(3)]; this.act((x) => x.eng.draw("indexed", a, 1, b, d, 0)); }
  DrawInstanced(c: Cpu): void { const [a, b, d, e] = [c.arg(1), c.arg(2), c.arg(3), c.arg(4)]; this.act((x) => x.eng.draw("draw", a, b, d, e, 0)); }
  DrawIndexedInstanced(c: Cpu): void { const [a, b, d, e, f] = [c.arg(1), c.arg(2), c.arg(3), c.argI(4), c.arg(5)]; this.act((x) => x.eng.draw("indexed", a, b, d, e, f)); }
  DrawInstancedIndirect(c: Cpu): void { const b = this.ob<Buf11>(c.arg(1)), o = c.arg(2); if (b) this.act((x) => x.eng.draw("indirect", o, 0, 0, 0, 0, b)); }
  DrawIndexedInstancedIndirect(c: Cpu): void { const b = this.ob<Buf11>(c.arg(1)), o = c.arg(2); if (b) this.act((x) => x.eng.draw("indexedIndirect", o, 0, 0, 0, 0, b)); }
  DrawAuto(): void { this.eng.warn("drawauto", "DrawAuto (stream output) is not supported"); }
  Dispatch(c: Cpu): void { const [a, b, d] = [c.arg(1), c.arg(2), c.arg(3)]; this.act((x) => x.eng.dispatch(a, b, d)); }
  DispatchIndirect(c: Cpu): void { const b = this.ob<Buf11>(c.arg(1)), o = c.arg(2); if (b) this.act((x) => x.eng.dispatch(0, 0, 0, b, o)); }

  // ------------------------------------------------------------------------------------------------------------------
  // clears
  // ------------------------------------------------------------------------------------------------------------------
  ClearRenderTargetView(c: Cpu): void {
    const v = this.ob<RTV11>(c.arg(1)), p = c.arg(2), m = this.mem;
    if (!v || !p) return;
    const col: [number, number, number, number] = [m.rf32(p), m.rf32(p + 4), m.rf32(p + 8), m.rf32(p + 12)];
    this.act((x) => x.clearRtv(v, col));
  }
  clearRtv(v: RTV11, col: [number, number, number, number]) {
    const g = this.gpu;
    if (!(v.res instanceof Tex11) || !v.res.gpu || !v.view) return;
    const t = v.res;
    this.touch(t);
    this.endPassIfUses(t.gpu);
    if (v.simple && t.dim === 2) {
      g.setPendingClear(t.gpu!, { color: col }, { colors: [{ view: v.view, tex: t.gpu!, format: v.fmtGpu }], depth: null, width: t.gw, height: t.gh, samples: t.gpuSamples });
      return;
    }
    g.endPass();
    const att: GPURenderPassColorAttachment = { view: v.view, loadOp: "clear", storeOp: "store", clearValue: { r: col[0], g: col[1], b: col[2], a: col[3] } };
    if (t.dim === 3) att.depthSlice = v.desc.firstW;
    g.cmd().beginRenderPass({ colorAttachments: [att] }).end();
    this.eng.invalidatePass();
  }
  ClearDepthStencilView(c: Cpu): void {
    const v = this.ob<DSV11>(c.arg(1)), flags = c.arg(2), depth = c.argF32(3), stencil = c.arg(4) & 0xff;
    if (!v) return;
    this.act((x) => x.clearDsv(v, flags, depth, stencil));
  }
  clearDsv(v: DSV11, flags: number, depth: number, stencil: number) {
    const g = this.gpu;
    if (!(v.res instanceof Tex11) || !v.res.gpu || !v.view) return;
    const t = v.res;
    const f = v.fmtGpu;
    const hasD = /depth/.test(f), hasS = /stencil/.test(f);
    const cl: { depth?: number; stencil?: number } = {};
    if ((flags & 1) && hasD) cl.depth = Math.max(0, Math.min(1, depth));
    if ((flags & 2) && hasS) cl.stencil = stencil;
    if (cl.depth === undefined && cl.stencil === undefined) return;
    this.touch(t);
    this.endPassIfUses(t.gpu);
    if (v.simple) {
      g.setPendingClear(t.gpu!, cl, { colors: [], depth: { view: v.view, tex: t.gpu!, format: f }, width: t.gw, height: t.gh, samples: t.gpuSamples });
      return;
    }
    g.endPass();
    const da: GPURenderPassDepthStencilAttachment = { view: v.view };
    if (hasD) { if (cl.depth !== undefined) { da.depthLoadOp = "clear"; da.depthClearValue = cl.depth; } else da.depthLoadOp = "load"; da.depthStoreOp = "store"; }
    if (hasS) { if (cl.stencil !== undefined) { da.stencilLoadOp = "clear"; da.stencilClearValue = cl.stencil; } else da.stencilLoadOp = "load"; da.stencilStoreOp = "store"; }
    g.cmd().beginRenderPass({ colorAttachments: [], depthStencilAttachment: da }).end();
    this.eng.invalidatePass();
  }
  ClearUnorderedAccessViewUint(c: Cpu): void {
    const u = this.ob<UAV11>(c.arg(1)), p = c.arg(2), m = this.mem;
    if (!u || !p) return;
    const vals = [m.r32(p), m.r32(p + 4), m.r32(p + 8), m.r32(p + 12)];
    this.act((x) => x.clearUav(u, vals, false));
  }
  ClearUnorderedAccessViewFloat(c: Cpu): void {
    const u = this.ob<UAV11>(c.arg(1)), p = c.arg(2), m = this.mem;
    if (!u || !p) return;
    const vals = [m.rf32(p), m.rf32(p + 4), m.rf32(p + 8), m.rf32(p + 12)];
    this.act((x) => x.clearUav(u, vals, true));
  }
  clearUav(u: UAV11, v: number[], isFloat: boolean) {
    const g = this.gpu;
    if (u.res instanceof Buf11) {
      const b = u.res;
      if (!b.gpu) return;
      this.syncBefore(b);
      const bytes = new Uint8Array(b.size);
      const dv = new DataView(bytes.buffer);
      const stride = u.desc.dim === 1 && b.stride ? b.stride : 4;
      void stride;
      for (let o = 0; o + 4 <= b.size; o += 4) { const k = (o >> 2) & 3; const val = isFloat ? v[0] : v[0]; void k; if (isFloat) dv.setFloat32(o, val, true); else dv.setUint32(o, val >>> 0, true); }
      g.writeBuffer(b.gpu, 0, bytes);
      return;
    }
    const t = u.res as Tex11;
    if (!t.gpu) return;
    this.syncBefore(t);
    const mip = u.desc.mostDetailedMip;
    const w = Math.max(1, t.gw >> mip), h = Math.max(1, t.gh >> mip);
    const bpp = t.gpuBytes;
    const row = new Uint8Array(w * bpp);
    const dv = new DataView(row.buffer);
    const comps = Math.min(4, t.fmt.comps);
    const csz = Math.max(1, Math.floor(bpp / Math.max(1, comps)));
    for (let x = 0; x < w; x++) for (let k = 0; k < comps; k++) {
      const o = x * bpp + k * csz;
      if (csz === 4) { if (isFloat) dv.setFloat32(o, v[k], true); else dv.setUint32(o, v[k] >>> 0, true); }
      else if (csz === 2) dv.setUint16(o, isFloat ? 0 : v[k] & 0xffff, true);
      else row[o] = isFloat ? Math.round(Math.max(0, Math.min(1, v[k])) * 255) : v[k] & 255;
    }
    const all = new Uint8Array(w * bpp * h);
    for (let y = 0; y < h; y++) all.set(row, y * w * bpp);
    g.endPass();
    g.queue.writeTexture({ texture: t.gpu, mipLevel: mip }, all, { bytesPerRow: w * bpp, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
  }
  ClearView(): void {}
  DiscardResource(): void {}
  DiscardView(): void {}
  DiscardView1(): void {}

  // ------------------------------------------------------------------------------------------------------------------
  // misc
  // ------------------------------------------------------------------------------------------------------------------
  GenerateMips(c: Cpu): void {
    const v = this.ob<SRV11>(c.arg(1));
    if (!v || !(v.res instanceof Tex11)) return;
    this.act(() => {
      const t = v.res as Tex11;
      if (!t.gpu || t.mips < 2 || t.dim !== 2 || !(t.gpu.usage & GPUTextureUsage.RENDER_ATTACHMENT)) return;
      this.gpu.resolveTexture(t.gpu);
      this.gpu.endPass();
      this.eng.invalidatePass();
      this.touch(t);
      this.gpu.generateMips(t.gpu, t.viewFormat(v.desc.fmt), t.arrays);
    });
  }
  SetResourceMinLOD(): void {}
  GetResourceMinLOD(c: Cpu): void { void c; }
  Flush(): void { if (!this.rec) this.gpu.flush(); }
  ClearState(): void { this.state((x) => { x.s = new State11(); x.omVersion++; }); }
  CopyStructureCount(): void { this.eng.warn("copystructure", "CopyStructureCount is not supported"); }

  FinishCommandList(c: Cpu): number {
    if (!this.rec) return E.DXGI_ERROR_INVALID_CALL;
    const restore = c.arg(1) !== 0, out = c.arg(2);
    const list = this.dev.makeCommandList(this.rec);
    this.rec = [];
    if (!restore) { this.s = new State11(); this.omVersion++; }
    if (out) this.mem.wptr(out, list.ptr);
    return 0;
  }
  ExecuteCommandList(c: Cpu): void {
    const l = this.ob<CommandList11>(c.arg(1)), restore = c.arg(2) !== 0;
    if (!l) return;
    const saved = restore ? this.s.clone() : null;
    for (const op of l.ops) op(this);
    if (saved) { this.s = saved; this.omVersion++; } else { this.s = new State11(); this.omVersion++; }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // queries
  // ------------------------------------------------------------------------------------------------------------------
  Begin(c: Cpu): void { const q = this.ob<Query11>(c.arg(1)); if (q) this.act(() => { q.started = true; q.ready = false; }); }
  End(c: Cpu): void {
    const q = this.ob<Query11>(c.arg(1));
    if (!q) return;
    this.act(() => {
      q.ready = false;
      if (q.qtype === QUERY.TIMESTAMP) q.value = BigInt(Math.floor(performance.now() * 1e6));
      const g = this.gpu;
      g.flush();
      g.queue.onSubmittedWorkDone().then(() => { q.ready = true; }, () => { q.ready = true; });
    });
  }
  GetData(c: Cpu): number {
    const q = this.ob<Query11>(c.arg(1)), out = c.arg(2), size = c.arg(3), m = this.mem;
    if (!q) return E.INVALIDARG;
    const need = q.GetDataSize();
    if (!q.ready) { this.dev.p.yieldRequested = true; return 1; }
    if (!out) return 0;
    if (size < need) return E.INVALIDARG;
    switch (q.qtype) {
      case QUERY.EVENT: m.w32(out, 1); break;
      case QUERY.OCCLUSION: m.w64(out, 1n); break;
      case QUERY.TIMESTAMP: m.w64(out, q.value); break;
      case QUERY.TIMESTAMP_DISJOINT: m.w64(out, 1000000000n); m.w32(out + 8, 0); break;
      case QUERY.OCCLUSION_PREDICATE: m.w32(out, 1); break;
      default: m.fill(out, 0, need);
    }
    return 0;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // copies and updates
  // ------------------------------------------------------------------------------------------------------------------
  CopyResource(c: Cpu): void {
    const dst = this.ob<Resource11>(c.arg(1)), src = this.ob<Resource11>(c.arg(2));
    if (!dst || !src) return;
    this.act((x) => x.copyResource(dst, src));
  }
  copyResource(dst: Resource11, src: Resource11) {
    if (dst instanceof Buf11 && src instanceof Buf11) { this.copyBuffer(dst, 0, src, 0, Math.min(dst.size, src.size)); return; }
    if (dst instanceof Tex11 && src instanceof Tex11) {
      const n = Math.min(dst.subresources, src.subresources);
      for (let s = 0; s < n; s++) this.copyTexture(dst, s, 0, 0, 0, src, s, null);
    }
  }
  CopySubresourceRegion(c: Cpu): void { this.copyRegion(c, false); }
  CopySubresourceRegion1(c: Cpu): void { this.copyRegion(c, true); }
  private copyRegion(c: Cpu, _v1: boolean) {
    const dst = this.ob<Resource11>(c.arg(1)), dsub = c.arg(2), dx = c.arg(3), dy = c.arg(4), dz = c.arg(5), src = this.ob<Resource11>(c.arg(6)), ssub = c.arg(7), bp = c.arg(8), m = this.mem;
    if (!dst || !src) return;
    const box = bp ? { l: m.r32(bp), t: m.r32(bp + 4), f: m.r32(bp + 8), r: m.r32(bp + 12), b: m.r32(bp + 16), k: m.r32(bp + 20) } : null;
    this.act((x) => {
      if (dst instanceof Buf11 && src instanceof Buf11) x.copyBuffer(dst, dx, src, box ? box.l : 0, box ? box.r - box.l : src.size);
      else if (dst instanceof Tex11 && src instanceof Tex11) x.copyTexture(dst, dsub, dx, dy, dz, src, ssub, box);
    });
  }

  private copyBuffer(dst: Buf11, dOff: number, src: Buf11, sOff: number, size: number) {
    const g = this.gpu, m = this.mem;
    size = Math.min(size, dst.size - dOff, src.size - sOff);
    if (size <= 0) return;
    this.touch(src); this.touch(dst);
    if (dst.gpu && src.gpu) {
      g.endPass(); this.eng.invalidatePass();
      const a = sOff & ~3, b = dOff & ~3;
      g.cmd().copyBufferToBuffer(src.gpu, a, dst.gpu, b, Math.min((size + 3) & ~3, src.gpu.size - a, dst.gpu.size - b));
      if (dst.mirror) dst.mirror.fill(0, 0, 0);
      return;
    }
    if (dst.shadow && !dst.gpu && src.gpu) {
      // GPU -> CPU-visible buffer: capture now, resolve on Map
      g.endPass(); this.eng.invalidatePass();
      const sz = (size + 3) & ~3;
      const tmp = g.device.createBuffer({ size: sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      g.cmd().copyBufferToBuffer(src.gpu, sOff & ~3, tmp, 0, Math.min(sz, src.gpu.size - (sOff & ~3)));
      dst.pendingReads.push({ buf: tmp, srcOffset: sOff & 3, dstOffset: dOff, size });
      return;
    }
    if (src.shadow && !src.gpu || (src.shadow && src.gpu && dst.shadow)) {
      // CPU -> destination (shadow copy and GPU upload)
      if (src.pendingReads.length) this.resolveNow(src);
      const data = m.bytes(src.shadow + sOff, size).slice();
      if (dst.shadow) m.write(dst.shadow + dOff, data);
      if (dst.isCB) dst.version++;
      if (dst.gpu) { this.syncBefore(dst); g.writeBuffer(dst.gpu, dOff, data); if (dst.mirror) dst.mirror.set(data, dOff); }
      return;
    }
    if (src.shadow && dst.shadow) { m.copy(dst.shadow + dOff, src.shadow + sOff, size); if (dst.isCB) dst.version++; }
  }

  /** synchronous resolution of GPU->CPU copies is only possible from a restartable call; used by Map */
  private resolveNow(r: Buf11 | Tex11) { void r; this.eng.warn("sync", "reading a resource with pending GPU copies outside Map"); }

  private copyTexture(dst: Tex11, dsub: number, dx: number, dy: number, dz: number, src: Tex11, ssub: number, box: { l: number; t: number; f: number; r: number; b: number; k: number } | null) {
    const g = this.gpu, m = this.mem;
    const smip = ssub % src.mips, slayer = Math.floor(ssub / src.mips), dmip = dsub % dst.mips, dlayer = Math.floor(dsub / dst.mips);
    const sw = Math.max(1, src.w >> smip), sh = Math.max(1, src.h >> smip), sd = Math.max(1, src.depth >> smip);
    const r = box ?? { l: 0, t: 0, f: 0, r: sw, b: sh, k: sd };
    const w = r.r - r.l, h = r.b - r.t, d = r.k - r.f;
    if (w <= 0 || h <= 0 || d <= 0) return;
    this.touch(src); this.touch(dst);
    if (src.gpu) g.resolveTexture(src.gpu);
    if (dst.gpu) g.resolveTexture(dst.gpu);
    const blk = src.fmt.block;
    const ext = (v: number, base: number) => (blk > 1 ? Math.min(Math.ceil(v / blk) * blk, Math.ceil(base / blk) * blk) : v);
    // ---- GPU -> GPU ------------------------------------------------------------------------------------------
    if (src.gpu && dst.gpu) {
      if (src.gpuSamples > 1 || dst.gpuSamples > 1) { this.eng.warn("msaacopy", "copy of multisampled textures is not supported"); return; }
      g.endPass(); this.eng.invalidatePass();
      const full = !box && src.w === dst.w && src.h === dst.h;
      void full;
      g.cmd().copyTextureToTexture(
        { texture: src.gpu, mipLevel: smip, origin: { x: r.l, y: r.t, z: src.dim === 3 ? r.f : slayer } },
        { texture: dst.gpu, mipLevel: dmip, origin: { x: dx, y: dy, z: dst.dim === 3 ? dz : dlayer } },
        { width: ext(w, Math.max(1, src.gw >> smip)), height: ext(h, Math.max(1, src.gh >> smip)), depthOrArrayLayers: src.dim === 3 ? d : 1 });
      return;
    }
    // ---- GPU -> staging --------------------------------------------------------------------------------------
    if (src.gpu && dst.shadow) {
      if (src.gpuSamples > 1 || /depth|stencil/.test(src.gpuFmt)) { this.eng.warn("rbdepth", "readback of multisampled or depth/stencil textures is not supported"); return; }
      g.endPass(); this.eng.invalidatePass();
      const gb = src.fmt.block > 1 ? src.fmt.bytes : src.gpuBytes;
      const rowB = (blk > 1 ? Math.ceil(w / blk) : w) * gb;
      const rows = blk > 1 ? Math.ceil(h / blk) : h;
      const bpr = (rowB + 255) & ~255;
      const tmp = g.device.createBuffer({ size: bpr * rows * d, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      g.cmd().copyTextureToBuffer(
        { texture: src.gpu, mipLevel: smip, origin: { x: r.l, y: r.t, z: src.dim === 3 ? r.f : slayer } },
        { buffer: tmp, bytesPerRow: bpr, rowsPerImage: rows },
        { width: ext(w, Math.max(1, src.gw >> smip)), height: ext(h, Math.max(1, src.gh >> smip)), depthOrArrayLayers: src.dim === 3 ? d : 1 });
      dst.pendingReads.push({ buf: tmp, bytesPerRow: bpr, rows, sub: dsub, x: dx, y: dy, z: dz, w, h, d });
      return;
    }
    // ---- staging / dynamic (CPU) -> GPU or staging -----------------------------------------------------------
    if (src.shadow) {
      if (src.pendingReads.length) this.resolveNow(src);
      const sl = src.layouts[ssub], dl = dst.layouts[dsub];
      const bb = src.fmt.bytes;
      const rowB = (blk > 1 ? Math.ceil(w / blk) : w) * bb;
      const rows = blk > 1 ? Math.ceil(h / blk) : h;
      const sx = (blk > 1 ? Math.floor(r.l / blk) : r.l) * bb, sy = blk > 1 ? Math.floor(r.t / blk) : r.t;
      if (dst.shadow) {
        const dxb = (blk > 1 ? Math.floor(dx / blk) : dx) * bb, dyb = blk > 1 ? Math.floor(dy / blk) : dy;
        for (let z = 0; z < d; z++) for (let y = 0; y < rows; y++) {
          m.copy(dst.shadow + dl.offset + (dz + z) * dl.slicePitch + (dyb + y) * dl.rowPitch + dxb, src.shadow + sl.offset + (r.f + z) * sl.slicePitch + (sy + y) * sl.rowPitch + sx, rowB);
        }
      }
      if (dst.gpu) {
        this.syncBefore(dst);
        this.upload(dst, dsub, dx, dy, dz, w, h, d, m.bytes(src.shadow + sl.offset + r.f * sl.slicePitch + sy * sl.rowPitch + sx, (d - 1) * sl.slicePitch + (rows - 1) * sl.rowPitch + rowB), sl.rowPitch, sl.slicePitch);
      }
    }
  }

  /** write texels (application layout, pitched rows) into a GPU texture subresource */
  upload(t: Tex11, sub: number, x: number, y: number, z: number, w: number, h: number, d: number, data: Uint8Array, rowPitch: number, slicePitch: number) {
    const g = this.gpu;
    if (!t.gpu) return;
    const mip = sub % t.mips, layer = Math.floor(sub / t.mips);
    const blk = t.fmt.block;
    const pw = blk > 1 ? Math.min(Math.ceil(w / blk) * blk, Math.ceil(Math.max(1, t.gw >> mip) / blk) * blk) : w;
    const ph = blk > 1 ? Math.min(Math.ceil(h / blk) * blk, Math.ceil(Math.max(1, t.gh >> mip) / blk) * blk) : h;
    const rows = blk > 1 ? Math.ceil(h / blk) : h;
    let bytes = data, bpr = rowPitch, rpi = slicePitch / Math.max(1, rowPitch);
    if (t.convert) {
      const gb = t.gpuBytes;
      const out = new Uint8Array(w * gb * h * d);
      for (let k = 0; k < d; k++) t.convert(data.subarray(k * slicePitch), rowPitch, out.subarray(k * w * gb * h), w * gb, w, h);
      bytes = out; bpr = w * gb; rpi = h;
    } else if (!Number.isInteger(rpi)) rpi = rows;
    g.endPass();
    this.eng.invalidatePass();
    g.queue.writeTexture({ texture: t.gpu, mipLevel: mip, origin: { x, y, z: t.dim === 3 ? z : layer } }, bytes as unknown as Uint8Array<ArrayBuffer>, { offset: 0, bytesPerRow: bpr, rowsPerImage: Math.max(1, rpi) },
      { width: pw, height: ph, depthOrArrayLayers: t.dim === 3 ? d : 1 });
  }

  UpdateSubresource(c: Cpu): void { this.updateSub(c, false); }
  UpdateSubresource1(c: Cpu): void { this.updateSub(c, true); }
  private updateSub(c: Cpu, _v1: boolean) {
    const res = this.ob<Resource11>(c.arg(1)), sub = c.arg(2), bp = c.arg(3), data = c.arg(4), rp = c.arg(5), dp = c.arg(6), m = this.mem;
    if (!res || !data) return;
    const box = bp ? { l: m.r32(bp), t: m.r32(bp + 4), f: m.r32(bp + 8), r: m.r32(bp + 12), b: m.r32(bp + 16), k: m.r32(bp + 20) } : null;
    if (res instanceof Buf11) {
      const off = box ? box.l : 0, size = box ? box.r - box.l : res.size;
      const bytes = m.bytes(data, Math.min(size, res.size - off)).slice();
      this.act((x) => x.updateBuffer(res, off, bytes));
      return;
    }
    const t = res as Tex11;
    const r = box ?? { l: 0, t: 0, f: 0, r: Math.max(1, t.w >> (sub % t.mips)), b: Math.max(1, t.h >> (sub % t.mips)), k: Math.max(1, t.depth >> (sub % t.mips)) };
    const w = r.r - r.l, h = r.b - r.t, d = r.k - r.f;
    const blk = t.fmt.block;
    const rows = blk > 1 ? Math.ceil(h / blk) : h;
    const rowB = (blk > 1 ? Math.ceil(w / blk) : w) * t.fmt.bytes;
    const rowPitch = rp || rowB, slicePitch = dp || rowPitch * rows;
    const total = (d - 1) * slicePitch + (rows - 1) * rowPitch + rowB;
    const bytes = m.bytes(data, total).slice();
    this.act((x) => x.updateTexture(t, sub, r, w, h, d, bytes, rowPitch, slicePitch));
  }
  updateBuffer(b: Buf11, off: number, bytes: Uint8Array) {
    if (b.shadow) { this.mem.write(b.shadow + off, bytes); }
    if (b.isCB) { b.version++; return; }
    if (!b.gpu) return;
    if (b.usedGen === this.gpu.stats.submits) {
      if (off === 0 && bytes.length >= b.size && !b.mirror) b.rename(); else this.gpu.flush();
    }
    this.gpu.writeBuffer(b.gpu, off, bytes);
    if (b.mirror) b.mirror.set(bytes, off);
  }
  updateTexture(t: Tex11, sub: number, r: { l: number; t: number; f: number }, w: number, h: number, d: number, bytes: Uint8Array, rowPitch: number, slicePitch: number) {
    if (t.shadow) {
      const l = t.layouts[sub], blk = t.fmt.block, bb = t.fmt.bytes;
      const rowB = (blk > 1 ? Math.ceil(w / blk) : w) * bb, rows = blk > 1 ? Math.ceil(h / blk) : h;
      const x0 = (blk > 1 ? Math.floor(r.l / blk) : r.l) * bb, y0 = blk > 1 ? Math.floor(r.t / blk) : r.t;
      for (let z = 0; z < d; z++) for (let y = 0; y < rows; y++) this.mem.write(t.shadow + l.offset + (r.f + z) * l.slicePitch + (y0 + y) * l.rowPitch + x0, bytes.subarray(z * slicePitch + y * rowPitch, z * slicePitch + y * rowPitch + rowB));
    }
    if (!t.gpu) return;
    this.syncBefore(t);
    if (t.gpu) this.gpu.resolveTexture(t.gpu);
    this.upload(t, sub, r.l, r.t, r.f, w, h, d, bytes, rowPitch, slicePitch);
  }

  ResolveSubresource(c: Cpu): void {
    const dst = this.ob<Tex11>(c.arg(1)), dsub = c.arg(2), src = this.ob<Tex11>(c.arg(3)), ssub = c.arg(4);
    if (!dst || !src) return;
    this.act((x) => {
      if (!dst.gpu || !src.gpu) return;
      const g = x.gpu;
      g.resolveTexture(src.gpu); g.resolveTexture(dst.gpu);
      g.endPass(); x.eng.invalidatePass();
      x.touch(src); x.touch(dst);
      const smip = ssub % src.mips, slayer = Math.floor(ssub / src.mips), dmip = dsub % dst.mips, dlayer = Math.floor(dsub / dst.mips);
      if (src.gpuSamples === 1) { x.copyTexture(dst, dsub, 0, 0, 0, src, ssub, null); return; }
      const sv = src.gpu.createView({ format: src.gpuFmt, dimension: "2d", baseMipLevel: smip, mipLevelCount: 1, baseArrayLayer: slayer, arrayLayerCount: 1 });
      const dv = dst.gpu.createView({ format: dst.gpuFmt, dimension: "2d", baseMipLevel: dmip, mipLevelCount: 1, baseArrayLayer: dlayer, arrayLayerCount: 1 });
      g.resolveViews(sv, dv);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // map / unmap
  // ------------------------------------------------------------------------------------------------------------------
  Map(c: Cpu): number {
    const res = this.ob<Resource11>(c.arg(1)), sub = c.arg(2), type = c.arg(3), flags = c.arg(4), out = c.arg(5), m = this.mem;
    if (!res) return E.INVALIDARG;
    if (res.mapState) return E.DXGI_ERROR_INVALID_CALL;
    if (this.rec) return this.deferredMap(res, sub, type, out);
    const wantsRead = type === MAP.READ || type === MAP.READ_WRITE;
    if (res instanceof Buf11) {
      if (!res.shadow) { this.eng.warn("mapdef", "Map on a default-usage buffer"); return E.INVALIDARG; }
      if (res.usage === USAGE.DEFAULT || res.usage === USAGE.IMMUTABLE) return E.INVALIDARG;
      if (wantsRead && res.pendingReads.length) {
        if (flags & DO_NOT_WAIT) { if (!this.dev.pollReadback(res)) { this.dev.p.yieldRequested = true; return E.DXGI_ERROR_WAS_STILL_DRAWING; } }
        else this.dev.waitReadback(res);
      }
      if (type === MAP.WRITE_DISCARD && res.gpu && res.usedGen === this.gpu.stats.submits) res.rename();
      res.mapState = { sub: 0, type };
      m.wptr(out, res.shadow); m.w32(out + 8, res.size); m.w32(out + 12, res.size);
      return 0;
    }
    const t = res as Tex11;
    if (!t.shadow) { this.eng.warn("mapdef", "Map on a default-usage texture"); return E.INVALIDARG; }
    if (sub >= t.subresources) return E.INVALIDARG;
    if (wantsRead && t.pendingReads.length) {
      if (flags & DO_NOT_WAIT) { if (!this.dev.pollReadback(t)) { this.dev.p.yieldRequested = true; return E.DXGI_ERROR_WAS_STILL_DRAWING; } }
      else this.dev.waitReadback(t);
    }
    const l = t.layouts[sub];
    t.mapState = { sub, type };
    m.wptr(out, t.shadow + l.offset); m.w32(out + 8, l.rowPitch); m.w32(out + 12, l.slicePitch);
    return 0;
  }
  Unmap(c: Cpu): void {
    const res = this.ob<Resource11>(c.arg(1)), sub = c.arg(2);
    if (!res) return;
    if (this.rec) { this.deferredUnmap(res); return; }
    const ms = res.mapState;
    if (!ms) return;
    res.mapState = null;
    const writes = ms.type !== MAP.READ;
    if (!writes) return;
    if (res instanceof Buf11) {
      if (res.isCB) { res.version++; return; }
      if (res.gpu) {
        if (ms.type !== MAP.WRITE_DISCARD && ms.type !== MAP.WRITE_NO_OVERWRITE && res.usedGen === this.gpu.stats.submits) this.gpu.flush();
        res.uploadShadow();
      }
      return;
    }
    const t = res as Tex11;
    void sub;
    if (t.gpu) {
      this.syncBefore(t);
      this.gpu.resolveTexture(t.gpu);
      const l = t.layouts[ms.sub];
      const mem = this.mem;
      this.upload(t, ms.sub, 0, 0, 0, l.w, l.h, l.d, mem.bytes(t.shadow + l.offset, l.size), l.rowPitch, l.slicePitch);
    }
  }
  private deferredMap(res: Resource11, sub: number, type: number, out: number): number {
    const m = this.mem;
    let size: number, rowPitch: number, slice: number;
    if (res instanceof Buf11) { size = res.size; rowPitch = size; slice = size; }
    else { const l = (res as Tex11).layouts[sub]; size = l.size; rowPitch = l.rowPitch; slice = l.slicePitch; }
    const ptr = this.dev.p.vm.alloc(Math.max(16, size), { commit: true, tag: "d3d11-deferred-map" });
    this.deferredMaps.set(res, { ptr, sub, type, size });
    res.mapState = { sub, type };
    m.wptr(out, ptr); m.w32(out + 8, rowPitch); m.w32(out + 12, slice);
    return 0;
  }
  private deferredUnmap(res: Resource11) {
    const d = this.deferredMaps.get(res);
    if (!d) return;
    this.deferredMaps.delete(res);
    res.mapState = null;
    const bytes = this.mem.bytes(d.ptr, d.size).slice();
    this.dev.p.vm.release(d.ptr);
    if (res instanceof Buf11) this.act((x) => x.updateBuffer(res, 0, bytes));
    else {
      const t = res as Tex11, l = t.layouts[d.sub];
      this.act((x) => x.updateTexture(t, d.sub, { l: 0, t: 0, f: 0 }, l.w, l.h, l.d, bytes, l.rowPitch, l.slicePitch));
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------------
// per-stage methods (VS/PS/GS/HS/DS/CS)
// ----------------------------------------------------------------------------------------------------------------------
const proto = Context11.prototype as any;
for (const st of STAGES) {
  const P = STAGE_PREFIX[st];
  proto[`${P}SetShader`] = function (this: Context11, c: Cpu) {
    const sh = this.ob<Shader11>(c.arg(1));
    this.state((x) => { x.s.sh[st as ShaderStage] = sh; });
  };
  proto[`${P}GetShader`] = function (this: Context11, c: Cpu) {
    const sh = this.s.sh[st as ShaderStage];
    this.mem.wptr(c.arg(1), sh ? sh.ptr : 0);
    if (sh) sh.refs++;
    if (c.arg(2) && c.arg(3)) this.mem.w32(c.arg(3), 0);
  };
  const setCb = function (this: Context11, c: Cpu, v1: boolean) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), pf = v1 ? c.arg(4) : 0, pn = v1 ? c.arg(5) : 0, m = this.mem;
    const items: { buf: Buf11 | null; first: number; num: number }[] = [];
    for (let i = 0; i < n; i++) items.push({ buf: pp ? this.ob<Buf11>(m.r32(pp + i * 8)) : null, first: pf ? m.r32(pf + i * 4) : 0, num: pn ? m.r32(pn + i * 4) : 4096 });
    this.state((x) => { items.forEach((it, i) => { if (start + i < 14) x.s.cb[st as ShaderStage][start + i] = it; }); });
  };
  proto[`${P}SetConstantBuffers`] = function (this: Context11, c: Cpu) { setCb.call(this, c, false); };
  proto[`${P}SetConstantBuffers1`] = function (this: Context11, c: Cpu) { setCb.call(this, c, true); };
  const getCb = function (this: Context11, c: Cpu, v1: boolean) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    for (let i = 0; i < n; i++) {
      const b = this.s.cb[st as ShaderStage][start + i];
      if (pp) { m.wptr(pp + i * 8, b.buf ? b.buf.ptr : 0); if (b.buf) b.buf.refs++; }
      if (v1) { if (c.arg(4)) m.w32(c.arg(4) + i * 4, b.first); if (c.arg(5)) m.w32(c.arg(5) + i * 4, b.num); }
    }
  };
  proto[`${P}GetConstantBuffers`] = function (this: Context11, c: Cpu) { getCb.call(this, c, false); };
  proto[`${P}GetConstantBuffers1`] = function (this: Context11, c: Cpu) { getCb.call(this, c, true); };
  proto[`${P}SetShaderResources`] = function (this: Context11, c: Cpu) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    const items: (SRV11 | null)[] = [];
    for (let i = 0; i < n; i++) items.push(pp ? this.ob<SRV11>(m.r32(pp + i * 8)) : null);
    this.state((x) => { items.forEach((it, i) => { if (start + i < 128) x.s.srv[st as ShaderStage][start + i] = it; }); });
  };
  proto[`${P}GetShaderResources`] = function (this: Context11, c: Cpu) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    for (let i = 0; i < n; i++) if (pp) { const v = this.s.srv[st as ShaderStage][start + i]; m.wptr(pp + i * 8, v ? v.ptr : 0); if (v) v.refs++; }
  };
  proto[`${P}SetSamplers`] = function (this: Context11, c: Cpu) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    const items: (SamplerState11 | null)[] = [];
    for (let i = 0; i < n; i++) items.push(pp ? this.ob<SamplerState11>(m.r32(pp + i * 8)) : null);
    this.state((x) => { items.forEach((it, i) => { if (start + i < 16) x.s.smp[st as ShaderStage][start + i] = it; }); });
  };
  proto[`${P}GetSamplers`] = function (this: Context11, c: Cpu) {
    const start = c.arg(1), n = c.arg(2), pp = c.arg(3), m = this.mem;
    for (let i = 0; i < n; i++) if (pp) { const v = this.s.smp[st as ShaderStage][start + i]; m.wptr(pp + i * 8, v ? v.ptr : 0); if (v) v.refs++; }
  };
}

void BIND; void CPU; void rowBytes; void rowCount; void DSV11;
