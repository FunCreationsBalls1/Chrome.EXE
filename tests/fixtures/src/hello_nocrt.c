// Freestanding program: only kernel32 imports, no C runtime.
#include <windows.h>

static int slen(const char *s) { int n = 0; while (s[n]) n++; return n; }
static void put(const char *s) {
  DWORD n;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), s, slen(s), &n, 0);
}
static void putnum(unsigned long long v) {
  char buf[32]; int i = 31; buf[i] = 0;
  if (!v) buf[--i] = '0';
  while (v) { buf[--i] = '0' + v % 10; v /= 10; }
  put(buf + i);
}

int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

void mainCRTStartup(void) {
  put("hello from a PE running on a JIT\n");
  put("fib(20)="); putnum(fib(20)); put("\n");
  // heap + memory
  char *p = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 100);
  for (int i = 0; i < 99; i++) p[i] = 'a' + (i % 26);
  put(p); put("\n");
  HeapFree(GetProcessHeap(), 0, p);
  // floating point (SSE2)
  volatile double d = 1.5;
  d = d * 4.0 + 0.25;
  putnum((unsigned long long)(d * 100)); put("\n");
  // tick count / QPC just have to work
  LARGE_INTEGER q; QueryPerformanceCounter(&q);
  put(q.QuadPart > 0 ? "qpc ok\n" : "qpc bad\n");
  ExitProcess(42);
}
