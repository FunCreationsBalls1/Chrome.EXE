// @compile PSMain ps_5_0 d3d11_flow.ps
// @compile VSMain vs_5_0 d3d11_flow.vs
cbuffer C : register(b0) { float4 a; float4 b; int4 ia; uint4 ua; float4 arr[6]; };
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; nointerpolation uint id : BLENDINDICES; noperspective float w : TEXCOORD1; };
VSOut VSMain(float3 p : POSITION, float2 uv : TEXCOORD0, uint vid : SV_VertexID) {
  VSOut o;
  o.pos = float4(p, 1);
  o.uv = uv; o.id = vid; o.w = p.x;
  return o;
}
float4 PSMain(VSOut i, bool front : SV_IsFrontFace) : SV_Target {
  float4 r = 0;
  [loop] for (int k = 0; k < 6; k++) { r += arr[k] * k; if (r.x > 1000) break; }
  for (uint j = 0; j < ua.x; j++) { if (j == 3) continue; r.w += j; }
  int ii = 0;
  while (ii < ia.y) { r.z += ii; ii++; }
  switch (ia.x) { case 0: r.y += 1; break; case 1: case 2: r.y += 2; break; default: r.y += 3; break; }
  if (front) r *= 2; else discard;
  r += arr[i.id & 3] + i.w;
  clip(r.w - 0.001);
  return r;
}
