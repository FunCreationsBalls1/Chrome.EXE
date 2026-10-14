// HLSL compiler driver: fxc.exe jobs.txt; each line "src entry profile out [flags]". Uses d3dcompiler_47.dll (Wine, running as guest code).
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct ID3DBlob ID3DBlob;
typedef struct { HRESULT (WINAPI *QueryInterface)(void*, const GUID*, void**); ULONG (WINAPI *AddRef)(void*); ULONG (WINAPI *Release)(void*); void* (WINAPI *GetBufferPointer)(void*); SIZE_T (WINAPI *GetBufferSize)(void*); } BlobVtbl;
struct ID3DBlob { const BlobVtbl *v; };
typedef HRESULT (WINAPI *PFN_D3DCompile)(const void*, SIZE_T, const char*, const void*, void*, const char*, const char*, UINT, UINT, ID3DBlob**, ID3DBlob**);

static char *readfile(const char *path, long *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END); *n = ftell(f); fseek(f, 0, SEEK_SET);
  char *b = malloc(*n + 1);
  fread(b, 1, *n, f); fclose(f);
  b[*n] = 0;
  return b;
}

int main(int argc, char **argv) {
  if (argc < 2) { printf("usage: fxc jobs.txt   (lines: src entry profile out [flags])\n"); return 2; }
  HMODULE m = LoadLibraryA("d3dcompiler_47.dll");
  if (!m) { printf("cannot load d3dcompiler_47.dll (%lu)\n", GetLastError()); return 3; }
  PFN_D3DCompile comp = (PFN_D3DCompile)GetProcAddress(m, "D3DCompile");
  if (!comp) { printf("no D3DCompile\n"); return 4; }
  long jn;
  char *jobs = readfile(argv[1], &jn);
  if (!jobs) { printf("cannot open %s\n", argv[1]); return 5; }
  int failed = 0;
  char *save1 = NULL;
  for (char *line = strtok_s(jobs, "\r\n", &save1); line; line = strtok_s(NULL, "\r\n", &save1)) {
    char *tok[5] = {0};
    int nt = 0;
    char *save2 = NULL;
    for (char *t = strtok_s(line, " \t", &save2); t && nt < 5; t = strtok_s(NULL, " \t", &save2)) tok[nt++] = t;
    if (nt < 4) continue;
    long n;
    char *src = readfile(tok[0], &n);
    if (!src) { printf("cannot open %s\n", tok[0]); failed++; continue; }
    UINT flags = tok[4] ? (UINT)strtoul(tok[4], NULL, 0) : 0;
    ID3DBlob *code = NULL, *err = NULL;
    HRESULT hr = comp(src, n, tok[0], NULL, NULL, tok[1], tok[2], flags, 0, &code, &err);
    if (err) { fwrite(err->v->GetBufferPointer(err), 1, err->v->GetBufferSize(err), stdout); }
    if (FAILED(hr) || !code) { printf("%s: D3DCompile failed: %08lx\n", tok[0], (unsigned long)hr); failed++; continue; }
    FILE *o = fopen(tok[3], "wb");
    fwrite(code->v->GetBufferPointer(code), 1, code->v->GetBufferSize(code), o);
    fclose(o);
    printf("%s -> %s (%lu bytes)\n", tok[0], tok[3], (unsigned long)code->v->GetBufferSize(code));
    fflush(stdout);
    free(src);
  }
  return failed;
}
