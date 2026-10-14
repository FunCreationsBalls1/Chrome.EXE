// A small assembler for Direct3D shader model 1-3 token streams, used to build test shaders that exercise specific opcodes.
import { OP, R, USAGE } from "../src/gpu/sm3.ts";

const OPS: Record<string, number> = {};
for (const [k, v] of Object.entries(OP)) OPS[k.toLowerCase()] = v;
OPS["texcrd"] = OP.TEXCOORD;
OPS["texld"] = OP.TEX;
OPS["texkill"] = OP.TEXKILL;

const USAGES: Record<string, number> = {
  position: USAGE.POSITION, blendweight: USAGE.BLENDWEIGHT, blendindices: USAGE.BLENDINDICES, normal: USAGE.NORMAL, psize: USAGE.PSIZE, texcoord: USAGE.TEXCOORD, tangent: USAGE.TANGENT,
  binormal: USAGE.BINORMAL, tessfactor: USAGE.TESSFACTOR, positiont: USAGE.POSITIONT, color: USAGE.COLOR, fog: USAGE.FOG, depth: USAGE.DEPTH, sample: USAGE.SAMPLE,
};
const CMPS: Record<string, number> = { gt: 1, eq: 2, ge: 3, lt: 4, ne: 5, le: 6 };

function regTok(type: number, index: number): number {
  return (0x80000000 | ((type & 7) << 28) | (((type >> 3) & 3) << 11) | (index & 0x7ff)) >>> 0;
}

interface ParsedReg { type: number; index: number; swz: string | null; neg: boolean; abs: boolean; mods: string[]; rel: { type: number; index: number; comp: number } | null; bnot: boolean }

function parseReg(s: string, isVs: boolean, major: number): ParsedReg {
  s = s.trim();
  let neg = false, bnot = false;
  const mods: string[] = [];
  if (s.startsWith("!")) { bnot = true; s = s.slice(1); }
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  let abs = false;
  const m1 = /^(.*)_(bias|bx2|x2|dz|dw|abs|comp)$/.exec(s);
  let work = s;
  if (m1) { work = m1[1]; mods.push(m1[2]); }
  if (/^abs\(.*\)$/.test(work)) { abs = true; work = work.slice(4, -1); }
  let swz: string | null = null;
  const sw = /^(.*?)\.([xyzwrgba]{1,4})$/.exec(work);
  let rel: ParsedReg["rel"] = null;
  const relm = /^(.*)\[\s*(a0|aL)(?:\.([xyzw]))?\s*(?:\+\s*(\d+))?\s*\]$/.exec(work);
  let base = work;
  if (relm) { base = relm[1] + (relm[4] ? relm[4] : "0"); rel = { type: relm[2] === "a0" ? R.ADDR : R.LOOP, index: 0, comp: relm[3] ? "xyzw".indexOf(relm[3]) : 0 }; }
  else if (sw) { base = sw[1]; swz = sw[2]; }
  let type = 0, index = 0;
  const pm = /^([a-zA-Z]+)(\d*)$/.exec(base);
  if (!pm) throw new Error("bad register " + s);
  const n = pm[2] === "" ? 0 : parseInt(pm[2], 10);
  switch (pm[1]) {
    case "r": type = R.TEMP; index = n; break;
    case "v": type = R.INPUT; index = n; break;
    case "c": type = R.CONST; index = n; break;
    case "a": type = R.ADDR; index = 0; break;
    case "t": type = R.TEXTURE; index = n; break;
    case "oPos": type = R.RASTOUT; index = 0; break;
    case "oFog": type = R.RASTOUT; index = 1; break;
    case "oPts": type = R.RASTOUT; index = 2; break;
    case "oD": type = R.ATTROUT; index = n; break;
    case "oT": type = R.TEXCRDOUT; index = n; break;
    case "o": type = isVs ? R.OUTPUT : R.COLOROUT; index = n; break;
    case "oC": type = R.COLOROUT; index = n; break;
    case "oDepth": type = R.DEPTHOUT; index = 0; break;
    case "i": type = R.CONSTINT; index = n; break;
    case "b": type = R.CONSTBOOL; index = n; break;
    case "s": type = R.SAMPLER; index = n; break;
    case "l": type = R.LABEL; index = n; break;
    case "p": type = R.PREDICATE; index = 0; break;
    case "aL": type = R.LOOP; index = 0; break;
    case "vPos": type = R.MISC; index = 0; break;
    case "vFace": type = R.MISC; index = 1; break;
    default: throw new Error("unknown register " + s);
  }
  void major;
  return { type, index, swz: swz, neg, abs, mods, rel, bnot };
}

const swzBits = (sw: string | null, n = 4): number => {
  const map: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
  if (!sw) return 0xe4;
  const c = sw.split("").map((ch) => map[ch]);
  while (c.length < 4) c.push(c[c.length - 1]);
  void n;
  return c[0] | (c[1] << 2) | (c[2] << 4) | (c[3] << 6);
};
const maskBits = (sw: string | null): number => {
  if (!sw) return 0xf;
  let m = 0;
  const map: Record<string, number> = { x: 1, y: 2, z: 4, w: 8, r: 1, g: 2, b: 4, a: 8 };
  for (const ch of sw) m |= map[ch];
  return m;
};

export function assembleSm3(text: string): Uint32Array {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$|;.*$/, "").trim()).filter(Boolean);
  const out: number[] = [];
  const header = lines.shift()!;
  const hm = /^(vs|ps)_(\d)_(\w+)$/.exec(header);
  if (!hm) throw new Error("bad version line: " + header);
  const isVs = hm[1] === "vs";
  const major = parseInt(hm[2], 10);
  const minor = hm[3] === "x" ? 1 : parseInt(hm[3], 10);
  out.push(((isVs ? 0xfffe : 0xffff) << 16) | (major << 8) | minor);
  for (const line of lines) {
    // predicate prefix: (p0.x) / (!p0.x)
    let pred: ParsedReg | null = null;
    let l = line;
    const pm = /^\(\s*(!?p0(?:\.\w)?)\s*\)\s*(.*)$/.exec(l);
    if (pm) { pred = parseReg(pm[1], isVs, major); l = pm[2]; }
    const sp = l.indexOf(" ");
    const opfull = (sp < 0 ? l : l.slice(0, sp)).toLowerCase();
    const argstr = sp < 0 ? "" : l.slice(sp + 1);
    const args = argstr.length ? splitArgs(argstr) : [];
    const parts = opfull.split("_");
    let name = parts[0];
    const suffix = parts.slice(1);
    let resultMods = 0, shift = 0, ctrl = 0;
    const predBit = pred ? 0x10000000 : 0;
    if (name === "dcl") {
      // dcl_position v0 / dcl_2d s0 / dcl_texcoord3 o1.xy
      const what = suffix[0];
      if (what === "2d" || what === "cube" || what === "volume") {
        const reg = parseReg(args[0], isVs, major);
        const tt = what === "2d" ? 2 : what === "cube" ? 3 : 4;
        out.push(OP.DCL | (2 << 24), (0x80000000 | (tt << 27)) >>> 0, regTok(reg.type, reg.index) | (0xf << 16));
        continue;
      }
      const usage = what ? USAGES[what] : undefined;
      const reg = parseReg(args[0], isVs, major);
      const idx = suffix[0] ? parseInt((suffix[0].match(/\d+$/) ?? ["0"])[0], 10) : 0;
      const usageName = suffix[0]?.replace(/\d+$/, "");
      const u = usageName && USAGES[usageName] !== undefined ? USAGES[usageName] : 0;
      void usage;
      const useIdx = /\d+$/.test(suffix[0] ?? "") ? idx : suffix[1] ? parseInt(suffix[1], 10) : 0;
      const maskTok = maskBits(reg.swz);
      out.push(OP.DCL | (2 << 24), (0x80000000 | u | (useIdx << 16)) >>> 0, regTok(reg.type, reg.index) | (maskTok << 16));
      continue;
    }
    for (const sfx of suffix) {
      if (sfx === "sat") resultMods |= 1;
      else if (sfx === "pp") resultMods |= 2;
      else if (sfx === "centroid") resultMods |= 4;
      else if (sfx === "x2") shift = 1; else if (sfx === "x4") shift = 2; else if (sfx === "x8") shift = 3; else if (sfx === "d2") shift = -1; else if (sfx === "d4") shift = -2; else if (sfx === "d8") shift = -3;
      else if (sfx === "p") ctrl = 1; else if (sfx === "b") ctrl = 2;
      else if (CMPS[sfx] !== undefined) ctrl = CMPS[sfx];
    }
    if (name === "def") {
      const reg = parseReg(args[0], isVs, major);
      const f = new Float32Array(args.slice(1).map(Number));
      out.push(OP.DEF | (5 << 24), regTok(reg.type, reg.index) | (0xf << 16), ...new Uint32Array(f.buffer));
      continue;
    }
    if (name === "defi") {
      const reg = parseReg(args[0], isVs, major);
      out.push(OP.DEFI | (5 << 24), regTok(reg.type, reg.index) | (0xf << 16), ...args.slice(1).map((x) => parseInt(x, 10) >>> 0));
      continue;
    }
    if (name === "defb") {
      const reg = parseReg(args[0], isVs, major);
      out.push(OP.DEFB | (2 << 24), regTok(reg.type, reg.index) | (0xf << 16), args[1] === "true" || args[1] === "1" ? 1 : 0);
      continue;
    }
    if (name === "end") { continue; }
    if (ctrl && name === "if") name = "ifc";
    if (ctrl && name === "break") name = "breakc";
    if (name === "texldp") { name = "texld"; ctrl = 1; } else if (name === "texldb") { name = "texld"; ctrl = 2; }
    const opcode = OPS[name];
    if (opcode === undefined) throw new Error("unknown opcode " + name);
    const toks: number[] = [];
    const noDst = [OP.IF, OP.IFC, OP.BREAKC, OP.BREAKP, OP.CALL, OP.CALLNZ, OP.LABEL, OP.LOOP, OP.REP].includes(opcode as any) || [OP.RET, OP.ENDLOOP, OP.ENDREP, OP.ELSE, OP.ENDIF, OP.BREAK, OP.NOP].includes(opcode as any);
    let i = 0;
    if (!noDst && args.length) {
      const d = parseReg(args[i++], isVs, major);
      let t = regTok(d.type, d.index) | (maskBits(d.swz) << 16) | (resultMods << 20) | ((shift & 0xf) << 24);
      if (d.rel) t |= 0x2000;
      toks.push(t >>> 0);
    }
    for (; i < args.length; i++) {
      const s = parseReg(args[i], isVs, major);
      let mod = 0;
      if (s.bnot) mod = 13;
      else if (s.abs) mod = s.neg ? 12 : 11;
      else if (s.mods.length) { const m = s.mods[0]; const base = m === "bias" ? 2 : m === "bx2" ? 4 : m === "x2" ? 7 : m === "dz" ? 9 : m === "dw" ? 10 : m === "comp" ? 6 : 0; mod = s.neg && (m === "bias" || m === "bx2" || m === "x2") ? base + 1 : base; }
      else if (s.neg) mod = 1;
      const hasRel = s.rel !== null;
      let t = regTok(s.type, s.index) | (swzBits(s.swz) << 16) | (mod << 24);
      if (hasRel) t |= 0x2000;
      toks.push(t >>> 0);
      if (hasRel) toks.push(regTok(s.rel!.type, s.rel!.index) | ((s.rel!.comp * 0x55) << 16) >>> 0);
    }
    if (pred) {
      const p = pred;
      toks.push((regTok(R.PREDICATE, 0) | (swzBits(p.swz ?? "x") << 16) | ((p.bnot || /!/.test(line) ? 13 : 0) << 24)) >>> 0);
    }
    const len = major >= 2 ? toks.length : 0;
    out.push((opcode | (ctrl << 16) | (len << 24) | predBit) >>> 0, ...toks);
  }
  out.push(0x0000ffff);
  return new Uint32Array(out);
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
