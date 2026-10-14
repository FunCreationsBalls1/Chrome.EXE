import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitSm3, parseSm3, semKey, USAGE } from "../src/gpu/sm3.ts";
import type { Sm3Link } from "../src/gpu/sm3.ts";
import { assembleSm3 } from "./sm3asm.ts";
import { buildWeb, haveChromium, openShell, validateWgsl } from "./browser.ts";

const BIN = join(import.meta.dirname, "shaders/bin");
const rd = (f: string) => { const b = readFileSync(join(BIN, f)); return new Uint32Array(b.buffer, b.byteOffset, b.length >> 2); };

function linkFor(stage: "vs" | "ps", sh: ReturnType<typeof parseSm3>, other?: ReturnType<typeof parseSm3>): Sm3Link {
  const slots = new Map<number, number>();
  const add = (u: number, i: number) => { const k = semKey(u, i); if (!slots.has(k)) slots.set(k, slots.size); };
  for (const s of [sh, other]) if (s) { for (const i of s.inputs) if (s.stage === "ps") add(i.usage, i.usageIndex); for (const o of s.outputs) add(o.usage === USAGE.POSITION ? 99 : o.usage, o.usageIndex); }
  return { stage, slots, halfPixel: stage === "vs" };
}

const ASM: Record<string, string> = {
  "vs ops": `vs_3_0
dcl_position v0
dcl_texcoord0 v1
dcl_color0 v2
dcl_position o0
dcl_texcoord0 o1
dcl_color0 o2
def c200, 0.5, 2, 3, 4
mov r0, v0
add r0, r0, c0
sub r1, r0, c1
mul r2, r1, c2
mad r3, r0, r1, c3
rcp r4, r3.x
rsq r4.y, r3.y
dp3 r5, r4, r2
dp4 r5.y, r4, r2
min r6, r0, r1
max r6.zw, r0, r1
slt r7, r0, r1
sge r7.xy, r0, r1
exp r8, r0.x
log r8.y, r0.y
lit r9, r0
dst r10, r0, r1
lrp r11, r0, r1, r2
frc r11.xy, r0
pow r12, r0.x, r1.x
crs r13, r0, r1
sgn r13.w, r0, r1, r2
abs r14, r0
nrm r15, r0
sincos r15.xy, r0.x
mov a0.x, v1.x
mova a0.x, v1.x
mov r0, c[a0.x + 3]
m4x4 r1, r0, c4
m4x3 r2.xyz, r0, c8
m3x3 r3.xyz, r0, c12
m3x2 r4.xy, r0, c16
dp2add r5, r0, r1, r2
cmp r6, r0, r1, r2
mov_sat r7, -r0.wzyx
mul_x2 r8, r0, abs(r1)
mov oPos, r0
mov o1, r1
mov o2, r2
`,
  "vs flow": `vs_3_0
dcl_position v0
dcl_position o0
defi i0, 4, 0, 1, 0
defb b1, true
mov r0, v0
loop aL, i0
  add r0, r0, c[aL + 10]
  if_lt r0.x, c0.x
    break
  endif
endloop
rep i0
  add r0.x, r0.x, c1.x
endrep
if b0
  mov r0.y, c2.y
else
  mov r0.y, c3.y
endif
ifc_gt r0.x, r0.y
  mov r0.z, c4.x
endif
call l0
mov oPos, r0
ret
label l0
add r0, r0, c5
ret
`,
  "ps basic": `ps_3_0
dcl_texcoord0 v0
dcl_color0 v1
dcl_2d s0
dcl_cube s1
texld r0, v0, s0
texldp r1, v0, s0
texldl r2, v0, s0
texld_b r3, v0, s0
mul r0, r0, v1
dsx r4, v0
dsy r5, v0
texkill r0
setp_gt p0, r0, r1
(p0.x) mov r0, r1
(!p0.y) mov r0.x, c0.x
mov_sat oC0, r0
`,
  "ps legacy": `ps_1_4
def c0, 1, 0.5, 0.25, 1
texld r0, t0
texld r1, t1
mad r0, r0, r1, c0
`,
  "ps legacy11": `ps_1_1
tex t0
tex t1
mul r0, t0, t1
`,
};

test("SM3 -> WGSL translation validates in the browser's WGSL compiler", { skip: !haveChromium() }, async () => {
  buildWeb();
  const mods: Record<string, string> = {};
  const vsb = parseSm3(rd("basic.vs.cso")), psb = parseSm3(rd("basic.ps.cso"));
  mods["basic.vs"] = emitSm3(vsb, linkFor("vs", vsb, psb)).wgsl;
  mods["basic.ps"] = emitSm3(psb, linkFor("ps", psb, vsb)).wgsl;
  const vs2 = parseSm3(rd("basic.vs20.cso")), ps2 = parseSm3(rd("basic.ps20.cso"));
  mods["basic.vs20"] = emitSm3(vs2, linkFor("vs", vs2, ps2)).wgsl;
  mods["basic.ps20"] = emitSm3(ps2, linkFor("ps", ps2, vs2)).wgsl;
  const fvs = parseSm3(rd("flow.vs.cso"));
  mods["flow.vs"] = emitSm3(fvs, linkFor("vs", fvs)).wgsl;
  for (const [name, src] of Object.entries(ASM)) {
    const sh = parseSm3(assembleSm3(src));
    const link = linkFor(sh.stage, sh);
    mods[name] = emitSm3(sh, link).wgsl;
  }
  const s = await openShell();
  try {
    const res = await validateWgsl(s.page, mods);
    const bad = Object.entries(res).filter(([, e]) => e.length);
    assert.equal(bad.length, 0, bad.map(([n, e]) => `== ${n}\n${e.join("\n")}\n--- source\n${mods[n]}`).join("\n\n"));
  } finally {
    await s.close();
  }
});
