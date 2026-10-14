import { writeSync } from "node:fs";
import { assemble, randCase, Rng, runNative, compare, disasm, dumpCase } from "./harness.ts";
import type { Case, JitRunner } from "./harness.ts";
import * as L from "../src/jit/layout.ts";

export interface Template {
  asm: string;
  flags?: number;
  fixed?: Record<number, bigint>;
  n?: number;
  xmm?: "exact" | "f32" | "f64" | "approx32";
  /** skip comparing memory (e.g. FXSAVE images contain implementation specific fields) */
  noMem?: boolean;
  /** compare memory bytes only at these scratch ranges */
}

export function runGroup(list: Template[], jr: JitRunner, seed: bigint) {
  const filter = process.env.TFILTER;
  if (filter) list = list.filter((t) => t.asm.includes(filter));
  const codes = assemble(list.map((t) => t.asm));
  const r = new Rng(seed);
  const cases: { t: Template; c: Case }[] = [];
  list.forEach((t, i) => {
    const n = t.n ?? 24;
    for (let k = 0; k < n; k++) cases.push({ t, c: randCase(r, codes[i], { fixed: t.fixed }) });
  });
  const nat = runNative(cases.map((x) => x.c));
  const failures: string[] = [];
  let compared = 0;
  const seen = new Set<string>();
  const label = (t: Template) => t.asm.replace(/\n/g, "; ");
  for (let i = 0; i < cases.length; i++) {
    const { t, c } = cases[i];
    const n = nat[i];
    if (n.sig !== 0 && n.sig !== 8) continue;
    let j;
    try {
      if (process.env.TVERBOSE) writeSync(2, "RUN " + label(t) + " :: " + dumpCase(c) + "\n");
      j = jr.run(c);
    } catch (e: any) {
      const key = t.asm + "!exc";
      if (!seen.has(key)) { seen.add(key); failures.push(`[${label(t)}] JIT threw: ${e.message}\n   ${disasm(c.code)}`); }
      continue;
    }
    if (n.sig === 8) {
      if (j.status !== L.ST_FAULT || j.fault !== L.FK_DIV) {
        const key = t.asm + "!div";
        if (!seen.has(key)) { seen.add(key); failures.push(`[${label(t)}] expected #DE, JIT status=${j.status} fault=${j.fault}\n   ${dumpCase(c)}`); }
      }
      continue;
    }
    if (j.status !== L.ST_HOSTCALL_RETURN) {
      const key = t.asm + "!status";
      if (!seen.has(key)) { seen.add(key); failures.push(`[${label(t)}] JIT status=${j.status} fault=${j.fault} rip=${jr.m.rip.toString(16)}\n   ${disasm(c.code)}`); }
      continue;
    }
    compared++;
    const d = compare(c, n, j, { flagMask: t.flags, xmm: t.xmm, skipMem: t.noMem });
    if (d.length && !seen.has(t.asm)) {
      seen.add(t.asm);
      failures.push(`[${label(t)}]\n   ${disasm(c.code)}\n   in: ${dumpCase(c)}\n   xmm in: ${c.xmm.slice(0, 4).map((x) => Buffer.from(x).toString("hex")).join(" ")}\n   ${d.slice(0, 6).join("\n   ")}`);
    }
  }
  return { failures, compared, templates: list.length };
}
