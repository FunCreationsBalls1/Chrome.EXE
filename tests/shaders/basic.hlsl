// @compile vsmain vs_3_0 basic.vs
// @compile psmain ps_3_0 basic.ps
// @compile vsmain vs_2_0 basic.vs20
// @compile psmain ps_2_0 basic.ps20
float4x4 wvp : register(c0);
float4 tint : register(c4);
sampler2D tex0 : register(s0);

struct VSIn { float4 pos : POSITION; float4 col : COLOR0; float2 uv : TEXCOORD0; };
struct VSOut { float4 pos : POSITION; float4 col : COLOR0; float2 uv : TEXCOORD0; };

VSOut vsmain(VSIn i) {
  VSOut o;
  o.pos = mul(i.pos, wvp);
  o.col = i.col * tint;
  o.uv = i.uv;
  return o;
}

struct PSIn { float4 col : COLOR0; float2 uv : TEXCOORD0; };
float4 psmain(PSIn i) : COLOR0 {
  return tex2D(tex0, i.uv) * i.col;
}
