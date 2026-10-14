// WebGPU device wrapper shared by the Direct3D 9 and 11 front-ends.
//
// Owns the device, one shared command encoder (flushed on present / readback / explicit sync), the render-pass tracker with
// deferred clears, ring buffers for transient uniform and vertex data, and small utility pipelines (blit, clear).

export interface PendingClear {
  color?: [number, number, number, number];
  depth?: number;
  stencil?: number;
}

export interface PassTarget {
  colors: { view: GPUTextureView; tex: GPUTexture; format: GPUTextureFormat }[];
  depth: { view: GPUTextureView; tex: GPUTexture; format: GPUTextureFormat } | null;
  width: number;
  height: number;
  samples: number;
}

const UNIFORM_RING = 16 << 20;
const TRANSIENT_RING = 32 << 20;

export class Gpu {
  device!: GPUDevice;
  adapter!: GPUAdapter;
  queue!: GPUQueue;
  features = new Set<string>();
  limits!: GPUSupportedLimits;
  canvasFormat: GPUTextureFormat = "bgra8unorm";
  hasBC = false;
  hasDepth32Stencil8 = false;
  hasFloat32Filterable = false;
  hasFloat32Blendable = false;
  hasClipDistances = false;
  hasDualSource = false;
  hasIndirectFirstInstance = false;
  hasTimestamp = false;
  encoder: GPUCommandEncoder | null = null;
  pass: GPURenderPassEncoder | null = null;
  passKey = "";
  passTargets: PassTarget | null = null;
  pending = new Map<GPUTexture, PendingClear>();
  /** statistics */
  stats = { draws: 0, passes: 0, submits: 0, pipelines: 0, uploads: 0 };
  lastError: string | null = null;
  errors: string[] = [];
  private errorsReported = 0;
  /** validation errors raised since the last call */
  drainErrors(): string[] {
    const out = this.errors.slice(this.errorsReported);
    this.errorsReported = this.errors.length;
    return out;
  }

  static async create(opts: { powerPreference?: GPUPowerPreference } = {}): Promise<Gpu | null> {
    const nav = (globalThis as any).navigator;
    if (!nav?.gpu) return null;
    const adapter: GPUAdapter | null = await nav.gpu.requestAdapter({ powerPreference: opts.powerPreference ?? "high-performance" });
    if (!adapter) return null;
    const g = new Gpu();
    g.adapter = adapter;
    const want: GPUFeatureName[] = ["texture-compression-bc", "depth32float-stencil8", "float32-filterable", "float32-blendable", "clip-distances", "dual-source-blending", "indirect-first-instance", "bgra8unorm-storage", "rg11b10ufloat-renderable"] as GPUFeatureName[];
    const features = want.filter((f) => adapter.features.has(f));
    // request the best limits the adapter offers: D3D applications use many more resources than the WebGPU defaults
    const requiredLimits: Record<string, number> = {};
    for (const k of ["maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D", "maxTextureArrayLayers", "maxBindGroups", "maxBindingsPerBindGroup", "maxDynamicUniformBuffersPerPipelineLayout",
      "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage",
      "maxUniformBufferBindingSize", "maxStorageBufferBindingSize", "maxVertexBuffers", "maxBufferSize", "maxVertexAttributes", "maxVertexBufferArrayStride", "maxInterStageShaderVariables",
      "maxColorAttachments", "maxColorAttachmentBytesPerSample", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY",
      "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension"]) {
      const v = (adapter.limits as any)[k];
      if (typeof v === "number") requiredLimits[k] = v;
    }
    g.device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits });
    g.queue = g.device.queue;
    g.features = new Set(features);
    g.limits = g.device.limits;
    g.canvasFormat = nav.gpu.getPreferredCanvasFormat();
    g.hasBC = g.features.has("texture-compression-bc");
    g.hasDepth32Stencil8 = g.features.has("depth32float-stencil8");
    g.hasFloat32Filterable = g.features.has("float32-filterable");
    g.hasFloat32Blendable = g.features.has("float32-blendable");
    g.hasClipDistances = g.features.has("clip-distances");
    g.hasDualSource = g.features.has("dual-source-blending");
    g.hasIndirectFirstInstance = g.features.has("indirect-first-instance");
    g.device.addEventListener("uncapturederror", (e: any) => {
      const msg = e.error?.message ?? String(e);
      g.lastError = msg;
      if (g.errors.length < 200) g.errors.push(msg);
    });
    g.device.lost.then((info) => { g.errors.push("device lost: " + info.message); });
    g.initRings();
    return g;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // command encoding
  // ------------------------------------------------------------------------------------------------------------------
  cmd(): GPUCommandEncoder {
    if (!this.encoder) this.encoder = this.device.createCommandEncoder();
    return this.encoder;
  }
  endPass() {
    if (this.pass) { this.pass.end(); this.pass = null; this.passKey = ""; this.passTargets = null; }
  }
  /** Finish and submit everything recorded so far. */
  flush() {
    this.endPass();
    if (this.encoder) {
      this.queue.submit([this.encoder.finish()]);
      this.encoder = null;
      this.stats.submits++;
    }
    this.resetRings();
  }

  setPendingClear(tex: GPUTexture, c: PendingClear) {
    const cur = this.pending.get(tex) ?? {};
    this.pending.set(tex, { ...cur, ...c });
  }
  clearPending(tex: GPUTexture) { this.pending.delete(tex); }

  /** The render pass for these targets; begins a new pass (applying pending clears) when the targets differ from the open one. */
  renderPass(t: PassTarget, key: string): GPURenderPassEncoder {
    if (this.pass && this.passKey === key) return this.pass;
    this.endPass();
    const colorAttachments: GPURenderPassColorAttachment[] = t.colors.map((c) => {
      const p = this.pending.get(c.tex);
      if (p?.color) { const col = p.color; this.pending.set(c.tex, { ...p, color: undefined }); return { view: c.view, loadOp: "clear", storeOp: "store", clearValue: { r: col[0], g: col[1], b: col[2], a: col[3] } }; }
      return { view: c.view, loadOp: "load", storeOp: "store" };
    });
    const desc: GPURenderPassDescriptor = { colorAttachments };
    if (t.depth) {
      const p = this.pending.get(t.depth.tex);
      const hasStencil = /stencil/.test(t.depth.format);
      const hasDepth = /depth/.test(t.depth.format);
      const da: GPURenderPassDepthStencilAttachment = { view: t.depth.view };
      if (hasDepth) {
        if (p?.depth !== undefined) { da.depthLoadOp = "clear"; da.depthClearValue = p.depth; } else da.depthLoadOp = "load";
        da.depthStoreOp = "store";
      }
      if (hasStencil) {
        if (p?.stencil !== undefined) { da.stencilLoadOp = "clear"; da.stencilClearValue = p.stencil; } else da.stencilLoadOp = "load";
        da.stencilStoreOp = "store";
      }
      if (p) this.pending.set(t.depth.tex, { ...p, depth: undefined, stencil: undefined });
      desc.depthStencilAttachment = da;
    }
    this.pass = this.cmd().beginRenderPass(desc);
    this.passKey = key;
    this.passTargets = t;
    this.stats.passes++;
    return this.pass;
  }

  /** Apply pending clears to a set of attachments without drawing (a pass with no draws). */
  resolvePending(t: PassTarget, key: string) {
    this.renderPass(t, key);
    this.endPass();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // transient data rings (uniforms and vertex/index data for user-pointer draws)
  // ------------------------------------------------------------------------------------------------------------------
  uniformRing!: GPUBuffer;
  uniformOffset = 0;
  transientRing!: GPUBuffer;
  transientOffset = 0;
  uniformAlign = 256;
  private initRings() {
    this.uniformAlign = this.limits.minUniformBufferOffsetAlignment;
    this.uniformRing = this.device.createBuffer({ size: UNIFORM_RING, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: "uniform ring" });
    this.transientRing = this.device.createBuffer({ size: TRANSIENT_RING, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE, label: "transient ring" });
  }
  /** incremented whenever the rings restart from zero (cached ring offsets become invalid) */
  ringEpoch = 0;
  private resetRings() {
    this.uniformOffset = 0;
    this.transientOffset = 0;
    this.ringEpoch++;
  }
  /** make sure `uniformBytes`/`transientBytes` can be pushed without a mid-pass flush */
  reserve(uniformBytes: number, transientBytes: number) {
    if (this.uniformOffset + uniformBytes + 4 * this.uniformAlign > UNIFORM_RING || this.transientOffset + transientBytes + 64 > TRANSIENT_RING) this.flush();
  }
  /** Write uniform data into the ring; returns the dynamic offset. Flushes (submits) when the ring is exhausted. */
  pushUniform(data: ArrayBufferView): number {
    const size = (data.byteLength + this.uniformAlign - 1) & ~(this.uniformAlign - 1);
    if (this.uniformOffset + size > UNIFORM_RING) this.flushForRing();
    const off = this.uniformOffset;
    this.queue.writeBuffer(this.uniformRing, off, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    this.uniformOffset += size;
    return off;
  }
  pushTransient(data: ArrayBufferView, align = 16): number {
    const size = (data.byteLength + 3) & ~3;
    if (this.transientOffset + size + align > TRANSIENT_RING) this.flushForRing();
    const off = (this.transientOffset + align - 1) & ~(align - 1);
    if (size === data.byteLength) this.queue.writeBuffer(this.transientRing, off, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    else { const tmp = new Uint8Array(size); tmp.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); this.queue.writeBuffer(this.transientRing, off, tmp); }
    this.transientOffset = off + size;
    return off;
  }
  private flushForRing() {
    // Ring space is only reusable after previously recorded commands were submitted *and executed*; queue.writeBuffer ordering
    // guarantees that writes happen before later submits but not after earlier ones, so a wrap would corrupt in-flight data.
    // Cheap solution: flush, then continue from zero (the queue serialises writes against submitted work).
    this.flush();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------------------------
  createBuffer(size: number, usage: GPUBufferUsageFlags, label?: string): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(4, (size + 3) & ~3), usage, label });
  }
  writeBuffer(buf: GPUBuffer, offset: number, data: Uint8Array) {
    // writeBuffer requires 4-byte aligned offset/size
    const start = offset & ~3;
    const end = (offset + data.length + 3) & ~3;
    if (start === offset && end === offset + data.length) { this.queue.writeBuffer(buf, offset, data.buffer as ArrayBuffer, data.byteOffset, data.length); return; }
    const tmp = new Uint8Array(end - start);
    tmp.set(data, offset - start);
    this.queue.writeBuffer(buf, start, tmp);
  }

  // blit pipelines (texture -> texture, used for presentation and stretch/copy operations)
  private blitCache = new Map<string, GPURenderPipeline>();
  private blitSampler: GPUSampler | null = null;
  private blitModule: GPUShaderModule | null = null;
  blitPipeline(format: GPUTextureFormat, filtered: boolean): GPURenderPipeline {
    const key = format + (filtered ? "f" : "n");
    let p = this.blitCache.get(key);
    if (p) return p;
    if (!this.blitModule) {
      this.blitModule = this.device.createShaderModule({
        label: "blit",
        code: `
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
struct Params { rect: vec4<f32>, src: vec4<f32> };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> prm: Params;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0));
  let q = p[vi];
  var o: VOut;
  // rect = (x0, y0, x1, y1) in clip space; src = (u0, v0, u1, v1)
  o.pos = vec4<f32>(mix(prm.rect.x, prm.rect.z, q.x), mix(prm.rect.y, prm.rect.w, q.y), 0.0, 1.0);
  o.uv = vec2<f32>(mix(prm.src.x, prm.src.z, q.x), mix(prm.src.y, prm.src.w, q.y));
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> { return textureSampleLevel(tex, smp, i.uv, 0.0); }
`,
      });
    }
    p = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.blitModule, entryPoint: "vs" },
      fragment: { module: this.blitModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-strip" },
      label: "blit " + key,
    });
    this.blitCache.set(key, p);
    return p;
  }
  blitSamplerFor(filtered: boolean): GPUSampler {
    const key = filtered ? "f" : "n";
    this.samplerCache ??= new Map();
    let s = this.samplerCache.get(key);
    if (!s) { s = this.device.createSampler({ magFilter: filtered ? "linear" : "nearest", minFilter: filtered ? "linear" : "nearest" }); this.samplerCache.set(key, s); }
    return s;
  }
  private samplerCache: Map<string, GPUSampler> | null = null;

  /** Draw `src` (or a sub-rectangle of it) into `dst` (a view with `dstFormat`) covering the pixel rectangle dstRect. */
  blit(src: GPUTexture, srcRect: [number, number, number, number] | null, dst: GPUTexture, dstFormat: GPUTextureFormat, dstRect: [number, number, number, number] | null, filtered: boolean) {
    this.endPass();
    const dw = dst.width, dh = dst.height;
    const dr = dstRect ?? [0, 0, dw, dh];
    const sr = srcRect ?? [0, 0, src.width, src.height];
    const params = new Float32Array([
      (dr[0] / dw) * 2 - 1, 1 - (dr[3] / dh) * 2, (dr[2] / dw) * 2 - 1, 1 - (dr[1] / dh) * 2, // note: v grows downward; quad's y=0 is bottom
      sr[0] / src.width, sr[3] / src.height, sr[2] / src.width, sr[1] / src.height,
    ]);
    const pipeline = this.blitPipeline(dstFormat, filtered);
    const ubuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.queue.writeBuffer(ubuf, 0, params);
    const bg = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: src.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }) }, { binding: 1, resource: this.blitSamplerFor(filtered) }, { binding: 2, resource: { buffer: ubuf } }],
    });
    const p = this.pending.get(dst);
    const pass = this.cmd().beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: p ? "clear" : "load", storeOp: "store", clearValue: p?.color ? { r: p.color[0], g: p.color[1], b: p.color[2], a: p.color[3] } : undefined }] });
    if (p) this.pending.delete(dst);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.setViewport(0, 0, dw, dh, 0, 1);
    pass.draw(4);
    pass.end();
    ubuf.destroy();
  }

  /** Read back a texture's mip-0 contents as tightly packed rows (async; the caller must drive completion). */
  async readTexture(tex: GPUTexture, bytesPerPixel: number, x = 0, y = 0, w = tex.width, h = tex.height, layer = 0, mip = 0): Promise<Uint8Array> {
    this.endPass();
    const rowBytes = w * bytesPerPixel;
    const pitch = (rowBytes + 255) & ~255;
    const buf = this.device.createBuffer({ size: pitch * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.cmd().copyTextureToBuffer({ texture: tex, origin: { x, y, z: layer }, mipLevel: mip }, { buffer: buf, bytesPerRow: pitch }, { width: w, height: h });
    this.flush();
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(rowBytes * h);
    for (let r = 0; r < h; r++) out.set(src.subarray(r * pitch, r * pitch + rowBytes), r * rowBytes);
    buf.unmap();
    buf.destroy();
    return out;
  }
}
