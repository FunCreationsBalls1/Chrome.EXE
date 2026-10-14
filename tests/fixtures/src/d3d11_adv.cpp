// Direct3D 11 feature collage. Each cell exercises one feature; the program reads the back buffer back through a staging
// texture (CopyResource + Map READ) and verifies cell pixels itself, printing PASS/FAIL lines.
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static bool g_quit = false;
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) { case WM_CHAR: if (w == 'q') g_quit = true; return 0; case WM_DESTROY: PostQuitMessage(0); return 0; }
  return DefWindowProcA(h, m, w, l);
}
struct Vertex { float pos[3]; unsigned char col[4]; float off[2]; };
struct Frame { float scaleOff[4]; float tint[4]; };
static unsigned char *readFile(const char *name, size_t *size) {
  FILE *f = fopen(name, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END); *size = ftell(f); fseek(f, 0, SEEK_SET);
  unsigned char *d = (unsigned char *)malloc(*size);
  fread(d, 1, *size, f); fclose(f);
  return d;
}
#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { printf("FAILED %s -> %08lx\n", #x, (unsigned long)hr_); fflush(stdout); return 2; } } while (0)

static ID3D11Device *dev; static ID3D11DeviceContext *ctx;
static ID3D11Buffer *cbuf;
static ID3D11SamplerState *sampPoint;

static void setFrame(float sx, float sy, float ox, float oy, float r = 1, float g = 1, float b = 1, float a = 1) {
  Frame f = { { sx, sy, ox, oy }, { r, g, b, a } };
  D3D11_MAPPED_SUBRESOURCE ms;
  ctx->Map(cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms);
  memcpy(ms.pData, &f, sizeof(f));
  ctx->Unmap(cbuf, 0);
}
static void cellViewport(int cx, int cy) { D3D11_VIEWPORT vp = { (float)(cx * 80), (float)(cy * 80), 80, 80, 0, 1 }; ctx->RSSetViewports(1, &vp); }

static int g_pass = 0, g_fail = 0;
static void expect(const char *name, const unsigned char *px, int r, int g, int b, int tol = 3) {
  bool ok = abs(px[0] - r) <= tol && abs(px[1] - g) <= tol && abs(px[2] - b) <= tol;
  if (ok) g_pass++; else g_fail++;
  printf("%s %s got=%d,%d,%d want=%d,%d,%d\n", ok ? "PASS" : "FAIL", name, px[0], px[1], px[2], r, g, b);
}

int main() {
  bool interactive = GetFileAttributesA("interactive.flag") != INVALID_FILE_ATTRIBUTES;
  WNDCLASSA wc = {0};
  wc.lpfnWndProc = WndProc; wc.hInstance = GetModuleHandle(NULL); wc.lpszClassName = "D3D11Adv"; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassA(&wc);
  RECT r = {0, 0, 320, 240};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  HWND hwnd = CreateWindowA("D3D11Adv", "d3d11 adv", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
  DXGI_SWAP_CHAIN_DESC sd = {};
  sd.BufferDesc.Width = 320; sd.BufferDesc.Height = 240; sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; sd.SampleDesc.Count = 1;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; sd.BufferCount = 1; sd.OutputWindow = hwnd; sd.Windowed = TRUE; sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  D3D_FEATURE_LEVEL lv = D3D_FEATURE_LEVEL_11_0, got;
  IDXGISwapChain *sc = NULL;
  CHECK(D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, &lv, 1, D3D11_SDK_VERSION, &sd, &sc, &dev, &got, &ctx));
  ID3D11Texture2D *back = NULL; ID3D11RenderTargetView *rtv = NULL;
  CHECK(sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void **)&back));
  CHECK(dev->CreateRenderTargetView(back, NULL, &rtv));

  size_t n1, n2, n3, n4;
  unsigned char *vsb = readFile("adv.vs.cso", &n1), *psb = readFile("adv.ps.cso", &n2), *fvsb = readFile("adv.fvs.cso", &n3), *tpsb = readFile("adv.tps.cso", &n4);
  size_t ncs; unsigned char *csb = readFile("adv.cs.cso", &ncs);
  if (!vsb || !psb || !fvsb || !tpsb || !csb) { printf("missing shader files\n"); return 3; }
  ID3D11VertexShader *vs, *fvs; ID3D11PixelShader *ps, *tps; ID3D11ComputeShader *cs;
  CHECK(dev->CreateVertexShader(vsb, n1, NULL, &vs)); CHECK(dev->CreatePixelShader(psb, n2, NULL, &ps));
  CHECK(dev->CreateVertexShader(fvsb, n3, NULL, &fvs)); CHECK(dev->CreatePixelShader(tpsb, n4, NULL, &tps));
  CHECK(dev->CreateComputeShader(csb, ncs, NULL, &cs));
  D3D11_INPUT_ELEMENT_DESC el[] = {
    { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    { "COLOR", 0, DXGI_FORMAT_R8G8B8A8_UNORM, 0, 12, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    { "OFFSET", 0, DXGI_FORMAT_R32G32_FLOAT, 1, 0, D3D11_INPUT_PER_INSTANCE_DATA, 1 },
  };
  ID3D11InputLayout *layout; CHECK(dev->CreateInputLayout(el, 3, vsb, n1, &layout));

  // geometry: unit quad (z = 0.5 default) in vertex slot 0; instance data in slot 1
  auto quad = [](float z, unsigned char r, unsigned char g, unsigned char b, Vertex *v) {
    float p[4][2] = { {-1, -1}, {-1, 1}, {1, 1}, {1, -1} };
    for (int i = 0; i < 4; i++) { v[i].pos[0] = p[i][0]; v[i].pos[1] = p[i][1]; v[i].pos[2] = z; v[i].col[0] = r; v[i].col[1] = g; v[i].col[2] = b; v[i].col[3] = 255; v[i].off[0] = v[i].off[1] = 0; }
  };
  unsigned short idx[6] = { 0, 1, 2, 0, 2, 3 };
  float zeroInst[2] = { 0, 0 };
  float insts[6] = { -0.6f, 0, 0, 0, 0.6f, 0 };
  auto mkbuf = [&](const void *data, UINT size, UINT bind, ID3D11Buffer **out) {
    D3D11_BUFFER_DESC bd = {}; bd.ByteWidth = size; bd.Usage = D3D11_USAGE_DEFAULT; bd.BindFlags = bind;
    D3D11_SUBRESOURCE_DATA sr = { data, 0, 0 };
    return dev->CreateBuffer(&bd, &sr, out);
  };
  Vertex q[4]; ID3D11Buffer *vbWhite, *vbGreen, *vbRed, *vbOrange, *vbMagenta, *ib, *instZero, *inst3;
  quad(0.5f, 255, 255, 255, q); CHECK(mkbuf(q, sizeof(q), D3D11_BIND_VERTEX_BUFFER, &vbWhite));
  quad(0.2f, 0, 255, 0, q); CHECK(mkbuf(q, sizeof(q), D3D11_BIND_VERTEX_BUFFER, &vbGreen));
  quad(0.6f, 255, 0, 0, q); CHECK(mkbuf(q, sizeof(q), D3D11_BIND_VERTEX_BUFFER, &vbRed));
  quad(0.5f, 255, 128, 0, q); CHECK(mkbuf(q, sizeof(q), D3D11_BIND_VERTEX_BUFFER, &vbOrange));
  quad(0.5f, 255, 0, 255, q); CHECK(mkbuf(q, sizeof(q), D3D11_BIND_VERTEX_BUFFER, &vbMagenta));
  CHECK(mkbuf(idx, sizeof(idx), D3D11_BIND_INDEX_BUFFER, &ib));
  CHECK(mkbuf(zeroInst, sizeof(zeroInst), D3D11_BIND_VERTEX_BUFFER, &instZero));
  CHECK(mkbuf(insts, sizeof(insts), D3D11_BIND_VERTEX_BUFFER, &inst3));
  D3D11_BUFFER_DESC cbd = {}; cbd.ByteWidth = sizeof(Frame); cbd.Usage = D3D11_USAGE_DYNAMIC; cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER; cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  CHECK(dev->CreateBuffer(&cbd, NULL, &cbuf));
  D3D11_SAMPLER_DESC smp = {}; smp.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT; smp.AddressU = smp.AddressV = smp.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP; smp.ComparisonFunc = D3D11_COMPARISON_NEVER; smp.MaxLOD = D3D11_FLOAT32_MAX;
  CHECK(dev->CreateSamplerState(&smp, &sampPoint));

  // states
  D3D11_RASTERIZER_DESC rd = {}; rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE;
  ID3D11RasterizerState *rs; CHECK(dev->CreateRasterizerState(&rd, &rs));
  D3D11_DEPTH_STENCIL_DESC d0 = {}; ID3D11DepthStencilState *dsOff; CHECK(dev->CreateDepthStencilState(&d0, &dsOff));
  D3D11_DEPTH_STENCIL_DESC d1 = {}; d1.DepthEnable = TRUE; d1.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL; d1.DepthFunc = D3D11_COMPARISON_LESS;
  ID3D11DepthStencilState *dsLess; CHECK(dev->CreateDepthStencilState(&d1, &dsLess));
  D3D11_DEPTH_STENCIL_DESC d2 = {}; d2.StencilEnable = TRUE; d2.StencilReadMask = 0xff; d2.StencilWriteMask = 0xff;
  d2.FrontFace.StencilFunc = d2.BackFace.StencilFunc = D3D11_COMPARISON_ALWAYS; d2.FrontFace.StencilPassOp = d2.BackFace.StencilPassOp = D3D11_STENCIL_OP_REPLACE;
  d2.FrontFace.StencilFailOp = d2.BackFace.StencilFailOp = D3D11_STENCIL_OP_KEEP; d2.FrontFace.StencilDepthFailOp = d2.BackFace.StencilDepthFailOp = D3D11_STENCIL_OP_KEEP;
  ID3D11DepthStencilState *dsStWrite; CHECK(dev->CreateDepthStencilState(&d2, &dsStWrite));
  D3D11_DEPTH_STENCIL_DESC d3 = d2; d3.FrontFace.StencilFunc = d3.BackFace.StencilFunc = D3D11_COMPARISON_EQUAL; d3.FrontFace.StencilPassOp = d3.BackFace.StencilPassOp = D3D11_STENCIL_OP_KEEP;
  ID3D11DepthStencilState *dsStTest; CHECK(dev->CreateDepthStencilState(&d3, &dsStTest));
  D3D11_BLEND_DESC b0 = {}; b0.RenderTarget[0].RenderTargetWriteMask = 0xf;
  ID3D11BlendState *bsOpaque; CHECK(dev->CreateBlendState(&b0, &bsOpaque));
  D3D11_BLEND_DESC b1 = {}; b1.RenderTarget[0].RenderTargetWriteMask = 0;
  ID3D11BlendState *bsNoColor; CHECK(dev->CreateBlendState(&b1, &bsNoColor));
  D3D11_BLEND_DESC b2 = {}; b2.RenderTarget[0].BlendEnable = TRUE; b2.RenderTarget[0].SrcBlend = D3D11_BLEND_BLEND_FACTOR; b2.RenderTarget[0].DestBlend = D3D11_BLEND_ZERO; b2.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
  b2.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE; b2.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO; b2.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD; b2.RenderTarget[0].RenderTargetWriteMask = 0xf;
  ID3D11BlendState *bsFactor; CHECK(dev->CreateBlendState(&b2, &bsFactor));

  // depth/stencil target
  D3D11_TEXTURE2D_DESC dtd = {}; dtd.Width = 320; dtd.Height = 240; dtd.MipLevels = 1; dtd.ArraySize = 1; dtd.Format = DXGI_FORMAT_D24_UNORM_S8_UINT; dtd.SampleDesc.Count = 1; dtd.Usage = D3D11_USAGE_DEFAULT; dtd.BindFlags = D3D11_BIND_DEPTH_STENCIL;
  ID3D11Texture2D *dtex; CHECK(dev->CreateTexture2D(&dtd, NULL, &dtex));
  ID3D11DepthStencilView *dsv; CHECK(dev->CreateDepthStencilView(dtex, NULL, &dsv));

  // sampled-texture helper
  auto mkTex = [&](UINT w, UINT h, UINT mips, UINT bind, UINT misc, D3D11_USAGE usage, UINT cpu, const void *data, UINT pitch, ID3D11Texture2D **out, DXGI_FORMAT fmt = DXGI_FORMAT_R8G8B8A8_UNORM) {
    D3D11_TEXTURE2D_DESC td = {}; td.Width = w; td.Height = h; td.MipLevels = mips; td.ArraySize = 1; td.Format = fmt; td.SampleDesc.Count = 1; td.Usage = usage; td.BindFlags = bind; td.CPUAccessFlags = cpu; td.MiscFlags = misc;
    D3D11_SUBRESOURCE_DATA sr = { data, pitch, 0 };
    return dev->CreateTexture2D(&td, data ? &sr : NULL, out);
  };
  auto mkSrv = [&](ID3D11Resource *res, ID3D11ShaderResourceView **out) { return dev->CreateShaderResourceView(res, NULL, out); };

  // (0,0) render target: 32x32
  ID3D11Texture2D *rtt; ID3D11RenderTargetView *rttRtv; ID3D11ShaderResourceView *rttSrv;
  CHECK(mkTex(32, 32, 1, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DEFAULT, 0, NULL, 0, &rtt));
  CHECK(dev->CreateRenderTargetView(rtt, NULL, &rttRtv)); CHECK(mkSrv(rtt, &rttSrv));
  // (3,0) mip generation
  ID3D11Texture2D *mipTex; ID3D11ShaderResourceView *mipSrvTop, *mipSrvAll;
  CHECK(mkTex(8, 8, 0, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_USAGE_DEFAULT, 0, NULL, 0, &mipTex));
  CHECK(mkSrv(mipTex, &mipSrvAll));
  D3D11_SHADER_RESOURCE_VIEW_DESC svd = {}; svd.Format = DXGI_FORMAT_R8G8B8A8_UNORM; svd.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; svd.Texture2D.MostDetailedMip = 3; svd.Texture2D.MipLevels = 1;
  CHECK(dev->CreateShaderResourceView(mipTex, &svd, &mipSrvTop));
  // (0,1) dynamic texture
  ID3D11Texture2D *dynTex; ID3D11ShaderResourceView *dynSrv;
  CHECK(mkTex(4, 4, 1, D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DYNAMIC, D3D11_CPU_ACCESS_WRITE, NULL, 0, &dynTex)); CHECK(mkSrv(dynTex, &dynSrv));
  // (0,2) MSAA
  UINT q4 = 0; CHECK(dev->CheckMultisampleQualityLevels(DXGI_FORMAT_R8G8B8A8_UNORM, 4, &q4));
  printf("msaa4 quality levels: %u\n", q4);
  D3D11_TEXTURE2D_DESC md = {}; md.Width = 32; md.Height = 32; md.MipLevels = 1; md.ArraySize = 1; md.Format = DXGI_FORMAT_R8G8B8A8_UNORM; md.SampleDesc.Count = 4; md.Usage = D3D11_USAGE_DEFAULT; md.BindFlags = D3D11_BIND_RENDER_TARGET;
  ID3D11Texture2D *msTex; ID3D11RenderTargetView *msRtv; CHECK(dev->CreateTexture2D(&md, NULL, &msTex)); CHECK(dev->CreateRenderTargetView(msTex, NULL, &msRtv));
  ID3D11Texture2D *resTex; ID3D11ShaderResourceView *resSrv; CHECK(mkTex(32, 32, 1, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET, 0, D3D11_USAGE_DEFAULT, 0, NULL, 0, &resTex)); CHECK(mkSrv(resTex, &resSrv));
  // (1,2) compute: input texture (R32_UINT), output R32_UINT and RGBA8 images
  unsigned int cin[64]; for (int i = 0; i < 64; i++) cin[i] = i * 10;
  ID3D11Texture2D *csIn, *csOut, *csImg, *csStage;
  CHECK(mkTex(64, 1, 1, D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DEFAULT, 0, cin, 256, &csIn, DXGI_FORMAT_R32_UINT));
  CHECK(mkTex(64, 1, 1, D3D11_BIND_UNORDERED_ACCESS, 0, D3D11_USAGE_DEFAULT, 0, NULL, 0, &csOut, DXGI_FORMAT_R32_UINT));
  CHECK(mkTex(64, 4, 1, D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DEFAULT, 0, NULL, 0, &csImg));
  CHECK(mkTex(64, 1, 1, 0, 0, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ, NULL, 0, &csStage, DXGI_FORMAT_R32_UINT));
  ID3D11ShaderResourceView *csInSrv, *csImgSrv; ID3D11UnorderedAccessView *csOutUav, *csImgUav;
  CHECK(mkSrv(csIn, &csInSrv)); CHECK(mkSrv(csImg, &csImgSrv));
  CHECK(dev->CreateUnorderedAccessView(csOut, NULL, &csOutUav)); CHECK(dev->CreateUnorderedAccessView(csImg, NULL, &csImgUav));
  // (3,2) region copy
  unsigned int srcData[16]; for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) srcData[y * 4 + x] = 0xff000000u | ((x * 60) << 0) | ((y * 60) << 8) | (200u << 16);
  ID3D11Texture2D *cpSrc, *cpDst; ID3D11ShaderResourceView *cpDstSrv;
  CHECK(mkTex(4, 4, 1, D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DEFAULT, 0, srcData, 16, &cpSrc));
  CHECK(mkTex(4, 4, 1, D3D11_BIND_SHADER_RESOURCE, 0, D3D11_USAGE_DEFAULT, 0, NULL, 0, &cpDst)); CHECK(mkSrv(cpDst, &cpDstSrv));
  // staging copy of the back buffer
  ID3D11Texture2D *stage; CHECK(mkTex(320, 240, 1, 0, 0, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ, NULL, 0, &stage));
  printf("setup done\n");

  UINT stride = sizeof(Vertex), off0 = 0, istride = 8;
  float clear[4] = { 10 / 255.0f, 20 / 255.0f, 30 / 255.0f, 1.0f };
  float bf0[4] = { 1, 1, 1, 1 };
  int frames = 0;
  MSG msg;
  while (!g_quit) {
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    ctx->ClearState();
    ctx->OMSetRenderTargets(1, &rtv, dsv);
    ctx->ClearRenderTargetView(rtv, clear);
    ctx->ClearDepthStencilView(dsv, D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);
    ctx->RSSetState(rs);
    ctx->IASetInputLayout(layout);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetConstantBuffers(0, 1, &cbuf);
    ctx->PSSetSamplers(0, 1, &sampPoint);
    ctx->IASetIndexBuffer(ib, DXGI_FORMAT_R16_UINT, 0);
    ctx->OMSetBlendState(bsOpaque, bf0, 0xffffffff);
    ctx->OMSetDepthStencilState(dsOff, 0);

    auto drawFlat = [&](ID3D11Buffer *vb, ID3D11Buffer *inst, float sx, float sy, float ox, float oy, int instances = 1) {
      ID3D11Buffer *vbs[2] = { vb, inst }; UINT strides[2] = { stride, istride }, offs[2] = { 0, 0 };
      ctx->IASetVertexBuffers(0, 2, vbs, strides, offs);
      ctx->VSSetShader(vs, NULL, 0); ctx->PSSetShader(ps, NULL, 0);
      setFrame(sx, sy, ox, oy);
      ctx->DrawIndexedInstanced(6, instances, 0, 0, 0);
    };
    auto drawFull = [&](ID3D11ShaderResourceView *srv) {
      ctx->IASetInputLayout(NULL);
      ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      ctx->VSSetShader(fvs, NULL, 0); ctx->PSSetShader(tps, NULL, 0);
      ctx->PSSetShaderResources(0, 1, &srv);
      ctx->Draw(3, 0);
      ctx->IASetInputLayout(layout);
    };

    // (0,0) render to texture then sample it
    {
      ctx->OMSetRenderTargets(1, &rttRtv, NULL);
      float blue[4] = { 0, 0, 1, 1 }; ctx->ClearRenderTargetView(rttRtv, blue);
      D3D11_VIEWPORT vp = { 0, 0, 32, 32, 0, 1 }; ctx->RSSetViewports(1, &vp);
      drawFlat(vbOrange, instZero, 0.5f, 0.5f, 0, 0);
      ctx->OMSetRenderTargets(1, &rtv, dsv);
      cellViewport(0, 0);
      drawFull(rttSrv);
    }
    // (1,0) depth test: green near (z=0.2) first, then bigger red far (z=0.6)
    {
      ctx->OMSetDepthStencilState(dsLess, 0);
      cellViewport(1, 0);
      drawFlat(vbGreen, instZero, 0.4f, 0.4f, 0, 0);
      drawFlat(vbRed, instZero, 0.9f, 0.9f, 0, 0);
      ctx->OMSetDepthStencilState(dsOff, 0);
    }
    // (2,0) instancing
    {
      cellViewport(2, 0);
      drawFlat(vbWhite, inst3, 0.15f, 0.15f, 0, 0, 3);
    }
    // (3,0) GenerateMips on an 8x8 black/white checker rendered into level 0
    {
      unsigned int chk[64]; for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) chk[y * 8 + x] = ((x + y) & 1) ? 0xffffffffu : 0xff000000u;
      ctx->UpdateSubresource(mipTex, 0, NULL, chk, 32, 0);
      ctx->GenerateMips(mipSrvAll);
      cellViewport(3, 0);
      drawFull(mipSrvTop);
    }
    // (0,1) dynamic texture + partial UpdateSubresource
    {
      D3D11_MAPPED_SUBRESOURCE ms;
      ctx->Map(dynTex, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms);
      for (int y = 0; y < 4; y++) { unsigned char *row = (unsigned char *)ms.pData + y * ms.RowPitch; for (int x = 0; x < 4; x++) { row[x * 4] = x * 60; row[x * 4 + 1] = y * 60; row[x * 4 + 2] = 100; row[x * 4 + 3] = 255; } }
      ctx->Unmap(dynTex, 0);
      cellViewport(0, 1);
      drawFull(dynSrv);
    }
    // (1,1) stencil: write a small square (colour writes off), then draw a big square only where stencil == 1
    {
      cellViewport(1, 1);
      ctx->OMSetBlendState(bsNoColor, bf0, 0xffffffff);
      ctx->OMSetDepthStencilState(dsStWrite, 1);
      drawFlat(vbWhite, instZero, 0.4f, 0.4f, 0, 0);
      ctx->OMSetBlendState(bsOpaque, bf0, 0xffffffff);
      ctx->OMSetDepthStencilState(dsStTest, 1);
      drawFlat(vbMagenta, instZero, 0.95f, 0.95f, 0, 0);
      ctx->OMSetDepthStencilState(dsOff, 0);
    }
    // (2,1) blend factor
    {
      cellViewport(2, 1);
      float f[4] = { 0.25f, 0.5f, 0.75f, 1.0f };
      ctx->OMSetBlendState(bsFactor, f, 0xffffffff);
      drawFlat(vbWhite, instZero, 1.0f, 1.0f, 0, 0);
      ctx->OMSetBlendState(bsOpaque, bf0, 0xffffffff);
    }
    // (3,1) deferred context
    {
      ID3D11DeviceContext *dc = NULL; ID3D11CommandList *cl = NULL;
      if (SUCCEEDED(dev->CreateDeferredContext(0, &dc))) {
        dc->OMSetRenderTargets(1, &rtv, dsv);
        D3D11_VIEWPORT vp = { 240, 80, 80, 80, 0, 1 }; dc->RSSetViewports(1, &vp);
        dc->RSSetState(rs); dc->IASetInputLayout(layout); dc->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        dc->OMSetBlendState(bsOpaque, bf0, 0xffffffff); dc->OMSetDepthStencilState(dsOff, 0);
        ID3D11Buffer *vbs[2] = { vbRed, instZero }; UINT strides[2] = { stride, istride }, offs[2] = { 0, 0 };
        dc->IASetVertexBuffers(0, 2, vbs, strides, offs); dc->IASetIndexBuffer(ib, DXGI_FORMAT_R16_UINT, 0);
        dc->VSSetShader(vs, NULL, 0); dc->PSSetShader(ps, NULL, 0); dc->VSSetConstantBuffers(0, 1, &cbuf);
        dc->DrawIndexed(6, 0, 0);
        dc->FinishCommandList(FALSE, &cl);
        setFrame(0.8f, 0.8f, 0, 0);
        ctx->ExecuteCommandList(cl, TRUE);
        cl->Release(); dc->Release();
      }
    }
    // (0,2) MSAA triangle resolved
    {
      ctx->OMSetRenderTargets(1, &msRtv, NULL);
      float blue[4] = { 0, 0, 1, 1 }; ctx->ClearRenderTargetView(msRtv, blue);
      D3D11_VIEWPORT vp = { 0, 0, 32, 32, 0, 1 }; ctx->RSSetViewports(1, &vp);
      drawFlat(vbOrange, instZero, 0.5f, 0.5f, 0, 0);
      ctx->ResolveSubresource(resTex, 0, msTex, 0, DXGI_FORMAT_R8G8B8A8_UNORM);
      ctx->OMSetRenderTargets(1, &rtv, dsv);
      cellViewport(0, 2);
      drawFull(resSrv);
    }
    // (1,2) compute
    if (frames == 0) {
      ctx->CSSetShader(cs, NULL, 0);
      ctx->CSSetShaderResources(0, 1, &csInSrv);
      ID3D11UnorderedAccessView *uavs[2] = { csOutUav, csImgUav };
      ctx->CSSetUnorderedAccessViews(0, 2, uavs, NULL);
      struct { UINT v[4]; } pr = { { 0, 0, 0, 0 } };
      D3D11_BUFFER_DESC pd = {}; pd.ByteWidth = 16; pd.Usage = D3D11_USAGE_IMMUTABLE; pd.BindFlags = D3D11_BIND_CONSTANT_BUFFER; D3D11_SUBRESOURCE_DATA psr = { &pr, 0, 0 };
      ID3D11Buffer *pb;
      CHECK(dev->CreateBuffer(&pd, &psr, &pb));
      ctx->CSSetConstantBuffers(0, 1, &pb);
      ctx->Dispatch(1, 1, 1);
      ID3D11UnorderedAccessView *nulls[2] = { NULL, NULL };
      ctx->CSSetUnorderedAccessViews(0, 2, nulls, NULL);
      ctx->CopyResource(csStage, csOut);
      D3D11_MAPPED_SUBRESOURCE ms;
      CHECK(ctx->Map(csStage, 0, D3D11_MAP_READ, 0, &ms));
      unsigned int *res = (unsigned int *)ms.pData;
      bool ok = true;
      for (int i = 0; i < 64; i++) if (res[i] != (unsigned)(i * 10 * 2 + i)) { ok = false; printf("cs mismatch at %d: %u\n", i, res[i]); break; }
      ctx->Unmap(csStage, 0);
      printf("%s compute readback\n", ok ? "PASS" : "FAIL"); if (ok) g_pass++; else g_fail++;
    }
    {
      cellViewport(1, 2);
      drawFull(csImgSrv);
    }
    // (3,2) CopySubresourceRegion
    {
      ctx->CopySubresourceRegion(cpDst, 0, 0, 0, 0, cpSrc, 0, NULL);
      D3D11_BOX box = { 1, 1, 0, 3, 3, 1 };
      ctx->CopySubresourceRegion(cpDst, 0, 2, 2, 0, cpSrc, 0, &box);
      cellViewport(3, 2);
      drawFull(cpDstSrv);
    }
    // read the frame back and check cells (once, at frame 3, after GPU work settled)
    if (frames == 3) {
      ctx->CopyResource(stage, back);
      D3D11_MAPPED_SUBRESOURCE ms;
      CHECK(ctx->Map(stage, 0, D3D11_MAP_READ, 0, &ms));
      auto at = [&](int x, int y) { return (const unsigned char *)ms.pData + y * ms.RowPitch + x * 4; };
      expect("rtt centre", at(40, 40), 255, 128, 0);
      expect("rtt corner", at(1, 1), 0, 0, 255);
      expect("depth near wins", at(120, 40), 0, 255, 0);
      expect("depth far visible", at(80 + 70, 5 + 70 - 5), 255, 0, 0);
      expect("instance 0", at(160 + 40 - 24, 40), 255, 255, 255);
      expect("instance 1", at(160 + 40, 40), 255, 255, 255);
      expect("instance 2", at(160 + 40 + 24, 40), 255, 255, 255);
      expect("instance gap", at(160 + 40 - 12, 40), 10, 20, 30);
      expect("generate mips top level", at(280, 40), 128, 128, 128, 4);
      expect("dynamic texel (1,2)", at(30, 80 + 50), 60, 120, 100);
      expect("dynamic texel (3,0)", at(70, 80 + 10), 180, 0, 100);
      expect("stencil inside", at(80 + 40, 80 + 40), 255, 0, 255);
      expect("stencil outside", at(80 + 5, 80 + 5), 10, 20, 30);
      expect("blend factor", at(160 + 40, 80 + 40), 64, 128, 191, 4);
      expect("deferred", at(240 + 40, 80 + 40), 255, 0, 0);
      expect("msaa centre", at(40, 160 + 40), 255, 128, 0);
      expect("msaa corner", at(1, 160 + 1), 0, 0, 255);
      expect("compute image", at(80 + 40, 160 + 1), 128, 0, 255, 5);
      expect("copy region texel (0,0)", at(240 + 10, 160 + 10), 0, 0, 200);
      expect("copy region texel (3,3)", at(240 + 70, 160 + 70), 120, 120, 200);
      ctx->Unmap(stage, 0);
      printf("summary pass=%d fail=%d\n", g_pass, g_fail);
      fflush(stdout);
    }
    HRESULT hr = sc->Present(0, 0);
    if (FAILED(hr)) { printf("Present failed %08lx\n", (unsigned long)hr); return 4; }
    frames++;
    if (!interactive && frames >= 12) break;
  }
  printf("frames=%d\n", frames);
  return g_fail ? 1 : 0;
}
