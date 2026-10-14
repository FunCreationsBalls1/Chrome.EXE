// Integer instruction test templates for the differential harness.
export interface Template {
  asm: string;
  /** flags that are architecturally defined for this instruction (others are not compared) */
  flags?: number;
  fixed?: Record<number, bigint>;
  /** number of random inputs */
  n?: number;
}

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800, DF = 0x400;
export const ALLF = CF | PF | AF | ZF | SF | OF | DF;
const NOAF = ALLF & ~AF;

const REGS: Record<string, string[]> = {
  // [8, 16, 32, 64]
  rax: ["al", "ax", "eax", "rax"], rcx: ["cl", "cx", "ecx", "rcx"], rdx: ["dl", "dx", "edx", "rdx"],
  rsi: ["sil", "si", "esi", "rsi"], rdi: ["dil", "di", "edi", "rdi"], rbp: ["bpl", "bp", "ebp", "rbp"],
  r8: ["r8b", "r8w", "r8d", "r8"], r9: ["r9b", "r9w", "r9d", "r9"], r10: ["r10b", "r10w", "r10d", "r10"],
  r11: ["r11b", "r11w", "r11d", "r11"], r12: ["r12b", "r12w", "r12d", "r12"], r15: ["r15b", "r15w", "r15d", "r15"],
};
const szIdx = (sz: number) => (sz === 8 ? 0 : sz === 16 ? 1 : sz === 32 ? 2 : 3);
const ptr = (sz: number) => ({ 8: "byte", 16: "word", 32: "dword", 64: "qword" } as Record<number, string>)[sz];
export const reg = (r: string, sz: number) => REGS[r][szIdx(sz)];

const PAIRS: [string, string][] = [["rax", "rcx"], ["rdx", "rax"], ["rax", "rax"], ["r8", "r9"], ["rsi", "rdi"], ["r12", "rbp"], ["rcx", "r15"]];
const SIZES = [8, 16, 32, 64];
const IMMS: Record<number, string[]> = {
  8: ["0", "1", "0x7f", "0x80", "0xff", "-1"],
  16: ["0", "1", "0x7fff", "0x8000", "0xffff", "-1", "0x7f", "-128"],
  32: ["0", "1", "0x7fffffff", "0x80000000", "-1", "0x7f", "-128", "0x12345678"],
  64: ["0", "1", "0x7fffffff", "-1", "0x7f", "-128", "-0x80000000", "0x12345678"],
};

export function aluTemplates(): Template[] {
  const out: Template[] = [];
  const ops = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp", "test"];
  for (const op of ops) {
    const flags = op === "and" || op === "or" || op === "xor" || op === "test" ? NOAF : ALLF;
    for (const sz of SIZES) {
      for (const [a, b] of PAIRS) out.push({ asm: `${op} ${reg(a, sz)}, ${reg(b, sz)}`, flags });
      for (const imm of IMMS[sz]) {
        out.push({ asm: `${op} ${reg("rax", sz)}, ${imm}`, flags });
        out.push({ asm: `${op} ${reg("r9", sz)}, ${imm}`, flags });
        out.push({ asm: `${op} ${ptr(sz)} [rbx+8], ${imm}`, flags });
      }
      out.push({ asm: `${op} [rbx+16], ${reg("rcx", sz)}`, flags });
      out.push({ asm: `${op} ${reg("rdx", sz)}, [rbx+24]`, flags });
      out.push({ asm: `${op} ${reg("r10", sz)}, [rbx+rsi*0+32]`, flags });
    }
    if (op !== "test") {
      // high byte registers
      out.push({ asm: `${op} ah, cl`, flags });
      out.push({ asm: `${op} al, dh`, flags });
    }
  }
  // carry chains (adc/sbb consuming flags produced by the previous op in the same trace)
  for (const sz of [32, 64]) {
    out.push({ asm: `add ${reg("rax", sz)}, ${reg("rcx", sz)}\nadc ${reg("rdx", sz)}, ${reg("rsi", sz)}`, flags: ALLF });
    out.push({ asm: `sub ${reg("rax", sz)}, ${reg("rcx", sz)}\nsbb ${reg("rdx", sz)}, ${reg("rsi", sz)}`, flags: ALLF });
    out.push({ asm: `cmp ${reg("rax", sz)}, ${reg("rcx", sz)}\nadc ${reg("rdx", sz)}, 0`, flags: ALLF });
    out.push({ asm: `stc\nadc ${reg("rdx", sz)}, ${reg("rsi", sz)}`, flags: ALLF });
    out.push({ asm: `stc\nsbb ${reg("rdx", sz)}, ${reg("rsi", sz)}`, flags: ALLF });
    out.push({ asm: `clc\nsbb ${reg("rdx", sz)}, ${reg("rsi", sz)}`, flags: ALLF });
  }
  return out;
}

export function unaryTemplates(): Template[] {
  const out: Template[] = [];
  for (const op of ["inc", "dec", "neg", "not"]) {
    for (const sz of SIZES) {
      out.push({ asm: `${op} ${reg("rax", sz)}`, flags: ALLF });
      out.push({ asm: `${op} ${reg("r10", sz)}`, flags: ALLF });
      out.push({ asm: `${op} ${ptr(sz)} [rbx+40]`, flags: ALLF });
      // inc/dec preserve CF: feed CF from a previous op
      out.push({ asm: `add ${reg("rcx", 32)}, ${reg("rdx", 32)}\n${op} ${reg("rax", sz)}\nadc ${reg("rsi", 32)}, 0`, flags: ALLF });
      out.push({ asm: `cmp ${reg("rcx", 32)}, ${reg("rdx", 32)}\n${op} ${reg("rax", sz)}\nsetb sil`, flags: ALLF });
      out.push({ asm: `${op} ${reg("rax", sz)}\n${op} ${reg("rcx", sz)}\njz .a\nmov esi, 1\n.a:`, flags: ALLF });
    }
  }
  out.push({ asm: "inc ah", flags: ALLF });
  out.push({ asm: "neg ch", flags: ALLF });
  return out;
}

export function movTemplates(): Template[] {
  const out: Template[] = [];
  const f = ALLF;
  for (const sz of SIZES) {
    for (const [a, b] of PAIRS) out.push({ asm: `mov ${reg(a, sz)}, ${reg(b, sz)}`, flags: f });
    for (const imm of IMMS[sz]) {
      out.push({ asm: `mov ${reg("rax", sz)}, ${imm}`, flags: f });
      out.push({ asm: `mov ${ptr(sz)} [rbx+8], ${imm}`, flags: f });
    }
    out.push({ asm: `mov [rbx+16], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `mov ${reg("rdx", sz)}, [rbx+24]`, flags: f });
    out.push({ asm: `mov ${reg("r11", sz)}, [rbx+rcx*0+2]`, flags: f });
    out.push({ asm: `xchg ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `xchg [rbx+8], ${reg("rdx", sz)}`, flags: f });
    out.push({ asm: `xchg ${reg("r8", sz)}, [rbx+8]`, flags: f });
  }
  out.push({ asm: "mov rax, 0x123456789abcdef0", flags: f });
  out.push({ asm: "mov r11, 0xfedcba9876543210", flags: f });
  out.push({ asm: "mov ah, 0x55\nmov bh, ch", flags: f });
  out.push({ asm: "mov rax, [0x1000000+0x80]", flags: f });
  out.push({ asm: "mov [0x1000000+0x88], rcx", flags: f });
  out.push({ asm: "mov al, [0x1000000+0x80]\nmov [0x1000000+0x91], dl", flags: f });
  // movzx / movsx / movsxd
  for (const d of [16, 32, 64]) {
    out.push({ asm: `movzx ${reg("rax", d)}, cl`, flags: f });
    if (d !== 64) out.push({ asm: `movzx ${reg("rax", d)}, ch`, flags: f });
    out.push({ asm: `movzx ${reg("rdx", d)}, byte [rbx+9]`, flags: f });
    out.push({ asm: `movsx ${reg("rax", d)}, cl`, flags: f });
    if (d !== 64) out.push({ asm: `movsx ${reg("rax", d)}, ch`, flags: f });
    out.push({ asm: `movsx ${reg("r9", d)}, byte [rbx+11]`, flags: f });
  }
  for (const d of [32, 64]) {
    out.push({ asm: `movzx ${reg("rax", d)}, cx`, flags: f });
    out.push({ asm: `movzx ${reg("rdx", d)}, word [rbx+10]`, flags: f });
    out.push({ asm: `movsx ${reg("rax", d)}, cx`, flags: f });
    out.push({ asm: `movsx ${reg("r9", d)}, word [rbx+12]`, flags: f });
  }
  out.push({ asm: "movsxd rax, ecx", flags: f });
  out.push({ asm: "movsxd r9, dword [rbx+4]", flags: f });
  // lea
  const eas = ["[rax]", "[rax+rcx]", "[rax+rcx*2]", "[rax+rcx*4+0x10]", "[rax+rcx*8-0x20]", "[rcx*4+0x100]", "[rax+0x12345]",
    "[r8+r9*2]", "[rbx+rsi*8+7]", "[rax*2]", "[rel $+0x100]"];
  for (const e of eas) {
    for (const d of [16, 32, 64]) out.push({ asm: `lea ${reg("rdx", d)}, ${e}`, flags: f });
  }
  out.push({ asm: "lea eax, [ecx+edx*2+5]", flags: f });
  out.push({ asm: "lea rax, [ecx+edx*2+5]", flags: f });
  // sign extension idioms
  out.push({ asm: "cbw", flags: f }, { asm: "cwde", flags: f }, { asm: "cdqe", flags: f });
  out.push({ asm: "cwd", flags: f }, { asm: "cdq", flags: f }, { asm: "cqo", flags: f });
  out.push({ asm: "bswap eax", flags: f }, { asm: "bswap rcx", flags: f }, { asm: "bswap r9", flags: f }, { asm: "bswap r10d", flags: f });
  out.push({ asm: "xlatb", flags: f, fixed: { 3: 0x1000100n } });
  // flag manipulation
  for (const op of ["clc", "stc", "cmc", "cld", "std", "lahf", "sahf"]) out.push({ asm: op, flags: ALLF });
  out.push({ asm: "add eax, ecx\nlahf", flags: ALLF });
  out.push({ asm: "sub eax, ecx\nmov ah, 0xff\nsahf\nsetb dl\nsetz dh", flags: ALLF });
  out.push({ asm: "add eax, ecx\ncmc\nseto dl\nsetc dh", flags: ALLF });
  return out;
}

export function shiftTemplates(): Template[] {
  const out: Template[] = [];
  for (const op of ["shl", "shr", "sar", "rol", "ror"]) {
    const rot = op === "rol" || op === "ror";
    for (const sz of SIZES) {
      const bits = sz;
      const counts = ["1", "2", "3", "7", "8", String(bits - 1), String(bits > 8 ? bits : 5), String(bits > 16 ? bits + 1 : 4)];
      for (const c of counts) {
        const n = Number(c);
        // OF is only defined for 1-bit shifts. CF for over-wide shifts is undefined on 8/16-bit shl/shr, defined by rotates.
        let flags = rot ? (CF | OF | ZF | SF | PF | AF | DF) : NOAF;
        if (n !== 1) flags &= ~OF;
        if (!rot && sz < 32 && n >= bits) flags &= ~(CF | PF | SF | ZF);
        if (!rot && n >= 32 && sz < 64) flags &= ~(CF | PF | SF | ZF | OF);
        if (rot && n > 1 && sz < 32 && n % bits === 0) flags &= ~OF;
        if (n % 32 >= 0 && sz === 64 && n >= 64) continue; // masked count 0/1 -> covered elsewhere
        out.push({ asm: `${op} ${reg("rax", sz)}, ${c}`, flags });
        out.push({ asm: `${op} ${ptr(sz)} [rbx+8], ${c}`, flags });
      }
      let flags = rot ? (CF | ZF | SF | PF | AF | DF) : (ALLF & ~AF & ~OF);
      if (!rot && sz < 32) flags &= ~(CF | PF | SF | ZF);
      // variable count in cl (may be 0 => flags unchanged; may exceed the width)
      out.push({ asm: `${op} ${reg("rdx", sz)}, cl`, flags, n: 80 });
      out.push({ asm: `${op} ${ptr(sz)} [rbx+8], cl`, flags, n: 40 });
      out.push({ asm: `${op} ${reg("rdx", sz)}, 1`, flags: rot ? ALLF & ~AF | 0 : NOAF });
      // consuming the produced flags in-trace
      if (!rot) {
        out.push({ asm: `${op} ${reg("rax", sz)}, 1\nsetc dl\nseto dh\nsets cl\nsetz sil`, flags: NOAF & ~AF });
        out.push({ asm: `${op} ${reg("rax", sz)}, 3\nsetc dl\nsets cl\nsetz sil`, flags: NOAF & ~AF & ~OF });
        out.push({ asm: `${op} ${reg("rax", sz)}, 1\nadc ecx, edx`, flags: ALLF & ~AF });
      } else {
        out.push({ asm: `${op} ${reg("rax", sz)}, 1\nsetc dl\nseto dh`, flags: ALLF });
        out.push({ asm: `cmp ecx, edx\n${op} ${reg("rax", sz)}, 3\nsetz dl\nsetc dh`, flags: ALLF & ~OF });
      }
    }
  }
  // double shifts
  for (const op of ["shld", "shrd"]) {
    for (const sz of [16, 32, 64]) {
      for (const c of ["1", "3", String(sz / 2), String(sz - 1)]) {
        const n = Number(c);
        let flags = NOAF;
        if (n !== 1) flags &= ~OF;
        out.push({ asm: `${op} ${reg("rax", sz)}, ${reg("rcx", sz)}, ${c}`, flags });
        out.push({ asm: `${op} ${ptr(sz)} [rbx+8], ${reg("rcx", sz)}, ${c}`, flags });
      }
      if (sz !== 16) out.push({ asm: `${op} ${reg("rdx", sz)}, ${reg("rsi", sz)}, cl`, flags: NOAF & ~OF, n: 60 });
    }
  }
  // rcl / rcr
  for (const op of ["rcl", "rcr"]) {
    for (const sz of SIZES) {
      for (const c of ["1", "2", "5"]) {
        out.push({ asm: `${op} ${reg("rax", sz)}, ${c}`, flags: Number(c) === 1 ? ALLF : ALLF & ~OF });
      }
      out.push({ asm: `${op} ${reg("rdx", sz)}, cl`, flags: ALLF & ~OF, n: 50 });
    }
  }
  return out;
}

export function mulDivTemplates(): Template[] {
  const out: Template[] = [];
  const MULF = CF | OF | DF; // SF ZF AF PF undefined
  for (const sz of SIZES) {
    out.push({ asm: `mul ${reg("rcx", sz)}`, flags: MULF });
    out.push({ asm: `imul ${reg("rcx", sz)}`, flags: MULF });
    out.push({ asm: `mul ${ptr(sz)} [rbx+8]`, flags: MULF });
    out.push({ asm: `imul ${ptr(sz)} [rbx+8]`, flags: MULF });
    if (sz > 8) {
      out.push({ asm: `imul ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: MULF });
      out.push({ asm: `imul ${reg("r9", sz)}, ${ptr(sz)} [rbx+16]`, flags: MULF });
      for (const imm of sz === 16 ? ["3", "-5", "0x1234", "0x7fff"] : ["3", "-5", "0x12345", "0x7fffffff"]) {
        out.push({ asm: `imul ${reg("rax", sz)}, ${reg("rcx", sz)}, ${imm}`, flags: MULF });
        out.push({ asm: `imul ${reg("rdx", sz)}, ${ptr(sz)} [rbx+24], ${imm}`, flags: MULF });
      }
    }
    // unsigned division with a zero high half (rarely overflows)
    const zdx = sz === 8 ? "xor ah, ah\n" : sz === 16 ? "xor dx, dx\n" : sz === 32 ? "xor edx, edx\n" : "xor edx, edx\n";
    out.push({ asm: `${zdx}div ${reg("rcx", sz)}`, flags: 0, n: 60 });
    out.push({ asm: `${zdx}div ${ptr(sz)} [rbx+8]`, flags: 0, n: 40 });
    const sext = sz === 8 ? "cbw\n" : sz === 16 ? "cwd\n" : sz === 32 ? "cdq\n" : "cqo\n";
    out.push({ asm: `${sext}idiv ${reg("rcx", sz)}`, flags: 0, n: 60 });
    out.push({ asm: `${sext}idiv ${ptr(sz)} [rbx+8]`, flags: 0, n: 40 });
    // arbitrary (often overflowing => #DE) operands
    out.push({ asm: `div ${reg("rcx", sz)}`, flags: 0, n: 30 });
    out.push({ asm: `idiv ${reg("rcx", sz)}`, flags: 0, n: 30 });
  }
  out.push({ asm: "mul rcx\nsetc dl\nseto dh", flags: MULF });
  out.push({ asm: "imul eax, ecx\nseto dl\nsetc dh", flags: MULF });
  return out;
}

export function bitTemplates(): Template[] {
  const out: Template[] = [];
  for (const op of ["bt", "bts", "btr", "btc"]) {
    for (const sz of [16, 32, 64]) {
      out.push({ asm: `${op} ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: CF | ZF | DF, n: 40 });
      for (const i of ["0", "1", "5", String(sz - 1), "31"]) {
        if (Number(i) >= sz) continue;
        out.push({ asm: `${op} ${reg("rdx", sz)}, ${i}`, flags: CF | ZF | DF });
        out.push({ asm: `${op} ${ptr(sz)} [rbx+8], ${i}`, flags: CF | ZF | DF });
      }
      // bit-string addressing with register offset (bounded)
      out.push({ asm: `and ecx, 0x3ff\nsub ecx, 0x1ff\nmovsxd rcx, ecx\n${op} ${ptr(sz)} [rbx+100], ${reg("rcx", sz)}`, flags: CF | ZF | DF, n: 40, fixed: {} });
      out.push({ asm: `${op} ${reg("rdx", sz)}, ${reg("rsi", sz)}\nsetc cl\njnc .z\nmov dl, 1\n.z:`, flags: CF | ZF | DF, n: 20 });
    }
    // CF consumed in the same trace
    out.push({ asm: `${op} eax, 3\nsetc dl\nsbb esi, esi`, flags: CF | ZF | DF });
  }
  for (const op of ["bsf", "bsr"]) {
    for (const sz of [16, 32, 64]) {
      out.push({ asm: `${op} ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: ZF | DF, n: 40 });
      out.push({ asm: `${op} ${reg("rdx", sz)}, ${ptr(sz)} [rbx+8]`, flags: ZF | DF });
      out.push({ asm: `${op} ${reg("rax", sz)}, ${reg("rcx", sz)}\njz .z\nmov esi, 1\n.z:`, flags: ZF | DF, n: 40 });
    }
  }
  for (const op of ["tzcnt", "lzcnt"]) {
    for (const sz of [16, 32, 64]) {
      out.push({ asm: `${op} ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: CF | ZF | DF, n: 40 });
      out.push({ asm: `${op} ${reg("rdx", sz)}, ${ptr(sz)} [rbx+8]`, flags: CF | ZF | DF });
    }
  }
  for (const sz of [16, 32, 64]) {
    out.push({ asm: `popcnt ${reg("rax", sz)}, ${reg("rcx", sz)}`, flags: ALLF, n: 40 });
    out.push({ asm: `popcnt ${reg("rdx", sz)}, ${ptr(sz)} [rbx+8]`, flags: ALLF });
  }
  return out;
}

const CCS = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
export function condTemplates(): Template[] {
  const out: Template[] = [];
  const producers: [string, number][] = [
    ["", ALLF], ["cmp eax, ecx", ALLF], ["cmp rax, rcx", ALLF], ["cmp al, cl", ALLF], ["cmp ax, cx", ALLF], ["test eax, ecx", NOAF],
    ["test rax, rax", NOAF], ["add eax, ecx", ALLF], ["add rax, rcx", ALLF], ["sub eax, ecx", ALLF], ["sub al, cl", ALLF],
    ["and eax, ecx", NOAF], ["or ax, cx", NOAF], ["xor eax, ecx", NOAF], ["inc eax", ALLF], ["dec rax", ALLF],
    ["neg eax", ALLF], ["neg r8b", ALLF], ["adc eax, ecx", ALLF], ["sbb rax, rcx", ALLF], ["cmp eax, 5", ALLF], ["cmp rax, -1", ALLF],
    ["test al, 0x80", NOAF], ["cmp [rbx+8], eax", ALLF],
  ];
  for (const [prod, flags] of producers) {
    CCS.forEach((cc, i) => {
      out.push({ asm: `${prod}\nset${cc} dl\ncmov${cc} esi, edi\ncmov${cc} r8, r9\ncmov${cc} r10w, r11w`, flags });
      // branches: both outcomes write a marker
      out.push({ asm: `${prod}\nj${cc} .t\nmov r12d, 1\njmp .e\n.t:\nmov r12d, 2\n.e:`, flags });
    });
  }
  return out;
}

export function stackTemplates(): Template[] {
  const out: Template[] = [];
  const f = ALLF;
  out.push({ asm: "push rax\npush rcx\npop rdx\npop rsi", flags: f });
  out.push({ asm: "push r12\npop r13", flags: f });
  out.push({ asm: "push 0x1234\npop rax", flags: f });
  out.push({ asm: "push -5\npop rax", flags: f });
  out.push({ asm: "push qword [rbx+8]\npop qword [rbx+24]", flags: f });
  out.push({ asm: "push ax\npop cx", flags: f });
  out.push({ asm: "push rsp\npop rax", flags: f });
  out.push({ asm: "push rax\npop rsp", flags: f, fixed: { 0: 0n } });
  out.push({ asm: "pushfq\npop rax", flags: f });
  out.push({ asm: "add eax, ecx\npushfq\npop rdx", flags: f });
  out.push({ asm: "and eax, 0xcd5\npush rax\npopfq\nsetc dl\nsetz dh\nseto sil\nsets dil", flags: f });
  out.push({ asm: "push rbp\nmov rbp, rsp\nsub rsp, 32\nmov [rbp-8], rax\nleave", flags: f });
  out.push({ asm: "call .f\nmov esi, 7\njmp .e\n.f:\nmov edx, 9\nret\n.e:", flags: f });
  out.push({ asm: "lea rax, [rel .f]\ncall rax\nmov esi, 7\njmp .e\n.f:\nmov edx, 9\nret\n.e:", flags: f });
  out.push({ asm: "lea rax, [rel .t]\njmp rax\nmov esi, 1\n.t:\nmov edi, 2", flags: f });
  out.push({ asm: "lea rax, [rel .t]\nmov [rbx+8], rax\njmp [rbx+8]\nmov esi, 1\n.t:\nmov edi, 2", flags: f });
  out.push({ asm: "push rax\npush rcx\ncall .f\njmp .e\n.f:\nret 16\n.e:", flags: f });
  out.push({ asm: "push rcx\npush rdx\ncall .f\n.f:\nadd rsp, 8\npop rdx\npop rcx", flags: f });
  return out;
}

export function loopTemplates(): Template[] {
  const out: Template[] = [];
  const f = ALLF;
  out.push({ asm: "mov ecx, 10\nxor eax, eax\n.l:\nadd eax, ecx\ndec ecx\njnz .l", flags: f });
  out.push({ asm: "mov ecx, 7\nxor eax, eax\n.l:\nlea eax, [rax+rcx*2]\nloop .l", flags: f });
  out.push({ asm: "mov ecx, 9\nxor eax, eax\n.l:\ninc eax\ncmp eax, 5\nloopne .l", flags: f });
  out.push({ asm: "xor ecx, ecx\njrcxz .z\nmov eax, 1\n.z:\nmov edx, 2", flags: f });
  out.push({ asm: "mov ecx, 3\njrcxz .z\nmov eax, 1\n.z:\nmov edx, 2", flags: f });
  out.push({ asm: "mov esi, 100\nmov edi, 0\n.l:\nadd edi, esi\nsub esi, 7\njg .l", flags: f });
  out.push({ asm: "mov rcx, 5\n.a:\nmov rdx, 3\n.b:\nadd rax, rdx\ndec rdx\njnz .b\ndec rcx\njnz .a", flags: f });
  // jump table
  out.push({
    asm: "and ecx, 3\nlea rdx, [rel .tab]\nmovsxd rax, dword [rdx+rcx*4]\nadd rax, rdx\njmp rax\n.tab:\ndd .a-.tab, .b-.tab, .c-.tab, .d-.tab\n.a:\nmov esi,1\njmp .e\n.b:\nmov esi,2\njmp .e\n.c:\nmov esi,3\njmp .e\n.d:\nmov esi,4\n.e:\ntest esi, esi",
    flags: f,
  });
  return out;
}

export function stringTemplates(): Template[] {
  const out: Template[] = [];
  const f = ALLF;
  const setup = "lea rsi, [rbx+16]\nlea rdi, [rbx+128]\n";
  for (const [sfx, sz] of [["b", 1], ["w", 2], ["d", 4], ["q", 8]] as [string, number][]) {
    out.push({ asm: `${setup}movs${sfx}`, flags: f });
    out.push({ asm: `${setup}mov ecx, 7\nrep movs${sfx}`, flags: f });
    out.push({ asm: `std\nlea rsi, [rbx+200]\nlea rdi, [rbx+400]\nmov ecx, 5\nrep movs${sfx}\ncld`, flags: f });
    out.push({ asm: `${setup}stos${sfx}`, flags: f });
    out.push({ asm: `${setup}mov ecx, 9\nrep stos${sfx}`, flags: f });
    out.push({ asm: `std\nlea rdi, [rbx+300]\nmov ecx, 4\nrep stos${sfx}\ncld`, flags: f });
    out.push({ asm: `${setup}lods${sfx}`, flags: f });
    out.push({ asm: `${setup}xor ecx, ecx\nrep movs${sfx}`, flags: f });
    out.push({ asm: `${setup}scas${sfx}`, flags: f });
    out.push({ asm: `${setup}cmps${sfx}`, flags: f });
  }
  // overlapping forward copy (x86 byte-wise semantics replicates data)
  out.push({ asm: "lea rsi, [rbx+16]\nlea rdi, [rbx+17]\nmov ecx, 20\nrep movsb", flags: f });
  out.push({ asm: "lea rsi, [rbx+16]\nlea rdi, [rbx+18]\nmov ecx, 10\nrep movsw", flags: f });
  // repe cmps / repne scas on data crafted to be equal for a while
  out.push({ asm: "lea rsi, [rbx+16]\nlea rdi, [rbx+128]\nmov ecx, 12\nrepe cmpsb\nsetz dl\nsetb dh", flags: f, n: 40 });
  out.push({ asm: "lea rdi, [rbx+16]\nmov ecx, 100\nrepne scasb\nsetz dl", flags: f, n: 40 });
  out.push({ asm: "lea rdi, [rbx+16]\nmov ecx, 100\nxor eax, eax\nrepne scasb\nsetz dl", flags: f, n: 40 });
  out.push({ asm: "lea rsi, [rbx+16]\nlea rdi, [rbx+128]\nmov ecx, 12\nrepe cmpsd\nsetz dl", flags: f, n: 40 });
  out.push({ asm: "lea rsi, [rbx+16]\nmov ecx, 10\nrep lodsb", flags: f });
  // typical memset/memcpy idioms
  out.push({ asm: "lea rdi, [rbx+64]\nmov ecx, 8\nxor eax, eax\nrep stosq", flags: f });
  out.push({ asm: "lea rsi, [rbx+16]\nlea rdi, [rbx+256]\nmov ecx, 33\nrep movsb\nlea rsi, [rbx+256]\nlea rdi, [rbx+512]\nmov ecx, 4\nrep movsq", flags: f });
  return out;
}

export function atomicTemplates(): Template[] {
  const out: Template[] = [];
  const f = ALLF;
  for (const sz of SIZES) {
    out.push({ asm: `xadd [rbx+8], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `xadd ${reg("rdx", sz)}, ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `lock xadd [rbx+8], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `cmpxchg [rbx+8], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `cmpxchg ${reg("rdx", sz)}, ${reg("rcx", sz)}`, flags: f });
    // force the success path: store rax to memory first
    out.push({ asm: `mov [rbx+8], ${reg("rax", sz)}\nlock cmpxchg [rbx+8], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `mov ${reg("rdx", sz)}, ${reg("rax", sz)}\ncmpxchg ${reg("rdx", sz)}, ${reg("rcx", sz)}\nsetz sil`, flags: f });
    out.push({ asm: `lock add [rbx+8], ${reg("rcx", sz)}`, flags: f });
    out.push({ asm: `lock inc ${ptr(sz)} [rbx+8]`, flags: f });
    out.push({ asm: `lock or ${ptr(sz)} [rbx+8], 4`, flags: f });
  }
  out.push({ asm: "mov [rbx+8], eax\nmov [rbx+12], edx\ncmpxchg8b [rbx+8]", flags: ZF | DF });
  out.push({ asm: "cmpxchg8b [rbx+8]\nsetz sil", flags: ZF | DF });
  out.push({ asm: "mov [rbx+16], rax\nmov [rbx+24], rdx\ncmpxchg16b [rbx+16]", flags: ZF | DF });
  out.push({ asm: "cmpxchg16b [rbx+16]\nsetz sil", flags: ZF | DF });
  return out;
}

export function allIntTemplates(): { name: string; list: Template[] }[] {
  return [
    { name: "alu", list: aluTemplates() },
    { name: "unary", list: unaryTemplates() },
    { name: "mov", list: movTemplates() },
    { name: "shift", list: shiftTemplates() },
    { name: "muldiv", list: mulDivTemplates() },
    { name: "bit", list: bitTemplates() },
    { name: "cond", list: condTemplates() },
    { name: "stack", list: stackTemplates() },
    { name: "loop", list: loopTemplates() },
    { name: "string", list: stringTemplates() },
    { name: "atomic", list: atomicTemplates() },
  ];
}
