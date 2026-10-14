import { test } from "node:test";
import assert from "node:assert/strict";
import { JitRunner } from "./harness.ts";
import { x87Groups } from "./x87-templates.ts";
import { runGroup } from "./diff.ts";

const only = process.env.TGROUP;
const jr = new JitRunner();
for (const g of x87Groups()) {
  if (only && g.name !== only) continue;
  test(`jit-x87: ${g.name}`, () => {
    const { failures, compared, templates } = runGroup(g.list, jr, 0x87n);
    console.log(`  ${g.name}: ${templates} templates, ${compared} cases compared, ${failures.length} failing templates`);
    assert.equal(failures.length, 0, "\n" + failures.slice(0, 14).join("\n"));
  });
}
