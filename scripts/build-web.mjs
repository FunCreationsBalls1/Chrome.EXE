// Bundles the browser shell (page + worker) into dist/. System DLLs from build/sysdll (see fetch-sysdlls) are copied
// alongside with a manifest so the worker can load them over HTTP.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const minify = process.argv.includes("--minify");
const common = { bundle: true, format: "esm", target: "es2022", sourcemap: true, minify, logLevel: "info", legalComments: "none" };
await build({ ...common, entryPoints: [join(root, "src/web/main.ts")], outfile: join(dist, "main.js") });
await build({ ...common, entryPoints: [join(root, "src/web/worker.ts")], outfile: join(dist, "worker.js") });
copyFileSync(join(root, "src/web/index.html"), join(dist, "index.html"));

const sysdll = join(root, "build/sysdll");
const manifest = {};
if (existsSync(sysdll)) {
  mkdirSync(join(dist, "sysdll"), { recursive: true });
  for (const f of readdirSync(sysdll)) {
    const p = join(sysdll, f);
    if (!statSync(p).isFile() || !/\.dll$/i.test(f) || /^(wined3d)\.dll$/i.test(f)) continue; // wined3d (23 MB) is only needed by the test-time HLSL compiler
    copyFileSync(p, join(dist, "sysdll", f));
    manifest[f.toLowerCase()] = statSync(p).size;
  }
  writeFileSync(join(dist, "sysdll/manifest.json"), JSON.stringify(manifest));
}
console.log(`dist ready (${Object.keys(manifest).length} system DLLs)`);
