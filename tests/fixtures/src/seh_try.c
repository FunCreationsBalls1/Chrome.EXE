// Windows structured exception handling (__try/__except/__finally), compiled with clang.
#include <windows.h>
#include <stdio.h>

static int filter_count;
static LONG filt(EXCEPTION_POINTERS *ep) {
  filter_count++;
  printf("filter code=%08lx\n", ep->ExceptionRecord->ExceptionCode);
  return EXCEPTION_EXECUTE_HANDLER;
}

static int divide(int a, volatile int b) {
  __try {
    return a / b;
  } __except (filt(GetExceptionInformation())) {
    printf("divide handler\n");
    return -1;
  }
}

static void with_finally(void) {
  __try {
    printf("in try\n");
    RaiseException(0xE0000001, 0, 0, 0);
    printf("not reached\n");
  } __finally {
    printf("in finally\n");
  }
}

int main(void) {
  printf("10/2=%d\n", divide(10, 2));
  printf("10/0=%d\n", divide(10, 0));
  __try {
    with_finally();
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    printf("outer caught %08lx\n", GetExceptionCode());
  }
  __try {
    RaiseException(0xE0000002, 0, 0, 0);
  } __except (GetExceptionCode() == 0xE0000002 ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
    printf("custom code handled\n");
  }
  printf("filters=%d\n", filter_count);
  return 0;
}
