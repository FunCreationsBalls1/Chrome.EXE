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
  cpp_exceptions: { flags: ["-O2", "-static"] },
  seh_try: { clang: true },
  d3d9_scene: { flags: ["-O2", "-mconsole", "-static-libgcc", "-static-libstdc++", "-std=gnu++17"], libs: ["-luser32", "-ld3d9", "-lkernel32"] },
  d3d9_basic: { flags: ["-O2", "-mconsole", "-static-libgcc", "-static-libstdc++"], libs: ["-luser32", "-ld3d9", "-lkernel32"] },
  win_basic: { flags: ["-O2", "-mconsole"], libs: ["-luser32", "-lgdi32", "-lkernel32"] },
};
for (const f of readdirSync(src)) {
  const m = /^(.*)\.(c|cpp)$/.exec(f);
  if (!m) continue;
  const name = m[1];
  if (only && only !== name) continue;
  const spec = specs[name] ?? { flags: ["-O2"] };
  if (spec.clang) {
    // clang for __try/__except; objects are linked with the mingw CRT
    const obj = join(out, name + ".o");
    const inc = "/usr/x86_64-w64-mingw32/include";
    const cargs = ["--target=x86_64-w64-mingw32", "-O1", "-fms-extensions", "-fasync-exceptions", "-isystem", inc, "-c", join(src, f), "-o", obj];
    console.log("clang", cargs.join(" "));
    execFileSync("clang", cargs, { stdio: "inherit" });
    execFileSync("x86_64-w64-mingw32-gcc", [obj, "-o", join(out, name + ".exe")], { stdio: "inherit" });
    continue;
  }
  const cc = m[2] === "cpp" ? "x86_64-w64-mingw32-g++" : "x86_64-w64-mingw32-gcc";
  const isDll = name.endsWith("_dll");
  const args = [...(isDll ? ["-shared"] : []), ...spec.flags, join(src, f), "-o", join(out, name + (isDll ? ".dll" : ".exe")), ...(spec.libs ?? [])];
  console.log(cc, args.join(" "));
  execFileSync(cc, args, { stdio: "inherit" });
}
