import { test } from "node:test";
import { writeSync } from "node:fs";
import assert from "node:assert/strict";
import { assemble, randCase, Rng, runNative, JitRunner, compare, disasm, dumpCase, hex } from "./harness.ts";
import type { Case } from "./harness.ts";
import { allIntTemplates } from "./int-templates.ts";
import type { Template } from "./int-templates.ts";
import * as L from "../src/jit/layout.ts";

const filter = process.env.TFILTER;
const only = process.env.TGROUP;

function runGroup(name: string, list: Template[], jr: JitRunner, seed: bigint) {
  if (filter) list = list.filter((t) => t.asm.includes(filter));
  const codes = assemble(list.map((t) => t.asm));
  const r = new Rng(seed);
  const cases: { t: Template; code: Uint8Array; c: Case }[] = [];
  list.forEach((t, i) => {
    const n = t.n ?? 24;
    for (let k = 0; k < n; k++) cases.push({ t, code: codes[i], c: randCase(r, codes[i], { fixed: t.fixed }) });
  });
  const nat = runNative(cases.map((x) => x.c));
  const failures: string[] = [];
  let compared = 0;
  const seen = new Set<string>();
  for (let i = 0; i < cases.length; i++) {
    const { t, c } = cases[i];
    const n = nat[i];
    if (n.sig !== 0 && n.sig !== 8) continue; // faulted natively for reasons other than #DE (e.g. wild stack): skip
    let j;
    try {
      if (process.env.TVERBOSE) writeSync(2, "RUN " + t.asm.replace(/\n/g, "; ") + " :: " + dumpCase(c) + "\n");
      j = jr.run(c);
    } catch (e: any) {
      const key = t.asm + "!exc";
      if (!seen.has(key)) {
        seen.add(key);
        failures.push(`[${t.asm.replace(/\n/g, "; ")}] JIT threw: ${e.message}\n   ${disasm(c.code)}`);
      }
      continue;
    }
    if (n.sig !== 0) {
      // fault natively: the JIT must fault too (we only check divide errors here)
      if (n.sig === 8 /*SIGFPE*/) {
        if (j.status !== L.ST_FAULT || j.fault !== L.FK_DIV) {
          const key = t.asm + "!div";
          if (!seen.has(key)) { seen.add(key); failures.push(`[${t.asm.replace(/\n/g, "; ")}] expected #DE, JIT status=${j.status} fault=${j.fault}\n   ${dumpCase(c)}`); }
        }
      }
      continue;
    }
    if (j.status !== L.ST_HOSTCALL_RETURN) {
      const key = t.asm + "!status";
      if (!seen.has(key)) { seen.add(key); failures.push(`[${t.asm.replace(/\n/g, "; ")}] JIT status=${j.status} fault=${j.fault} rip=${jr.m.rip.toString(16)}\n   ${disasm(c.code)}`); }
      continue;
    }
    compared++;
    const d = compare(c, n, j, { flagMask: t.flags });
    if (d.length) {
      const key = t.asm;
      if (!seen.has(key)) {
        seen.add(key);
        failures.push(`[${t.asm.replace(/\n/g, "; ")}]\n   ${disasm(c.code)}\n   in: ${dumpCase(c)}\n   ${d.slice(0, 6).join("\n   ")}`);
      }
    }
  }
  return { failures, compared, templates: list.length };
}

const jr = new JitRunner();
for (const g of allIntTemplates()) {
  if (only && g.name !== only) continue;
  test(`jit-int: ${g.name}`, () => {
    const { failures, compared, templates } = runGroup(g.name, g.list, jr, 0x1234n);
    console.log(`  ${g.name}: ${templates} templates, ${compared} cases compared, ${failures.length} failing templates`);
    assert.equal(failures.length, 0, "\n" + failures.slice(0, 12).join("\n"));
  });
}
