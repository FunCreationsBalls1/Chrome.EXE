// Compare our decoder's instruction boundaries/validity against objdump on a real ELF binary.
// usage: node tests/tools/objdump-compare.ts <elf> [maxInsns]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { decode } from "../../src/x86/decode.ts";

export interface Row { addr: number; bytes: number[]; text: string }

export function objdumpRows(path: string): Row[] {
  const out = execFileSync("objdump", ["-d", "-w", "-M", "intel", path], { maxBuffer: 1 << 30 }).toString();
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*([0-9a-f]+):\t((?:[0-9a-f]{2} )+)\s*\t?(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ addr: parseInt(m[1], 16), bytes: m[2].trim().split(" ").map((h) => parseInt(h, 16)), text: m[3].trim() });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  const max = Number(process.argv[3] ?? 1e9);
  const rows = objdumpRows(path).slice(0, max);
  // Build a memory image: place each row's bytes at its address (rows may be sparse across sections).
  const lo = rows[0].addr;
  const hi = rows[rows.length - 1].addr + 16;
  const mem = new Uint8Array(hi - lo + 64);
  for (const r of rows) mem.set(r.bytes, r.addr - lo);
  let bad = 0, invalid = 0, total = 0;
  const invalidByMnemonic = new Map<string, number>();
  const lenMismatch = new Map<string, number>();
  for (const r of rows) {
    total++;
    if (r.text.startsWith("(bad)")) continue;
    // objdump merges prefix-only rows (e.g. "rep stos") as single row; fine.
    const ins = decode(mem, r.addr - lo);
    if (ins.invalid) {
      invalid++;
      const mn = r.text.split(/\s+/).slice(0, 2).join(" ");
      invalidByMnemonic.set(mn, (invalidByMnemonic.get(mn) ?? 0) + 1);
      continue;
    }
    if (ins.len !== r.bytes.length) {
      bad++;
      const k = r.text.split(/\s+/)[0] + " (ours " + ins.len + " vs " + r.bytes.length + ")";
      lenMismatch.set(k, (lenMismatch.get(k) ?? 0) + 1);
      if (bad <= 15) console.log("LEN MISMATCH", r.addr.toString(16), r.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "), r.text, "ours=", ins.len);
    }
  }
  console.log({ total, invalid, lenMismatch: bad });
  console.log("top invalid:", [...invalidByMnemonic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40));
  console.log("len mismatches:", [...lenMismatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
}
