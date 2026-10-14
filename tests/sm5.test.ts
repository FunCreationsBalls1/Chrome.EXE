import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { disasm, emitSm5, parseDxbc } from "../src/gpu/sm5.ts";
import type { Sm5Link, Sm5Shader } from "../src/gpu/sm5.ts";
import { buildWeb, haveChromium, openShell, validateWgsl } from "./browser.ts";

const BIN = join(import.meta.dirname, "shaders/bin");
const rd = (f: string) => new Uint8Array(readFileSync(join(BIN, f)));

/** link context: varyings are keyed by semantic name + index, in the order the vertex shader writes them */
export function linkFor5(stage: "vs" | "ps" | "cs", sh: Sm5Shader, other?: Sm5Shader): Sm5Link {
  const slots = new Map<string, { slot: number; interp: string; kind: "f" | "u" | "i" }>();
  const vs = stage === "vs" ? sh : other;
  const ps = stage === "ps" ? sh : other;
  for (const o of vs?.outputs ?? []) {
    if (o.sysVal === 1 && o.name.toUpperCase() === "SV_POSITION") continue;
    slots.set(`${o.name.toUpperCase()}#${o.index}`, { slot: slots.size, interp: "", kind: o.compType === 2 ? "i" : o.compType === 1 ? "u" : "f" });
  }
  const inputKinds = new Map<number, string>();
  if (stage === "vs") for (const i of sh.inputs) inputKinds.set(i.reg, i.compType === 1 ? "u" : i.compType === 2 ? "i" : "f");
  void ps;
  return { stage, slots, inputKinds, targets: 4 };
}

const names = readdirSync(BIN).filter((f) => f.startsWith("d3d11_")).sort();

test("DXBC containers parse and disassemble", () => {
  assert.ok(names.length >= 9);
  for (const n of names) {
    const sh = parseDxbc(rd(n));
    assert.ok(sh.ins.length > 0, n);
    assert.deepEqual(sh.unsupported, [], n);
    const text = disasm(sh);
    assert.ok(text.includes("ret"), `${n}\n${text}`);
  }
  const ps = parseDxbc(rd("d3d11_basic.ps.cso"));
  assert.equal(ps.type, 0);
  assert.equal(ps.major, 5);
  assert.ok(ps.srvs.has(0) && ps.samplers.has(0));
  const vs = parseDxbc(rd("d3d11_basic.vs.cso"));
  assert.equal(vs.type, 1);
  assert.deepEqual(vs.inputs.map((i) => i.name.toUpperCase()), ["POSITION", "COLOR", "TEXCOORD"]);
  assert.ok(vs.cbs.get(0)!.size >= 5);
  const v4 = parseDxbc(rd("d3d11_basic.vs40.cso"));
  assert.equal(v4.major, 4);
});

test("SM4/5 -> WGSL translation validates in the browser's WGSL compiler", { skip: !haveChromium() }, async () => {
  buildWeb();
  const mods: Record<string, string> = {};
  const parsed = new Map(names.map((n) => [n, parseDxbc(rd(n))]));
  for (const [n, sh] of parsed) {
    const stage = sh.type === 1 ? "vs" : "ps";
    const other = stage === "ps" ? parsed.get(n.replace(".ps", ".vs")) : parsed.get(n.replace(".vs", ".ps"));
    mods[n] = emitSm5(sh, linkFor5(stage, sh, other)).wgsl;
  }
  const s = await openShell();
  try {
    const res = await validateWgsl(s.page, mods);
    const bad = Object.entries(res).filter(([, e]) => e.length);
    assert.equal(bad.length, 0, bad.map(([n, e]) => `== ${n}\n${e.join("\n")}\n--- source\n${mods[n]}\n--- dxbc\n${disasm(parsed.get(n)!)}`).join("\n\n"));
  } finally {
    await s.close();
  }
});
