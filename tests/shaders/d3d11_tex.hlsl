// @compile PSMain ps_5_0 d3d11_tex.ps
Texture2D<float4> t0 : register(t0);
Texture2D<uint4> tu : register(t1);
TextureCube<float4> tc : register(t2);
Texture2DArray<float4> ta : register(t3);
Texture3D<float4> t3d : register(t4);
Texture2D<float> depthTex : register(t5);
SamplerState s0 : register(s0);
SamplerComparisonState scmp : register(s1);
float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD0, float3 n : NORMAL) : SV_Target {
  float4 r = t0.Sample(s0, uv) + t0.SampleLevel(s0, uv, 2) + t0.SampleBias(s0, uv, 1) + t0.SampleGrad(s0, uv, ddx(uv), ddy(uv));
  r += t0.Load(int3(uv * 4, 0)) + t0.Sample(s0, uv, int2(1, 1));
  r += (float4)tu.Load(int3(1, 1, 0));
  r += tc.Sample(s0, normalize(n));
  r += ta.Sample(s0, float3(uv, 1));
  r += t3d.Sample(s0, float3(uv, 0.5));
  r.x += depthTex.SampleCmp(scmp, uv, 0.5) + depthTex.SampleCmpLevelZero(scmp, uv, 0.25);
  r += t0.Gather(s0, uv);
  uint w, h, lv; t0.GetDimensions(0, w, h, lv);
  r.x += w + h + lv;
  return r;
}
