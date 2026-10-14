// Compiles tests/shaders/*.hlsl to bytecode by running Wine's d3dcompiler_47 (with its built-in vkd3d-shader HLSL front-end)
// as guest code inside our own emulator. Input files declare their targets in a leading comment:
//   // @compile entry profile [outname]
// Outputs go to tests/shaders/bin/<outname>.cso (committed so tests need no compiler run).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture } from "../tests/win32-util.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "tests/shaders");
const outDir = join(dir, "bin");
mkdirSync(outDir, { recursive: true });
const only = process.argv[2];
const files: Record<string, Uint8Array> = {};
const jobs: string[] = [];
const outs: string[] = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".hlsl")) continue;
  const text = readFileSync(join(dir, f), "utf8");
  for (const m of text.matchAll(/\/\/ @compile\s+(\w+)\s+(\w+)(?:\s+([\w.]+))?/g)) {
    const name = m[3] ?? `${f.replace(/\.hlsl$/, "")}.${m[2]}`;
    if (only && !name.includes(only)) continue;
    files[f] = new TextEncoder().encode(text);
    jobs.push(`C:\\app\\${f} ${m[1]} ${m[2]} C:\\app\\${name}.cso`);
    outs.push(name);
  }
}
if (!jobs.length) { console.log("nothing to compile"); process.exit(0); }
files["jobs.txt"] = new TextEncoder().encode(jobs.join("\n"));
let proc: any;
const r = runFixture("fxc.exe", { args: "C:\\app\\jobs.txt", files, setup: (p) => { proc = p; } });
process.stdout.write(r.stdout.replace(/\r\n/g, "\n"));
for (const name of outs) {
  const d = proc.vfs.readAll(`C:\\app\\${name}.cso`);
  if (d) { writeFileSync(join(outDir, name + ".cso"), d); console.log("wrote", name, d.length); } else console.log("MISSING", name);
}
process.exit(r.code);
