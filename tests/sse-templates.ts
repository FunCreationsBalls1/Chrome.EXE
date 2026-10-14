import type { Template } from "./diff.ts";

const CF = 1, PF = 4, ZF = 0x40, DF = 0x400;
const ALLF = 0x8d5 | DF;

type Mode = Template["xmm"];
const mk = (asm: string, xmm: Mode = "exact", extra: Partial<Template> = {}): Template => ({ asm, flags: ALLF, xmm, ...extra });

function binForms(op: string, mode: Mode, memAligned = true): Template[] {
  return [
    mk(`${op} xmm1, xmm2`, mode),
    mk(`${op} xmm0, xmm0`, mode),
    mk(`${op} xmm8, xmm9`, mode),
    mk(`${op} xmm3, xmm15`, mode),
    mk(`${op} xmm4, [rbx+${memAligned ? 16 : 20}]`, mode),
  ];
}

export function sseGroups(): { name: string; list: Template[] }[] {
  const groups: { name: string; list: Template[] }[] = [];

  // packed float arithmetic
  {
    const l: Template[] = [];
    for (const op of ["addps", "subps", "mulps", "divps", "minps", "maxps", "sqrtps"]) l.push(...binForms(op, "f32"));
    for (const op of ["addpd", "subpd", "mulpd", "divpd", "minpd", "maxpd", "sqrtpd"]) l.push(...binForms(op, "f64"));
    for (const op of ["addss", "subss", "mulss", "divss", "minss", "maxss", "sqrtss"]) {
      l.push(...binForms(op, "f32", false));
    }
    for (const op of ["addsd", "subsd", "mulsd", "divsd", "minsd", "maxsd", "sqrtsd"]) l.push(...binForms(op, "f64", false));
    for (const op of ["rcpps", "rsqrtps", "rcpss", "rsqrtss"]) l.push(...binForms(op, "approx32", false).map((t) => ({ ...t, n: 12 })));
    for (const op of ["haddps", "hsubps", "addsubps"]) l.push(...binForms(op, "f32"));
    for (const op of ["haddpd", "hsubpd", "addsubpd"]) l.push(...binForms(op, "f64"));
    l.push(mk("cvtsi2ss xmm1, eax", "f32"), mk("cvtsi2ss xmm1, rax", "f32"), mk("cvtsi2sd xmm1, ecx", "f64"), mk("cvtsi2sd xmm9, r8", "f64"),
      mk("cvtsi2ss xmm1, dword [rbx+8]", "f32"), mk("cvtsi2sd xmm1, qword [rbx+8]", "f64"));
    groups.push({ name: "fp-arith", list: l });
  }
  // logic, integer arithmetic
  {
    const l: Template[] = [];
    for (const op of ["andps", "andnps", "orps", "xorps", "andpd", "andnpd", "orpd", "xorpd", "pand", "pandn", "por", "pxor",
      "paddb", "paddw", "paddd", "paddq", "psubb", "psubw", "psubd", "psubq", "paddsb", "paddsw", "paddusb", "paddusw",
      "psubsb", "psubsw", "psubusb", "psubusw", "pmullw", "pmulhw", "pmulhuw", "pmuludq", "pmaddwd", "pavgb", "pavgw",
      "pminub", "pmaxub", "pminsw", "pmaxsw", "psadbw", "pcmpeqb", "pcmpeqw", "pcmpeqd", "pcmpgtb", "pcmpgtw", "pcmpgtd",
      "packsswb", "packuswb", "packssdw", "punpcklbw", "punpcklwd", "punpckldq", "punpcklqdq", "punpckhbw", "punpckhwd",
      "punpckhdq", "punpckhqdq", "unpcklps", "unpckhps", "unpcklpd", "unpckhpd",
      // SSSE3 / SSE4.1
      "pshufb", "phaddw", "phaddd", "phaddsw", "phsubw", "phsubd", "phsubsw", "pmaddubsw", "psignb", "psignw", "psignd", "pmulhrsw",
      "pabsb", "pabsw", "pabsd", "pmulld", "pmuldq", "pminsb", "pmaxsb", "pminuw", "pmaxuw", "pminsd", "pmaxsd", "pminud", "pmaxud",
      "pcmpeqq", "packusdw", "pmovsxbw", "pmovsxwd", "pmovsxdq", "pmovzxbw", "pmovzxwd", "pmovzxdq"])
      l.push(...binForms(op, "exact"));
    for (const op of ["pmovsxbd", "pmovzxbd", "pmovsxbq", "pmovzxbq", "pmovsxwq", "pmovzxwq"]) l.push(...binForms(op, "exact", false));
    l.push(mk("movhlps xmm1, xmm2"), mk("movlhps xmm1, xmm2"), mk("movddup xmm1, xmm2"), mk("movsldup xmm1, xmm2"), mk("movshdup xmm1, xmm2"));
    groups.push({ name: "simd-int", list: l });
  }
  // shifts
  {
    const l: Template[] = [];
    for (const [op, bits] of [["psllw", 16], ["psrlw", 16], ["psraw", 16], ["pslld", 32], ["psrld", 32], ["psrad", 32], ["psllq", 64], ["psrlq", 64]] as [string, number][]) {
      for (const c of [0, 1, 3, bits - 1, bits, bits + 1, 200]) l.push(mk(`${op} xmm1, ${c}`));
      l.push(mk(`${op} xmm2, xmm3`, "exact", { n: 40 }), mk(`${op} xmm2, [rbx+16]`, "exact", { n: 40 }));
      l.push(mk(`mov eax, 7\nmovd xmm3, eax\n${op} xmm2, xmm3`));
    }
    for (const n of [0, 1, 4, 8, 15, 16, 20]) l.push(mk(`pslldq xmm1, ${n}`), mk(`psrldq xmm1, ${n}`));
    groups.push({ name: "simd-shift", list: l });
  }
  // shuffles
  {
    const l: Template[] = [];
    for (const imm of [0, 0x1b, 0xe4, 0x55, 0xaa, 0xff, 0x93, 0x4e]) {
      l.push(mk(`pshufd xmm1, xmm2, ${imm}`), mk(`pshufd xmm1, [rbx+16], ${imm}`), mk(`shufps xmm1, xmm2, ${imm}`), mk(`shufps xmm8, [rbx+32], ${imm}`),
        mk(`pshuflw xmm1, xmm2, ${imm}`), mk(`pshufhw xmm1, xmm2, ${imm}`));
    }
    for (const imm of [0, 1, 2, 3]) l.push(mk(`shufpd xmm1, xmm2, ${imm}`));
    for (const imm of [0, 1, 5, 15, 16, 20, 31, 32]) l.push(mk(`palignr xmm1, xmm2, ${imm}`), mk(`palignr xmm1, [rbx+16], ${imm}`));
    for (const imm of [0, 0x55, 0xa3, 0xff]) l.push(mk(`pblendw xmm1, xmm2, ${imm}`));
    for (const imm of [0, 5, 10, 15]) l.push(mk(`blendps xmm1, xmm2, ${imm}`));
    for (const imm of [0, 1, 2, 3]) l.push(mk(`blendpd xmm1, xmm2, ${imm}`));
    l.push(mk("pblendvb xmm1, xmm2"), mk("blendvps xmm1, xmm2"), mk("blendvpd xmm1, xmm2"));
    for (const imm of [0, 0x10, 0x4c, 0xb1, 0xff, 0x8f]) l.push(mk(`insertps xmm1, xmm2, ${imm}`, "f32"), mk(`insertps xmm1, [rbx+16], ${imm}`, "f32"));
    groups.push({ name: "simd-shuffle", list: l });
  }
  // compares and flags
  {
    const l: Template[] = [];
    for (let i = 0; i < 8; i++) {
      l.push(mk(`cmpps xmm1, xmm2, ${i}`, "f32"), mk(`cmppd xmm1, xmm2, ${i}`, "f64"), mk(`cmpss xmm1, xmm2, ${i}`, "f32"), mk(`cmpsd xmm1, xmm2, ${i}`, "f64"),
        mk(`cmpss xmm1, [rbx+20], ${i}`, "f32"), mk(`cmpsd xmm1, [rbx+24], ${i}`, "f64"));
    }
    for (const op of ["comiss", "ucomiss", "comisd", "ucomisd"]) {
      l.push(mk(`${op} xmm1, xmm2`, "exact", { flags: CF | PF | ZF | 0x8d5 | DF }));
      l.push(mk(`${op} xmm1, xmm2\nseta al\nsetb cl\nsete dl\nsetp sil`));
      l.push(mk(`${op} xmm1, xmm1\nsetp al\njp .x\nmov ecx, 5\n.x:`));
      l.push(mk(`${op} xmm3, [rbx+16]\njbe .x\nmov ecx, 5\n.x:`));
    }
    l.push(mk("ptest xmm1, xmm2"), mk("ptest xmm1, xmm1"), mk("xorps xmm2, xmm2\nptest xmm2, xmm1\nsetz al"));
    l.push(mk("movmskps eax, xmm1"), mk("movmskpd eax, xmm1"), mk("pmovmskb eax, xmm1"), mk("pmovmskb r9d, xmm10"));
    groups.push({ name: "simd-compare", list: l });
  }
  // conversions
  {
    const l: Template[] = [];
    for (const op of ["cvtdq2ps", "cvtps2dq", "cvttps2dq"]) l.push(...binForms(op, "f32"));
    l.push(...binForms("cvtps2pd", "f64", false), ...binForms("cvtpd2ps", "f32"), ...binForms("cvtdq2pd", "f64", false), ...binForms("cvtpd2dq", "exact"), ...binForms("cvttpd2dq", "exact"));
    l.push(...binForms("cvtss2sd", "f64", false), ...binForms("cvtsd2ss", "f32", false));
    for (const op of ["cvttss2si", "cvtss2si"]) {
      l.push(mk(`${op} eax, xmm1`), mk(`${op} rax, xmm1`), mk(`${op} r9d, xmm10`), mk(`${op} edx, [rbx+20]`), mk(`${op} rdx, [rbx+24]`));
    }
    for (const op of ["cvttsd2si", "cvtsd2si"]) {
      l.push(mk(`${op} eax, xmm1`), mk(`${op} rax, xmm1`), mk(`${op} r9d, xmm10`), mk(`${op} edx, [rbx+24]`), mk(`${op} rdx, [rbx+24]`));
    }
    for (const mode of [0, 1, 2, 3, 8, 9, 10, 11]) {
      l.push(mk(`roundps xmm1, xmm2, ${mode}`, "f32"), mk(`roundpd xmm1, xmm2, ${mode}`, "f64"), mk(`roundss xmm1, xmm2, ${mode}`, "f32"), mk(`roundsd xmm1, xmm2, ${mode}`, "f64"));
    }
    for (const imm of [0xff, 0x71, 0xf3, 0x31]) l.push(mk(`dpps xmm1, xmm2, ${imm}`, "f32"));
    groups.push({ name: "simd-convert", list: l });
  }
  // data movement
  {
    const l: Template[] = [];
    for (const op of ["movaps", "movups", "movapd", "movupd", "movdqa", "movdqu"]) {
      l.push(mk(`${op} xmm1, xmm2`), mk(`${op} xmm9, [rbx+${op.endsWith("u") || op.endsWith("upd") || op.endsWith("ups") || op === "movdqu" ? 20 : 32}]`),
        mk(`${op} [rbx+${op.includes("u") ? 36 : 48}], xmm3`));
    }
    l.push(mk("movss xmm1, xmm2"), mk("movss xmm1, [rbx+20]"), mk("movss [rbx+20], xmm1"), mk("movsd xmm1, xmm2"), mk("movsd xmm1, [rbx+24]"), mk("movsd [rbx+24], xmm1"));
    l.push(mk("movd xmm1, eax"), mk("movd eax, xmm1"), mk("movq xmm1, rax"), mk("movq rax, xmm1"), mk("movd xmm9, dword [rbx+20]"), mk("movd dword [rbx+20], xmm9"),
      mk("movq xmm1, xmm2"), mk("movq xmm1, [rbx+24]"), mk("movq [rbx+24], xmm1"), mk("movq r10, xmm12"), mk("movd r9d, xmm14"));
    l.push(mk("movlps xmm1, [rbx+24]"), mk("movhps xmm1, [rbx+24]"), mk("movlps [rbx+24], xmm1"), mk("movhps [rbx+24], xmm1"),
      mk("movlpd xmm1, [rbx+24]"), mk("movhpd xmm1, [rbx+24]"), mk("movlpd [rbx+24], xmm1"), mk("movhpd [rbx+24], xmm1"));
    l.push(mk("movntdq [rbx+48], xmm1"), mk("movntps [rbx+48], xmm1"), mk("lddqu xmm1, [rbx+21]"), mk("movntdqa xmm1, [rbx+48]"));
    for (let i = 0; i < 8; i++) {
      l.push(mk(`pextrw eax, xmm1, ${i}`), mk(`pinsrw xmm1, eax, ${i}`), mk(`pinsrw xmm1, word [rbx+22], ${i}`));
      l.push(mk(`pextrb eax, xmm1, ${i}`), mk(`pinsrb xmm1, ecx, ${i}`), mk(`pextrb [rbx+24], xmm1, ${i}`));
    }
    for (let i = 0; i < 4; i++) l.push(mk(`pextrd eax, xmm1, ${i}`), mk(`pinsrd xmm1, ecx, ${i}`), mk(`extractps eax, xmm1, ${i}`), mk(`pextrd [rbx+24], xmm1, ${i}`));
    for (let i = 0; i < 2; i++) l.push(mk(`pextrq rax, xmm1, ${i}`), mk(`pinsrq xmm1, rcx, ${i}`));
    l.push(mk("ldmxcsr [rbx+16]"), mk("stmxcsr [rbx+16]\nmov dword [rbx+16], 0x1f80"));
    groups.push({ name: "simd-move", list: l });
  }
  return groups;
}
