// @compile PSMain ps_5_0 d3d11_int.ps
cbuffer C : register(b0) { float4 a; float4 b; int4 ia; uint4 ua; float4 arr[6]; };
float4 PSMain(float4 pos : SV_Position) : SV_Target {
  int4 q = ia * ia + (ia >> 2) - (ia << 1) + (ia & 7) + (ia | 8) + (ia ^ 3) + ~ia + min(ia, 3) + max(ia, -3) + abs(ia) + ia / 3 + ia % 5;
  uint4 u = ua * ua + (ua >> 3) + (ua << 2) + ua / 3 + ua % 5 + min(ua, 7u) + max(ua, 2u);
  float4 r = q + (float4)u + (float4)(ia > 2) + (float4)(ua < 3u) + (float4)(ia == 1);
  r += asfloat(ia) + asfloat(ua);
  return r;
}
