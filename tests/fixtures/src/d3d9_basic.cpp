// Direct3D 9 smoke test: device creation, clear, fixed-function colored geometry, present.
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>

struct VertexRHW { float x, y, z, rhw; DWORD color; };
#define FVF_RHW (D3DFVF_XYZRHW | D3DFVF_DIFFUSE)

static bool g_quit = false;
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CHAR: if (w == 'q') g_quit = true; return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

int main() {
  bool interactive = GetFileAttributesA("interactive.flag") != INVALID_FILE_ATTRIBUTES;
  WNDCLASSA wc = {0};
  wc.lpfnWndProc = WndProc; wc.hInstance = GetModuleHandle(NULL); wc.lpszClassName = "D3D9Basic"; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassA(&wc);
  RECT r = {0, 0, 320, 240};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  HWND hwnd = CreateWindowA("D3D9Basic", "d3d9 basic", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
  IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
  if (!d3d) { printf("Direct3DCreate9 failed\n"); return 1; }
  D3DADAPTER_IDENTIFIER9 id;
  d3d->GetAdapterIdentifier(0, 0, &id);
  printf("adapter: %s\n", id.Description);
  D3DCAPS9 caps;
  d3d->GetDeviceCaps(0, D3DDEVTYPE_HAL, &caps);
  printf("caps: vs=%08lx ps=%08lx maxtex=%lu\n", caps.VertexShaderVersion, caps.PixelShaderVersion, caps.MaxTextureWidth);
  D3DPRESENT_PARAMETERS pp = {0};
  pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.BackBufferFormat = D3DFMT_X8R8G8B8;
  pp.EnableAutoDepthStencil = TRUE; pp.AutoDepthStencilFormat = D3DFMT_D24S8; pp.hDeviceWindow = hwnd;
  pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
  IDirect3DDevice9 *dev = NULL;
  HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
  if (FAILED(hr)) { printf("CreateDevice failed %08lx\n", (unsigned long)hr); return 2; }
  printf("device ok bb=%ux%u\n", pp.BackBufferWidth, pp.BackBufferHeight);
  int frames = 0;
  MSG msg;
  while (!g_quit) {
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    dev->Clear(0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, D3DCOLOR_XRGB(10, 20, 30), 1.0f, 0);
    dev->BeginScene();
    dev->SetRenderState(D3DRS_LIGHTING, FALSE);
    dev->SetRenderState(D3DRS_ZENABLE, FALSE);
    dev->SetRenderState(D3DRS_CULLMODE, D3DCULL_NONE);
    dev->SetFVF(FVF_RHW);
    // solid green rectangle
    VertexRHW quad[4] = {
      {10, 10, 0.5f, 1, 0xff00ff00}, {110, 10, 0.5f, 1, 0xff00ff00}, {10, 60, 0.5f, 1, 0xff00ff00}, {110, 60, 0.5f, 1, 0xff00ff00},
    };
    dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, quad, sizeof(VertexRHW));
    // gouraud triangle
    VertexRHW tri[3] = { {40, 220, 0.5f, 1, 0xffff0000}, {160, 90, 0.5f, 1, 0xff00ff00}, {280, 220, 0.5f, 1, 0xff0000ff} };
    dev->DrawPrimitiveUP(D3DPT_TRIANGLELIST, 1, tri, sizeof(VertexRHW));
    // alpha blended white rectangle over the green one
    dev->SetRenderState(D3DRS_ALPHABLENDENABLE, TRUE);
    dev->SetRenderState(D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    dev->SetRenderState(D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
    VertexRHW blend[4] = { {60, 30, 0.5f, 1, 0x80ffffff}, {160, 30, 0.5f, 1, 0x80ffffff}, {60, 80, 0.5f, 1, 0x80ffffff}, {160, 80, 0.5f, 1, 0x80ffffff} };
    dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, blend, sizeof(VertexRHW));
    dev->SetRenderState(D3DRS_ALPHABLENDENABLE, FALSE);
    dev->EndScene();
    hr = dev->Present(NULL, NULL, NULL, NULL);
    if (FAILED(hr)) { printf("Present failed %08lx\n", (unsigned long)hr); return 3; }
    frames++;
    if (!interactive && frames >= 30) break;
  }
  printf("frames=%d\n", frames);
  dev->Release();
  d3d->Release();
  return 0;
}
