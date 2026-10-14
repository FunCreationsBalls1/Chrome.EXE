// Headless Chromium (software WebGPU through SwiftShader) harness for the browser shell.
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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

export async function openShell(opts: { width?: number; height?: number } = {}): Promise<Session> {
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
  const url = `http://localhost:${port}/`;
  await page.goto(url);
  return { browser, page, url, logs, close: async () => { await browser.close(); server.close(); } };
}

export async function waitEmu(page: Page, pred: string, timeout = 60000) {
  await page.waitForFunction(`(() => { const e = window.__emu; return ${pred}; })()`, undefined, { timeout });
}
