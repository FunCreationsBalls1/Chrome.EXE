// Fetches Wine's PE-format runtime DLLs (C/C++ runtimes, D3DX, HLSL compiler) from the Ubuntu archive into build/sysdll.
// They are LGPL-licensed user-mode libraries that run as ordinary guest code on top of our kernel32/ntdll HLE.
// Not committed to the repository; the web build serves them from dist/sysdll.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "build/sysdll");
if (existsSync(join(dest, "ucrtbase.dll")) && !process.argv.includes("--force")) {
  console.log("build/sysdll already populated (use --force to refetch)");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "wine-"));
try {
  console.log("downloading libwine (about 100 MB)...");
  execFileSync("apt-get", ["download", "libwine"], { cwd: tmp, stdio: "inherit" });
  const deb = readdirSync(tmp).find((f) => f.startsWith("libwine") && f.endsWith(".deb"));
  execFileSync("dpkg", ["-x", join(tmp, deb), join(tmp, "x")], { stdio: "inherit" });
  const dir = join(tmp, "x/usr/lib/x86_64-linux-gnu/wine/x86_64-windows");
  const want = /^(ucrtbase|msvcrt|msvcr\d+|msvcp\d+|vcruntime\d+(_\d)?|concrt\d+|d3dx(9|10|11)_\d+|d3dcompiler_\d+|d3dxof|xinput.*|d3dx11.*)\.dll$/i;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (want.test(f)) { copyFileSync(join(dir, f), join(dest, f)); n++; }
  }
  console.log(`copied ${n} DLLs to build/sysdll`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
