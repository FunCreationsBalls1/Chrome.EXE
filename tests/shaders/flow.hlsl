// @compile psmain ps_3_0 flow.ps
// @compile vsmain vs_3_0 flow.vs
float4 params : register(c0);
float4 arr[8] : register(c1);
sampler2D tex0 : register(s0);
sampler2D tex1 : register(s1);
samplerCUBE cube0 : register(s2);

struct VSOut { float4 pos : POSITION; float2 uv : TEXCOORD0; float3 n : TEXCOORD1; float4 col : COLOR0; };

VSOut vsmain(float4 pos : POSITION, float2 uv : TEXCOORD0, float3 n : NORMAL, float4 col : COLOR0) {
  VSOut o;
  o.pos = pos;
  o.uv = uv;
  o.n = n;
  o.col = col;
  return o;
}

float4 psmain(VSOut i) : COLOR0 {
  float4 acc = 0;
  [loop] for (int k = 0; k < 4; k++) {
    acc += arr[k] * (k + 1);
  }
  if (i.uv.x > 0.5) {
    acc += tex2D(tex0, i.uv);
  } else {
    acc -= tex2Dlod(tex1, float4(i.uv, 0, 1));
  }
  acc.rgb += texCUBE(cube0, normalize(i.n)).rgb;
  acc *= saturate(dot(normalize(i.n), float3(0, 1, 0)));
  acc.a = pow(abs(params.x), params.y) + lerp(params.z, params.w, i.col.a);
  clip(acc.a - 0.01);
  return acc;
}
