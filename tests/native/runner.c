// Native oracle: executes machine-code test cases on the host CPU and reports the resulting architectural state.
// Protocol (little endian) on stdin, repeated until EOF:
//   u32 code_len, code bytes, ctx_in (gpr[16] u64, flags u64, xmm[16][16]), scratch_in[SCR_N], stack_in[STK_N]
// stdout per case: u32 signal (0 = ok), ctx_out, scratch_out, stack_out
#define _GNU_SOURCE
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define SCRATCH 0x01000000UL
#define STACK_PAGE (SCRATCH + 0x1000)
#define STACK_TOP (SCRATCH + 0x2000)
#define CODE 0x01010000UL
#define SCR_N 1024
#define STK_N 256

typedef struct {
  uint64_t gpr[16];
  uint64_t flags;
  uint64_t pad;
  uint8_t xmm[16][16];
} ctx_t;

ctx_t g_in, g_out;
uint64_t saved_rsp, code_ptr;

extern void run_code(void);
__asm__(
    ".intel_syntax noprefix\n"
    ".text\n"
    ".globl run_code\n"
    "run_code:\n"
    "  push rbx\n  push rbp\n  push r12\n  push r13\n  push r14\n  push r15\n"
    "  mov [rip+saved_rsp], rsp\n"
    "  lea rdi, [rip+g_in]\n"
    "  movups xmm0, [rdi+144]\n  movups xmm1, [rdi+160]\n  movups xmm2, [rdi+176]\n  movups xmm3, [rdi+192]\n"
    "  movups xmm4, [rdi+208]\n  movups xmm5, [rdi+224]\n  movups xmm6, [rdi+240]\n  movups xmm7, [rdi+256]\n"
    "  movups xmm8, [rdi+272]\n  movups xmm9, [rdi+288]\n  movups xmm10, [rdi+304]\n  movups xmm11, [rdi+320]\n"
    "  movups xmm12, [rdi+336]\n  movups xmm13, [rdi+352]\n  movups xmm14, [rdi+368]\n  movups xmm15, [rdi+384]\n"
    "  push qword ptr [rdi+128]\n  popfq\n"
    "  mov rax,[rdi+0]\n  mov rcx,[rdi+8]\n  mov rdx,[rdi+16]\n  mov rbx,[rdi+24]\n  mov rbp,[rdi+40]\n"
    "  mov rsi,[rdi+48]\n  mov r8,[rdi+64]\n  mov r9,[rdi+72]\n  mov r10,[rdi+80]\n  mov r11,[rdi+88]\n"
    "  mov r12,[rdi+96]\n  mov r13,[rdi+104]\n  mov r14,[rdi+112]\n  mov r15,[rdi+120]\n"
    "  mov rsp,[rdi+32]\n"
    "  mov rdi,[rdi+56]\n"
    "  call qword ptr [rip+code_ptr]\n"
    "  mov [rip+g_out+0], rax\n  mov [rip+g_out+8], rcx\n  mov [rip+g_out+16], rdx\n  mov [rip+g_out+24], rbx\n"
    "  mov [rip+g_out+32], rsp\n  mov [rip+g_out+40], rbp\n  mov [rip+g_out+48], rsi\n  mov [rip+g_out+56], rdi\n"
    "  mov [rip+g_out+64], r8\n  mov [rip+g_out+72], r9\n  mov [rip+g_out+80], r10\n  mov [rip+g_out+88], r11\n"
    "  mov [rip+g_out+96], r12\n  mov [rip+g_out+104], r13\n  mov [rip+g_out+112], r14\n  mov [rip+g_out+120], r15\n"
    "  pushfq\n  pop qword ptr [rip+g_out+128]\n"
    "  lea rdi, [rip+g_out]\n"
    "  movups [rdi+144], xmm0\n  movups [rdi+160], xmm1\n  movups [rdi+176], xmm2\n  movups [rdi+192], xmm3\n"
    "  movups [rdi+208], xmm4\n  movups [rdi+224], xmm5\n  movups [rdi+240], xmm6\n  movups [rdi+256], xmm7\n"
    "  movups [rdi+272], xmm8\n  movups [rdi+288], xmm9\n  movups [rdi+304], xmm10\n  movups [rdi+320], xmm11\n"
    "  movups [rdi+336], xmm12\n  movups [rdi+352], xmm13\n  movups [rdi+368], xmm14\n  movups [rdi+384], xmm15\n"
    "  mov rsp, [rip+saved_rsp]\n"
    "  cld\n"
    "  pop r15\n  pop r14\n  pop r13\n  pop r12\n  pop rbp\n  pop rbx\n"
    "  ret\n"
    ".att_syntax prefix\n");

static sigjmp_buf jb;
static volatile int got_sig;
static void on_sig(int s, siginfo_t *si, void *uc) {
  (void)si; (void)uc;
  got_sig = s;
  siglongjmp(jb, 1);
}

static int read_all(void *p, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(0, (char *)p + got, n - got);
    if (r <= 0) return got ? -1 : 0;
    got += r;
  }
  return 1;
}

int main(void) {
  void *scr = mmap((void *)SCRATCH, 0x2000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  void *code = mmap((void *)CODE, 0x10000, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  if (scr != (void *)SCRATCH || code != (void *)CODE) { fprintf(stderr, "mmap failed\n"); return 1; }
  static char altstack[65536];
  stack_t ss = {.ss_sp = altstack, .ss_size = sizeof altstack, .ss_flags = 0};
  sigaltstack(&ss, 0);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_sig;
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_NODEFER;
  sigaction(SIGSEGV, &sa, 0); sigaction(SIGFPE, &sa, 0); sigaction(SIGILL, &sa, 0); sigaction(SIGTRAP, &sa, 0); sigaction(SIGBUS, &sa, 0); sigaction(SIGALRM, &sa, 0);
  setvbuf(stdout, NULL, _IOFBF, 1 << 20);
  for (;;) {
    uint32_t len;
    int r = read_all(&len, 4);
    if (r <= 0) break;
    if (len > 0x8000) return 2;
    uint8_t codebuf[0x8000];
    if (read_all(codebuf, len) <= 0 || read_all(&g_in, sizeof g_in) <= 0) return 3;
    static uint8_t sin[SCR_N], kin[STK_N];
    if (read_all(sin, SCR_N) <= 0 || read_all(kin, STK_N) <= 0) return 3;
    memset((void *)SCRATCH, 0, 0x2000);
    memcpy((void *)SCRATCH, sin, SCR_N);
    memcpy((void *)(STACK_TOP - STK_N), kin, STK_N);
    memcpy((void *)CODE, codebuf, len);
    ((uint8_t *)CODE)[len] = 0xc3; // ensure termination
    code_ptr = CODE;
    memset(&g_out, 0, sizeof g_out);
    got_sig = 0;
    uint32_t sig = 0;
    if (sigsetjmp(jb, 1) == 0) {
      alarm(1);
      run_code();
      alarm(0);
    } else {
      sig = got_sig;
    }
    fwrite(&sig, 4, 1, stdout);
    fwrite(&g_out, sizeof g_out, 1, stdout);
    fwrite((void *)SCRATCH, SCR_N, 1, stdout);
    fwrite((void *)(STACK_TOP - STK_N), STK_N, 1, stdout);
  }
  fflush(stdout);
  return 0;
}
