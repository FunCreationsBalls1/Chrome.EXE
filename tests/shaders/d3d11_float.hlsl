// @compile PSMain ps_5_0 d3d11_float.ps
cbuffer C : register(b0) { float4 a; float4 b; int4 ia; uint4 ua; float4 arr[6]; };
float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  float4 r = a * b + a / (b + 1) - sqrt(abs(a)) * rsqrt(abs(b) + 1);
  r += sin(a) + cos(b) + exp2(a.x) + log2(abs(a.y) + 1) + frac(a * 3.5) + floor(b * 2) + ceil(a) + round(b) + trunc(a);
  r += saturate(a) + min(a, b) + max(a, b) + clamp(a, 0, 1) + lerp(a, b, 0.25) + step(a, b) + sign(a);
  r.x += dot(a.xy, b.xy) + dot(a.xyz, b.xyz) + dot(a, b) + length(a) + distance(a.xyz, b.xyz);
  r.xyz += normalize(a.xyz) + cross(a.xyz, b.xyz) + reflect(a.xyz, normalize(b.xyz));
  r += pow(abs(a), b) + (a > b ? a : b);
  return r;
}
