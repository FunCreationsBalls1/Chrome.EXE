import { test } from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { buildWeb, dropFixture, emuState, haveChromium, openShell, samplePixels, waitEmu } from "./browser.ts";
import { haveSysdll } from "./win32-util.ts";

const skip = !haveChromium() || !haveSysdll();

test("Direct3D 9: device creation, clear, fixed-function colored geometry and alpha blending render through WebGPU", { skip }, async () => {
  buildWeb();
  const s = await openShell();
  let cleanup = () => {};
  try {
    cleanup = await dropFixture(s, "d3d9_basic.exe", {}, ["interactive.flag"]);
    await waitEmu(s.page, "(e.windows && Object.keys(e.windows).length > 0 && /device ok/.test(e.stdout)) || e.crash || e.exitCode !== null", 60000);
    await s.page.waitForTimeout(1500);
    const st = await emuState(s.page);
    assert.equal(st.crash, null, String(st.crash) + "\n" + st.log.join("\n"));
    assert.match(st.out, /adapter: Chrome\.EXE WebGPU Adapter\r?\ncaps: vs=fffe0300 ps=ffff0300 maxtex=16384\r?\ndevice ok bb=320x240/);
    const W = 320, H = 240;
    const px = await samplePixels(s.page, [[5 / W, 5 / H], [30 / W, 15 / H], [100 / W, 55 / H], [160 / W, 55 / H], [160 / W, 130 / H], [45 / W, 215 / H]]);
    assert.deepEqual(px[0], [10, 20, 30], "clear color");
    assert.deepEqual(px[1], [0, 255, 0], "solid green rectangle");
    assert.deepEqual(px[2].map((v, i) => Math.abs(v - [128, 255, 128][i]) <= 2), [true, true, true], "half-transparent white over green: " + px[2]);
    assert.ok(px[4][0] + px[4][1] + px[4][2] > 150, "gouraud triangle interior is coloured: " + px[4]);
    assert.ok(px[5][0] > px[5][1] && px[5][0] > px[5][2], "red corner of the triangle: " + px[5]);
    await s.page.keyboard.press("q");
    await waitEmu(s.page, "e.exitCode !== null || e.crash", 20000);
    const end = await emuState(s.page);
    assert.equal(end.crash, null, String(end.crash));
    assert.equal(end.code, 0, end.out + end.log.join("\n"));
  } finally {
    const st = await emuState(s.page).catch(() => null);
    if (st) console.log(st.log.slice(0, 30).join("\n"), s.logs.join("\n"));
    await s.close();
    cleanup();
  }
});

const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("Direct3D 9: buffers, textures (DXT1, render targets), lighting, programmable shaders, scissor, alpha test, depth, StretchRect", { skip }, async () => {
  buildWeb();
  const s = await openShell();
  let cleanup = () => {};
  try {
    cleanup = await dropFixture(s, "d3d9_scene.exe", { "basic.vs.cso": join(import.meta.dirname, "shaders/bin/basic.vs.cso"), "basic.ps.cso": join(import.meta.dirname, "shaders/bin/basic.ps.cso") }, ["interactive.flag"]);
    await waitEmu(s.page, "e.crash || e.exitCode !== null || /rt readback/.test(e.stdout)", 60000);
    await s.page.waitForTimeout(2500);
    const st = await emuState(s.page);
    assert.equal(st.crash, null, String(st.crash) + "\n" + st.log.join("\n"));
    const out = st.out.replace(/\r\n/g, "\n");
    assert.match(out, /create checker: 00000000\ncreate dxt1: 00000000\ncreate rt: 00000000\nvs create: 00000000\nps create: 00000000\nstretchrect: 00000000\nrt readback: top=ffff00ff stripe=ff00ff00\n/, out + st.log.join("\n"));
    const pts: [number, number, string, number[]][] = [
      [80, 80, "lit quad", [255, 128, 64]],
      [180, 20, "checker texel (0,0) red", [255, 0, 0]], [188, 20, "checker texel (1,0) white", [255, 255, 255]],
      [360, 24, "shader checker texel white * tint", [128, 255, 64]], [344, 24, "shader checker texel red * tint", [128, 0, 0]],
      [560, 30, "render target magenta", [255, 0, 255]], [560, 80, "render target stripe green", [0, 255, 0]],
      [48, 240, "DXT1 red half", [255, 0, 0]], [112, 240, "DXT1 blue half", [0, 0, 255]],
      [310, 160 + 20, "unreachable sentinel", [-1, -1, -1]],
      [560, 240, "scissored cyan", [0, 255, 255]], [500, 180, "outside scissor keeps clear", [10, 20, 30]],
      [40, 400, "alpha test discards transparent texels", [10, 20, 30]], [120, 400, "alpha test keeps opaque", [255, 255, 0]],
      [240, 400, "depth: near green", [0, 255, 0]], [312, 400, "depth: far red visible beside", [255, 0, 0]],
      [350, 350, "StretchRect magenta", [255, 0, 255]], [400, 400, "StretchRect stripe", [0, 255, 0]],
      [400, 240, "triangle fan centre", [255, 255, 0]],
    ];
    const px = await samplePixels(s.page, pts.map(([x, y]) => [x / 640, y / 480]));
    const bad: string[] = [];
    pts.forEach(([x, y, label, want], i) => { if (want[0] >= 0 && !near(px[i], want)) bad.push(`${label} at (${x},${y}): got ${px[i]} want ${want}`); });
    // vertex-colour quad: corners dominated by their vertex colour
    const corners = await samplePixels(s.page, [[180 / 640, 300 / 480], [180 / 640, 180 / 480], [300 / 640, 180 / 480], [300 / 640, 300 / 480]]);
    if (!(corners[0][0] > 150 && corners[0][1] < 100)) bad.push("quad bottom-left should be red: " + corners[0]);
    if (!(corners[1][1] > 150 && corners[1][0] < 100)) bad.push("quad top-left should be green: " + corners[1]);
    if (!(corners[2][2] > 150 && corners[2][0] < 100)) bad.push("quad top-right should be blue: " + corners[2]);
    if (!(corners[3][0] > 150 && corners[3][1] > 150 && corners[3][2] > 150)) bad.push("quad bottom-right should be white: " + corners[3]);
    assert.equal(bad.length, 0, bad.join("\n") + "\n" + st.log.join("\n"));
    await s.page.keyboard.press("q");
    await waitEmu(s.page, "e.exitCode !== null || e.crash", 20000);
  } finally {
    const st = await emuState(s.page).catch(() => null);
    if (st) console.log(st.log.slice(0, 40).join("\n"));
    await s.close();
    cleanup();
  }
});
