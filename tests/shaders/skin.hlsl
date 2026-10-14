// @compile vsmain vs_3_0 skin.vs
float4x3 bones[24] : register(c20);
float4x4 vp : register(c0);
struct VSIn { float4 pos : POSITION; float4 w : BLENDWEIGHT; int4 idx : BLENDINDICES; float3 n : NORMAL; float2 uv : TEXCOORD0; };
struct VSOut { float4 pos : POSITION; float3 n : TEXCOORD1; float2 uv : TEXCOORD0; };
VSOut vsmain(VSIn i) {
  VSOut o;
  float3 p = 0, n = 0;
  int4 ix = i.idx;
  float wsum = 0;
  for (int k = 0; k < 3; k++) {
    float w = i.w[k];
    p += mul(i.pos, bones[ix[k]]) * w;
    n += mul(i.n, (float3x3)bones[ix[k]]) * w;
    wsum += w;
  }
  p += mul(i.pos, bones[ix[3]]) * (1 - wsum);
  o.pos = mul(float4(p, 1), vp);
  o.n = normalize(n);
  o.uv = i.uv;
  return o;
}
