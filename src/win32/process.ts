// A Windows process: guest memory, loaded modules, threads, handles, and the machinery to run them.
import { Machine } from "../jit/machine.ts";
import * as L from "../jit/layout.ts";
import { Cpu, RAX, RCX, RDX, R8, R9, RSP } from "./cpu.ts";
import { GuestMem } from "./mem.ts";
import { Vm, MEM_IMAGE, PAGE_READWRITE } from "./vm.ts";
import { Heap } from "./heap.ts";
import { Hle } from "./hle.ts";
import { Vfs, canon } from "./vfs.ts";
import {
  DIR_EXPORT, DIR_TLS, parseDelayImports, parseExports, parseImports, parsePe, parseTls, iterRelocs, PeError,
} from "../pe/pe.ts";
import type { PeImage, TlsInfo } from "../pe/pe.ts";
import type { Host } from "./host.ts";
import { NullHost } from "./host.ts";

export class ProcessExit extends Error {
  isControlFlow = true;
  code: number;
  constructor(code: number) {
    super("process exit " + code);
    this.code = code;
  }
}

export const DLL_PROCESS_ATTACH = 1, DLL_THREAD_ATTACH = 2, DLL_THREAD_DETACH = 3, DLL_PROCESS_DETACH = 0;

export interface LoadedModule {
  name: string; // lowercase base name, e.g. "msvcrt.dll"
  path: string; // Windows path
  /** guest-visible virtual base (HMODULE); may exceed 4 GiB for fixed-base images */
  base: number;
  /** address in the wasm memory (== base unless the image lives in a high window) */
  pbase: number;
  size: number;
  entry: number; // guest-visible entry point or 0
  img: PeImage | null;
  isHle: boolean;
  isExe: boolean;
  exportsByName: Map<string, number>; // lowercase -> RVA
  exportsByOrd: Map<number, number>;
  forwarders: Map<number, string>; // rva -> "dll.name"
  fwdByName: Map<string, string>;
  deps: LoadedModule[];
  refCount: number;
  initialized: boolean;
  tls: TlsInfo | null;
  tlsIndex: number;
  ldrEntry: number;
  exportRvaRange: [number, number];
  imageBase: bigint;
  data: Uint8Array | null;
}

export interface KObject {
  type: string;
  [k: string]: any;
}

export class HandleTable {
  private map = new Map<number, KObject>();
  private next = 0x100;
  alloc(o: KObject): number {
    const h = this.next;
    this.next += 4;
    this.map.set(h, o);
    return h;
  }
  set(h: number, o: KObject) {
    this.map.set(h, o);
  }
  get(h: number): KObject | undefined {
    return this.map.get(h >>> 0);
  }
  close(h: number): boolean {
    return this.map.delete(h >>> 0);
  }
  has(h: number) {
    return this.map.has(h >>> 0);
  }
  entries() {
    return this.map.entries();
  }
}

export interface Thread {
  id: number;
  handle: number;
  teb: number;
  stackBase: number; // high address
  stackLimit: number; // low address
  exitCode: number;
  state: "ready" | "running" | "blocked" | "done" | "suspended";
  /** saved CPU state when not running */
  ctx: Uint8Array | null;
  waitingOn?: any;
  suspendCount: number;
  startFn: number;
  startArg: number;
  tlsBlocks: Map<number, number>;
  lastError: number;
  name?: string;
  priority: number;
}

export interface ProcessOptions {
  vfs?: Vfs;
  cmdline?: string;
  exePath?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdout?: (s: Uint8Array) => void;
  stderr?: (s: Uint8Array) => void;
  log?: (s: string) => void;
  strictImports?: boolean;
  pages?: number;
  smc?: boolean;
  host?: Host;
}

const LIST_ENTRY = 16;

export class Process {
  readonly m: Machine;
  readonly mem: GuestMem;
  readonly vm: Vm;
  readonly cpu: Cpu;
  readonly hle: Hle;
  readonly vfs: Vfs;
  readonly host: Host;
  readonly handles = new HandleTable();
  readonly heaps = new Map<number, Heap>();
  readonly modules: LoadedModule[] = [];
  readonly threads = new Map<number, Thread>();
  readonly opts: ProcessOptions;
  readonly log: (s: string) => void;
  processHeap!: Heap;
  peb = 0;
  ldr = 0;
  mainThread!: Thread;
  curThread!: Thread;
  pid = 0x1234;
  nextTid = 0x2000;
  cmdline: string;
  exePath: string;
  cwd: string;
  env = new Map<string, string>();
  exe: LoadedModule | null = null;
  exitCode = 0;
  exited = false;
  sentinel = 0;
  /** active callGuest invocations: `end` = rsp after the callee returns to the sentinel; `ctx` = context to continue an exception walk from */
  hostFrames: { end: number; ctx: number }[] = [];
  tlsSlotCount = 0; // implicit TLS (image TLS directory) slot counter
  missingReported = new Set<string>();
  /** hooks installed by HLE modules */
  onProcessExit: (() => void)[] = [];
  /** extension point storage for HLE subsystems (window manager, d3d, ...) */
  ext: Record<string, any> = {};

  constructor(opts: ProcessOptions = {}) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.m = new Machine({ pages: opts.pages ?? 1024, smc: opts.smc ?? true });
    this.mem = new GuestMem(this.m);
    this.vm = new Vm(this.m);
    this.cpu = new Cpu(this.m);
    this.hle = new Hle(this.m);
    this.vfs = opts.vfs ?? new Vfs();
    this.host = opts.host ?? new NullHost();
    this.exePath = opts.exePath ?? "C:\\app.exe";
    this.cmdline = opts.cmdline ?? `"${this.exePath}"`;
    this.cwd = opts.cwd ?? this.exePath.slice(0, this.exePath.lastIndexOf("\\"));
    this.sentinel = this.m.registerThunk(() => L.ST_HOSTCALL_RETURN);
    const defaults: Record<string, string> = {
      SystemRoot: "C:\\Windows", windir: "C:\\Windows", SystemDrive: "C:", TEMP: "C:\\Users\\user\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\user\\AppData\\Local\\Temp", USERPROFILE: "C:\\Users\\user", APPDATA: "C:\\Users\\user\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData", COMPUTERNAME: "CHROME-EXE", USERNAME: "user", OS: "Windows_NT", NUMBER_OF_PROCESSORS: "4",
      PROCESSOR_ARCHITECTURE: "AMD64", PATH: "C:\\Windows\\system32;C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\user",
    };
    for (const [k, v] of Object.entries({ ...defaults, ...(opts.env ?? {}) })) this.env.set(k, v);
    for (const d of ["C:\\Windows\\System32", "C:\\Windows\\SysWOW64", "C:\\Users\\user\\AppData\\Local\\Temp", "C:\\Users\\user\\AppData\\Roaming",
      "C:\\Users\\user\\Documents", "C:\\ProgramData", "C:\\Program Files"]) this.vfs.mkdirs(d);
    this.hle.onMissing = (dll, name) => {
      const k = dll + "!" + name;
      if (!this.missingReported.has(k)) {
        this.missingReported.add(k);
        this.log(`[hle] unimplemented: ${k}`);
      }
      if (this.opts.strictImports) throw new Error(`unimplemented import ${k}`);
    };
    this.setupProcess();
  }

  // -------------------------------------------------------------------------------------
  // PEB / TEB / LDR
  // -------------------------------------------------------------------------------------
  private setupProcess() {
    const mem = this.mem;
    this.peb = this.vm.alloc(0x2000, { commit: true, tag: "PEB" });
    this.ldr = this.vm.alloc(0x1000, { commit: true, tag: "LDR" });
    this.processHeap = this.createHeap(0);
    mem.w8(this.peb + 2, 0);
    mem.w64(this.peb + 0x30, this.processHeap.handle);
    mem.w32(this.peb + 0xb8, 4); // NumberOfProcessors
    mem.w32(this.peb + 0x118, 10); // OSMajorVersion
    mem.w32(this.peb + 0x11c, 0);
    mem.w16(this.peb + 0x120, 19045); // OSBuildNumber
    mem.w32(this.peb + 0x124, 2); // VER_PLATFORM_WIN32_NT
    mem.w64(this.peb + 0x18, this.ldr);
    mem.w32(this.ldr, 0x58);
    mem.w8(this.ldr + 4, 1);
    for (const off of [0x10, 0x20, 0x30]) {
      mem.w64(this.ldr + off, this.ldr + off);
      mem.w64(this.ldr + off + 8, this.ldr + off);
    }
    this.mainThread = this.createThreadObject(0, 0, 0, 0);
    this.curThread = this.mainThread;
    this.mainThread.state = "running";
    this.m.dv.setBigUint64(L.STATE + L.S_GS_BASE, BigInt(this.mainThread.teb), true);
    this.setupParams();
  }

  private setupParams() {
    const mem = this.mem;
    const pp = this.vm.alloc(0x2000, { commit: true, tag: "ProcessParameters" });
    mem.w64(this.peb + 0x20, pp);
    const putUs = (off: number, s: string) => {
      const buf = this.vm.alloc(Math.max(0x1000, (s.length + 1) * 2), { commit: true, tag: "ustr" });
      mem.wwstr(buf, s);
      mem.w16(pp + off, s.length * 2);
      mem.w16(pp + off + 2, s.length * 2 + 2);
      mem.w64(pp + off + 8, buf);
    };
    mem.w32(pp + 4, 0x400);
    putUs(0x38, this.cwd + "\\");
    putUs(0x60, this.exePath);
    putUs(0x70, this.cmdline);
    putUs(0x50, "C:\\Windows\\System32");
    mem.w64(pp + 0x80, this.buildEnvironmentBlock(true));
  }

  buildEnvironmentBlock(wide: boolean): number {
    let total = 2;
    const items = [...this.env.entries()].map(([k, v]) => `${k}=${v}`).sort();
    for (const it of items) total += (it.length + 1) * (wide ? 2 : 1);
    const p = this.vm.alloc(Math.max(total + 4, 0x1000), { commit: true, tag: "env" });
    let o = p;
    for (const it of items) {
      if (wide) { this.mem.wwstr(o, it); o += (it.length + 1) * 2; } else { this.mem.wcstr(o, it); o += it.length + 1; }
    }
    if (wide) this.mem.w16(o, 0); else this.mem.w8(o, 0);
    return p;
  }

  createHeap(flags: number, initial = 0): Heap {
    const handle = this.vm.alloc(0x1000, { commit: true, tag: "heap-handle" });
    const h = new Heap(this.mem, this.vm, handle, flags);
    this.heaps.set(handle, h);
    void initial;
    return h;
  }

  createThreadObject(startFn: number, startArg: number, stackSize: number, flagsSuspended: number): Thread {
    const mem = this.mem;
    const id = this.threads.size === 0 ? this.pid + 4 : this.nextTid;
    if (this.threads.size) this.nextTid += 4;
    const teb = this.vm.alloc(0x2000, { commit: true, tag: "TEB" });
    const reserve = Math.max(stackSize || 0, 1024 * 1024);
    const stackSz = Math.min(Math.max(reserve, 256 * 1024), 16 * 1024 * 1024);
    const stackLow = this.vm.alloc(stackSz, { commit: true, tag: "stack" });
    const stackHigh = stackLow + stackSz;
    mem.w64(teb + 0x00, 0xffffffffffffffffn);
    mem.wptr(teb + 0x08, stackHigh);
    mem.wptr(teb + 0x10, stackLow);
    mem.wptr(teb + 0x30, teb);
    mem.wptr(teb + 0x40, this.pid);
    mem.wptr(teb + 0x48, id);
    mem.wptr(teb + 0x60, this.peb);
    mem.wptr(teb + 0x1478, stackLow); // DeallocationStack
    const t: Thread = {
      id, handle: 0, teb, stackBase: stackHigh, stackLimit: stackLow, exitCode: 0x103, state: flagsSuspended ? "suspended" : "ready",
      ctx: null, suspendCount: flagsSuspended ? 1 : 0, startFn, startArg, tlsBlocks: new Map(), lastError: 0, priority: 0,
    };
    this.threads.set(id, t);
    // allocate implicit TLS blocks for modules already loaded
    this.setupThreadTls(t);
    return t;
  }

  // implicit TLS (TLS directory): TEB.ThreadLocalStoragePointer[index] -> block
  setupThreadTls(t: Thread) {
    const mem = this.mem;
    const n = Math.max(this.tlsSlotCount, 1) + 8;
    let arr = mem.r32(t.teb + 0x58);
    if (!arr) {
      arr = this.vm.alloc(Math.max(0x1000, n * 8), { commit: true, tag: "tlsarray" });
      mem.wptr(t.teb + 0x58, arr);
    }
    for (const mod of this.modules) {
      if (mod.tls && !t.tlsBlocks.has(mod.tlsIndex)) this.allocTlsBlock(t, mod);
    }
  }
  allocTlsBlock(t: Thread, mod: LoadedModule) {
    const tls = mod.tls!;
    const mem = this.mem;
    const start = Number(tls.startRaw) , end = Number(tls.endRaw);
    const size = end - start + tls.zeroFill;
    const blk = this.vm.alloc(Math.max(size, 16), { commit: true, tag: "tls:" + mod.name });
    if (end > start) mem.copy(blk, start, end - start);
    t.tlsBlocks.set(mod.tlsIndex, blk);
    const arr = mem.r32(t.teb + 0x58);
    mem.wptr(arr + mod.tlsIndex * 8, blk);
  }

  // -------------------------------------------------------------------------------------
  // Modules
  // -------------------------------------------------------------------------------------
  findModule(name: string): LoadedModule | undefined {
    const n = this.baseName(name);
    return this.modules.find((m) => m.name === n);
  }
  /** find the module containing a guest-visible address (physical addresses inside high windows are translated) */
  moduleByAddr(addr: number): LoadedModule | undefined {
    const v = addr < 0x100000000 ? this.m.virt(addr) : addr;
    for (const m of this.modules) if (v >= m.base && v < m.base + m.size) return m;
    for (const m of this.modules) if (addr >= m.base && addr < m.base + m.size) return m;
    return undefined;
  }
  /** HMODULE -> module; handles are matched on their low 32 bits (unique by construction) */
  moduleByHandle(h: number): LoadedModule | undefined {
    const lo = h >>> 0;
    return this.modules.find((m) => m.base !== 0 && (m.base >>> 0) === lo);
  }
  baseName(p: string): string {
    let n = p.toLowerCase().replace(/^.*[\\/]/, "");
    if (!/\.[a-z0-9]{1,4}$/.test(n)) n += ".dll";
    return n;
  }

  /** Wrap HLE modules as LoadedModules (called once after HLE registration). */
  registerHleModules() {
    this.hle.materialize(this.vm, this.mem);
    for (const hm of this.hle.modules.values()) {
      const lm: LoadedModule = {
        name: hm.name, path: "C:\\Windows\\System32\\" + hm.name, base: hm.base, pbase: hm.base, size: hm.size, entry: 0, img: null, isHle: true, isExe: false,
        exportsByName: new Map(), exportsByOrd: new Map(), forwarders: new Map(), fwdByName: new Map(), deps: [], refCount: 1, initialized: true,
        tls: null, tlsIndex: 0, ldrEntry: 0, exportRvaRange: [0, 0], imageBase: BigInt(hm.base), data: null,
      };
      this.modules.push(lm);
      this.addLdrEntry(lm);
    }
  }

  addLdrEntry(mod: LoadedModule) {
    const mem = this.mem;
    const e = this.vm.alloc(0x100, { commit: true, tag: "ldr-entry" });
    mod.ldrEntry = e;
    mem.wptr(e + 0x30, mod.base);
    mem.wptr(e + 0x38, mod.entry);
    mem.w32(e + 0x40, mod.size);
    const full = mod.path, base = mod.path.slice(mod.path.lastIndexOf("\\") + 1);
    const putUs = (off: number, s: string) => {
      const buf = this.vm.alloc(0x1000, { commit: true, tag: "ldr-str" });
      mem.wwstr(buf, s);
      mem.w16(e + off, s.length * 2);
      mem.w16(e + off + 2, s.length * 2 + 2);
      mem.wptr(e + off + 8, buf);
    };
    putUs(0x48, full);
    putUs(0x58, base);
    mem.w32(e + 0x68, 0x4000);
    mem.w16(e + 0x6c, 1);
    for (const off of [0x00, 0x10, 0x20]) {
      const head = this.ldr + 0x10 + (off === 0 ? 0 : off === 0x10 ? 0x10 : 0x20);
      const tail = mem.r32(head + 8);
      mem.wptr(e + off, head);
      mem.wptr(e + off + 8, tail);
      mem.wptr(tail, e + off);
      mem.wptr(head + 8, e + off);
    }
  }

  /** Locate DLL bytes: exe dir, system directory, then fallback dirs. */
  findDllFile(name: string): { path: string; data: Uint8Array } | null {
    const n = this.baseName(name);
    const dirs = [this.exePath.slice(0, this.exePath.lastIndexOf("\\")), this.cwd, "C:\\Windows\\System32", "C:\\Windows"];
    for (const d of dirs) {
      const p = d + "\\" + n;
      const data = this.vfs.readAll(p);
      if (data) return { path: p, data };
    }
    return null;
  }

  /** Load (or find) a module by name. Returns null when it cannot be found. */
  loadLibrary(name: string, refs = true): LoadedModule | null {
    const canonical = this.hle.canonical(name);
    const already = this.findModule(canonical);
    if (already) {
      if (refs) already.refCount++;
      return already;
    }
    if (/[\\/]/.test(name) && name.includes(":")) {
      // explicit path
      const data = this.vfs.readAll(name);
      if (data) return this.mapImage(name, data, false);
    }
    const f = this.findDllFile(canonical);
    if (f) return this.mapImage(f.path, f.data, false);
    return null;
  }

  mapImage(path: string, data: Uint8Array, isExe: boolean): LoadedModule {
    const img = parsePe(data);
    const name = this.baseName(path);
    // choose the load address
    let pbase = 0;
    let base = 0; // guest-visible base
    const pref = img.imageBase;
    if (pref < 0x100000000n && pref >= 0x400000n) {
      pbase = this.vm.alloc(img.sizeOfImage, { addr: Number(pref), type: MEM_IMAGE, tag: "image:" + name });
      base = pbase;
    }
    if (!pbase) {
      if (!img.hasRelocs && pref >= 0x100000000n) {
        // fixed-base image above 4 GiB: map it in a high window at (base mod 2^32); the guest still sees the real addresses
        const phys = Number(pref & 0xffffffffn);
        pbase = this.vm.alloc(img.sizeOfImage, { addr: phys, type: MEM_IMAGE, tag: "image:" + name });
        if (!pbase) throw new PeError(`${name}: fixed image base 0x${pref.toString(16)} collides with already used address space`);
        base = Number(pref);
        this.m.addHighWindow(pbase, img.sizeOfImage, Number(pref >> 32n));
      } else {
        pbase = this.vm.alloc(img.sizeOfImage, { type: MEM_IMAGE, tag: "image:" + name });
        base = pbase;
      }
    }
    if (!pbase) throw new PeError(`${name}: out of address space`);
    if (!this.vm.commit(pbase, img.sizeOfImage, PAGE_READWRITE)) throw new PeError(`${name}: out of memory`);
    const m = this.mem;
    m.write(base, data.subarray(0, Math.min(img.sizeOfHeaders, data.length)));
    for (const s of img.sections) {
      const n = Math.min(s.rawSize, s.virtualSize || s.rawSize, Math.max(0, data.length - s.rawPtr));
      if (n > 0) m.write(base + s.virtualAddress, data.subarray(s.rawPtr, s.rawPtr + n));
    }
    // relocations
    const delta = BigInt(base) - img.imageBase;
    if (delta !== 0n) {
      if (!img.hasRelocs) throw new PeError(`${name}: needs relocation but has none`);
      for (const r of iterRelocs(data, img)) {
        const a = base + r.rva;
        switch (r.type) {
          case 0: break;
          case 3: m.w32(a, (m.r32(a) + Number(delta & 0xffffffffn)) >>> 0); break;
          case 10: m.w64(a, m.r64(a) + delta); break;
          case 1: m.w16(a, (m.r16(a) + Number((delta >> 16n) & 0xffffn)) & 0xffff); break;
          case 2: m.w16(a, (m.r16(a) + Number(delta & 0xffffn)) & 0xffff); break;
          default: throw new PeError(`${name}: unsupported relocation type ${r.type}`);
        }
      }
    }
    const mod: LoadedModule = {
      name, path, base, pbase, size: img.sizeOfImage, entry: img.entryRva ? base + img.entryRva : 0, img, isHle: false, isExe,
      exportsByName: new Map(), exportsByOrd: new Map(), forwarders: new Map(), fwdByName: new Map(), deps: [], refCount: 1, initialized: false,
      tls: null, tlsIndex: 0, ldrEntry: 0, exportRvaRange: [img.dirs[DIR_EXPORT].rva, img.dirs[DIR_EXPORT].rva + img.dirs[DIR_EXPORT].size],
      imageBase: img.imageBase, data,
    };
    const ex = parseExports(data, img);
    if (ex) {
      for (const e of ex.entries) {
        if (e.name) mod.exportsByName.set(e.name.toLowerCase(), e.rva);
        mod.exportsByOrd.set(e.ordinal, e.rva);
        if (e.forwarder) {
          mod.forwarders.set(e.rva, e.forwarder);
          if (e.name) mod.fwdByName.set(e.name.toLowerCase(), e.forwarder);
        }
      }
    }
    this.modules.push(mod);
    this.addLdrEntry(mod);
    // TLS
    const tls = parseTls(data, img);
    if (tls) {
      // the directory holds preferred-base virtual addresses: apply the load delta
      tls.startRaw += delta; tls.endRaw += delta; tls.indexAddr += delta;
      if (tls.callbacksAddr) tls.callbacksAddr += delta;
      mod.tls = tls;
      mod.tlsIndex = this.tlsSlotCount++;
      this.mem.w32(Number(tls.indexAddr), mod.tlsIndex);
      for (const t of this.threads.values()) this.allocTlsBlock(t, mod);
    }
    this.resolveImports(mod, data, img);
    return mod;
  }

  /** Resolve an exported symbol of a loaded module to an address (follows forwarders). */
  resolveExport(mod: LoadedModule, name: string | null, ordinal: number, depth = 0): number {
    if (depth > 8) return 0;
    if (mod.isHle) {
      const hm = this.hle.modules.get(mod.name)!;
      if (name !== null) {
        const a = hm.lookup(name);
        if (a !== undefined) return a;
        // kernelbase / kernel32 are the same module for us
        return 0;
      }
      return hm.ordinals.get(ordinal) ?? 0;
    }
    let rva: number | undefined;
    if (name !== null) {
      rva = mod.exportsByName.get(name.toLowerCase());
    } else rva = mod.exportsByOrd.get(ordinal);
    if (rva === undefined) return 0;
    const fwd = mod.forwarders.get(rva);
    if (fwd) {
      const dot = fwd.indexOf(".");
      const dll = fwd.slice(0, dot), sym = fwd.slice(dot + 1);
      const target = this.loadLibrary(dll, false);
      if (!target) return 0;
      if (sym.startsWith("#")) return this.resolveExport(target, null, parseInt(sym.slice(1)), depth + 1);
      return this.resolveExport(target, sym, 0, depth + 1);
    }
    return mod.base + rva;
  }

  private resolveImports(mod: LoadedModule, data: Uint8Array, img: PeImage) {
    const mem = this.mem;
    for (const d of parseImports(data, img)) {
      const dep = this.loadLibrary(d.dll, true) ?? this.stubModule(d.dll);
      if (!mod.deps.includes(dep)) mod.deps.push(dep);
      for (const e of d.entries) {
        let addr = this.resolveExport(dep, e.name, e.ordinal);
        if (!addr) addr = this.hle.missingStub(dep.name, e.name ?? "#" + e.ordinal);
        mem.wptr(mod.base + e.iatRva, addr);
      }
    }
    // delay imports are resolved by the module's own delay-load helper at runtime (via LoadLibrary/GetProcAddress)
    void parseDelayImports;
  }

  private stubModule(dll: string): LoadedModule {
    const name = this.baseName(this.hle.canonical(dll));
    this.log(`[loader] module not found: ${dll} (imports will be stubbed)`);
    if (this.opts.strictImports) throw new PeError(`module not found: ${dll}`);
    const hm = this.hle.module(name);
    const lm: LoadedModule = {
      name, path: "C:\\Windows\\System32\\" + name, base: 0, pbase: 0, size: 0, entry: 0, img: null, isHle: true, isExe: false, exportsByName: new Map(),
      exportsByOrd: new Map(), forwarders: new Map(), fwdByName: new Map(), deps: [], refCount: 1, initialized: true, tls: null, tlsIndex: 0, ldrEntry: 0,
      exportRvaRange: [0, 0], imageBase: 0n, data: null,
    };
    void hm;
    this.modules.push(lm);
    return lm;
  }

  getProcAddress(mod: LoadedModule, name: string | null, ordinal: number): number {
    const a = this.resolveExport(mod, name, ordinal);
    if (a) return a;
    if (mod.isHle) return 0;
    return 0;
  }

  /** Run TLS callbacks and DllMain for a module graph (dependencies first). */
  initModules(root: LoadedModule, reason = DLL_PROCESS_ATTACH) {
    const visit = (mod: LoadedModule) => {
      if (mod.initialized) return;
      mod.initialized = true;
      for (const d of mod.deps) visit(d);
      this.runModuleInit(mod, reason);
    };
    visit(root);
  }
  runModuleInit(mod: LoadedModule, reason: number) {
    if (mod.isHle) return;
    if (mod.tls && mod.tls.callbacksAddr) {
      let p = Number(mod.tls.callbacksAddr);
      for (let fn = this.mem.r32(p); fn; p += 8, fn = this.mem.r32(p)) {
        this.callGuest(fn, [mod.base, reason, 0]);
      }
    }
    if (!mod.isExe && mod.entry) {
      const r = this.callGuest(mod.entry, [mod.base, reason, 0]);
      if (reason === DLL_PROCESS_ATTACH && (r & 0xffffffffn) === 0n) {
        this.log(`[loader] DllMain of ${mod.name} returned FALSE`);
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Calling into guest code
  // -------------------------------------------------------------------------------------
  private saveState(): Uint8Array {
    return this.m.u8.slice(L.STATE, L.STATE + L.S_END);
  }
  private restoreState(s: Uint8Array) {
    this.m.u8.set(s, L.STATE);
  }

  /** Synchronous call into guest code; returns rax. Safe to use from inside HLE handlers. */
  callGuest(fn: number, args: (number | bigint)[] = [], floatArgs: number[] = [], unwindCtx = 0): bigint {
    const m = this.m;
    const saved = this.saveState();
    let sp = m.dv.getUint32(L.gprOff(RSP), true);
    // stay clear of whatever the interrupted code may have below its stack pointer
    sp = (sp - 0x200) & ~0xf;
    const nStack = Math.max(0, args.length - 4);
    sp -= 0x20 + nStack * 8;
    sp &= ~0xf;
    for (let i = 4; i < args.length; i++) m.dv.setBigUint64(sp + 0x20 + (i - 4) * 8, BigInt.asUintN(64, BigInt(args[i])), true);
    sp -= 8;
    m.dv.setBigUint64(sp, BigInt(this.sentinel), true);
    m.setGpr(RSP, sp);
    const regs = [RCX, RDX, R8, R9];
    for (let i = 0; i < Math.min(4, args.length); i++) m.setGpr(regs[i], BigInt.asUintN(64, BigInt(args[i])));
    for (let i = 0; i < floatArgs.length && i < 4; i++) m.dv.setFloat64(L.xmmOff(i), floatArgs[i], true);
    this.nested++;
    this.hostFrames.push({ end: sp + 8, ctx: unwindCtx });
    let st: number;
    try {
      st = m.run(fn);
    } catch (e) {
      this.restoreState(saved);
      throw e;
    } finally {
      this.nested--;
      this.hostFrames.pop();
    }
    if (st !== L.ST_HOSTCALL_RETURN) {
      this.restoreState(saved);
      throw this.statusError(st);
    }
    const rax = m.gpr(RAX);
    this.restoreState(saved);
    return rax;
  }

  statusError(st: number): Error {
    const rip = this.m.rip;
    switch (st) {
      case L.ST_EXIT: return new ProcessExit(this.exitCode);
      case L.ST_FAULT:
        return new Error(`guest exception kind=${this.m.faultKind} at 0x${rip.toString(16)} (${this.describeAddr(rip)})`);
      case L.ST_INVALID:
        return new Error(`unsupported or invalid instruction at 0x${rip.toString(16)} (${this.describeAddr(rip)}): ${[...this.m.u8.subarray(rip, rip + 12)].map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
      default: return new Error(`unexpected execution status ${st} at 0x${rip.toString(16)}`);
    }
  }
  describeAddr(a: number): string {
    const mod = this.moduleByAddr(a);
    return mod ? `${mod.name}+0x${(this.m.virt(a) - mod.base).toString(16)}` : "unknown module";
  }

  // -------------------------------------------------------------------------------------
  // Running a program
  // -------------------------------------------------------------------------------------
  /** Load the main executable. */
  loadExe(path: string, data: Uint8Array): LoadedModule {
    const mod = this.mapImage(path, data, true);
    this.exe = mod;
    this.mem.wptr(this.peb + 0x10, mod.base);
    return mod;
  }

  /** Initialise DLLs on the main thread and set it up to run the executable's entry point. */
  prepareMain() {
    const exe = this.exe!;
    const t = this.mainThread;
    this.m.dv.setBigUint64(L.STATE + L.S_GS_BASE, BigInt(t.teb), true);
    const sp = (t.stackBase - 0x1000) & ~0xf;
    this.m.setGpr(RSP, sp);
    this.initModules(exe);
    t.startFn = exe.entry;
    t.startArg = this.peb;
    t.ctx = null;
    t.state = "ready";
  }

  /** Run the whole process to completion synchronously (sleeps are busy-waited). */
  runSync(): number {
    try {
      this.prepareMain();
      return this.sched.runToCompletion();
    } catch (e) {
      if (e instanceof ProcessExit) return e.code;
      throw e;
    }
  }
}

export { RAX, RCX, RDX, DIR_TLS, canon };
