// usage: node scripts/pe-imports.ts <pe files...>   -> prints per-DLL import inventory
import { readFileSync } from "node:fs";
import { parseImports, parseDelayImports, parsePe } from "../src/pe/pe.ts";

const all = new Map<string, Set<string>>();
for (const f of process.argv.slice(2)) {
  const buf = new Uint8Array(readFileSync(f));
  const img = parsePe(buf);
  for (const d of [...parseImports(buf, img), ...parseDelayImports(buf, img)]) {
    const k = d.dll.toLowerCase();
    if (!all.has(k)) all.set(k, new Set());
    for (const e of d.entries) all.get(k)!.add(e.name ?? "#" + e.ordinal);
  }
}
for (const [dll, names] of [...all].sort()) {
  console.log(`${dll} (${names.size}): ${[...names].sort().join(" ")}`);
}
