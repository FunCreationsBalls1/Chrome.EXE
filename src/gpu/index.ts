// Graphics subsystem entry: COM runtime and the Direct3D front-ends.
import type { Process } from "../win32/process.ts";
import { ComRuntime } from "./com.ts";
import { installD3D9 } from "./d3d9.ts";
import { installD3D11 } from "./d3d11.ts";
import { installDxgi } from "./dxgi.ts";

export function installGraphics(p: Process) {
  p.com = new ComRuntime(p);
  installD3D9(p);
  installDxgi(p);
  installD3D11(p);
}
export { Gpu } from "./gpu.ts";
