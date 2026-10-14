// Headless Chromium (software WebGPU through SwiftShader) harness for the browser shell.
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
// @ts-ignore (plain JS module)
import { serve } from "../scripts/serve.mjs";

const ROOT = join(import.meta.dirname, "..");

export function haveChromium(): boolean {
  return existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") || !!process.env.CHROME_PATH;
}

export interface Session {
  browser: Browser;
  page: Page;
  url: string;
  close(): Promise<void>;
  logs: string[];
}

export function buildWeb() {
  execFileSync("node", [join(ROOT, "scripts/build-web.mjs")], { stdio: "ignore" });
}

export async function openShell(opts: { width?: number; height?: number; present?: "gpu" | "readback"; query?: string } = {}): Promise<Session> {
  const { server, port } = await serve(0);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--enable-webgpu-developer-features", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 720 } });
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  const url = `http://localhost:${port}/?present=${opts.present ?? "readback"}${opts.query ? "&" + opts.query : ""}`;
  await page.goto(url);
  return { browser, page, url, logs, close: async () => { await browser.close(); server.close(); } };
}

export async function waitEmu(page: Page, pred: string, timeout = 60000) {
  await page.waitForFunction(`(() => { const e = window.__emu; return ${pred}; })()`, undefined, { timeout });
}

/** Validate WGSL modules with the browser's compiler. Returns error messages per module (empty array = valid). */
export async function validateWgsl(page: Page, modules: Record<string, string>): Promise<Record<string, string[]>> {
  return page.evaluate(async (mods) => {
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter");
    const device = await adapter.requestDevice();
    const res: Record<string, string[]> = {};
    for (const [name, code] of Object.entries(mods)) {
      const m = device.createShaderModule({ code });
      const info = await m.getCompilationInfo();
      const lines = code.split("\n");
      res[name] = info.messages.filter((x: any) => x.type === "error").map((x: any) => `${x.lineNum}:${x.linePos}: ${x.message}\n    ${lines[x.lineNum - 1] ?? ""}`);
    }
    return res;
  }, modules);
}

import { copyFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

/** Drop a folder containing a fixture exe (and extra files) into the page. Returns a cleanup function. */
export async function dropFixture(s: Session, exe: string, extra: Record<string, string | Uint8Array> = {}, flags: string[] = []): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "chromeexe-"));
  copyFileSync(join(ROOT, "tests/fixtures/bin", exe), join(dir, exe));
  for (const f of flags) writeFileSync(join(dir, f), "1");
  for (const [name, data] of Object.entries(extra)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof data === "string") copyFileSync(data, p); else writeFileSync(p, data);
  }
  await s.page.setInputFiles("#folder", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

export async function emuState(page: Page) {
  return page.evaluate(() => { const e = (window as any).__emu; return { state: e.state, out: e.stdout as string, err: e.stderr as string, code: e.exitCode as number | null, crash: e.crash as string | null, log: e.log as string[], windows: e.windows }; });
}

/** Read pixels of the first window canvas from a screenshot, at fractional coordinates (0..1). */
export async function samplePixels(page: Page, points: [number, number][]): Promise<number[][]> {
  const canvas = page.locator("#screen canvas[data-hwnd]").first();
  const png = await canvas.screenshot();
  return page.evaluate(async ({ b64, pts }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return pts.map(([fx, fy]) => Array.from(g.getImageData(Math.min(img.width - 1, Math.floor(fx * img.width)), Math.min(img.height - 1, Math.floor(fy * img.height)), 1, 1).data.slice(0, 3)));
  }, { b64: png.toString("base64"), pts: points });
}
