// Direct3D 11 smoke test: device + swap chain, shaders from disk, vertex/index/constant buffers, textures, blending, draws, present.
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static bool g_quit = false;
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CHAR: if (w == 'q') g_quit = true; return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

struct Vertex { float pos[3]; unsigned char col[4]; float uv[2]; };
struct Frame { float wvp[16]; float tint[4]; };

static unsigned char *readFile(const char *name, size_t *size) {
  FILE *f = fopen(name, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END); *size = ftell(f); fseek(f, 0, SEEK_SET);
  unsigned char *d = (unsigned char *)malloc(*size);
  fread(d, 1, *size, f); fclose(f);
  return d;
}
#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { printf("FAILED %s -> %08lx\n", #x, (unsigned long)hr_); return 2; } } while (0)

int main() {
  bool interactive = GetFileAttributesA("interactive.flag") != INVALID_FILE_ATTRIBUTES;
  WNDCLASSA wc = {0};
  wc.lpfnWndProc = WndProc; wc.hInstance = GetModuleHandle(NULL); wc.lpszClassName = "D3D11Basic"; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassA(&wc);
  RECT r = {0, 0, 320, 240};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  HWND hwnd = CreateWindowA("D3D11Basic", "d3d11 basic", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);

  DXGI_SWAP_CHAIN_DESC sd = {};
  sd.BufferDesc.Width = 320; sd.BufferDesc.Height = 240; sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  sd.BufferDesc.RefreshRate.Numerator = 60; sd.BufferDesc.RefreshRate.Denominator = 1;
  sd.SampleDesc.Count = 1; sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; sd.BufferCount = 1; sd.OutputWindow = hwnd; sd.Windowed = TRUE; sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1 };
  D3D_FEATURE_LEVEL got = (D3D_FEATURE_LEVEL)0;
  IDXGISwapChain *sc = NULL; ID3D11Device *dev = NULL; ID3D11DeviceContext *ctx = NULL;
  CHECK(D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, levels, 3, D3D11_SDK_VERSION, &sd, &sc, &dev, &got, &ctx));
  printf("feature level %04x\n", (unsigned)got);

  IDXGIDevice *dxgiDev = NULL; IDXGIAdapter *adapter = NULL;
  CHECK(dev->QueryInterface(__uuidof(IDXGIDevice), (void **)&dxgiDev));
  CHECK(dxgiDev->GetAdapter(&adapter));
  DXGI_ADAPTER_DESC ad; CHECK(adapter->GetDesc(&ad));
  printf("adapter: %ls vendor=%04x\n", ad.Description, ad.VendorId);
  adapter->Release(); dxgiDev->Release();

  ID3D11Texture2D *back = NULL;
  CHECK(sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void **)&back));
  D3D11_TEXTURE2D_DESC bd; back->GetDesc(&bd);
  printf("backbuffer %ux%u fmt=%u\n", bd.Width, bd.Height, (unsigned)bd.Format);
  ID3D11RenderTargetView *rtv = NULL;
  CHECK(dev->CreateRenderTargetView(back, NULL, &rtv));
  back->Release();

  size_t vsz = 0, psz = 0;
  unsigned char *vsb = readFile("basic.vs.cso", &vsz), *psb = readFile("basic.ps.cso", &psz);
  if (!vsb || !psb) { printf("missing shader files\n"); return 3; }
  ID3D11VertexShader *vs = NULL; ID3D11PixelShader *ps = NULL;
  CHECK(dev->CreateVertexShader(vsb, vsz, NULL, &vs));
  CHECK(dev->CreatePixelShader(psb, psz, NULL, &ps));
  D3D11_INPUT_ELEMENT_DESC el[] = {
    { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    { "COLOR", 0, DXGI_FORMAT_R8G8B8A8_UNORM, 0, 12, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 16, D3D11_INPUT_PER_VERTEX_DATA, 0 },
  };
  ID3D11InputLayout *layout = NULL;
  CHECK(dev->CreateInputLayout(el, 3, vsb, vsz, &layout));
  printf("shaders and layout created\n");

  Vertex quad[4] = {
    { {-0.5f, -0.5f, 0}, {255, 255, 255, 255}, {0, 1} },
    { {-0.5f,  0.5f, 0}, {255, 255, 255, 255}, {0, 0} },
    { { 0.5f,  0.5f, 0}, {255, 255, 255, 255}, {1, 0} },
    { { 0.5f, -0.5f, 0}, {255, 255, 255, 255}, {1, 1} },
  };
  unsigned short idx[6] = { 0, 1, 2, 0, 2, 3 };
  Vertex tri[3] = {
    { {-0.9f, -0.9f, 0}, {255, 0, 0, 255}, {0.5f, 0.5f} },
    { {-0.6f, -0.2f, 0}, {0, 255, 0, 255}, {0.5f, 0.5f} },
    { {-0.3f, -0.9f, 0}, {0, 0, 255, 128}, {0.5f, 0.5f} },
  };
  D3D11_BUFFER_DESC bdsc = {}; D3D11_SUBRESOURCE_DATA sr = {};
  ID3D11Buffer *vb = NULL, *vb2 = NULL, *ib = NULL, *cb = NULL;
  bdsc.ByteWidth = sizeof(quad); bdsc.Usage = D3D11_USAGE_IMMUTABLE; bdsc.BindFlags = D3D11_BIND_VERTEX_BUFFER; sr.pSysMem = quad;
  CHECK(dev->CreateBuffer(&bdsc, &sr, &vb));
  bdsc.ByteWidth = sizeof(tri); sr.pSysMem = tri;
  CHECK(dev->CreateBuffer(&bdsc, &sr, &vb2));
  bdsc.ByteWidth = sizeof(idx); bdsc.BindFlags = D3D11_BIND_INDEX_BUFFER; sr.pSysMem = idx;
  CHECK(dev->CreateBuffer(&bdsc, &sr, &ib));
  bdsc.ByteWidth = sizeof(Frame); bdsc.Usage = D3D11_USAGE_DYNAMIC; bdsc.BindFlags = D3D11_BIND_CONSTANT_BUFFER; bdsc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  CHECK(dev->CreateBuffer(&bdsc, NULL, &cb));

  // 4x4 red/white checker and a 1x1 white texture
  unsigned int checker[16];
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) checker[y * 4 + x] = ((x + y) & 1) ? 0xffffffffu : 0xff0000ffu; // ABGR: red / white
  unsigned int white = 0xffffffffu;
  D3D11_TEXTURE2D_DESC td = {};
  td.Width = 4; td.Height = 4; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R8G8B8A8_UNORM; td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_IMMUTABLE; td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  D3D11_SUBRESOURCE_DATA tsr = {}; tsr.pSysMem = checker; tsr.SysMemPitch = 16;
  ID3D11Texture2D *tex = NULL, *tex1 = NULL;
  CHECK(dev->CreateTexture2D(&td, &tsr, &tex));
  td.Width = td.Height = 1; tsr.pSysMem = &white; tsr.SysMemPitch = 4;
  CHECK(dev->CreateTexture2D(&td, &tsr, &tex1));
  ID3D11ShaderResourceView *srv = NULL, *srv1 = NULL;
  CHECK(dev->CreateShaderResourceView(tex, NULL, &srv));
  CHECK(dev->CreateShaderResourceView(tex1, NULL, &srv1));
  D3D11_SAMPLER_DESC smp = {};
  smp.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT; smp.AddressU = smp.AddressV = smp.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP; smp.ComparisonFunc = D3D11_COMPARISON_NEVER; smp.MaxLOD = D3D11_FLOAT32_MAX;
  ID3D11SamplerState *ss = NULL;
  CHECK(dev->CreateSamplerState(&smp, &ss));

  D3D11_BLEND_DESC blend = {};
  blend.RenderTarget[0].BlendEnable = TRUE; blend.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA; blend.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA; blend.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
  blend.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE; blend.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO; blend.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD; blend.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  ID3D11BlendState *bs = NULL; CHECK(dev->CreateBlendState(&blend, &bs));
  D3D11_RASTERIZER_DESC rd = {}; rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE;
  ID3D11RasterizerState *rs = NULL; CHECK(dev->CreateRasterizerState(&rd, &rs));
  D3D11_DEPTH_STENCIL_DESC dsd = {}; ID3D11DepthStencilState *dss = NULL; CHECK(dev->CreateDepthStencilState(&dsd, &dss));
  printf("resources created\n");

  D3D11_VIEWPORT vp = { 0, 0, 320, 240, 0, 1 };
  int frames = 0;
  MSG msg;
  while (!g_quit) {
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    D3D11_MAPPED_SUBRESOURCE ms;
    CHECK(ctx->Map(cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms));
    Frame *f = (Frame *)ms.pData;
    memset(f, 0, sizeof(*f));
    f->wvp[0] = f->wvp[5] = f->wvp[10] = f->wvp[15] = 1;
    f->tint[0] = 0.5f; f->tint[1] = 1.0f; f->tint[2] = 0.5f; f->tint[3] = 1.0f;
    ctx->Unmap(cb, 0);

    float clear[4] = { 10 / 255.0f, 20 / 255.0f, 30 / 255.0f, 1.0f };
    ctx->OMSetRenderTargets(1, &rtv, NULL);
    ctx->ClearRenderTargetView(rtv, clear);
    ctx->RSSetViewports(1, &vp);
    ctx->RSSetState(rs);
    ctx->OMSetDepthStencilState(dss, 0);
    ctx->IASetInputLayout(layout);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs, NULL, 0);
    ctx->PSSetShader(ps, NULL, 0);
    ctx->VSSetConstantBuffers(0, 1, &cb);
    ctx->PSSetSamplers(0, 1, &ss);
    UINT stride = sizeof(Vertex), off = 0;
    // opaque textured quad
    ctx->OMSetBlendState(NULL, NULL, 0xffffffff);
    ctx->PSSetShaderResources(0, 1, &srv);
    ctx->IASetVertexBuffers(0, 1, &vb, &stride, &off);
    ctx->IASetIndexBuffer(ib, DXGI_FORMAT_R16_UINT, 0);
    ctx->DrawIndexed(6, 0, 0);
    // alpha-blended vertex-coloured triangle
    float bf[4] = { 1, 1, 1, 1 };
    ctx->OMSetBlendState(bs, bf, 0xffffffff);
    ctx->PSSetShaderResources(0, 1, &srv1);
    ctx->IASetVertexBuffers(0, 1, &vb2, &stride, &off);
    ctx->Draw(3, 0);
    HRESULT hr = sc->Present(0, 0);
    if (FAILED(hr)) { printf("Present failed %08lx\n", (unsigned long)hr); return 4; }
    frames++;
    if (!interactive && frames >= 30) break;
  }
  printf("frames=%d\n", frames);
  ctx->ClearState();
  rtv->Release(); sc->Release(); ctx->Release(); dev->Release();
  return 0;
}
