// COM object infrastructure: guest-visible objects whose vtables are filled with HLE thunks that dispatch to JS objects.
//
// A COM interface pointer is the address of a 16-byte guest block: [vtbl:8][object id:4][pad:4]. The vtable for an interface
// (one per interface name, shared by all objects) is an array of thunk addresses. Each thunk looks the JS object up by id
// and calls the method of the same name on it, passing the Win64 CPU view (argument 0 is `this`).
import type { Process } from "../win32/process.ts";
import type { Cpu } from "../win32/cpu.ts";
import { COM } from "./gen/com-tables.ts";

export const S_OK = 0, S_FALSE = 1, E_NOTIMPL = 0x80004001 | 0, E_NOINTERFACE = 0x80004002 | 0, E_POINTER = 0x80004003 | 0, E_FAIL = 0x80004005 | 0, E_INVALIDARG = 0x80070057 | 0, E_OUTOFMEMORY = 0x8007000e | 0;

export function guidToString(mem: Process["mem"], a: number): string {
  const h = (n: number, w: number) => n.toString(16).padStart(w, "0");
  let s = h(mem.r32(a), 8) + "-" + h(mem.r16(a + 4), 4) + "-" + h(mem.r16(a + 6), 4) + "-" + h(mem.r8(a + 8), 2) + h(mem.r8(a + 9), 2) + "-";
  for (let i = 10; i < 16; i++) s += h(mem.r8(a + i), 2);
  return s;
}
export function writeGuid(mem: Process["mem"], a: number, g: string) {
  const parts = g.split("-");
  mem.w32(a, parseInt(parts[0], 16)); mem.w16(a + 4, parseInt(parts[1], 16)); mem.w16(a + 6, parseInt(parts[2], 16));
  const rest = parts[3] + parts[4];
  for (let i = 0; i < 8; i++) mem.w8(a + 8 + i, parseInt(rest.slice(i * 2, i * 2 + 2), 16));
}

export type ComMethod = (this: ComObject, c: Cpu) => number | bigint | boolean | void;

export class ComObject {
  rt!: ComRuntime;
  id = 0;
  refs = 1;
  /** interface name -> guest pointer */
  ptrs = new Map<string, number>();
  /** interfaces this object answers QueryInterface for, most-derived first. The first entry is the primary interface. */
  ifaces: string[] = [];
  destroyed = false;
  /** extra reference-holders (children keep parents alive) */
  onDestroy: (() => void) | null = null;

  /** guest pointer of the primary interface */
  get ptr(): number { return this.ptrFor(this.ifaces[0]); }
  ptrFor(iface: string): number { return this.rt.ptrOf(this, iface); }

  QueryInterface(c: Cpu): number {
    const riid = c.arg(1), out = c.arg(2);
    if (!out) return E_POINTER;
    const g = guidToString(this.rt.p.mem, riid);
    this.rt.p.mem.wptr(out, 0);
    if (g === "00000000-0000-0000-c000-000000000046") { this.rt.p.mem.wptr(out, this.ptr); this.refs++; return S_OK; }
    for (const name of this.ifaces) {
      if (COM[name]?.iid === g) { this.rt.p.mem.wptr(out, this.ptrFor(name)); this.refs++; return S_OK; }
    }
    const extra = this.queryExtra(g);
    if (extra) { this.rt.p.mem.wptr(out, extra); return S_OK; }
    return E_NOINTERFACE;
  }
  /** subclass hook: answer QueryInterface for IIDs not in `ifaces` (e.g. delegating to a parent object) */
  queryExtra(_iid: string): number { return 0; }
  AddRef(_c: Cpu): number { return ++this.refs; }
  Release(_c: Cpu): number {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0 && !this.destroyed) { this.destroyed = true; this.onDestroy?.(); this.destroy(); this.rt.free(this); }
    return this.refs;
  }
  /** called when the last reference is released */
  destroy(): void {}
}

export class ComRuntime {
  readonly p: Process;
  private objs: (ComObject | undefined)[] = [undefined];
  private freeIds: number[] = [];
  private vtables = new Map<string, number>();
  private mod;
  /** called for methods the object does not implement (diagnostics) */
  unimplemented = new Set<string>();
  trace: ((iface: string, method: string, obj: ComObject, c: Cpu) => void) | null = null;

  constructor(p: Process) {
    this.p = p;
    this.mod = p.hle.module("com.internal");
  }

  create<T extends ComObject>(obj: T, ifaces: string[]): T {
    obj.rt = this;
    obj.ifaces = ifaces;
    const id = this.freeIds.pop() ?? this.objs.length;
    obj.id = id;
    this.objs[id] = obj;
    return obj;
  }
  free(obj: ComObject) {
    for (const ptr of obj.ptrs.values()) this.p.vm.release(ptr);
    obj.ptrs.clear();
    this.objs[obj.id] = undefined;
    this.freeIds.push(obj.id);
  }
  ptrOf(obj: ComObject, iface: string): number {
    let ptr = obj.ptrs.get(iface);
    if (ptr) return ptr;
    ptr = this.p.vm.alloc(0x1000, { commit: true, tag: "com:" + iface });
    this.p.mem.wptr(ptr, this.vtable(iface));
    this.p.mem.w32(ptr + 8, obj.id);
    obj.ptrs.set(iface, ptr);
    return ptr;
  }
  objectAt(ptr: number): ComObject | undefined {
    if (!ptr) return undefined;
    return this.objs[this.p.mem.r32(ptr + 8)];
  }
  private vtable(iface: string): number {
    let v = this.vtables.get(iface);
    if (v) return v;
    const def = COM[iface];
    if (!def) throw new Error(`COM interface ${iface} not in generated tables`);
    const mem = this.p.mem;
    v = this.p.vm.alloc(Math.max(0x1000, def.methods.length * 8 + 8), { commit: true, tag: "vtbl:" + iface });
    def.methods.forEach((name, i) => {
      const thunk = this.mod.fn(`${iface}::${name}`, (c) => {
        const self = this.objs[mem.r32(c.arg(0) + 8)];
        if (!self) { this.p.log(`[com] ${iface}::${name} on a released object`); return E_FAIL; }
        if (this.trace) this.trace(iface, name, self, c);
        const f = (self as any)[iface + "_" + name] ?? (self as any)[name];
        if (typeof f !== "function") {
          const key = iface + "::" + name;
          if (!this.unimplemented.has(key)) { this.unimplemented.add(key); this.p.log(`[com] unimplemented: ${key} (on ${self.constructor.name})`); }
          return name === "AddRef" || name === "Release" ? 1 : E_NOTIMPL;
        }
        return f.call(self, c);
      });
      mem.wptr(v! + i * 8, thunk);
    });
    this.vtables.set(iface, v);
    return v;
  }
}

declare module "../win32/process.ts" {
  interface Process {
    com: ComRuntime;
  }
}
