import type { Template } from "./diff.ts";

const ALLF = 0x8d5 | 0x400;
const PRE = "fninit\nmov word [rbx+500], 0x27f\nfldcw [rbx+500]\n";
const mk = (asm: string, extra: Partial<Template> = {}): Template => ({ asm: PRE + asm, flags: ALLF, ...extra });
const DUMP = "\nfstp qword [rbx+600]\nfstp qword [rbx+608]\nfstp qword [rbx+616]";
const FLAGS_CMP = 0x45 | 0x400; // C/Z/P defined for fcomi; others cleared

export function x87Groups(): { name: string; list: Template[] }[] {
  const arith: Template[] = [];
  const setup = "fild dword [rbx+8]\nfild dword [rbx+12]\n";
  for (const op of ["fadd", "fsub", "fsubr", "fmul", "fdiv", "fdivr"]) {
    arith.push(mk(`${setup}${op} st0, st1${DUMP}`), mk(`${setup}${op} st1, st0${DUMP}`), mk(`${setup}${op}p st1, st0${DUMP}`));
    arith.push(mk(`fild dword [rbx+8]\nfild dword [rbx+12]\nfstp dword [rbx+100]\nfstp qword [rbx+108]\nfild dword [rbx+16]\n${op} dword [rbx+100]${DUMP}`));
    arith.push(mk(`fild dword [rbx+16]\nfild dword [rbx+12]\nfstp qword [rbx+108]\n${op} qword [rbx+108]${DUMP}`));
    arith.push(mk(`fild dword [rbx+16]\n${op.replace("f", "fi")} dword [rbx+20]${DUMP}`), mk(`fild dword [rbx+16]\n${op.replace("f", "fi")} word [rbx+22]${DUMP}`));
  }
  arith.push(mk(`${setup}fchs${DUMP}`), mk(`${setup}fabs${DUMP}`), mk(`${setup}fabs\nfsqrt${DUMP}`), mk(`${setup}fxch st1${DUMP}`),
    mk(`${setup}fld st1\nfstp st3${DUMP}`), mk(`${setup}fst st1${DUMP}`), mk(`${setup}fadd st0, st0\nfincstp\nfdecstp${DUMP}`));
  const conv: Template[] = [];
  for (const rc of [0, 1, 2, 3]) {
    const cw = 0x27f | (rc << 10);
    const set = `mov word [rbx+502], ${cw}\nfldcw [rbx+502]\n`;
    conv.push(mk(`${set}fild dword [rbx+8]\nfild dword [rbx+12]\nfdivp st1, st0\nfrndint${DUMP}`));
    conv.push(mk(`${set}fild dword [rbx+8]\nfild dword [rbx+12]\nfdivp st1, st0\nfistp dword [rbx+100]${DUMP}`));
    conv.push(mk(`${set}fild dword [rbx+8]\nfild dword [rbx+12]\nfdivp st1, st0\nfistp word [rbx+100]${DUMP}`));
    conv.push(mk(`${set}fild dword [rbx+8]\nfild dword [rbx+12]\nfdivp st1, st0\nfistp qword [rbx+104]${DUMP}`));
    conv.push(mk(`${set}fild dword [rbx+8]\nfist dword [rbx+100]\nfist word [rbx+110]${DUMP}`));
  }
  conv.push(mk("mov rax, [rbx+8]\nsar rax, 11\nmov [rbx+8], rax\nfild qword [rbx+8]\nfistp qword [rbx+100]"), mk("fild word [rbx+8]\nfistp word [rbx+100]"));
  conv.push(mk("fild dword [rbx+8]\nfstp tword [rbx+100]\nfld tword [rbx+100]\nfstp qword [rbx+120]"));
  conv.push(mk("fild dword [rbx+8]\nfstp dword [rbx+100]\nfld dword [rbx+100]\nfstp qword [rbx+120]"));
  conv.push(mk("fnstcw [rbx+100]\nfnstsw [rbx+104]\nfnstsw ax"));
  conv.push(mk("fld1\nfldl2t\nfldl2e\nfldpi\nfldlg2\nfldln2\nfldz\nfstp qword [rbx+100]\nfstp qword [rbx+108]\nfstp qword [rbx+116]\nfstp qword [rbx+124]\nfstp qword [rbx+132]\nfstp qword [rbx+140]\nfstp qword [rbx+148]"));
  const cmp: Template[] = [];
  for (const op of ["fcom", "fcomp", "fucom", "fucomp"]) {
    cmp.push(mk(`${setup}${op} st1\nfnstsw ax\nsahf\nseta cl\nsetb dl\nsete sil${DUMP}`, { flags: 0x8d5 | 0x400 }));
    cmp.push(mk(`${setup}${op}\nfnstsw ax${DUMP}`));
  }
  cmp.push(mk(`${setup}fcompp\nfnstsw ax`), mk(`${setup}fucompp\nfnstsw ax`), mk(`${setup}ftst\nfnstsw ax`), mk(`${setup}fxam\nfnstsw ax`));
  cmp.push(mk(`fnstsw ax\nfxam\nfnstsw ax`));
  for (const op of ["fcomi", "fucomi", "fcomip", "fucomip"]) {
    cmp.push(mk(`${setup}${op} st0, st1\nseta cl\nsetb dl\nsete sil\nsetp dil${DUMP}`, { flags: 0x8d5 | 0x400 }));
    cmp.push(mk(`${setup}${op} st0, st1\njbe .x\nmov ecx, 5\n.x:${DUMP}`));
  }
  for (const cc of ["b", "e", "be", "u", "nb", "ne", "nbe", "nu"]) {
    cmp.push(mk(`${setup}cmp eax, ecx\nfcmov${cc} st0, st1${DUMP}`), mk(`${setup}fucomi st0, st1\nfcmov${cc} st0, st1${DUMP}`));
  }
  const misc: Template[] = [];
  misc.push(mk("fild dword [rbx+8]\nfild dword [rbx+12]\nfabs\nfxch\nfprem\nfnstsw ax" + DUMP));
  misc.push(mk("fild dword [rbx+8]\nfild word [rbx+12]\nfscale" + DUMP));
  misc.push(mk("fld1\nfldz\nffree st0\nfnstsw ax"));
  misc.push(mk("fild dword [rbx+8]\nmovaps xmm3, [rbx+16]\nmovaps xmm12, [rbx+32]\nfxsave [rbx+256]\nfninit\nxorps xmm3, xmm3\nxorps xmm12, xmm12\nfxrstor [rbx+256]" + DUMP, { noMem: true }));
  misc.push(mk("fld1\nfld1\nfld1\nfld1\nfld1\nfld1\nfld1\nfld1\nfld1\nfnstsw ax"));
  misc.push(mk("fstp st0\nfnstsw ax"));
  misc.push(mk("fild dword [rbx+8]\nfsin\nfstp qword [rbx+100]\nfild dword [rbx+8]\nfcos\nfstp qword [rbx+108]", { noMem: true }));
  return [{ name: "x87-arith", list: arith }, { name: "x87-convert", list: conv }, { name: "x87-compare", list: cmp }, { name: "x87-misc", list: misc }];
}
void FLAGS_CMP;
