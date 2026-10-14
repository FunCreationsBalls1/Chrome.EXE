// PE resources: FindResource/LoadResource/LockResource and string-table lookup (shared with user32!LoadString).
import type { Process, LoadedModule } from "./process.ts";
import { parseResources } from "../pe/pe.ts";
import type { ResourceEntry } from "../pe/pe.ts";
import { ERROR } from "./k32-core.ts";

declare module "./process.ts" {
  interface Process {
    resourcesOf(mod: LoadedModule): ResourceEntry[];
    findResource(mod: LoadedModule, type: number | string, id: number | string, lang?: number): { addr: number; size: number; lang: number } | null;
    loadString(mod: LoadedModule, id: number): string | null;
  }
}

const RT_STRING = 6;

export function installKernel32Resources(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;
  const cache = new WeakMap<LoadedModule, ResourceEntry[]>();

  p.resourcesOf = (mod) => {
    let r = cache.get(mod);
    if (!r) {
      try { r = mod.img && mod.data ? parseResources(mod.data, mod.img) : []; } catch { r = []; }
      cache.set(mod, r);
    }
    return r;
  };

  const norm = (v: number | string): number | string => (typeof v === "string" && /^#\d+$/.test(v) ? parseInt(v.slice(1), 10) : typeof v === "string" ? v.toUpperCase() : v);

  p.findResource = (mod, type, id, lang = 0) => {
    const t = norm(type), n = norm(id);
    const list = p.resourcesOf(mod).filter((e) => norm(e.type) === t && norm(e.id) === n);
    if (!list.length) return null;
    const pick = list.find((e) => lang && e.lang === lang) ?? list.find((e) => e.lang === 0x409) ?? list.find((e) => e.lang === 0) ?? list[0];
    return { addr: mod.pbase + pick.dataRva, size: pick.size, lang: pick.lang };
  };

  p.loadString = (mod, id) => {
    const r = p.findResource(mod, RT_STRING, (id >> 4) + 1);
    if (!r) return null;
    let a = r.addr;
    const end = r.addr + r.size;
    for (let i = 0; i < 16 && a < end; i++) {
      const len = mem.r16(a);
      a += 2;
      if (i === (id & 15)) return mem.wstrn(a, len);
      a += len * 2;
    }
    return null;
  };

  // resource "handles" are simply the data addresses; we keep a table for size lookup
  const infoByAddr = new Map<number, { size: number }>();
  const mod = (h: number): LoadedModule | undefined => (h ? p.moduleByHandle(h) : p.exe ?? undefined);

  const findW = (c: any, wide: boolean, ex: boolean) => {
    const m = mod(c.arg(0));
    if (!m) { p.setLastError(ERROR.RESOURCE_TYPE_NOT_FOUND); return 0; }
    const rd = (ptr: number): number | string => (ptr < 0x10000 ? ptr : wide ? mem.wstr(ptr) : mem.cstr(ptr));
    const name = rd(c.arg(ex ? 2 : 1)), type = rd(c.arg(ex ? 1 : 2));
    const lang = ex ? c.arg(4) & 0xffff : 0;
    const r = p.findResource(m, type, name, lang);
    if (!r) { p.setLastError(ERROR.RESOURCE_NAME_NOT_FOUND); return 0; }
    infoByAddr.set(r.addr, { size: r.size });
    return r.addr;
  };
  k.fn("FindResourceW", (c) => findW(c, true, false));
  k.fn("FindResourceA", (c) => findW(c, false, false));
  k.fn("FindResourceExW", (c) => findW(c, true, true));
  k.fn("FindResourceExA", (c) => findW(c, false, true));
  k.fn("LoadResource", (c) => c.arg(1));
  k.fn("LockResource", (c) => c.arg(0));
  k.fn("SizeofResource", (c) => infoByAddr.get(c.arg(1))?.size ?? 0);
  k.fn("FreeResource", () => 0);
  k.fn("EnumResourceNamesW", (c) => {
    const m = mod(c.arg(0));
    if (!m) return 0;
    const ty = c.arg(1) < 0x10000 ? c.arg(1) : mem.wstr(c.arg(1));
    const seen = new Set<number | string>();
    for (const e of p.resourcesOf(m)) {
      if (norm(e.type) !== norm(ty) || seen.has(e.id)) continue;
      seen.add(e.id);
      let namePtr: number;
      if (typeof e.id === "number") namePtr = e.id;
      else { namePtr = p.vm.alloc(0x1000, { commit: true, tag: "resname" }); mem.wwstr(namePtr, e.id); }
      const r = Number(p.callGuest(c.arg(2), [m.base, c.arg(1), namePtr, c.arg64(3)]) & 0xffffffffn);
      if (!r) break;
    }
    return 1;
  });
}
