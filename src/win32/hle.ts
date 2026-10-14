// High-level emulation registry: Win32 modules implemented in JS, exposed to guest code as thunk addresses.
import type { Machine } from "../jit/machine.ts";
import { Cpu } from "./cpu.ts";
import type { GuestMem } from "./mem.ts";
import type { Vm } from "./vm.ts";
import { MEM_IMAGE } from "./vm.ts";
import { buildSyntheticDll } from "./synthdll.ts";
import type { SynthExport } from "./synthdll.ts";

export type HleFn = (c: Cpu) => number | bigint | boolean | void;

export class HleModule {
  readonly hle: Hle;
  readonly name: string; // canonical lowercase, e.g. "kernel32.dll"
  /** lowercase export name -> thunk address */
  readonly exports = new Map<string, number>();
  readonly names = new Map<string, string>(); // lowercase -> original case
  readonly ordinals = new Map<number, number>();
  base = 0;
  size = 0;
  constructor(hle: Hle, name: string) {
    this.hle = hle;
    this.name = name;
  }
  /** register an exported function; returns its thunk address */
  fn(name: string, f: HleFn, ordinal?: number): number {
    const hle = this.hle;
    const full = this.name + "!" + name;
    const addr = hle.m.registerThunk(() => {
      hle.calls++;
      if (hle.trace) hle.trace(full, hle.cpu);
      let r: number | bigint | boolean | void;
      hle.thunkStack.push(addr);
      try {
        r = f(hle.cpu);
      } catch (e: any) {
        if (e && e.isControlFlow) throw e;
        if (e instanceof Error && !e.message.startsWith("[" + full)) e.message = `[${full}] ${e.message}`;
        throw e;
      } finally {
        hle.thunkStack.pop();
      }
      if (r !== undefined) hle.cpu.ret(r);
      return 0;
    });
    this.exports.set(name.toLowerCase(), addr);
    this.names.set(name.toLowerCase(), name);
    if (ordinal !== undefined) this.ordinals.set(ordinal, addr);
    return addr;
  }
  /** alias an existing export under another name */
  alias(newName: string, existing: string) {
    const a = this.exports.get(existing.toLowerCase());
    if (a === undefined) throw new Error(`alias target ${existing} missing in ${this.name}`);
    this.exports.set(newName.toLowerCase(), a);
    this.names.set(newName.toLowerCase(), newName);
  }
  /** export a data value (e.g. a global variable) located at `addr` */
  data(name: string, addr: number) {
    this.exports.set(name.toLowerCase(), addr);
    this.names.set(name.toLowerCase(), name);
  }
  lookup(name: string): number | undefined {
    return this.exports.get(name.toLowerCase());
  }
}

export class Hle {
  readonly m: Machine;
  readonly cpu: Cpu;
  readonly modules = new Map<string, HleModule>();
  /** calls dispatched (for statistics) */
  calls = 0;
  trace: ((name: string, c: Cpu) => void) | null = null;
  /** dll name (lowercase) -> real module name for API sets / aliases */
  aliases = new Map<string, string>();
  /** invoked when a guest imports something we do not implement */
  onMissing: ((dll: string, name: string) => void) | null = null;
  private stubs = new Map<string, number>();
  /** addresses of the thunks currently executing (innermost last) */
  thunkStack: number[] = [];
  currentThunk(): number {
    return this.thunkStack[this.thunkStack.length - 1];
  }
  constructor(m: Machine) {
    this.m = m;
    this.cpu = new Cpu(m);
  }

  module(name: string): HleModule {
    name = name.toLowerCase();
    let mod = this.modules.get(name);
    if (!mod) this.modules.set(name, (mod = new HleModule(this, name)));
    return mod;
  }
  has(name: string): boolean {
    return this.modules.has(this.canonical(name));
  }

  /** normalise a DLL name: lowercase, default extension, API-set / alias mapping */
  canonical(name: string): string {
    let n = name.toLowerCase().replace(/^.*[\\/]/, "");
    if (!/\.[a-z0-9]{1,4}$/.test(n)) n += ".dll";
    const a = this.aliases.get(n);
    if (a) return a;
    if (/^api-ms-win-(core|eventing|security|service|devices|shcore|ro)-/.test(n) || /^ext-ms-win-/.test(n)) return "kernel32.dll";
    if (/^api-ms-win-crt-/.test(n)) return "ucrtbase.dll";
    return n;
  }

  /** a stub that logs and returns 0 for unimplemented functions */
  missingStub(dll: string, name: string): number {
    const key = dll + "!" + name;
    let a = this.stubs.get(key);
    if (a === undefined) {
      a = this.m.registerThunk(() => {
        if (this.onMissing) this.onMissing(dll, name);
        this.cpu.ret(0);
        return 0;
      });
      this.stubs.set(key, a);
    }
    return a;
  }

  /** Allocate guest PE images for HLE modules (so manual export walking works). Call once after registration. */
  materialize(vm: Vm, mem: GuestMem) {
    for (const mod of this.modules.values()) {
      if (mod.base) continue;
      const list: SynthExport[] = [];
      let ord = 1;
      const used = new Set<number>();
      for (const [ordn, addr] of mod.ordinals) { used.add(ordn); list.push({ name: null, ordinal: ordn, target: addr }); void addr; }
      for (const [lname, addr] of mod.exports) {
        while (used.has(ord)) ord++;
        list.push({ name: mod.names.get(lname) ?? lname, ordinal: ord++, target: addr });
      }
      // ordinal-only entries shadowing named exports are fine; the named ones get fresh ordinals
      const probe = buildSyntheticDll(mod.name, 0, list);
      const base = vm.alloc(probe.length, { type: MEM_IMAGE, commit: true, tag: "hle:" + mod.name });
      const img = buildSyntheticDll(mod.name, base, list);
      mem.write(base, img);
      mod.base = base;
      mod.size = img.length;
    }
  }
}
