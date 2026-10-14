import { test } from "node:test";
import assert from "node:assert/strict";
import { JitRunner } from "./harness.ts";
import { sseGroups } from "./sse-templates.ts";
import { runGroup } from "./diff.ts";

const only = process.env.TGROUP;
const jr = new JitRunner();
for (const g of sseGroups()) {
  if (only && g.name !== only) continue;
  test(`jit-sse: ${g.name}`, () => {
    const { failures, compared, templates } = runGroup(g.list, jr, 0x5eedn);
    console.log(`  ${g.name}: ${templates} templates, ${compared} cases compared, ${failures.length} failing templates`);
    assert.equal(failures.length, 0, "\n" + failures.slice(0, 14).join("\n"));
  });
}
