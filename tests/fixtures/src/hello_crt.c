#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

int main(int argc, char **argv) {
  printf("argc=%d argv0=%s\n", argc, argv[0] ? "yes" : "no");
  int v[] = {5, 3, 9, 1, 7};
  qsort(v, 5, sizeof v[0], cmp);
  for (int i = 0; i < 5; i++) printf("%d ", v[i]);
  printf("\n");
  printf("%.3f %5.1f %e %g\n", sqrt(2.0), 3.14159, 12345.678, 0.0001);
  char *s = malloc(64);
  strcpy(s, "heap string");
  printf("%s (%zu) %08x %lld\n", s, strlen(s), 0xbeef, -123456789012LL);
  free(s);
  fprintf(stderr, "to stderr\n");
  return 7;
}
