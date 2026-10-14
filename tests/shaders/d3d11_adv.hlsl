// @compile VSFlat vs_5_0 d3d11_adv.vs
// @compile PSFlat ps_5_0 d3d11_adv.ps
// @compile VSFull vs_5_0 d3d11_adv.fvs
// @compile PSTex ps_5_0 d3d11_adv.tps
cbuffer C : register(b0) { float4 scaleOff; float4 tint; };
struct VSIn { float3 pos : POSITION; float4 col : COLOR; float2 off : OFFSET; };
struct VSOut { float4 pos : SV_Position; float4 col : COLOR; };
VSOut VSFlat(VSIn i) {
  VSOut o;
  o.pos = float4(i.pos.xy * scaleOff.xy + scaleOff.zw + i.off, i.pos.z, 1);
  o.col = i.col * tint;
  return o;
}
float4 PSFlat(VSOut i) : SV_Target { return i.col; }
struct FOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
FOut VSFull(uint id : SV_VertexID) {
  FOut o;
  float2 uv = float2((id << 1) & 2, id & 2);
  o.uv = uv;
  o.pos = float4(uv.x * 2 - 1, 1 - uv.y * 2, 0, 1);
  return o;
}
Texture2D t0 : register(t0);
SamplerState s0 : register(s0);
float4 PSTex(FOut i) : SV_Target { return t0.Sample(s0, i.uv); }
