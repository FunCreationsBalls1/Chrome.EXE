// @compile CSMain cs_5_0 d3d11_cs
Texture2D<uint> src : register(t0);
RWTexture2D<uint> dst : register(u0);
RWTexture2D<float4> img : register(u1);
cbuffer P : register(b0) { uint4 params; };
groupshared uint sh[64];
[numthreads(64, 1, 1)]
void CSMain(uint3 id : SV_DispatchThreadID, uint3 gtid : SV_GroupThreadID) {
  sh[gtid.x] = src.Load(int3(id.x, 0, 0)) * 2 + id.x;

  uint v = sh[gtid.x];
  dst[uint2(id.x, 0)] = v;
  img[uint2(id.x, params.x)] = float4(id.x / 64.0, 0, 1, 1);
}
