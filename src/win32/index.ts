// Assemble a Process with all HLE modules installed.
import { Process } from "./process.ts";
import type { ProcessOptions } from "./process.ts";
import { installKernel32Core } from "./k32-core.ts";
import { installKernel32Memory } from "./k32-mem.ts";
import { installKernel32File } from "./k32-file.ts";
import { installKernel32Sync } from "./k32-sync.ts";
import { installKernel32Strings } from "./k32-str.ts";
import { installScheduler } from "./sched.ts";
import { installNtdll } from "./ntdll.ts";
import { installKernel32Seh } from "./k32-seh.ts";

export type InstallFn = (p: Process) => void;
const extraInstallers: InstallFn[] = [];
/** Register an additional HLE subsystem (user32, d3d9, ...). Called for every new Process. */
export function registerHleInstaller(fn: InstallFn) {
  if (!extraInstallers.includes(fn)) extraInstallers.push(fn);
}

export function createProcess(opts: ProcessOptions = {}): Process {
  const p = new Process(opts);
  installKernel32Core(p);
  installKernel32Memory(p);
  installKernel32File(p);
  installKernel32Sync(p);
  installKernel32Strings(p);
  installScheduler(p);
  installKernel32Seh(p);
  installNtdll(p);
  for (const fn of extraInstallers) fn(p);
  p.registerHleModules();
  return p;
}

export { Process };
export type { ProcessOptions };
