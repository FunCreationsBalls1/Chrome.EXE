import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture, haveSysdll } from "./win32-util.ts";

test("freestanding PE: kernel32 only, fib/heap/SSE", () => {
  const r = runFixture("hello_nocrt.exe");
  const letters = Array.from({ length: 99 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  assert.equal(r.stdout, `hello from a PE running on a JIT\nfib(20)=6765\n${letters}\n625\nqpc ok\n`);
  assert.equal(r.code, 42);
});

test("msvcrt-based PE: printf/qsort/malloc via Wine's CRT running as guest code", { skip: !haveSysdll() }, () => {
  const r = runFixture("hello_crt.exe");
  assert.equal(r.log.filter((l) => !l.startsWith("[dbg]")).join("\n"), "");
  assert.equal(r.stdout.replace(/\r\n/g, "\n"), "argc=1 argv0=yes\n1 3 5 7 9 \n1.414   3.1 1.234568e+04 0.0001\nheap string (11) 0000beef -123456789012\n");
  assert.equal(r.stderr.replace(/\r\n/g, "\n"), "to stderr\n");
  assert.equal(r.code, 7);
});
