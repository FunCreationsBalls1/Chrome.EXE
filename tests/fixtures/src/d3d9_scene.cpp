// Direct3D 9 feature test: buffers, textures (incl. DXT1 + render targets), fixed-function lighting, shaders, scissor, alpha test.
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

static bool g_quit = false;
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CHAR: if (w == 'q') g_quit = true; return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

struct VtxLit { float x, y, z, nx, ny, nz; DWORD color; float u, v; };
#define FVF_LIT (D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_TEX1)
struct VtxCol { float x, y, z; DWORD color; };
#define FVF_COL (D3DFVF_XYZ | D3DFVF_DIFFUSE)
struct VtxTex { float x, y, z; DWORD color; float u, v; };
#define FVF_TEX (D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1)

static void ident(float *m) { memset(m, 0, 64); m[0] = m[5] = m[10] = m[15] = 1; }
static void persp(float *m, float fov, float aspect, float zn, float zf) {
  float ys = 1.0f / tanf(fov / 2), xs = ys / aspect;
  memset(m, 0, 64);
  m[0] = xs; m[5] = ys; m[10] = zf / (zf - zn); m[11] = 1; m[14] = -zn * zf / (zf - zn);
}

static IDirect3DDevice9 *dev;
static void viewportCell(int i, int cell = 160) {
  D3DVIEWPORT9 vp = { (DWORD)((i % 4) * cell), (DWORD)((i / 4) * cell), (DWORD)cell, (DWORD)cell, 0.0f, 1.0f };
  dev->SetViewport(&vp);
}
static void setOrtho() {
  float m[16]; ident(m);
  dev->SetTransform(D3DTS_WORLD, (D3DMATRIX *)m);
  dev->SetTransform(D3DTS_VIEW, (D3DMATRIX *)m);
  dev->SetTransform(D3DTS_PROJECTION, (D3DMATRIX *)m);
}

int main() {
  bool interactive = GetFileAttributesA("interactive.flag") != INVALID_FILE_ATTRIBUTES;
  WNDCLASSA wc = {0};
  wc.lpfnWndProc = WndProc; wc.hInstance = GetModuleHandle(NULL); wc.lpszClassName = "D3D9Scene"; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassA(&wc);
  RECT r = {0, 0, 640, 480};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  HWND hwnd = CreateWindowA("D3D9Scene", "d3d9 scene", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
  IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
  D3DPRESENT_PARAMETERS pp = {0};
  pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.BackBufferWidth = 640; pp.BackBufferHeight = 480;
  pp.EnableAutoDepthStencil = TRUE; pp.AutoDepthStencilFormat = D3DFMT_D24S8; pp.hDeviceWindow = hwnd; pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
  HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
  if (FAILED(hr)) { printf("CreateDevice failed %08lx\n", (unsigned long)hr); return 2; }

  // --- checker texture 8x8 (A8R8G8B8): red/white 1-texel squares ---
  IDirect3DTexture9 *checker = NULL;
  hr = dev->CreateTexture(8, 8, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &checker, NULL);
  printf("create checker: %08lx\n", (unsigned long)hr);
  {
    D3DLOCKED_RECT lr;
    checker->LockRect(0, &lr, NULL, 0);
    for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) ((DWORD *)((BYTE *)lr.pBits + y * lr.Pitch))[x] = ((x + y) & 1) ? 0xffffffff : 0xffff0000;
    checker->UnlockRect(0);
  }
  // --- alpha texture 2x2: left column transparent, right column opaque yellow ---
  IDirect3DTexture9 *alphaTex = NULL;
  dev->CreateTexture(2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &alphaTex, NULL);
  {
    D3DLOCKED_RECT lr; alphaTex->LockRect(0, &lr, NULL, 0);
    for (int y = 0; y < 2; y++) { DWORD *row = (DWORD *)((BYTE *)lr.pBits + y * lr.Pitch); row[0] = 0x00ff00ff; row[1] = 0xffffff00; }
    alphaTex->UnlockRect(0);
  }
  // --- DXT1 4x4: left half red, right half blue ---
  IDirect3DTexture9 *dxt = NULL;
  hr = dev->CreateTexture(4, 4, 1, 0, D3DFMT_DXT1, D3DPOOL_MANAGED, &dxt, NULL);
  printf("create dxt1: %08lx\n", (unsigned long)hr);
  if (SUCCEEDED(hr)) {
    D3DLOCKED_RECT lr; dxt->LockRect(0, &lr, NULL, 0);
    BYTE *b = (BYTE *)lr.pBits;
    b[0] = 0x00; b[1] = 0xf8; // color0 = 0xF800 (red)
    b[2] = 0x1f; b[3] = 0x00; // color1 = 0x001F (blue)
    // 2 bits per texel, row by row (LSB first): columns 0,1 -> index 0; columns 2,3 -> index 1  => byte = 01 01 00 00 = 0x50
    b[4] = b[5] = b[6] = b[7] = 0x50;
    dxt->UnlockRect(0);
  }
  // --- render target texture 64x64 ---
  IDirect3DTexture9 *rtTex = NULL;
  hr = dev->CreateTexture(64, 64, 1, D3DUSAGE_RENDERTARGET, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &rtTex, NULL);
  printf("create rt: %08lx\n", (unsigned long)hr);
  // --- vertex/index buffers: quad, drawn with DrawIndexedPrimitive ---
  IDirect3DVertexBuffer9 *vb = NULL; IDirect3DIndexBuffer9 *ib = NULL;
  dev->CreateVertexBuffer(4 * sizeof(VtxCol), D3DUSAGE_WRITEONLY, FVF_COL, D3DPOOL_MANAGED, &vb, NULL);
  dev->CreateIndexBuffer(6 * sizeof(WORD), D3DUSAGE_WRITEONLY, D3DFMT_INDEX16, D3DPOOL_MANAGED, &ib, NULL);
  {
    VtxCol *v; vb->Lock(0, 0, (void **)&v, 0);
    v[0] = { -0.8f, -0.8f, 0.5f, 0xffff0000 }; v[1] = { -0.8f, 0.8f, 0.5f, 0xff00ff00 }; v[2] = { 0.8f, 0.8f, 0.5f, 0xff0000ff }; v[3] = { 0.8f, -0.8f, 0.5f, 0xffffffff };
    vb->Unlock();
    WORD *i; ib->Lock(0, 0, (void **)&i, 0);
    i[0] = 0; i[1] = 1; i[2] = 2; i[3] = 0; i[4] = 2; i[5] = 3;
    ib->Unlock();
  }
  // --- shaders from files ---
  IDirect3DVertexShader9 *vsh = NULL; IDirect3DPixelShader9 *psh = NULL;
  {
    auto load = [](const char *name, void **data) -> bool {
      FILE *f = fopen(name, "rb"); if (!f) return false;
      fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
      *data = malloc(n); fread(*data, 1, n, f); fclose(f); return true;
    };
    void *vcode = NULL, *pcode = NULL;
    if (load("basic.vs.cso", &vcode)) printf("vs create: %08lx\n", (unsigned long)dev->CreateVertexShader((DWORD *)vcode, &vsh));
    if (load("basic.ps.cso", &pcode)) printf("ps create: %08lx\n", (unsigned long)dev->CreatePixelShader((DWORD *)pcode, &psh));
  }
  IDirect3DVertexDeclaration9 *decl = NULL;
  {
    D3DVERTEXELEMENT9 el[] = {
      { 0, 0, D3DDECLTYPE_FLOAT3, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0 },
      { 0, 12, D3DDECLTYPE_D3DCOLOR, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR, 0 },
      { 0, 16, D3DDECLTYPE_FLOAT2, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_TEXCOORD, 0 },
      D3DDECL_END()
    };
    dev->CreateVertexDeclaration(el, &decl);
  }

  int frames = 0;
  bool readbackDone = false;
  MSG msg;
  while (!g_quit) {
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }

    // ---- pass 1: render into the RT texture (solid magenta, with a green stripe via partial clear) ----
    IDirect3DSurface9 *rtSurf = NULL, *backBuf = NULL, *depth = NULL;
    rtTex->GetSurfaceLevel(0, &rtSurf);
    dev->GetRenderTarget(0, &backBuf);
    dev->GetDepthStencilSurface(&depth);
    dev->SetRenderTarget(0, rtSurf);
    dev->SetDepthStencilSurface(NULL);
    dev->Clear(0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(255, 0, 255), 1.0f, 0);
    D3DRECT stripe = { 0, 24, 64, 40 };
    dev->Clear(1, &stripe, D3DCLEAR_TARGET, D3DCOLOR_XRGB(0, 255, 0), 1.0f, 0);
    dev->SetRenderTarget(0, backBuf);
    dev->SetDepthStencilSurface(depth);
    D3DVIEWPORT9 full = { 0, 0, 640, 480, 0.0f, 1.0f };
    dev->SetViewport(&full);

    dev->Clear(0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, D3DCOLOR_XRGB(10, 20, 30), 1.0f, 0);
    dev->BeginScene();
    dev->SetRenderState(D3DRS_CULLMODE, D3DCULL_NONE);
    dev->SetRenderState(D3DRS_ZENABLE, FALSE);
    dev->SetRenderState(D3DRS_LIGHTING, FALSE);

    // cell 0: lit cube face (single quad facing the camera, normal -z) with a directional light
    {
      viewportCell(0);
      dev->SetRenderState(D3DRS_ZENABLE, TRUE);
      dev->SetRenderState(D3DRS_LIGHTING, TRUE);
      dev->SetRenderState(D3DRS_AMBIENT, 0);
      float w[16], v[16], p[16]; ident(w); ident(v); v[14] = 5.0f; persp(p, 1.0f, 1.0f, 1.0f, 20.0f);
      dev->SetTransform(D3DTS_WORLD, (D3DMATRIX *)w); dev->SetTransform(D3DTS_VIEW, (D3DMATRIX *)v); dev->SetTransform(D3DTS_PROJECTION, (D3DMATRIX *)p);
      D3DMATERIAL9 mat; memset(&mat, 0, sizeof(mat)); mat.Diffuse = { 1.0f, 0.5f, 0.25f, 1.0f }; mat.Ambient = { 0, 0, 0, 1 };
      dev->SetMaterial(&mat);
      D3DLIGHT9 light; memset(&light, 0, sizeof(light)); light.Type = D3DLIGHT_DIRECTIONAL; light.Diffuse = { 1, 1, 1, 1 }; light.Direction = { 0, 0, 1 };
      dev->SetLight(0, &light); dev->LightEnable(0, TRUE);
      dev->SetRenderState(D3DRS_COLORVERTEX, FALSE);
      VtxLit q[4] = {
        { -1, -1, 0, 0, 0, -1, 0xffffffff, 0, 1 }, { -1, 1, 0, 0, 0, -1, 0xffffffff, 0, 0 }, { 1, -1, 0, 0, 0, -1, 0xffffffff, 1, 1 }, { 1, 1, 0, 0, 0, -1, 0xffffffff, 1, 0 },
      };
      dev->SetFVF(FVF_LIT);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxLit));
      dev->SetRenderState(D3DRS_LIGHTING, FALSE);
      dev->SetRenderState(D3DRS_ZENABLE, FALSE);
      dev->SetRenderState(D3DRS_COLORVERTEX, TRUE);
    }
    // cell 1: FFP textured quad (checker, point filtering, 2x repeat)
    {
      viewportCell(1); setOrtho();
      dev->SetTexture(0, checker);
      dev->SetSamplerState(0, D3DSAMP_MAGFILTER, D3DTEXF_POINT); dev->SetSamplerState(0, D3DSAMP_MINFILTER, D3DTEXF_POINT); dev->SetSamplerState(0, D3DSAMP_ADDRESSU, D3DTADDRESS_WRAP);
      VtxTex q[4] = { { -0.8f, -0.8f, 0.5f, 0xffffffff, 0, 2 }, { -0.8f, 0.8f, 0.5f, 0xffffffff, 0, 0 }, { 0.8f, -0.8f, 0.5f, 0xffffffff, 2, 2 }, { 0.8f, 0.8f, 0.5f, 0xffffffff, 2, 0 } };
      dev->SetFVF(FVF_TEX);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxTex));
      dev->SetTexture(0, NULL);
    }
    // cell 2: programmable pipeline
    if (vsh && psh) {
      viewportCell(2);
      float wvp[16]; ident(wvp);
      dev->SetVertexShaderConstantF(0, wvp, 4);
      float tint[4] = { 0.5f, 1.0f, 0.25f, 1.0f };
      dev->SetVertexShaderConstantF(4, tint, 1); // vkd3d allocates `tint` right after the 4 matrix registers
      dev->SetTexture(0, checker);
      dev->SetVertexDeclaration(decl);
      dev->SetVertexShader(vsh); dev->SetPixelShader(psh);
      VtxTex q[4] = { { -0.8f, -0.8f, 0.5f, 0xffffffff, 0, 1 }, { -0.8f, 0.8f, 0.5f, 0xffffffff, 0, 0 }, { 0.8f, -0.8f, 0.5f, 0xffffffff, 1, 1 }, { 0.8f, 0.8f, 0.5f, 0xffffffff, 1, 0 } };
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxTex));
      dev->SetVertexShader(NULL); dev->SetPixelShader(NULL); dev->SetVertexDeclaration(NULL);
      dev->SetTexture(0, NULL);
    }
    // cell 3: render-target texture
    {
      viewportCell(3); setOrtho();
      dev->SetTexture(0, rtTex);
      dev->SetSamplerState(0, D3DSAMP_MAGFILTER, D3DTEXF_POINT); dev->SetSamplerState(0, D3DSAMP_MINFILTER, D3DTEXF_POINT);
      VtxTex q[4] = { { -0.8f, -0.8f, 0.5f, 0xffffffff, 0, 1 }, { -0.8f, 0.8f, 0.5f, 0xffffffff, 0, 0 }, { 0.8f, -0.8f, 0.5f, 0xffffffff, 1, 1 }, { 0.8f, 0.8f, 0.5f, 0xffffffff, 1, 0 } };
      dev->SetFVF(FVF_TEX);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxTex));
      dev->SetTexture(0, NULL);
    }
    // cell 4: DXT1 texture
    if (dxt) {
      viewportCell(4); setOrtho();
      dev->SetTexture(0, dxt);
      VtxTex q[4] = { { -0.8f, -0.8f, 0.5f, 0xffffffff, 0, 1 }, { -0.8f, 0.8f, 0.5f, 0xffffffff, 0, 0 }, { 0.8f, -0.8f, 0.5f, 0xffffffff, 1, 1 }, { 0.8f, 0.8f, 0.5f, 0xffffffff, 1, 0 } };
      dev->SetFVF(FVF_TEX);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxTex));
      dev->SetTexture(0, NULL);
    }
    // cell 5: vertex + index buffers
    {
      viewportCell(5); setOrtho();
      dev->SetStreamSource(0, vb, 0, sizeof(VtxCol));
      dev->SetIndices(ib);
      dev->SetFVF(FVF_COL);
      dev->DrawIndexedPrimitive(D3DPT_TRIANGLELIST, 0, 0, 4, 0, 2);
    }
    // cell 6: triangle fan hexagon
    {
      viewportCell(6); setOrtho();
      VtxCol hexv[8];
      hexv[0] = { 0, 0, 0.5f, 0xffffff00 };
      for (int i = 0; i < 7; i++) { float a = i * 3.14159265f * 2 / 6; hexv[1 + i] = { cosf(a) * 0.8f, sinf(a) * 0.8f, 0.5f, 0xffff00ff }; }
      dev->SetFVF(FVF_COL);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLEFAN, 6, hexv, sizeof(VtxCol));
    }
    // cell 7: scissor test: a large quad clipped to a 40x40 rect in the cell
    {
      viewportCell(7); setOrtho();
      RECT sc = { 3 * 160 + 60, 160 + 60, 3 * 160 + 100, 160 + 100 };
      dev->SetScissorRect(&sc);
      dev->SetRenderState(D3DRS_SCISSORTESTENABLE, TRUE);
      VtxCol q[4] = { { -1, -1, 0.5f, 0xff00ffff }, { -1, 1, 0.5f, 0xff00ffff }, { 1, -1, 0.5f, 0xff00ffff }, { 1, 1, 0.5f, 0xff00ffff } };
      dev->SetFVF(FVF_COL);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxCol));
      dev->SetRenderState(D3DRS_SCISSORTESTENABLE, FALSE);
    }
    // cell 8: alpha test on a 2x2 texture (left column transparent)
    {
      viewportCell(8); setOrtho();
      dev->SetTexture(0, alphaTex);
      dev->SetSamplerState(0, D3DSAMP_MAGFILTER, D3DTEXF_POINT); dev->SetSamplerState(0, D3DSAMP_MINFILTER, D3DTEXF_POINT);
      dev->SetRenderState(D3DRS_ALPHATESTENABLE, TRUE); dev->SetRenderState(D3DRS_ALPHAREF, 0x80); dev->SetRenderState(D3DRS_ALPHAFUNC, D3DCMP_GREATEREQUAL);
      dev->SetTextureStageState(0, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1); dev->SetTextureStageState(0, D3DTSS_ALPHAARG1, D3DTA_TEXTURE);
      VtxTex q[4] = { { -0.8f, -0.8f, 0.5f, 0xffffffff, 0, 1 }, { -0.8f, 0.8f, 0.5f, 0xffffffff, 0, 0 }, { 0.8f, -0.8f, 0.5f, 0xffffffff, 1, 1 }, { 0.8f, 0.8f, 0.5f, 0xffffffff, 1, 0 } };
      dev->SetFVF(FVF_TEX);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VtxTex));
      dev->SetRenderState(D3DRS_ALPHATESTENABLE, FALSE);
      dev->SetTexture(0, NULL);
    }
    // cell 9: depth test: far red quad drawn after a near green quad must stay hidden behind it
    {
      viewportCell(9); setOrtho();
      dev->SetRenderState(D3DRS_ZENABLE, TRUE);
      VtxCol near_[4] = { { -0.8f, -0.8f, 0.2f, 0xff00ff00 }, { -0.8f, 0.8f, 0.2f, 0xff00ff00 }, { 0.8f, -0.8f, 0.2f, 0xff00ff00 }, { 0.8f, 0.8f, 0.2f, 0xff00ff00 } };
      VtxCol far_[4] = { { -0.5f, -0.5f, 0.8f, 0xffff0000 }, { -0.5f, 0.5f, 0.8f, 0xffff0000 }, { 1.0f, -0.5f, 0.8f, 0xffff0000 }, { 1.0f, 0.5f, 0.8f, 0xffff0000 } };
      dev->SetFVF(FVF_COL);
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, near_, sizeof(VtxCol));
      dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, far_, sizeof(VtxCol));
      dev->SetRenderState(D3DRS_ZENABLE, FALSE);
    }
    dev->SetViewport(&full);
    dev->EndScene();

    // cell 10: StretchRect from the render-target texture into the back buffer
    {
      RECT dst = { 2 * 160 + 20, 2 * 160 + 20, 2 * 160 + 140, 2 * 160 + 140 };
      hr = dev->StretchRect(rtSurf, NULL, backBuf, &dst, D3DTEXF_POINT);
      if (!frames) printf("stretchrect: %08lx\n", (unsigned long)hr);
    }
    // read back the render target once
    if (!readbackDone) {
      IDirect3DSurface9 *sys = NULL;
      hr = dev->CreateOffscreenPlainSurface(64, 64, D3DFMT_A8R8G8B8, D3DPOOL_SYSTEMMEM, &sys, NULL);
      hr = dev->GetRenderTargetData(rtSurf, sys);
      D3DLOCKED_RECT lr;
      if (SUCCEEDED(sys->LockRect(&lr, NULL, D3DLOCK_READONLY))) {
        DWORD top = *(DWORD *)((BYTE *)lr.pBits + 2 * lr.Pitch + 4 * 8);
        DWORD mid = *(DWORD *)((BYTE *)lr.pBits + 30 * lr.Pitch + 4 * 8);
        printf("rt readback: top=%08lx stripe=%08lx\n", (unsigned long)top, (unsigned long)mid);
        sys->UnlockRect();
      } else printf("rt readback: lock failed\n");
      sys->Release();
      readbackDone = true;
    }
    rtSurf->Release(); backBuf->Release(); if (depth) depth->Release();
    hr = dev->Present(NULL, NULL, NULL, NULL);
    if (FAILED(hr)) { printf("Present failed %08lx\n", (unsigned long)hr); return 3; }
    frames++;
    if (!interactive && frames >= 20) break;
  }
  printf("frames=%d\n", frames);
  return 0;
}
