import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createProcess } from "../src/win32/index.ts";
import { NodeDirSource } from "../src/win32/vfs-node.ts";
import type { ProcessOptions } from "../src/win32/index.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures/bin");
export const SYSDLL = join(import.meta.dirname, "../build/sysdll");

export function haveSysdll(): boolean {
  return existsSync(join(SYSDLL, "ucrtbase.dll"));
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  log: string[];
  p: ReturnType<typeof createProcess>;
}

/** Run a fixture exe to completion. `files` adds extra files to C:\app. */
export function runFixture(name: string, opts: { args?: string; files?: Record<string, Uint8Array>; sysdll?: boolean; setup?: (p: ReturnType<typeof createProcess>) => void } = {}): RunResult {
  const out: number[] = [], err: number[] = [];
  const log: string[] = [];
  const exePath = "C:\\app\\" + name;
  const p = createProcess({
    exePath,
    cmdline: `"${exePath}"${opts.args ? " " + opts.args : ""}`,
    stdout: (b) => out.push(...b),
    stderr: (b) => err.push(...b),
    log: (s) => log.push(s),
  });
  p.vfs.mkdirs("C:\\app");
  const data = new Uint8Array(readFileSync(join(FIXTURES, name)));
  p.vfs.writeFile(exePath, data);
  for (const [f, d] of Object.entries(opts.files ?? {})) p.vfs.writeFile("C:\\app\\" + f, d);
  if (opts.sysdll !== false && haveSysdll()) p.vfs.mount("C:\\Windows\\System32", new NodeDirSource(SYSDLL));
  opts.setup?.(p);
  p.loadExe(exePath, data);
  const code = p.runSync();
  return { code, stdout: Buffer.from(out).toString("latin1"), stderr: Buffer.from(err).toString("latin1"), log, p };
}
