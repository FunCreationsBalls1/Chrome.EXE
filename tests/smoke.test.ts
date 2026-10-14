import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, randCase, Rng, runNative, JitRunner, compare, disasm, dumpCase } from "./harness.ts";

test("smoke: add eax, ebx; ret", () => {
  const [code] = assemble(["add eax, ebx"]);
  const r = new Rng(1n);
  const cases = Array.from({ length: 20 }, () => randCase(r, code));
  const nat = runNative(cases);
  const jr = new JitRunner();
  for (let i = 0; i < cases.length; i++) {
    const j = jr.run(cases[i]);
    const d = compare(cases[i], nat[i], j);
    assert.deepEqual(d, [], `${disasm(code)} ${dumpCase(cases[i])}`);
  }
});
