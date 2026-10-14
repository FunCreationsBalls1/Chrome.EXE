// Direct3D 9 fixed-function pipeline emulation: generates WGSL for the transform/lighting stage and the texture-stage
// cascade from the current device state.
import { semKey, USAGE } from "./sm3.ts";
import type { Sm3Link } from "./sm3.ts";

export const MAX_LIGHTS = 8;
// uniform layout (floats): see packFfp()
const FLOATS_MATRICES = 16 * (5 + 8 + 4); // world, view, proj, wv, wvp, tex[8], blend[4]
const FLOATS_NORMALMAT = 12;
const FLOATS_MATERIAL = 4 * 6;
const FLOATS_LIGHT = 4 * 7;
export const FFP_FLOATS = FLOATS_MATRICES + FLOATS_NORMALMAT + FLOATS_MATERIAL + FLOATS_LIGHT * MAX_LIGHTS + 4 * 4 + 6 * 4;
export const FFP_UNIFORM_BYTES = Math.ceil((FFP_FLOATS * 4) / 16) * 16;

export interface FfpVertexState {
  /** key parts describing the vertex layout the shader reads */
  hasNormal: boolean;
  hasDiffuse: boolean;
  hasSpecular: boolean;
  pretransformed: boolean;
  /** position attribute has 4 components (XYZW) */
  position4: boolean;
  blendWeights: number;
  blendIndices: boolean;
  /** per texture stage 0..7: number of components of the source coordinate set read by TEXCOORDINDEX (0 = unavailable) */
  texCoordDims: number[];
  lighting: boolean;
  colorVertex: boolean;
  diffuseSrc: number; specularSrc: number; ambientSrc: number; emissiveSrc: number;
  specularEnable: boolean;
  normalize: boolean;
  localViewer: boolean;
  lights: number[]; // enabled light types in order (1 point, 2 spot, 3 directional)
  vertexBlend: number; // 0..3, 255 = tweening
  fogVertexMode: number; // D3DFOG_* when per-vertex fog is on, 0 otherwise
  fogEnable: boolean;
  rangeFog: boolean;
  tableFog: boolean;
  /** per stage: texcoord index and generation mode, transform flags */
  stages: { index: number; gen: number; ttff: number }[];
  numStages: number;
}

export interface FfpStage {
  colorOp: number; colorArg0: number; colorArg1: number; colorArg2: number;
  alphaOp: number; alphaArg0: number; alphaArg1: number; alphaArg2: number;
  resultArg: number;
  hasTexture: boolean;
  dim: "2d" | "cube" | "3d";
  projected: boolean;
  /** constant colour source (D3DTA_CONSTANT) */
  constant: number;
}

export interface FfpPixelState {
  specularEnable: boolean;
  fogEnable: boolean;
  fogMode: number; // table fog mode (D3DFOG_*) for pixel fog, 0 for vertex fog
  hasSpecularInput: boolean;
}

interface VertexGen { key: string; inputs: { loc: number; usage: number; usageIndex: number }[]; outputs: { usage: number; usageIndex: number }[]; emit(link: Sm3Link): { wgsl: string; vsOutputs: number[]; psInputs: number[] } }
interface PixelGen { key: string; varyings: { usage: number; usageIndex: number }[]; samplers: Map<number, "2d" | "cube" | "3d">; emit(link: Sm3Link): { wgsl: string; vsOutputs: number[]; psInputs: number[] } }

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const STRUCTS = `
struct Light { info: vec4<f32>, diffuse: vec4<f32>, specular: vec4<f32>, ambient: vec4<f32>, position: vec4<f32>, direction: vec4<f32>, atten: vec4<f32> };
struct Ffp {
  world: mat4x4<f32>, view: mat4x4<f32>, proj: mat4x4<f32>, wv: mat4x4<f32>, wvp: mat4x4<f32>,
  tex: array<mat4x4<f32>, 8>,
  blend: array<mat4x4<f32>, 4>,
  nrm0: vec4<f32>, nrm1: vec4<f32>, nrm2: vec4<f32>,
  mDiffuse: vec4<f32>, mAmbient: vec4<f32>, mSpecular: vec4<f32>, mEmissive: vec4<f32>, mPower: vec4<f32>, ambient: vec4<f32>,
  lights: array<Light, ${MAX_LIGHTS}>,
  tfactor: vec4<f32>, viewport: vec4<f32>, fog: vec4<f32>, fogColor: vec4<f32>,
  clip: array<vec4<f32>, 6>,
};
@group(0) @binding(2) var<uniform> prm: Params;
@group(0) @binding(3) var<uniform> ffp: Ffp;
`;
const PARAMS = `struct Params { vpInv: vec4<f32>, alpha: vec4<f32>, fogColor: vec4<f32>, fog: vec4<f32>, misc: vec4<f32> };`;

export function ffpVertex(s: FfpVertexState): VertexGen {
  const key = JSON.stringify([s.hasNormal, s.hasDiffuse, s.hasSpecular, s.pretransformed, s.position4, s.blendWeights, s.blendIndices, s.texCoordDims, s.lighting, s.colorVertex, s.diffuseSrc, s.specularSrc, s.ambientSrc,
    s.emissiveSrc, s.specularEnable, s.normalize, s.localViewer, s.lights, s.vertexBlend, s.fogVertexMode, s.fogEnable, s.rangeFog, s.tableFog, s.stages, s.numStages]);
  const inputs: VertexGen["inputs"] = [{ loc: 0, usage: s.pretransformed ? USAGE.POSITIONT : USAGE.POSITION, usageIndex: 0 }];
  if (s.hasNormal) inputs.push({ loc: 1, usage: USAGE.NORMAL, usageIndex: 0 });
  if (s.hasDiffuse) inputs.push({ loc: 2, usage: USAGE.COLOR, usageIndex: 0 });
  if (s.hasSpecular) inputs.push({ loc: 3, usage: USAGE.COLOR, usageIndex: 1 });
  for (let i = 0; i < 8; i++) if (s.texCoordDims[i]) inputs.push({ loc: 4 + i, usage: USAGE.TEXCOORD, usageIndex: i });
  if (s.blendWeights) inputs.push({ loc: 12, usage: USAGE.BLENDWEIGHT, usageIndex: 0 });
  const outputs: VertexGen["outputs"] = [{ usage: USAGE.COLOR, usageIndex: 0 }, { usage: USAGE.COLOR, usageIndex: 1 }];
  for (let i = 0; i < s.numStages; i++) outputs.push({ usage: USAGE.TEXCOORD, usageIndex: i });
  outputs.push({ usage: USAGE.FOG, usageIndex: 0 });
  return {
    key, inputs, outputs,
    emit(link) {
      const slotOf = (u: number, i: number) => link.slots.get(semKey(u, i));
      const out: string[] = [];
      const entryIn: string[] = [`@location(0) pos: vec4<f32>`];
      if (s.hasNormal) entryIn.push("@location(1) normal: vec4<f32>");
      if (s.hasDiffuse) entryIn.push("@location(2) diffuse: vec4<f32>");
      if (s.hasSpecular) entryIn.push("@location(3) specular: vec4<f32>");
      for (let i = 0; i < 8; i++) if (s.texCoordDims[i]) entryIn.push(`@location(${4 + i}) tc${i}: vec4<f32>`);
      if (s.blendWeights) entryIn.push("@location(12) bw: vec4<f32>");
      const kinds = link.inputKinds;
      const swz = (loc: number, e: string) => (kinds?.get(loc) === "c" ? `${e}.zyxw` : e);
      const entryOut: string[] = [];
      const writes: string[] = [];
      const emitOut = (u: number, i: number, expr: string) => {
        const slot = slotOf(u, i);
        if (slot === undefined) return;
        entryOut.push(`@location(${slot}) l${slot}: vec4<f32>`);
        writes.push(`out.l${slot} = ${expr};`);
      };
      out.push("diagnostic(off, derivative_uniformity);");
      out.push(PARAMS);
      out.push(STRUCTS);
      out.push("struct In {\n" + entryIn.map((x) => "  " + x + ",").join("\n") + "\n};");
      const body: string[] = [];
      // ---- position ----
      if (s.pretransformed) {
        body.push("let rhw = select(1.0, in.pos.w, in.pos.w != 0.0);");
        body.push("let cx = (in.pos.x - ffp.viewport.x) / ffp.viewport.z * 2.0 - 1.0;");
        body.push("let cy = 1.0 - (in.pos.y - ffp.viewport.y) / ffp.viewport.w * 2.0;");
        body.push("var clipPos = vec4<f32>(cx / rhw, cy / rhw, in.pos.z / rhw, 1.0 / rhw);");
        body.push("var vpos = vec3<f32>(0.0);");
        body.push("var vnrm = vec3<f32>(0.0, 0.0, 1.0);");
      } else {
        body.push(`var p4 = vec4<f32>(in.pos.xyz, ${s.position4 ? "in.pos.w" : "1.0"});`);
        if (s.vertexBlend > 0 && s.vertexBlend !== 255 && s.blendWeights) {
          body.push("var wsum = 0.0;");
          body.push("var vp4 = vec4<f32>(0.0);");
          body.push("var vn = vec3<f32>(0.0);");
          for (let i = 0; i <= s.vertexBlend; i++) {
            const w = i < s.vertexBlend ? `in.bw[${i}]` : "(1.0 - wsum)";
            body.push(`{ let wt = ${w}; vp4 = vp4 + (ffp.blend[${i}] * p4) * wt;${s.hasNormal ? ` vn = vn + (mat3x3<f32>(ffp.blend[${i}][0].xyz, ffp.blend[${i}][1].xyz, ffp.blend[${i}][2].xyz) * in.normal.xyz) * wt;` : ""} ${i < s.vertexBlend ? "wsum = wsum + wt;" : ""} }`);
          }
          body.push("let vposv = vp4;");
          body.push("var vpos = vposv.xyz;");
          body.push("var clipPos = ffp.proj * vposv;");
          body.push("var vnrm = vn;");
        } else {
          body.push("let vposv = ffp.wv * p4;");
          body.push("var vpos = vposv.xyz;");
          body.push("var clipPos = ffp.wvp * p4;");
          body.push(s.hasNormal ? "var vnrm = vec3<f32>(dot(ffp.nrm0.xyz, in.normal.xyz), dot(ffp.nrm1.xyz, in.normal.xyz), dot(ffp.nrm2.xyz, in.normal.xyz));" : "var vnrm = vec3<f32>(0.0, 0.0, 1.0);");
        }
        if (s.normalize || s.vertexBlend) body.push("vnrm = normalize(vnrm);");
      }
      // ---- colours / lighting ----
      const vcol = s.hasDiffuse ? swz(2, "in.diffuse") : "vec4<f32>(1.0)";
      const vspec = s.hasSpecular ? swz(3, "in.specular") : "vec4<f32>(0.0)";
      let diffuseOut = vcol, specularOut = vspec;
      if (s.lighting && !s.pretransformed) {
        const src = (mode: number, mat: string, vc: string, has: boolean) => (s.colorVertex && has ? (mode === 1 ? vcol : mode === 2 ? vspec : mat) : mat);
        // material sources: 0 = material, 1 = COLOR1 (diffuse), 2 = COLOR2 (specular)
        body.push(`let md = ${src(s.diffuseSrc, "ffp.mDiffuse", vcol, s.diffuseSrc === 1 ? s.hasDiffuse : s.hasSpecular)};`);
        body.push(`let ma = ${src(s.ambientSrc, "ffp.mAmbient", vcol, s.ambientSrc === 1 ? s.hasDiffuse : s.hasSpecular)};`);
        body.push(`let ms = ${src(s.specularSrc, "ffp.mSpecular", vcol, s.specularSrc === 1 ? s.hasDiffuse : s.hasSpecular)};`);
        body.push(`let me = ${src(s.emissiveSrc, "ffp.mEmissive", vcol, s.emissiveSrc === 1 ? s.hasDiffuse : s.hasSpecular)};`);
        body.push("var accD = ma.rgb * ffp.ambient.rgb;");
        body.push("var accS = vec3<f32>(0.0);");
        body.push(`let eye = ${s.localViewer ? "normalize(-vpos)" : "vec3<f32>(0.0, 0.0, -1.0)"};`);
        s.lights.forEach((ty, i) => {
          body.push("{");
          body.push(`  let L_ = ffp.lights[${i}];`);
          if (ty === 3) {
            body.push("  let ldir = normalize(-L_.direction.xyz);");
            body.push("  var att = 1.0;");
          } else {
            body.push("  var ldv = L_.position.xyz - vpos;");
            body.push("  let dist = length(ldv);");
            body.push("  let ldir = ldv / max(dist, 1.0e-20);");
            body.push("  var att = 1.0 / (L_.atten.x + L_.atten.y * dist + L_.atten.z * dist * dist);");
            body.push("  if (dist > L_.info.y) { att = 0.0; }");
            if (ty === 2) {
              body.push("  let rho = dot(-ldir, normalize(L_.direction.xyz));");
              body.push("  let cth = L_.direction.w; let cph = L_.position.w;");
              body.push("  if (rho <= cph) { att = 0.0; } else if (rho < cth) { att = att * pow((rho - cph) / (cth - cph), L_.info.z); }");
            }
          }
          body.push("  let ndl = max(dot(vnrm, ldir), 0.0);");
          body.push("  accD = accD + att * (ma.rgb * L_.ambient.rgb + md.rgb * L_.diffuse.rgb * ndl);");
          if (s.specularEnable) {
            body.push("  let hv = normalize(ldir + eye);");
            body.push("  let ndh = max(dot(vnrm, hv), 0.0);");
            body.push("  if (ndl > 0.0 && ffp.mPower.x > 0.0) { accS = accS + att * ms.rgb * L_.specular.rgb * pow(ndh, ffp.mPower.x); }");
          }
          body.push("}");
        });
        diffuseOut = "vec4<f32>(clamp(accD + me.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), md.a)";
        specularOut = s.specularEnable ? "vec4<f32>(clamp(accS, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0)" : "vec4<f32>(0.0)";
        // light with no lights: only ambient+emissive
      } else if (s.lighting) {
        diffuseOut = vcol;
      }
      body.push(`let outD = ${diffuseOut};`);
      body.push(`let outS = ${specularOut};`);
      emitOut(USAGE.COLOR, 0, "outD");
      emitOut(USAGE.COLOR, 1, "outS");
      // ---- texture coordinates ----
      for (let i = 0; i < s.numStages; i++) {
        const st = s.stages[i];
        const gen = st.gen;
        let src: string;
        const setIdx = st.index;
        const dim = s.texCoordDims[setIdx] ?? 0;
        const comp = `vec4<f32>(${dim >= 1 ? "" : "0.0, "}${dim ? `in.tc${setIdx}` : ""}`;
        void comp;
        if (gen === 1) src = "vec4<f32>(vnrm, 1.0)"; // camera space normal
        else if (gen === 2) src = "vec4<f32>(vpos, 1.0)"; // camera space position
        else if (gen === 3) src = "vec4<f32>(reflect(normalize(vpos), vnrm), 1.0)"; // reflection vector
        else if (gen === 4) { // sphere map
          body.push(`let r${i} = reflect(normalize(vpos), vnrm); let m${i} = 2.0 * sqrt(r${i}.x * r${i}.x + r${i}.y * r${i}.y + (r${i}.z + 1.0) * (r${i}.z + 1.0));`);
          src = `vec4<f32>(r${i}.x / m${i} + 0.5, -r${i}.y / m${i} + 0.5, 0.0, 1.0)`;
        } else if (dim) {
          const tcExpr = `in.tc${setIdx}`;
          src = dim === 1 ? `vec4<f32>(${tcExpr}.x, 0.0, 0.0, 1.0)` : dim === 2 ? `vec4<f32>(${tcExpr}.xy, 0.0, 1.0)` : dim === 3 ? `vec4<f32>(${tcExpr}.xyz, 1.0)` : `${tcExpr}`;
        } else src = "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
        const cnt = st.ttff & 0xff;
        if (cnt) {
          body.push(`var tt${i} = ffp.tex[${i}] * ${src};`);
          // components beyond the requested count are zero (w=1 stays for projection)
          const zeros = cnt === 1 ? "tt" + i + " = vec4<f32>(tt" + i + ".x, 0.0, 0.0, 1.0);" : cnt === 2 ? "tt" + i + " = vec4<f32>(tt" + i + ".xy, 0.0, 1.0);" : cnt === 3 ? "tt" + i + " = vec4<f32>(tt" + i + ".xyz, 1.0);" : "";
          if (st.ttff & 256) {
            // projected: the divisor is the last requested component; deliver (x, y, z, divisor)
            const last = cnt === 1 ? "x" : cnt === 2 ? "y" : cnt === 3 ? "z" : "w";
            body.push(`tt${i} = vec4<f32>(tt${i}.xyz, tt${i}.${last});`);
          } else if (zeros) body.push(zeros);
          emitOut(USAGE.TEXCOORD, i, `tt${i}`);
        } else {
          emitOut(USAGE.TEXCOORD, i, src);
        }
      }
      // ---- fog ----
      if (s.fogEnable) {
        if (s.tableFog) {
          emitOut(USAGE.FOG, 0, s.rangeFog ? "vec4<f32>(length(vpos))" : "vec4<f32>(abs(vpos.z))");
        } else if (s.fogVertexMode) {
          const d = s.rangeFog ? "length(vpos)" : "abs(vpos.z)";
          const fm = s.fogVertexMode === 3 ? `clamp((ffp.fog.y - ${d}) / (ffp.fog.y - ffp.fog.x), 0.0, 1.0)` : s.fogVertexMode === 1 ? `clamp(exp(-ffp.fog.z * ${d}), 0.0, 1.0)` : `clamp(exp(-(ffp.fog.z * ${d}) * (ffp.fog.z * ${d})), 0.0, 1.0)`;
          emitOut(USAGE.FOG, 0, `vec4<f32>(${fm})`);
        }
      }
      void f;
      // user clip planes are applied in the pixel stage through discard (not supported here)
      out.push("struct Out {\n  @builtin(position) pos: vec4<f32>,\n" + entryOut.map((x) => "  " + x + ",").join("\n") + "\n};");
      const vsOutputs = [...link.slots.values()].filter((sl) => entryOut.some((e) => e.includes(`@location(${sl})`)));
      const extra = (link.extraSlots ?? []).filter((sl) => !vsOutputs.includes(sl));
      for (const sl of extra) { entryOut.push(`@location(${sl}) l${sl}: vec4<f32>`); writes.push(`out.l${sl} = vec4<f32>(0.0);`); }
      out[out.length - 1] = "struct Out {\n  @builtin(position) pos: vec4<f32>,\n" + entryOut.map((x) => "  " + x + ",").join("\n") + "\n};";
      out.push("@vertex fn main(in: In) -> Out {");
      out.push("  var out: Out;");
      for (const l of body) out.push("  " + l);
      out.push("  var cp = clipPos;");
      out.push("  cp.x = cp.x + cp.w * prm.vpInv.x;");
      out.push("  cp.y = cp.y - cp.w * prm.vpInv.y;");
      out.push("  out.pos = cp;");
      for (const w of writes) out.push("  " + w);
      out.push("  return out;");
      out.push("}");
      return { wgsl: out.join("\n") + "\n", vsOutputs, psInputs: [] };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// pixel stage: texture stage cascade
// ---------------------------------------------------------------------------------------------------------------
export function ffpPixel(stages: FfpStage[], st: FfpPixelState, vsOutputs: { usage: number; usageIndex: number }[]): PixelGen {
  const n = stages.length;
  const key = JSON.stringify([stages, st, vsOutputs.length]);
  const samplers = new Map<number, "2d" | "cube" | "3d">();
  stages.forEach((s, i) => { if (s.hasTexture) samplers.set(i, s.dim); });
  const varyings: PixelGen["varyings"] = [{ usage: USAGE.COLOR, usageIndex: 0 }, { usage: USAGE.COLOR, usageIndex: 1 }];
  for (let i = 0; i < n; i++) varyings.push({ usage: USAGE.TEXCOORD, usageIndex: i });
  if (st.fogEnable) varyings.push({ usage: USAGE.FOG, usageIndex: 0 });
  return {
    key, varyings, samplers,
    emit(link) {
      const out: string[] = [];
      out.push("diagnostic(off, derivative_uniformity);");
      out.push(PARAMS);
      out.push(STRUCTS);
      for (const [i, dim] of samplers) {
        out.push(`@group(1) @binding(${i * 2}) var t_${i}: ${dim === "cube" ? "texture_cube<f32>" : dim === "3d" ? "texture_3d<f32>" : "texture_2d<f32>"};`);
        out.push(`@group(1) @binding(${i * 2 + 1}) var s_${i}: sampler;`);
      }
      const entryIn: string[] = [];
      const slotOf = (u: number, i: number) => link.slots.get(semKey(u, i));
      const rd = (u: number, i: number, dflt: string): string => {
        const sl = slotOf(u, i);
        if (sl === undefined) return dflt;
        if (!entryIn.some((e) => e.includes(`@location(${sl})`))) entryIn.push(`@location(${sl}) l${sl}: vec4<f32>`);
        return `in.l${sl}`;
      };
      const body: string[] = [];
      body.push(`var cur = clamp(${rd(USAGE.COLOR, 0, "vec4<f32>(1.0)")}, vec4<f32>(0.0), vec4<f32>(1.0));`);
      body.push(`let spec = clamp(${rd(USAGE.COLOR, 1, "vec4<f32>(0.0)")}, vec4<f32>(0.0), vec4<f32>(1.0));`);
      body.push("var tmp = vec4<f32>(0.0);");
      body.push(`let diffuse = cur;`);
      const argExpr = (a: number, idx: number, isAlpha: boolean, texName: string): string => {
        let base: string;
        switch (a & 7) {
          case 0: base = "diffuse"; break;
          case 1: base = "cur"; break;
          case 2: base = texName; break;
          case 3: base = "ffp.tfactor"; break;
          case 4: base = "spec"; break;
          case 5: base = "tmp"; break;
          case 6: base = "ffp.tfactor"; break;
          default: base = "cur";
        }
        let e = base;
        if (a & 0x20 && !isAlpha) e = `vec4<f32>(${e}.a)`;
        else if (a & 0x20) e = `vec4<f32>(${e}.a)`;
        if (a & 0x10) e = `(vec4<f32>(1.0) - ${e})`;
        void idx;
        return e;
      };
      stages.forEach((s, i) => {
        const tc = rd(USAGE.TEXCOORD, i, "vec4<f32>(0.0)");
        let texExpr = "vec4<f32>(1.0)"; // a stage without a bound texture samples as white (the cascade then reduces to the vertex colour)
        if (samplers.has(i)) {
          const dim = s.dim;
          const c = s.projected ? (dim === "2d" ? `(${tc}).xy / (${tc}).w` : `(${tc}).xyz / (${tc}).w`) : dim === "2d" ? `(${tc}).xy` : `(${tc}).xyz`;
          texExpr = `textureSample(t_${i}, s_${i}, ${c})`;
        }
        body.push(`let tex${i} = ${texExpr};`);
        const A = (a: number, isA: boolean) => argExpr(a, i, isA, `tex${i}`);
        const c0 = A(s.colorArg0, false), c1 = A(s.colorArg1, false), c2 = A(s.colorArg2, false);
        const a0 = A(s.alphaArg0, true), a1 = A(s.alphaArg1, true), a2 = A(s.alphaArg2, true);
        const colorExpr = topExpr(s.colorOp, c0, c1, c2, `${c1}`, "tex" + i, "diffuse", "cur", false);
        const alphaExpr = topExpr(s.alphaOp, a0, a1, a2, `${a1}`, "tex" + i, "diffuse", "cur", true);
        const dst = s.resultArg === 2 ? "tmp" : "cur";
        // alpha first (some colour ops read the previous alpha through `cur`)
        body.push(`{ let rc = ${colorExpr}; let ra = ${alphaExpr}; ${dst} = vec4<f32>(rc.rgb, ra.a); }`);
        body.push(`${dst} = clamp(${dst}, vec4<f32>(0.0), vec4<f32>(1.0));`);
      });
      if (n === 0) { /* no stages: current colour passes through */ }
      if (st.specularEnable) body.push("cur = vec4<f32>(clamp(cur.rgb + spec.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), cur.a);");
      if (st.fogEnable) {
        const fv = rd(USAGE.FOG, 0, "vec4<f32>(1.0)");
        let fac: string;
        if (st.fogMode === 3) fac = `clamp((prm.fog.y - ${fv}.x) / (prm.fog.y - prm.fog.x), 0.0, 1.0)`;
        else if (st.fogMode === 1) fac = `clamp(exp(-prm.fog.z * ${fv}.x), 0.0, 1.0)`;
        else if (st.fogMode === 2) fac = `clamp(exp(-(prm.fog.z * ${fv}.x) * (prm.fog.z * ${fv}.x)), 0.0, 1.0)`;
        else fac = `clamp(${fv}.x, 0.0, 1.0)`;
        body.push(`cur = vec4<f32>(mix(prm.fogColor.rgb, cur.rgb, ${fac}), cur.a);`);
      }
      if (link.alphaFunc && link.alphaFunc !== 8) {
        const a = "cur.a", ref = "prm.alpha.x";
        const fnc = link.alphaFunc;
        const test = fnc === 1 ? "false" : fnc === 2 ? `${a} < ${ref}` : fnc === 3 ? `${a} == ${ref}` : fnc === 4 ? `${a} <= ${ref}` : fnc === 5 ? `${a} > ${ref}` : fnc === 6 ? `${a} != ${ref}` : `${a} >= ${ref}`;
        body.push(`if (!(${test})) { discard; }`);
      }
      body.push("return cur;");
      if (entryIn.length) out.push("struct In {\n" + entryIn.map((x) => "  " + x + ",").join("\n") + "\n};");
      out.push(`@fragment fn main(${entryIn.length ? "in: In" : ""}) -> @location(0) vec4<f32> {`);
      for (const l of body) out.push("  " + l);
      out.push("}");
      const psInputs = entryIn.map((e) => Number(/@location\((\d+)\)/.exec(e)![1]));
      return { wgsl: out.join("\n") + "\n", vsOutputs: [], psInputs };
    },
  };
}

export function stageNeedsTexture(s: FfpStage): boolean {
  const t = (a: number) => (a & 7) === 2;
  if (s.colorOp === 1) return false;
  const usesColor = s.colorOp > 1 && (t(s.colorArg1) || t(s.colorArg2) || (s.colorOp === 25 || s.colorOp === 26) && t(s.colorArg0));
  const usesAlpha = s.alphaOp > 1 && (t(s.alphaArg1) || t(s.alphaArg2));
  return usesColor || usesAlpha || [13, 15, 18, 19, 20, 21, 17].includes(s.colorOp) || [13, 15].includes(s.alphaOp);
}

/** WGSL expression combining the arguments according to D3DTEXTUREOP (result as vec4; only rgb or a is meaningful). */
function topExpr(op: number, a0: string, a1: string, a2: string, sel1: string, tex: string, diffuse: string, cur: string, isAlpha: boolean): string {
  const v = (e: string) => e;
  const one = "vec4<f32>(1.0)";
  switch (op) {
    case 1: return isAlpha ? cur : cur; // DISABLE (handled by stage truncation)
    case 2: return v(a1);
    case 3: return v(a2);
    case 4: return `(${a1} * ${a2})`;
    case 5: return `(${a1} * ${a2} * 2.0)`;
    case 6: return `(${a1} * ${a2} * 4.0)`;
    case 7: return `(${a1} + ${a2})`;
    case 8: return `(${a1} + ${a2} - vec4<f32>(0.5))`;
    case 9: return `((${a1} + ${a2} - vec4<f32>(0.5)) * 2.0)`;
    case 10: return `(${a1} - ${a2})`;
    case 11: return `(${a1} + ${a2} - ${a1} * ${a2})`;
    case 12: return `mix(${a2}, ${a1}, ${diffuse}.a)`;
    case 13: return `mix(${a2}, ${a1}, ${tex}.a)`;
    case 14: return `mix(${a2}, ${a1}, ffp.tfactor.a)`;
    case 15: return `(${a1} + ${a2} * (${one} - vec4<f32>(${tex}.a)))`;
    case 16: return `mix(${a2}, ${a1}, ${cur}.a)`;
    case 17: return `(${a1} * ${a2})`; // PREMODULATE (alpha passes the next stage's texture)
    case 18: return `(${a1} * ${a2} + vec4<f32>(${a1}.a))`;
    case 19: return `(${a1}.a * ${a2} + ${a1})`;
    case 20: return `((${one} - vec4<f32>(${a1}.a)) * ${a2} + ${a1})`;
    case 21: return `((${one} - ${a1}) * ${a2} + vec4<f32>(${a1}.a))`;
    case 22: case 23: return v(a1); // bump mapping: approximated by the first argument
    case 24: { const d = `clamp(dot(${a1}.rgb - vec3<f32>(0.5), ${a2}.rgb - vec3<f32>(0.5)) * 4.0, 0.0, 1.0)`; return `vec4<f32>(${d})`; }
    case 25: return `(${a0} + ${a1} * ${a2})`;
    case 26: return `(${a1} * ${a0} + ${a2} * (${one} - ${a0}))`;
    default: return v(a1);
  }
}
