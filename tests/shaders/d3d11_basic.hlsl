// @compile VSMain vs_5_0 d3d11_basic.vs
// @compile PSMain ps_5_0 d3d11_basic.ps
// @compile VSMain vs_4_0 d3d11_basic.vs40
// @compile PSMain ps_4_0 d3d11_basic.ps40
cbuffer Frame : register(b0) { float4x4 wvp; float4 tint; };
Texture2D tex0 : register(t0);
SamplerState samp0 : register(s0);

struct VSIn { float3 pos : POSITION; float4 col : COLOR; float2 uv : TEXCOORD0; };
struct VSOut { float4 pos : SV_Position; float4 col : COLOR; float2 uv : TEXCOORD0; };

VSOut VSMain(VSIn i) {
  VSOut o;
  o.pos = mul(float4(i.pos, 1), wvp);
  o.col = i.col * tint;
  o.uv = i.uv;
  return o;
}
float4 PSMain(VSOut i) : SV_Target0 {
  return tex0.Sample(samp0, i.uv) * i.col;
}
