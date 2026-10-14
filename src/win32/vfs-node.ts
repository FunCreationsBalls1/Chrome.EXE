// VfsSource backed by a directory on the host file system (Node.js only; used by tests and the CLI runner).
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VfsFile, VfsSource, VfsStat } from "./vfs.ts";

export class NodeDirSource implements VfsSource {
  private root: string;
  // case-insensitive lookup cache: canonical (lowercase) relative path -> real relative path
  private cache = new Map<string, string | null>();
  constructor(root: string) {
    this.root = root;
  }
  private real(rel: string): string | null {
    const key = rel.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let cur = this.root;
    let out = "";
    if (rel) {
      for (const seg of rel.split("\\")) {
        let name: string | null = null;
        if (existsSync(join(cur, seg))) name = seg;
        else {
          try {
            const l = seg.toLowerCase();
            name = readdirSync(cur).find((n) => n.toLowerCase() === l) ?? null;
          } catch { name = null; }
        }
        if (name === null) { this.cache.set(key, null); return null; }
        cur = join(cur, name);
        out = out ? out + "\\" + name : name;
      }
    }
    this.cache.set(key, cur);
    return cur;
  }
  stat(rel: string): VfsStat | null {
    const r = this.real(rel);
    if (r === null) return null;
    try {
      const st = statSync(r);
      return { isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, attrs: st.isDirectory() ? 0x10 : 0x20 };
    } catch { return null; }
  }
  open(rel: string): VfsFile | null {
    const r = this.real(rel);
    if (r === null) return null;
    try {
      const fd = openSync(r, "r");
      const size = fstatSync(fd).size;
      // read-through file; the fd is kept open for the process lifetime (small number of opens)
      const f: VfsFile = {
        size,
        read(offset, out) {
          return readSync(fd, out, 0, out.length, offset);
        },
      };
      void closeSync;
      return f;
    } catch { return null; }
  }
  list(rel: string): { name: string; stat: VfsStat }[] | null {
    const r = this.real(rel);
    if (r === null) return null;
    try {
      return readdirSync(r).map((name) => ({ name, stat: this.stat(rel ? rel + "\\" + name : name)! })).filter((e) => e.stat);
    } catch { return null; }
  }
}
