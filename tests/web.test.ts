import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildWeb, haveChromium, openShell, waitEmu } from "./browser.ts";
import { haveSysdll } from "./win32-util.ts";

const FIX = join(import.meta.dirname, "fixtures/bin");

test("browser shell: drop a folder with win_basic.exe, it runs in a worker with a window, GDI painting, timers and input", { skip: !haveChromium() || !haveSysdll() }, async () => {
  buildWeb();
  const dir = mkdtempSync(join(tmpdir(), "chromeexe-"));
  copyFileSync(join(FIX, "win_basic.exe"), join(dir, "win_basic.exe"));
  writeFileSync(join(dir, "interactive.flag"), "1");
  const s = await openShell();
  try {
    await s.page.setInputFiles("#folder", dir);
    await waitEmu(s.page, "e.windows && Object.keys(e.windows).length > 0", 30000);
    const canvas = s.page.locator("#screen canvas[data-hwnd]").first();
    await canvas.waitFor({ state: "visible" });
    await s.page.waitForTimeout(300); // let the timer tick and WM_PAINT run
    const box = (await canvas.boundingBox())!;
    await s.page.keyboard.press("a");
    await s.page.mouse.click(box.x + 33 * (box.width / 320), box.y + 44 * (box.height / 240));
    await waitEmu(s.page, "/click 33,4[34]/.test(e.stdout)", 15000);
    // sample pixels from a screenshot of the element: red rectangle painted by WM_PAINT at (10,10)-(60,40)
    const png = await canvas.screenshot();
    const px = await s.page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const at = (x: number, y: number) => Array.from(g.getImageData(Math.round(x * img.width / 320), Math.round(y * img.height / 240), 1, 1).data.slice(0, 3));
      return { red: at(30, 25), line: at(50, 100), bg: at(200, 200), yellow: at(101, 51) };
    }, png.toString("base64"));
    assert.deepEqual(px.red, [255, 0, 0]);
    assert.deepEqual(px.line, [0, 255, 0]);
    assert.deepEqual(px.bg, [0, 0, 0]);
    assert.deepEqual(px.yellow, [255, 255, 0]);
    await s.page.keyboard.press("q");
    await waitEmu(s.page, "e.exitCode !== null || e.crash", 30000);
    const r = await s.page.evaluate(() => ({ out: (window as any).__emu.stdout, code: (window as any).__emu.exitCode, crash: (window as any).__emu.crash, log: (window as any).__emu.log }));
    assert.equal(r.crash, null, String(r.crash) + r.log.join("\n"));
    assert.equal(r.code, 5, r.out + r.log.join("\n"));
    const out = r.out.replace(/\r\n/g, "\n");
    assert.match(out, /^interactive=1\nadjusted 336,279\nWM_CREATE title=Hello cx=336 cy=279\nclient 320x240\n/);
    assert.match(out, /keydown vk=41\nchar a\n/);
    assert.match(out, /char q\nuser msg; closing\nWM_DESTROY\n/);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
