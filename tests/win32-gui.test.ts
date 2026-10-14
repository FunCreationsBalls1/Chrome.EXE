import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture, haveSysdll } from "./win32-util.ts";
import { NullHost } from "../src/win32/host.ts";
import type { HostEvent } from "../src/win32/host.ts";

/** A host that delivers scripted input after a given number of poll calls. */
class ScriptHost extends NullHost {
  polls = 0;
  script: [number, HostEvent][] = [];
  poll(): HostEvent[] {
    this.polls++;
    const out: HostEvent[] = [];
    while (this.script.length && this.script[0][0] <= this.polls) out.push(this.script.shift()![1]);
    return [...super.poll(), ...out];
  }
}

test("window class/creation/paint/timer/input/destroy through user32+gdi32", { skip: !haveSysdll() }, () => {
  const host = new ScriptHost();
  host.script = [
    [4, { t: "key", down: true, vk: 0x41, scan: 0x1e, text: "a" }],
    [4, { t: "key", down: false, vk: 0x41, scan: 0x1e }],
    [5, { t: "button", btn: 0, down: true, x: 33, y: 44 }],
  ];
  const r = runFixture("win_basic.exe", { host });
  const out = r.stdout.replace(/\r\n/g, "\n");
  assert.match(out, /^adjusted 336,279\nWM_CREATE title=Hello cx=336 cy=279\nclient 320x240\n/);
  assert.match(out, /keydown vk=41\nchar a\n/);
  assert.match(out, /click 33,44\n/);
  assert.match(out, /user msg; closing\nWM_DESTROY\n/);
  assert.match(out, /timers=6 paints>0=1 keys=1 chars=1 clicks=1 activated>0=1 sizes>0=1 size=320x240 quit=5\n/);
  assert.match(out, /sysmetrics 1920 1080\n/);
  assert.equal(r.code, 5);
  // the client area was presented with the GDI drawing
  const pr = host.presents[host.presents.length - 1];
  assert.ok(pr, "a frame was presented");
  const px = (x: number, y: number) => { const i = (y * pr.w + x) * 4; return [pr.bgra[i + 2], pr.bgra[i + 1], pr.bgra[i]]; };
  assert.deepEqual(px(20, 20), [255, 0, 0]);
  assert.deepEqual(px(50, 100), [0, 255, 0]);
  assert.deepEqual(px(5, 5), [0, 0, 255]);
  assert.deepEqual(px(101, 51), [255, 255, 0]);
  assert.deepEqual(px(125, 55), [255, 255, 0]);
  assert.deepEqual(px(200, 200), [0, 0, 0]);
});
