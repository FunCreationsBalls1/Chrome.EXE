import { test } from "node:test";
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
