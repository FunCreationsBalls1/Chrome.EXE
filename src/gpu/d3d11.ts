// d3d11.dll entry points.
import type { Cpu } from "../win32/cpu.ts";
import type { Process } from "../win32/process.ts";
import { E, FEATURE_LEVEL } from "./d3d11-consts.ts";
import { Device11 } from "./d3d11-dev.ts";
import { DxgiFactory } from "./dxgi.ts";

const SUPPORTED = [FEATURE_LEVEL.L11_0, FEATURE_LEVEL.L10_1, FEATURE_LEVEL.L10_0, FEATURE_LEVEL.L9_3, FEATURE_LEVEL.L9_2, FEATURE_LEVEL.L9_1];

function chooseLevel(p: Process, list: number, count: number): number {
  if (!list || !count) return FEATURE_LEVEL.L11_0;
  for (let i = 0; i < count; i++) {
    const l = p.mem.r32(list + i * 4);
    if (SUPPORTED.includes(l as any)) return l;
  }
  return 0;
}

export function installD3D11(p: Process) {
  const k = p.hle.module("d3d11.dll");
  const createDevice = (c: Cpu, swapDesc: number, outSwap: number, outDev: number, outLevel: number, outCtx: number): number => {
    const gpu = p.ext.gpu;
    if (!gpu) { p.log("[d3d11] WebGPU is not available: cannot create a device"); return E.DXGI_ERROR_UNSUPPORTED; }
    const flags = c.arg(3);
    const level = chooseLevel(p, c.arg(4), c.arg(5));
    if (!level) return E.INVALIDARG;
    // the adapter: either supplied by the application or a fresh default one
    let factory: DxgiFactory | null = null;
    const given = c.arg(0) ? p.com.objectAt(c.arg(0)) : undefined;
    if (given && (given as any).factory) factory = (given as any).factory as DxgiFactory;
    if (!factory) {
      factory = new DxgiFactory();
      p.com.create(factory, ["IDXGIFactory4", "IDXGIFactory3", "IDXGIFactory2", "IDXGIFactory1", "IDXGIFactory", "IDXGIObject"]);
      factory.p = p;
    }
    const dev = new Device11();
    p.com.create(dev, ["ID3D11Device", "ID3D11Device1", "IDXGIDevice1", "IDXGIDevice2", "IDXGIDevice", "IDXGIObject", "ID3D11Multithread"]);
    dev.init(p, gpu, flags);
    dev.featureLevel = level as typeof dev.featureLevel;
    dev.adapterObj = factory.getAdapter();
    dev.p.ext.debugShaders = p.ext.debugShaders;
    if (outSwap) {
      const r = factory.createFromDesc(dev, swapDesc, outSwap);
      if (r) { dev.refs = 1; dev.Release(null as any); return r; }
    }
    if (outDev) p.mem.wptr(outDev, dev.ptrFor("ID3D11Device"));
    else if (!outSwap) { dev.refs = 1; dev.Release(null as any); }
    if (outLevel) p.mem.w32(outLevel, level);
    if (outCtx) { p.mem.wptr(outCtx, dev.immediate.ptrFor("ID3D11DeviceContext")); dev.immediate.refs++; }
    return 0;
  };
  k.fn("D3D11CreateDevice", (c) => createDevice(c, 0, 0, c.arg(7), c.arg(8), c.arg(9)));
  k.fn("D3D11CreateDeviceAndSwapChain", (c) => createDevice(c, c.arg(7), c.arg(8), c.arg(9), c.arg(10), c.arg(11)));
  k.fn("D3D11CoreCreateDevice", () => E.DXGI_ERROR_UNSUPPORTED);
  k.fn("D3D11On12CreateDevice", () => E.DXGI_ERROR_UNSUPPORTED);
  k.fn("D3D11CreateDeviceForD3D12", () => E.DXGI_ERROR_UNSUPPORTED);
  k.fn("D3DKMTCloseAdapter", () => 0);
  k.fn("D3DKMTDestroyAllocation", () => 0);
  k.fn("D3DKMTDestroyContext", () => 0);
  k.fn("D3DKMTDestroyDevice", () => 0);
  k.fn("D3DKMTDestroySynchronizationObject", () => 0);
  k.fn("D3DKMTQueryAdapterInfo", () => E.FAIL);
  k.fn("D3DKMTSetDisplayPrivateDriverFormat", () => E.FAIL);
  k.fn("D3DKMTSignalSynchronizationObject", () => E.FAIL);
  k.fn("D3DKMTUnlock", () => E.FAIL);
  k.fn("D3DKMTWaitForSynchronizationObject", () => E.FAIL);
  k.fn("EnableFeatureLevelUpgrade", () => 1);
  k.fn("D3DPerformance_BeginEvent", () => 0);
  k.fn("D3DPerformance_EndEvent", () => 0);
  k.fn("D3DPerformance_GetStatus", () => 0);
  k.fn("D3DPerformance_SetMarker", () => 0);
}
