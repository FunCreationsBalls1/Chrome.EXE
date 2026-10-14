import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleBuilder } from "../src/wasm/builder.ts";
import { O, VT } from "../src/wasm/opcodes.ts";

const { i32, i64, f32, f64, v128 } = VT;

// Candidate signatures: any valid opcode must be accepted by at least one of them.
const sigs: [number[], number[]][] = [];
const tys = [i32, i64, f32, f64, v128];
for (const a of tys) {
  sigs.push([[a], [i32]], [[a], [i64]], [[a], [f32]], [[a], [f64]], [[a], [v128]]);
  for (const b of tys) {
    for (const r of tys) sigs.push([[a, b], [r]]);
  }
}
for (const r of tys) sigs.push([[v128, v128, v128], [r]]);

function validatesWithSomeSig(emit: (f: any) => void): string | null {
  for (const [p, r] of sigs) {
    const m = new ModuleBuilder();
    const { f } = m.func(p, r);
    // drop params after use so that extra params never cause problems: push all params in order
    for (let i = 0; i < p.length; i++) f.get(i);
    emit(f);
    f.end();
    try {
      new WebAssembly.Module(m.encode() as BufferSource);
      return p.join() + ">" + r.join();
    } catch {
      /* try next */
    }
  }
  return null;
}

test("every plain opcode is a valid wasm instruction", () => {
  const skip = /^(block|loop|if|else|end|br|br_if|br_table|return|call|call_indirect|return_call|return_call_indirect|local_get|local_set|local_tee|global_get|global_set|memory_size|memory_grow|memory_copy|memory_fill|unreachable|nop|drop|select|i32_const|i64_const|f32_const|f64_const|v128_const|i8x16_shuffle|.*_lane.*|.*load.*|.*store.*)$/;
  const bad: string[] = [];
  for (const [name, code] of Object.entries(O)) {
    if (skip.test(name)) continue;
    const ok = validatesWithSomeSig((f) => f.op(code));
    if (!ok) bad.push(name);
  }
  assert.deepEqual(bad, []);
});

test("memory ops and lane ops validate", () => {
  const m2 = new ModuleBuilder();
  m2.importMemory("e", "mem", 1);
  const g = m2.func([i32], [v128]).f;
  g.get(0).mem(O.v128_load, 0, 4);
  g.get(0).mem(O.v128_load32_splat, 4, 2).op(O.i32x4_add);
  g.i32(7).lane(O.i32x4_replace_lane, 1);
  g.end();
  new WebAssembly.Module(m2.encode() as BufferSource);
});

test("semantic spot checks", async () => {
  const m = new ModuleBuilder();
  const a = m.func([i32, i32], [i32]);
  a.f.get(0).get(1).op(O.i32_sub).end();
  m.exportFunc("sub", a.index);
  const b = m.func([i64, i64], [i64]);
  b.f.get(0).get(1).op(O.i64_shr_u).end();
  m.exportFunc("shr", b.index);
  const c = m.func([], [i64]);
  c.f.i64(-0x123456789abcdefn).end();
  m.exportFunc("c", c.index);
  const d = m.func([], [i32]);
  d.f.i32(-5).op(O.i32_extend8_s).end();
  m.exportFunc("d", d.index);
  // v128: (1,2,3,4) - (1,1,1,1) -> extract lane 3
  const e = m.func([], [i32]);
  e.f.v128(new Uint8Array(new Int32Array([1, 2, 3, 4]).buffer)).v128(new Uint8Array(new Int32Array([1, 1, 1, 1]).buffer));
  e.f.op(O.i32x4_sub).lane(O.i32x4_extract_lane, 3).end();
  m.exportFunc("e", e.index);
  const { instance } = await WebAssembly.instantiate(m.encode() as BufferSource);
  const x = instance.exports as any;
  assert.equal(x.sub(10, 3), 7);
  assert.equal(x.shr(0x100n, 4n), 0x10n);
  assert.equal(x.c(), -0x123456789abcdefn);
  assert.equal(x.d(), -5);
  assert.equal(x.e(), 3);
});
