// Builds PE test programs with the mingw-w64 cross toolchain into tests/fixtures/bin (committed, so tests need no toolchain).
import { execFileSync } from "node:child_process";
import { readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "tests/fixtures/src");
const out = join(root, "tests/fixtures/bin");
mkdirSync(out, { recursive: true });

const only = process.argv[2];
const specs = {
  hello_nocrt: { flags: ["-O2", "-nostdlib", "-ffreestanding", "-mconsole", "-Wl,-e,mainCRTStartup"], libs: ["-lkernel32"] },
  hello_crt: { flags: ["-O2"] },
};
for (const f of readdirSync(src)) {
  const m = /^(.*)\.(c|cpp)$/.exec(f);
  if (!m) continue;
  const name = m[1];
  if (only && only !== name) continue;
  const spec = specs[name] ?? { flags: ["-O2"] };
  const cc = m[2] === "cpp" ? "x86_64-w64-mingw32-g++" : "x86_64-w64-mingw32-gcc";
  const isDll = name.endsWith("_dll");
  const args = [...(isDll ? ["-shared"] : []), ...spec.flags, join(src, f), "-o", join(out, name + (isDll ? ".dll" : ".exe")), ...(spec.libs ?? [])];
  console.log(cc, args.join(" "));
  execFileSync(cc, args, { stdio: "inherit" });
}
