import type { Gen } from "./gen.ts";
import type { Insn } from "../x86/decode.ts";

export function translateSSE(_g: Gen, _ins: Insn): boolean {
  return false;
}
