// Virtual file system presented to the guest. Reads come from mounted sources (dropped folder, bundled assets);
// all writes go to an in-memory copy-on-write overlay.

export interface VfsStat {
  isDir: boolean;
  size: number;
  mtime: number; // ms since epoch
  attrs: number;
}
export interface VfsFile {
  size: number;
  read(offset: number, out: Uint8Array): number;
}
export interface VfsSource {
  stat(rel: string): VfsStat | null;
  open(rel: string): VfsFile | null;
  list(rel: string): { name: string; stat: VfsStat }[] | null;
}

/** Canonical path form: lowercase, backslash separated, no trailing slash, e.g. "c:\\game\\data". */
export function canon(p: string): string {
  p = p.replace(/\//g, "\\").toLowerCase();
  const parts: string[] = [];
  const m = /^([a-z]:)?(.*)$/.exec(p)!;
  const drive = m[1] ?? "";
  for (const seg of m[2].split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return drive + "\\" + parts.join("\\");
}

class OverlayFile implements VfsFile {
  data: Uint8Array;
  size: number;
  constructor(data: Uint8Array, size: number) {
    this.data = data;
    this.size = size;
  }
  read(offset: number, out: Uint8Array): number {
    if (offset >= this.size) return 0;
    const n = Math.min(out.length, this.size - offset);
    out.set(this.data.subarray(offset, offset + n));
    return n;
  }
}

export class MemFile extends OverlayFile {}

interface Mount {
  prefix: string; // canonical, e.g. "c:\\game"
  src: VfsSource;
}

export class Vfs {
  private mounts: Mount[] = [];
  private files = new Map<string, { data: Uint8Array; size: number; mtime: number; attrs: number }>();
  private dirs = new Set<string>();
  private deleted = new Set<string>();

  mount(prefix: string, src: VfsSource) {
    this.mounts.push({ prefix: canon(prefix), src });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    this.mkdirs(prefix);
  }
  private find(path: string): { src: VfsSource; rel: string } | null {
    const c = canon(path);
    for (const m of this.mounts) {
      if (c === m.prefix) return { src: m.src, rel: "" };
      if (c.startsWith(m.prefix + "\\")) return { src: m.src, rel: c.slice(m.prefix.length + 1) };
    }
    return null;
  }
  mkdirs(path: string) {
    let c = canon(path);
    while (c.length > 3) {
      this.dirs.add(c);
      const i = c.lastIndexOf("\\");
      if (i <= 2) { this.dirs.add(c.slice(0, 3)); break; }
      c = c.slice(0, i);
    }
    this.dirs.add(c);
  }

  stat(path: string): VfsStat | null {
    const c = canon(path);
    if (this.deleted.has(c)) return null;
    const f = this.files.get(c);
    if (f) return { isDir: false, size: f.size, mtime: f.mtime, attrs: f.attrs };
    if (/^[a-z]:\\?$/.test(c) || c === "\\") return { isDir: true, size: 0, mtime: 0, attrs: 0x10 };
    if (this.dirs.has(c)) return { isDir: true, size: 0, mtime: 0, attrs: 0x10 };
    const m = this.find(path);
    if (m) return m.src.stat(m.rel);
    return null;
  }
  exists(path: string): boolean {
    return this.stat(path) !== null;
  }
  open(path: string): VfsFile | null {
    const c = canon(path);
    if (this.deleted.has(c)) return null;
    const f = this.files.get(c);
    if (f) return new OverlayFile(f.data, f.size);
    const m = this.find(path);
    return m ? m.src.open(m.rel) : null;
  }
  readAll(path: string): Uint8Array | null {
    const f = this.open(path);
    if (!f) return null;
    const out = new Uint8Array(f.size);
    f.read(0, out);
    return out;
  }
  list(path: string): { name: string; stat: VfsStat }[] | null {
    const c = canon(path);
    const out = new Map<string, { name: string; stat: VfsStat }>();
    let any = false;
    const m = this.find(path);
    if (m) {
      const l = m.src.list(m.rel);
      if (l) { any = true; for (const e of l) out.set(e.name.toLowerCase(), e); }
    }
    const prefix = c.endsWith("\\") ? c : c + "\\";
    for (const [p, f] of this.files) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("\\")) {
        const name = p.slice(prefix.length);
        out.set(name, { name, stat: { isDir: false, size: f.size, mtime: f.mtime, attrs: f.attrs } });
        any = true;
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes("\\") && d.length > prefix.length) {
        const name = d.slice(prefix.length);
        out.set(name, { name, stat: { isDir: true, size: 0, mtime: 0, attrs: 0x10 } });
        any = true;
      }
    }
    if (!any && !this.dirs.has(c) && !this.stat(path)) return null;
    for (const k of [...out.keys()]) if (this.deleted.has(prefix + k)) out.delete(k);
    return [...out.values()];
  }
  /** write (replace) a whole file in the overlay */
  writeFile(path: string, data: Uint8Array) {
    const c = canon(path);
    this.deleted.delete(c);
    this.files.set(c, { data: data.slice(), size: data.length, mtime: Date.now(), attrs: 0x20 });
    this.mkdirs(c.slice(0, c.lastIndexOf("\\")));
  }
  /** ensure an overlay copy exists (copy-on-write) and return it */
  private ensure(path: string): { data: Uint8Array; size: number; mtime: number; attrs: number } | null {
    const c = canon(path);
    let f = this.files.get(c);
    if (f) return f;
    const cur = this.readAll(path);
    if (cur === null) return null;
    this.deleted.delete(c);
    f = { data: cur, size: cur.length, mtime: Date.now(), attrs: 0x20 };
    this.files.set(c, f);
    return f;
  }
  create(path: string, truncate: boolean): boolean {
    const c = canon(path);
    this.deleted.delete(c);
    const dir = c.slice(0, c.lastIndexOf("\\"));
    if (dir.length > 2 && !this.exists(dir)) return false;
    if (truncate || !this.exists(path)) this.files.set(c, { data: new Uint8Array(0), size: 0, mtime: Date.now(), attrs: 0x20 });
    else this.ensure(path);
    return true;
  }
  writeAt(path: string, offset: number, data: Uint8Array): boolean {
    const f = this.ensure(path);
    if (!f) return false;
    const end = offset + data.length;
    if (end > f.data.length) {
      const nd = new Uint8Array(Math.max(end, f.data.length * 2, 64));
      nd.set(f.data.subarray(0, f.size));
      f.data = nd;
    }
    f.data.set(data, offset);
    if (end > f.size) f.size = end;
    f.mtime = Date.now();
    return true;
  }
  setSize(path: string, size: number): boolean {
    const f = this.ensure(path);
    if (!f) return false;
    if (size > f.data.length) {
      const nd = new Uint8Array(size);
      nd.set(f.data.subarray(0, f.size));
      f.data = nd;
    } else if (size > f.size) f.data.fill(0, f.size, size);
    f.size = size;
    return true;
  }
  mkdir(path: string): boolean {
    const c = canon(path);
    if (this.exists(c)) return false;
    const parent = c.slice(0, c.lastIndexOf("\\"));
    if (parent.length > 2 && !this.exists(parent)) return false;
    this.deleted.delete(c);
    this.dirs.add(c);
    return true;
  }
  delete(path: string): boolean {
    const c = canon(path);
    const st = this.stat(path);
    if (!st || st.isDir) return false;
    this.files.delete(c);
    this.deleted.add(c);
    return true;
  }
  rmdir(path: string): boolean {
    const c = canon(path);
    const st = this.stat(path);
    if (!st || !st.isDir) return false;
    const l = this.list(path);
    if (l && l.length) return false;
    this.dirs.delete(c);
    this.deleted.add(c);
    return true;
  }
  rename(from: string, to: string, replace: boolean): boolean {
    const f = this.stat(from);
    if (!f || f.isDir) return false;
    if (this.exists(to) && !replace) return false;
    const data = this.readAll(from)!;
    this.writeFile(to, data);
    this.delete(from);
    return true;
  }
}

/** In-memory source: a flat map of relative paths to bytes (used by tests and bundled assets). */
export class MapSource implements VfsSource {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>([""]);
  add(rel: string, data: Uint8Array) {
    rel = canon(rel).slice(1);
    this.files.set(rel, data);
    let d = rel;
    while (d.includes("\\")) {
      d = d.slice(0, d.lastIndexOf("\\"));
      this.dirs.add(d);
    }
  }
  stat(rel: string): VfsStat | null {
    if (this.dirs.has(rel)) return { isDir: true, size: 0, mtime: 0, attrs: 0x10 };
    const f = this.files.get(rel);
    return f ? { isDir: false, size: f.length, mtime: 0, attrs: 0x20 } : null;
  }
  open(rel: string): VfsFile | null {
    const f = this.files.get(rel);
    return f ? new MemFile(f, f.length) : null;
  }
  list(rel: string): { name: string; stat: VfsStat }[] | null {
    if (!this.dirs.has(rel)) return null;
    const prefix = rel ? rel + "\\" : "";
    const out: { name: string; stat: VfsStat }[] = [];
    for (const [p, f] of this.files) if (p.startsWith(prefix) && !p.slice(prefix.length).includes("\\")) out.push({ name: p.slice(prefix.length), stat: { isDir: false, size: f.length, mtime: 0, attrs: 0x20 } });
    for (const d of this.dirs) if (d && d.startsWith(prefix) && !d.slice(prefix.length).includes("\\") && d.length > prefix.length) out.push({ name: d.slice(prefix.length), stat: { isDir: true, size: 0, mtime: 0, attrs: 0x10 } });
    return out;
  }
}
