import type { Gen } from "./gen.ts";
import type { Insn } from "../x86/decode.ts";

export function translateX87(_g: Gen, _ins: Insn): boolean {
  return false;
}
