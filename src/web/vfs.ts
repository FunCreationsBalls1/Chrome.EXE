// Browser VFS sources: a dropped file tree (read lazily with FileReaderSync inside the worker) and an HTTP directory
// (synchronous XHR with Range requests) used for the bundled system DLLs.
import type { VfsFile, VfsSource, VfsStat } from "../win32/vfs.ts";

export interface TreeNode {
  name: string;
  /** present for files */
  file?: File;
  /** present for directories */
  children?: TreeNode[];
}

declare class FileReaderSync {
  readAsArrayBuffer(b: Blob): ArrayBuffer;
}

const CHUNK = 1 << 18;

class LazyFile implements VfsFile {
  size: number;
  private file: File;
  private reader = new FileReaderSync();
  private chunkStart = -1;
  private chunk: Uint8Array | null = null;
  constructor(file: File) {
    this.file = file;
    this.size = file.size;
  }
  read(offset: number, out: Uint8Array): number {
    if (offset >= this.size) return 0;
    const n = Math.min(out.length, this.size - offset);
    if (n >= CHUNK) {
      out.set(new Uint8Array(this.reader.readAsArrayBuffer(this.file.slice(offset, offset + n))));
      return n;
    }
    let done = 0;
    while (done < n) {
      const pos = offset + done;
      if (!this.chunk || pos < this.chunkStart || pos >= this.chunkStart + this.chunk.length) {
        const start = Math.floor(pos / CHUNK) * CHUNK;
        this.chunk = new Uint8Array(this.reader.readAsArrayBuffer(this.file.slice(start, Math.min(start + CHUNK, this.size))));
        this.chunkStart = start;
      }
      const o = pos - this.chunkStart;
      const take = Math.min(n - done, this.chunk.length - o);
      out.set(this.chunk.subarray(o, o + take), done);
      done += take;
    }
    return n;
  }
}

export class FileTreeSource implements VfsSource {
  private index = new Map<string, TreeNode>();
  private dirs = new Map<string, TreeNode[]>();
  constructor(root: TreeNode[]) {
    this.dirs.set("", root);
    const walk = (nodes: TreeNode[], prefix: string) => {
      for (const n of nodes) {
        const rel = prefix ? prefix + "\\" + n.name.toLowerCase() : n.name.toLowerCase();
        this.index.set(rel, n);
        if (n.children) { this.dirs.set(rel, n.children); walk(n.children, rel); }
      }
    };
    walk(root, "");
  }
  private st(n: TreeNode): VfsStat {
    return n.children ? { isDir: true, size: 0, mtime: 0, attrs: 0x10 } : { isDir: false, size: n.file!.size, mtime: n.file!.lastModified, attrs: 0x20 };
  }
  stat(rel: string): VfsStat | null {
    if (rel === "") return { isDir: true, size: 0, mtime: 0, attrs: 0x10 };
    const n = this.index.get(rel);
    return n ? this.st(n) : null;
  }
  open(rel: string): VfsFile | null {
    const n = this.index.get(rel);
    return n && n.file ? new LazyFile(n.file) : null;
  }
  list(rel: string): { name: string; stat: VfsStat }[] | null {
    const d = this.dirs.get(rel);
    return d ? d.map((n) => ({ name: n.name, stat: this.st(n) })) : null;
  }
}

/** Read-only directory served over HTTP, described by a manifest {name: size}. */
export class HttpDirSource implements VfsSource {
  private sizes = new Map<string, number>();
  constructor(private base: string, manifest: Record<string, number>) {
    for (const [k, v] of Object.entries(manifest)) this.sizes.set(k.toLowerCase(), v);
  }
  stat(rel: string): VfsStat | null {
    if (rel === "") return { isDir: true, size: 0, mtime: 0, attrs: 0x10 };
    const s = this.sizes.get(rel);
    return s === undefined ? null : { isDir: false, size: s, mtime: 0, attrs: 0x20 };
  }
  open(rel: string): VfsFile | null {
    const size = this.sizes.get(rel);
    if (size === undefined) return null;
    const url = this.base + "/" + rel;
    let whole: Uint8Array | null = null;
    return {
      size,
      read(offset, out) {
        if (!whole) {
          const x = new XMLHttpRequest();
          x.open("GET", url, false);
          x.responseType = "arraybuffer";
          x.send();
          if (x.status !== 200) return 0;
          whole = new Uint8Array(x.response as ArrayBuffer);
        }
        if (offset >= whole.length) return 0;
        const n = Math.min(out.length, whole.length - offset);
        out.set(whole.subarray(offset, offset + n));
        return n;
      },
    };
  }
  list(rel: string): { name: string; stat: VfsStat }[] | null {
    if (rel !== "") return null;
    return [...this.sizes.entries()].map(([name, size]) => ({ name, stat: { isDir: false, size, mtime: 0, attrs: 0x20 } }));
  }
}
