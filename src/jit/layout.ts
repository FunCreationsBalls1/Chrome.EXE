// Memory layout shared by the translator, the JS host and the C runtime (runtime/layout.h is generated from this).
//
// The guest address space *is* the WebAssembly linear memory (guest address == wasm address), limited to 4 GiB.
// The low part of the space is reserved for host structures:
//
//   0x00000000 - 0x00000fff   null page (guest accesses fault)
//   0x00001000 - 0x00001fff   CPU state (STATE)
//   0x00002000 - 0x0000ffff   host scratch / C runtime stack lives below 0x1000
//   0x00010000 - 0x0010ffff   block lookup cache (LOOKUP)
//   0x00100000 - 0x001fffff   code page table (one byte per 4 KiB page of the 4 GiB space)
//   0x00300000 - 0x007fffff   HLE thunk region (synthetic export images + 16-byte call thunks)
//   0x00800000 -              guest user space
export const STATE = 0x1000;

// --- CPU state field offsets (relative to STATE) ---
export const S_GPR = 0x000; // 16 x u64 : rax rcx rdx rbx rsp rbp rsi rdi r8..r15
export const S_RIP = 0x080; // u64
export const S_CC_OP = 0x088; // u32 : (kind << 2) | log2(size bytes)
export const S_DF = 0x08c; // u32 : 0 or 1
export const S_EFL_OTHER = 0x090; // u32 : non-arithmetic EFLAGS bits (IF, AC, ID, ...)
export const S_CC_DST = 0x098; // u64
export const S_CC_SRC1 = 0x0a0; // u64
export const S_CC_SRC2 = 0x0a8; // u64
export const S_CC_AUX = 0x0b0; // u64
export const S_STATUS = 0x0b8; // u32 : last exit status
export const S_BUDGET = 0x0bc; // i32 : remaining block budget before yielding
export const S_GS_BASE = 0x0c0; // u64
export const S_FS_BASE = 0x0c8; // u64
export const S_MISS_PC = 0x0d0; // u32
export const S_FAULT_ADDR = 0x0d4; // u32
export const S_FAULT_KIND = 0x0d8; // u32  (0 = read AV, 1 = write AV, 2 = exec AV, 3 = divide error, 4 = int3, 5 = invalid insn, ...)
export const S_MXCSR = 0x0dc; // u32
export const S_FCW = 0x0e0; // u16
export const S_FSW = 0x0e2; // u16  (without TOP)
export const S_FTAG = 0x0e4; // u16 : 2 bits per physical register, 11 = empty
export const S_FTOP = 0x0e8; // u32 : stack top (0-7)
export const S_SCRATCH = 0x0f0; // 16 bytes
export const S_XMM = 0x100; // 16 x 16 bytes
export const S_ST = 0x200; // 8 x 16 bytes : x87 registers (f64 in the first 8 bytes; see x87.ts)
export const S_HOSTARGS = 0x300; // 0x100 bytes : arguments for host calls from the translator
export const S_END = 0x400;

export const gprOff = (i: number) => STATE + S_GPR + i * 8;
export const xmmOff = (i: number) => STATE + S_XMM + i * 16;

// block lookup cache: direct-mapped, 2^16 entries of {pc: u32, slot: u32}
export const LOOKUP = 0x10000;
export const LOOKUP_BITS = 16;
export const LOOKUP_SIZE = (1 << LOOKUP_BITS) * 8;

// Code page table: one byte per 4 KiB page for the full 4 GiB space (1 MiB). Non-zero => page has translated code.
export const CODEPAGE = 0x100000;
export const CODEPAGE_SIZE = 1 << 20;

export const HOST_RESERVED_END = 0x00800000;

// --- Exit status codes returned by translated code to the host driver ---
export const ST_MISS = 0; // translate S_MISS_PC
export const ST_YIELD = 1; // budget exhausted, resume at S_RIP
export const ST_HLE_YIELD = 2; // HLE call requested a scheduler yield / async completion; resume at S_RIP
export const ST_EXIT = 3; // process/thread exit requested
export const ST_FAULT = 4; // guest exception; S_FAULT_KIND/S_FAULT_ADDR describe it, S_RIP = faulting instruction
export const ST_SMC = 5; // self-modifying code detected; resume at S_RIP
export const ST_INVALID = 6; // undecodable/unsupported instruction at S_RIP
export const ST_HOSTCALL_RETURN = 7; // reached the host-return sentinel (nested guest call finished)

export const FK_READ = 0;
export const FK_WRITE = 1;
export const FK_EXEC = 2;
export const FK_DIV = 3;
export const FK_INT3 = 4;
export const FK_INVALID = 5;
export const FK_HLT = 6;
export const FK_INT = 7; // S_FAULT_ADDR = vector
export const FK_DEBUG = 8;

// --- Lazy flag operation kinds (cc_op = kind << 2 | log2(size)) ---
export const CC_EFLAGS = 0; // arithmetic flags materialised in cc_src1
export const CC_ADD = 1; // dst=result src1=a src2=b (also ADC)
export const CC_SUB = 2; // dst=result src1=a src2=b (also SBB, CMP, NEG)
export const CC_LOGIC = 3; // dst=result ; CF=OF=AF=0
export const CC_INC = 4; // dst=result aux=old CF
export const CC_DEC = 5; // dst=result aux=old CF
export const CC_SHL = 6; // dst=result src1=orig src2=count
export const CC_SHR = 7;
export const CC_SAR = 8;
export const CC_MUL = 9; // dst=low result aux=CF/OF
export const CC_SHRD = 10; // like SHR but OF = msb(res) ^ msb(orig)

// EFLAGS arithmetic bit positions
export const F_CF = 0x0001;
export const F_PF = 0x0004;
export const F_AF = 0x0010;
export const F_ZF = 0x0040;
export const F_SF = 0x0080;
export const F_DF = 0x0400;
export const F_OF = 0x0800;
export const F_ARITH = F_CF | F_PF | F_AF | F_ZF | F_SF | F_OF;

// Thunk (HLE) region: each entry is 16 bytes. Calls into this region are intercepted by the translator.
export const THUNK_BASE = 0x00300000;
export const THUNK_SIZE = 0x00500000; // 5 MiB => 327K thunks
export const THUNK_STRIDE = 16;
