import { test } from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { buildWeb, dropFixture, emuState, haveChromium, openShell, samplePixels, waitEmu } from "./browser.ts";
import { haveSysdll } from "./win32-util.ts";

const skip = !haveChromium() || !haveSysdll();
const BIN = join(import.meta.dirname, "shaders/bin");
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("Direct3D 11: device + swap chain, DXBC shaders, buffers, textures, blending render through WebGPU", { skip }, async () => {
  buildWeb();
  const s = await openShell();
  let cleanup = () => {};
  try {
    cleanup = await dropFixture(s, "d3d11_basic.exe", { "basic.vs.cso": join(BIN, "d3d11_basic.vs.cso"), "basic.ps.cso": join(BIN, "d3d11_basic.ps.cso") }, ["interactive.flag"]);
    await waitEmu(s.page, "(e.windows && Object.keys(e.windows).length > 0 && /resources created/.test(e.stdout)) || e.crash || e.exitCode !== null", 90000);
    await s.page.waitForTimeout(2500);
    const st = await emuState(s.page);
    assert.equal(st.crash, null, String(st.crash) + "\n" + st.log.join("\n"));
    const out = st.out.replace(/\r\n/g, "\n");
    assert.match(out, /feature level b000\nadapter: Chrome\.EXE WebGPU Adapter vendor=10de\nbackbuffer 320x240 fmt=28\nshaders and layout created\nresources created\n/, out + st.log.join("\n"));
    const W = 320, H = 240;
    const px = await samplePixels(s.page, [[5 / W, 5 / H], [100 / W, 80 / H], [140 / W, 80 / H], [100 / W, 160 / H], [140 / W, 160 / H], [40 / W, 200 / H]]);
    const bad: string[] = [];
    // checker texel (0,0) red * tint (0.5,1,0.5) = (128,0,0); texel (1,0) white * tint = (128,255,128)
    const want: [string, number[], number[]][] = [
      ["clear colour", px[0], [10, 20, 30]],
      ["checker top-left texel red*tint", px[1], [128, 0, 0]],
      ["checker texel white*tint", px[2], [128, 255, 128]],
    ];
    for (const [label, got, w] of want) if (!near(got, w)) bad.push(`${label}: got ${got} want ${w}`);
    assert.ok(px[5][0] + px[5][1] + px[5][2] > 120, "triangle interior is coloured: " + px[5]);
    assert.equal(bad.length, 0, bad.join("\n") + "\n" + st.log.join("\n"));
    await s.page.keyboard.press("q");
    await waitEmu(s.page, "e.exitCode !== null || e.crash", 30000);
    const end = await emuState(s.page);
    assert.equal(end.crash, null, String(end.crash));
    assert.equal(end.code, 0, end.out + end.log.join("\n"));
  } finally {
    const st = await emuState(s.page).catch(() => null);
    if (st) console.log(st.log.slice(0, 40).join("\n"), s.logs.join("\n"));
    await s.close();
    cleanup();
  }
});

test("Direct3D 11: render targets, depth/stencil, instancing, mips, dynamic textures, blend factor, deferred contexts, MSAA, compute, copies, readback", { skip }, async () => {
  buildWeb();
  const s = await openShell();
  let cleanup = () => {};
  try {
    cleanup = await dropFixture(s, "d3d11_adv.exe", {
      "adv.vs.cso": join(BIN, "d3d11_adv.vs.cso"), "adv.ps.cso": join(BIN, "d3d11_adv.ps.cso"), "adv.fvs.cso": join(BIN, "d3d11_adv.fvs.cso"), "adv.tps.cso": join(BIN, "d3d11_adv.tps.cso"),
      "adv.cs.cso": join(BIN, "d3d11_cs.cso"),
    });
    await waitEmu(s.page, "e.crash || e.exitCode !== null", 120000);
    const st = await emuState(s.page);
    assert.equal(st.crash, null, String(st.crash) + "\n" + st.log.join("\n"));
    const out = st.out.replace(/\r\n/g, "\n");
    const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
    assert.equal(fails.length, 0, out + "\n" + st.log.join("\n"));
    assert.match(out, /summary pass=\d+ fail=0/, out + "\n" + st.log.join("\n"));
    assert.equal(st.code, 0, out + st.log.join("\n"));
  } finally {
    const st = await emuState(s.page).catch(() => null);
    if (st) console.log(st.log.slice(0, 60).join("\n"), s.logs.join("\n"));
    await s.close();
    cleanup();
  }
});
