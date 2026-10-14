// kernel32: files, directories, console, pipes, path helpers.
import type { Process, KObject } from "./process.ts";
import { ERROR, msToFileTime, TIME_EPOCH_DIFF } from "./k32-core.ts";
import { canon } from "./vfs.ts";
import type { VfsFile } from "./vfs.ts";

export const INVALID_HANDLE = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_APPEND_DATA = 4, FILE_WRITE_DATA = 2;
const FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_NORMAL = 0x80, FILE_ATTRIBUTE_ARCHIVE = 0x20;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

export interface FileObj extends KObject {
  type: "file";
  path: string;
  pos: number;
  canRead: boolean;
  canWrite: boolean;
  append: boolean;
  isDir: boolean;
  vf: VfsFile | null;
  dirty: boolean;
}
export interface ConsoleObj extends KObject {
  type: "console";
  which: "in" | "out" | "err";
}
export interface PipeObj extends KObject {
  type: "pipe";
  buf: { data: number[]; closedWrite: boolean };
  end: "read" | "write";
}
export interface FindObj extends KObject {
  type: "find";
  entries: { name: string; stat: { isDir: boolean; size: number; mtime: number; attrs: number } }[];
  index: number;
}

export function normalizeWinPath(p: string): string {
  const m = /^([a-zA-Z]:)?(.*)$/.exec(p)!;
  const drive = m[1] ?? "";
  const parts: string[] = [];
  const rooted = m[2].startsWith("\\");
  for (const seg of m[2].split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return drive + (rooted || drive ? "\\" : "") + parts.join("\\");
}

export function installKernel32File(p: Process) {
  const k = p.hle.module("kernel32.dll");
  const mem = p.mem;
  const vfs = p.vfs;

  const fullPath = (name: string): string => {
    name = name.replace(/^\\\\\?\\/, "").replace(/^\\\?\?\\/, "").replace(/\//g, "\\");
    if (/^[a-zA-Z]:\\/.test(name)) return normalizeWinPath(name);
    if (/^[a-zA-Z]:/.test(name)) return normalizeWinPath(p.cwd + "\\" + name.slice(2));
    if (name.startsWith("\\")) return normalizeWinPath(p.cwd.slice(0, 2) + name);
    return normalizeWinPath(p.cwd + "\\" + name);
  };
  p.ext.fullPath = fullPath;

  const stdObjs: Record<string, ConsoleObj> = {
    in: { type: "console", which: "in" },
    out: { type: "console", which: "out" },
    err: { type: "console", which: "err" },
  };
  const stdHandles = { in: p.handles.alloc(stdObjs.in), out: p.handles.alloc(stdObjs.out), err: p.handles.alloc(stdObjs.err) };
  let curStd: Record<number, number> = { [-10]: stdHandles.in, [-11]: stdHandles.out, [-12]: stdHandles.err };

  k.fn("GetStdHandle", (c) => curStd[c.argI(0)] ?? INVALID_HANDLE);
  k.fn("SetStdHandle", (c) => { curStd[c.argI(0)] = c.arg(1); return 1; });

  const getFile = (h: number): FileObj | null => {
    const o = p.handles.get(h);
    return o && o.type === "file" ? (o as FileObj) : null;
  };
  const reopen = (f: FileObj) => {
    if (!f.vf || f.dirty) {
      f.vf = vfs.open(f.path);
      f.dirty = false;
    }
    return f.vf;
  };

  const createFile = (name: string, access: number, disp: number, flags: number): bigint | number => {
    const lname = name.toLowerCase();
    if (lname === "conout$" || lname === "con") return stdHandles.out;
    if (lname === "conin$") return stdHandles.in;
    if (lname === "nul") return p.handles.alloc({ type: "console", which: "err", nul: true });
    if (lname.startsWith("\\\\.\\") && !/^\\\\\.\\[a-z]:/i.test(name)) {
      p.setLastError(ERROR.FILE_NOT_FOUND);
      return INVALID_HANDLE;
    }
    const path = fullPath(name);
    const st = vfs.stat(path);
    const wantWrite = (access & (GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA)) !== 0;
    const o: FileObj = { type: "file", path, pos: 0, canRead: !wantWrite || (access & GENERIC_READ) !== 0 || access === 0 || (access & 1) !== 0, canWrite: wantWrite,
      append: (access & FILE_APPEND_DATA) !== 0 && !(access & FILE_WRITE_DATA) && !(access & GENERIC_WRITE), isDir: false, vf: null, dirty: false };
    if (st && st.isDir) {
      if (!(flags & 0x02000000)) { p.setLastError(ERROR.ACCESS_DENIED); return INVALID_HANDLE; }
      o.isDir = true;
      return p.handles.alloc(o);
    }
    switch (disp) {
      case 1: // CREATE_NEW
        if (st) { p.setLastError(ERROR.FILE_EXISTS); return INVALID_HANDLE; }
        if (!vfs.create(path, true)) { p.setLastError(ERROR.PATH_NOT_FOUND); return INVALID_HANDLE; }
        break;
      case 2: // CREATE_ALWAYS
        if (!vfs.create(path, true)) { p.setLastError(ERROR.PATH_NOT_FOUND); return INVALID_HANDLE; }
        if (st) p.setLastError(ERROR.ALREADY_EXISTS);
        break;
      case 3: // OPEN_EXISTING
        if (!st) {
          const parent = path.slice(0, path.lastIndexOf("\\"));
          p.setLastError(parent.length > 2 && !vfs.exists(parent) ? ERROR.PATH_NOT_FOUND : ERROR.FILE_NOT_FOUND);
          return INVALID_HANDLE;
        }
        break;
      case 4: // OPEN_ALWAYS
        if (!st) {
          if (!vfs.create(path, true)) { p.setLastError(ERROR.PATH_NOT_FOUND); return INVALID_HANDLE; }
        } else p.setLastError(ERROR.ALREADY_EXISTS);
        break;
      case 5: // TRUNCATE_EXISTING
        if (!st) { p.setLastError(ERROR.FILE_NOT_FOUND); return INVALID_HANDLE; }
        vfs.create(path, true);
        break;
      default:
        p.setLastError(ERROR.INVALID_PARAMETER);
        return INVALID_HANDLE;
    }
    if (!st && !wantWrite && disp !== 3) { /* created empty */ }
    o.vf = vfs.open(path);
    if (o.append) o.pos = vfs.stat(path)?.size ?? 0;
    return p.handles.alloc(o);
  };
  k.fn("CreateFileW", (c) => createFile(mem.wstr(c.arg(0)), c.arg(1), c.arg(4), c.arg(5)));
  k.fn("CreateFileA", (c) => createFile(mem.cstr(c.arg(0)), c.arg(1), c.arg(4), c.arg(5)));
  k.fn("CreateFile2", (c) => createFile(mem.wstr(c.arg(0)), c.arg(1), c.arg(3), 0));

  k.fn("CloseHandle", (c) => {
    const h = c.arg(0);
    const o = p.handles.get(h);
    if (!o) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (o.type === "console") return 1;
    if (o.type === "pipe" && o.end === "write") o.buf.closedWrite = true;
    p.handles.close(h);
    return 1;
  });
  k.fn("DuplicateHandle", (c) => {
    const o = p.handles.get(c.arg(1));
    if (!o) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const nh = p.handles.alloc(o);
    if (c.arg(3)) mem.wptr(c.arg(3), nh);
    return 1;
  });
  k.fn("SetHandleInformation", () => 1);
  k.fn("GetHandleInformation", (c) => { mem.w32(c.arg(1), 0); return 1; });
  k.fn("CompareObjectHandles", (c) => (p.handles.get(c.arg(0)) === p.handles.get(c.arg(1)) ? 1 : 0));

  const writeConsole = (o: ConsoleObj, data: Uint8Array) => {
    if ((o as any).nul) return;
    const sink = o.which === "err" ? p.opts.stderr : p.opts.stdout;
    if (sink) sink(data.slice());
  };

  // ---- OVERLAPPED completion helpers ----
  const completeOverlapped = (ov: number, n: number, status = 0) => {
    mem.w64(ov, BigInt(status));
    mem.w64(ov + 8, BigInt(n));
    const ev = mem.r32(ov + 24);
    if (ev) {
      const eo = p.handles.get(ev & ~1);
      if (eo && eo.type === "event") (eo as any).signaled = true;
    }
  };

  k.fn("WriteFile", (c) => {
    const h = c.arg(0), buf = c.arg(1), n = c.arg(2), outN = c.arg(3), ov = c.arg(4);
    const o = p.handles.get(h);
    if (!o) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (o.type === "console") {
      writeConsole(o as ConsoleObj, mem.bytes(buf, n));
      if (outN) mem.w32(outN, n);
      return 1;
    }
    if (o.type === "pipe") {
      const po = o as PipeObj;
      for (let i = 0; i < n; i++) po.buf.data.push(mem.r8(buf + i));
      if (outN) mem.w32(outN, n);
      return 1;
    }
    if (o.type !== "file") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const f = o as FileObj;
    if (!f.canWrite) { p.setLastError(ERROR.ACCESS_DENIED); return 0; }
    let pos = f.pos;
    if (ov) pos = mem.r32(ov + 16) + mem.r32(ov + 20) * 4294967296;
    else if (f.append) pos = vfs.stat(f.path)?.size ?? 0;
    vfs.writeAt(f.path, pos, mem.bytes(buf, n).slice());
    f.dirty = true;
    if (!ov) f.pos = pos + n;
    if (outN) mem.w32(outN, n);
    if (ov) completeOverlapped(ov, n);
    return 1;
  });
  k.fn("ReadFile", (c) => {
    const h = c.arg(0), buf = c.arg(1), n = c.arg(2), outN = c.arg(3), ov = c.arg(4);
    const o = p.handles.get(h);
    if (!o) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (o.type === "console") { if (outN) mem.w32(outN, 0); return 1; }
    if (o.type === "pipe") {
      const po = o as PipeObj;
      const got = Math.min(n, po.buf.data.length);
      for (let i = 0; i < got; i++) mem.w8(buf + i, po.buf.data.shift()!);
      if (outN) mem.w32(outN, got);
      if (got === 0 && po.buf.closedWrite) { p.setLastError(ERROR.BROKEN_PIPE); return 0; }
      return 1;
    }
    if (o.type !== "file") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const f = o as FileObj;
    const vf = reopen(f);
    if (!vf) { if (outN) mem.w32(outN, 0); return 1; }
    let pos = f.pos;
    if (ov) pos = mem.r32(ov + 16) + mem.r32(ov + 20) * 4294967296;
    let got = 0;
    if (pos < vf.size) {
      got = vf.read(pos, mem.bytes(buf, Math.min(n, vf.size - pos)));
    }
    if (!ov) f.pos = pos + got;
    if (outN) mem.w32(outN, got);
    if (ov) {
      completeOverlapped(ov, got, got === 0 ? 0xc0000011 : 0);
      if (got === 0 && n > 0) { p.setLastError(ERROR.HANDLE_EOF); return 0; }
    }
    return 1;
  });
  k.fn("ReadFileEx", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("WriteFileEx", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("GetOverlappedResult", (c) => {
    const ov = c.arg(1);
    if (c.arg(2)) mem.w32(c.arg(2), mem.r32(ov + 8));
    return 1;
  });
  k.fn("GetOverlappedResultEx", (c) => {
    const ov = c.arg(1);
    if (c.arg(2)) mem.w32(c.arg(2), mem.r32(ov + 8));
    return 1;
  });
  k.fn("CancelIo", () => 1);
  k.fn("CancelIoEx", () => 1);

  k.fn("SetFilePointer", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0xffffffff; }
    let off = c.argI(1);
    if (c.arg(2)) off += mem.ri32(c.arg(2)) * 4294967296;
    const size = vfs.stat(f.path)?.size ?? 0;
    const base = c.arg(3) === 0 ? 0 : c.arg(3) === 1 ? f.pos : size;
    const np = base + off;
    if (np < 0) { p.setLastError(ERROR.INVALID_PARAMETER); return 0xffffffff; }
    f.pos = np;
    if (c.arg(2)) mem.w32(c.arg(2), Math.floor(np / 4294967296));
    return np >>> 0;
  });
  k.fn("SetFilePointerEx", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const off = Number(BigInt.asIntN(64, c.arg64(1)));
    const size = vfs.stat(f.path)?.size ?? 0;
    const base = c.arg(3) === 0 ? 0 : c.arg(3) === 1 ? f.pos : size;
    const np = base + off;
    if (np < 0) { p.setLastError(ERROR.INVALID_PARAMETER); return 0; }
    f.pos = np;
    if (c.arg(2)) mem.w64(c.arg(2), BigInt(np));
    return 1;
  });
  k.fn("GetFileSize", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0xffffffff; }
    const sz = vfs.stat(f.path)?.size ?? 0;
    if (c.arg(1)) mem.w32(c.arg(1), Math.floor(sz / 4294967296));
    return sz >>> 0;
  });
  k.fn("GetFileSizeEx", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    mem.w64(c.arg(1), BigInt(vfs.stat(f.path)?.size ?? 0));
    return 1;
  });
  k.fn("SetEndOfFile", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    vfs.setSize(f.path, f.pos);
    f.dirty = true;
    return 1;
  });
  k.fn("SetFileValidData", () => 1);
  k.fn("FlushFileBuffers", () => 1);
  k.fn("LockFile", () => 1);
  k.fn("UnlockFile", () => 1);
  k.fn("LockFileEx", () => 1);
  k.fn("UnlockFileEx", () => 1);
  k.fn("GetFileType", (c) => {
    const o = p.handles.get(c.arg(0));
    if (!o) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    return o.type === "console" ? 2 : o.type === "pipe" ? 3 : 1;
  });
  const toFt = (ms: number) => (ms ? msToFileTime(ms) : TIME_EPOCH_DIFF);
  k.fn("GetFileTime", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const st = vfs.stat(f.path);
    const t = toFt(st?.mtime ?? 0);
    for (let i = 1; i <= 3; i++) if (c.arg(i)) mem.w64(c.arg(i), t);
    return 1;
  });
  k.fn("SetFileTime", () => 1);
  k.fn("GetFileInformationByHandle", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const st = vfs.stat(f.path);
    const a = c.arg(1);
    mem.fill(a, 0, 52);
    mem.w32(a, st?.attrs ?? FILE_ATTRIBUTE_NORMAL);
    const t = toFt(st?.mtime ?? 0);
    mem.w64(a + 4, t); mem.w64(a + 12, t); mem.w64(a + 20, t);
    mem.w32(a + 28, 0x1234);
    mem.w32(a + 32, Math.floor((st?.size ?? 0) / 4294967296));
    mem.w32(a + 36, (st?.size ?? 0) >>> 0);
    mem.w32(a + 40, 1);
    mem.w32(a + 44, 0);
    mem.w32(a + 48, 1);
    return 1;
  });
  k.fn("GetFileInformationByHandleEx", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("SetFileInformationByHandle", () => 1);
  k.fn("GetFinalPathNameByHandleW", (c) => {
    const f = getFile(c.arg(0));
    if (!f) { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    const s = "\\\\?\\" + f.path;
    if (s.length + 1 > c.arg(2)) return s.length + 1;
    mem.wwstr(c.arg(1), s);
    return s.length;
  });
  k.fn("NtQueryInformationFile", () => 0xc00000bb);

  // ---- attributes and file system operations ----
  const attrsOf = (path: string): number => {
    const st = vfs.stat(path);
    if (!st) return INVALID_FILE_ATTRIBUTES;
    return st.isDir ? FILE_ATTRIBUTE_DIRECTORY : st.attrs || FILE_ATTRIBUTE_ARCHIVE;
  };
  const notFound = (path: string) => {
    const parent = path.slice(0, path.lastIndexOf("\\"));
    p.setLastError(parent.length > 2 && !vfs.exists(parent) ? ERROR.PATH_NOT_FOUND : ERROR.FILE_NOT_FOUND);
  };
  const getAttr = (name: string) => {
    const path = fullPath(name);
    const a = attrsOf(path);
    if (a === INVALID_FILE_ATTRIBUTES) notFound(path);
    return a;
  };
  k.fn("GetFileAttributesW", (c) => getAttr(mem.wstr(c.arg(0))));
  k.fn("GetFileAttributesA", (c) => getAttr(mem.cstr(c.arg(0))));
  const getAttrEx = (name: string, out: number) => {
    const path = fullPath(name);
    const st = vfs.stat(path);
    if (!st) { notFound(path); return 0; }
    mem.w32(out, st.isDir ? FILE_ATTRIBUTE_DIRECTORY : st.attrs || FILE_ATTRIBUTE_ARCHIVE);
    const t = toFt(st.mtime);
    mem.w64(out + 4, t); mem.w64(out + 12, t); mem.w64(out + 20, t);
    mem.w32(out + 28, Math.floor(st.size / 4294967296));
    mem.w32(out + 32, st.size >>> 0);
    return 1;
  };
  k.fn("GetFileAttributesExW", (c) => getAttrEx(mem.wstr(c.arg(0)), c.arg(2)));
  k.fn("GetFileAttributesExA", (c) => getAttrEx(mem.cstr(c.arg(0)), c.arg(2)));
  k.fn("SetFileAttributesW", () => 1);
  k.fn("SetFileAttributesA", () => 1);
  const delFile = (name: string) => {
    const path = fullPath(name);
    const st = vfs.stat(path);
    if (!st) { notFound(path); return 0; }
    if (st.isDir) { p.setLastError(ERROR.ACCESS_DENIED); return 0; }
    vfs.delete(path);
    return 1;
  };
  k.fn("DeleteFileW", (c) => delFile(mem.wstr(c.arg(0))));
  k.fn("DeleteFileA", (c) => delFile(mem.cstr(c.arg(0))));
  const mkdir = (name: string) => {
    const path = fullPath(name);
    if (vfs.exists(path)) { p.setLastError(ERROR.ALREADY_EXISTS); return 0; }
    if (!vfs.mkdir(path)) { p.setLastError(ERROR.PATH_NOT_FOUND); return 0; }
    return 1;
  };
  k.fn("CreateDirectoryW", (c) => mkdir(mem.wstr(c.arg(0))));
  k.fn("CreateDirectoryA", (c) => mkdir(mem.cstr(c.arg(0))));
  k.fn("CreateDirectoryExW", (c) => mkdir(mem.wstr(c.arg(1))));
  const rmdir = (name: string) => {
    const path = fullPath(name);
    const st = vfs.stat(path);
    if (!st || !st.isDir) { p.setLastError(ERROR.PATH_NOT_FOUND); return 0; }
    if (!vfs.rmdir(path)) { p.setLastError(ERROR.DIR_NOT_EMPTY); return 0; }
    return 1;
  };
  k.fn("RemoveDirectoryW", (c) => rmdir(mem.wstr(c.arg(0))));
  k.fn("RemoveDirectoryA", (c) => rmdir(mem.cstr(c.arg(0))));
  const moveFile = (a: string, b: string, flags = 0) => {
    const from = fullPath(a), to = fullPath(b);
    if (!vfs.exists(from)) { notFound(from); return 0; }
    if (!vfs.rename(from, to, (flags & 1) !== 0)) { p.setLastError(ERROR.ALREADY_EXISTS); return 0; }
    return 1;
  };
  k.fn("MoveFileW", (c) => moveFile(mem.wstr(c.arg(0)), mem.wstr(c.arg(1))));
  k.fn("MoveFileA", (c) => moveFile(mem.cstr(c.arg(0)), mem.cstr(c.arg(1))));
  k.fn("MoveFileExW", (c) => moveFile(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), c.arg(2)));
  k.fn("MoveFileExA", (c) => moveFile(mem.cstr(c.arg(0)), mem.cstr(c.arg(1)), c.arg(2)));
  const copyFile = (a: string, b: string, failIfExists: boolean) => {
    const from = fullPath(a), to = fullPath(b);
    const data = vfs.readAll(from);
    if (!data) { notFound(from); return 0; }
    if (failIfExists && vfs.exists(to)) { p.setLastError(ERROR.FILE_EXISTS); return 0; }
    vfs.writeFile(to, data);
    return 1;
  };
  k.fn("CopyFileW", (c) => copyFile(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), c.arg(2) !== 0));
  k.fn("CopyFileA", (c) => copyFile(mem.cstr(c.arg(0)), mem.cstr(c.arg(1)), c.arg(2) !== 0));
  k.fn("CopyFileExW", (c) => copyFile(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), (c.arg(5) & 1) !== 0));
  k.fn("CreateHardLinkW", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("CreateHardLinkA", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("CreateSymbolicLinkW", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("CreateSymbolicLinkA", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });
  k.fn("ReplaceFileW", () => 0);
  k.fn("DeviceIoControl", () => { p.setLastError(ERROR.NOT_SUPPORTED); return 0; });

  // ---- paths ----
  const outStrA = (s: string, buf: number, size: number) => {
    if (s.length + 1 > size) return s.length + 1;
    mem.wcstr(buf, s);
    return s.length;
  };
  const outStrW = (s: string, buf: number, size: number) => {
    if (s.length + 1 > size) return s.length + 1;
    mem.wwstr(buf, s);
    return s.length;
  };
  k.fn("GetCurrentDirectoryA", (c) => outStrA(p.cwd, c.arg(1), c.arg(0)));
  k.fn("GetCurrentDirectoryW", (c) => outStrW(p.cwd, c.arg(1), c.arg(0)));
  const setCwd = (name: string) => {
    const path = fullPath(name);
    const st = vfs.stat(path);
    if (!st || !st.isDir) { p.setLastError(ERROR.PATH_NOT_FOUND); return 0; }
    p.cwd = path;
    return 1;
  };
  k.fn("SetCurrentDirectoryA", (c) => setCwd(mem.cstr(c.arg(0))));
  k.fn("SetCurrentDirectoryW", (c) => setCwd(mem.wstr(c.arg(0))));
  const getFull = (name: string, buf: number, size: number, filePart: number, wide: boolean) => {
    const s = fullPath(name);
    if (s.length + 1 > size) return s.length + 1;
    if (wide) mem.wwstr(buf, s); else mem.wcstr(buf, s);
    if (filePart) {
      const i = s.lastIndexOf("\\");
      mem.wptr(filePart, i >= 0 && !s.endsWith("\\") ? buf + (i + 1) * (wide ? 2 : 1) : 0);
    }
    return s.length;
  };
  k.fn("GetFullPathNameA", (c) => getFull(mem.cstr(c.arg(0)), c.arg(2), c.arg(1), c.arg(3), false));
  k.fn("GetFullPathNameW", (c) => getFull(mem.wstr(c.arg(0)), c.arg(2), c.arg(1), c.arg(3), true));
  k.fn("GetLongPathNameA", (c) => outStrA(fullPath(mem.cstr(c.arg(0))), c.arg(1), c.arg(2)));
  k.fn("GetLongPathNameW", (c) => outStrW(fullPath(mem.wstr(c.arg(0))), c.arg(1), c.arg(2)));
  k.fn("GetShortPathNameA", (c) => outStrA(fullPath(mem.cstr(c.arg(0))), c.arg(1), c.arg(2)));
  k.fn("GetShortPathNameW", (c) => outStrW(fullPath(mem.wstr(c.arg(0))), c.arg(1), c.arg(2)));
  const TEMP = "C:\\Users\\user\\AppData\\Local\\Temp\\";
  k.fn("GetTempPathA", (c) => outStrA(TEMP, c.arg(1), c.arg(0)));
  k.fn("GetTempPathW", (c) => outStrW(TEMP, c.arg(1), c.arg(0)));
  let tempCounter = 1;
  const tempName = (dir: string, prefix: string, unique: number, buf: number, wide: boolean) => {
    const n = unique || tempCounter++;
    const s = `${dir.endsWith("\\") ? dir : dir + "\\"}${prefix.slice(0, 3)}${n.toString(16).toUpperCase()}.tmp`;
    if (!unique) vfs.create(s, true);
    if (wide) mem.wwstr(buf, s); else mem.wcstr(buf, s);
    return n;
  };
  k.fn("GetTempFileNameA", (c) => tempName(mem.cstr(c.arg(0)), mem.cstr(c.arg(1)), c.arg(2), c.arg(3), false));
  k.fn("GetTempFileNameW", (c) => tempName(mem.wstr(c.arg(0)), mem.wstr(c.arg(1)), c.arg(2), c.arg(3), true));
  k.fn("GetDriveTypeA", (c) => (/^[cC]:/.test(mem.cstr(c.arg(0))) || !c.arg(0) ? 3 : 1));
  k.fn("GetDriveTypeW", (c) => (/^[cC]:/.test(mem.wstr(c.arg(0))) || !c.arg(0) ? 3 : 1));
  k.fn("GetLogicalDrives", () => 4);
  k.fn("GetLogicalDriveStringsA", (c) => { if (c.arg(0) >= 8) { mem.wcstr(c.arg(1), "C:\\"); mem.w8(c.arg(1) + 4, 0); } return 4; });
  k.fn("GetLogicalDriveStringsW", (c) => { if (c.arg(0) >= 8) { mem.wwstr(c.arg(1), "C:\\"); mem.w16(c.arg(1) + 8, 0); } return 4; });
  k.fn("GetVolumeInformationA", (c) => {
    if (c.arg(1)) mem.wcstr(c.arg(1), "Chrome.EXE", c.arg(2));
    if (c.arg(3)) mem.w32(c.arg(3), 0x12345678);
    if (c.arg(4)) mem.w32(c.arg(4), 255);
    if (c.arg(5)) mem.w32(c.arg(5), 0x3f);
    if (c.arg(6)) mem.wcstr(c.arg(6), "NTFS", c.arg(7));
    return 1;
  });
  k.fn("GetVolumeInformationW", (c) => {
    if (c.arg(1)) mem.wwstr(c.arg(1), "Chrome.EXE", c.arg(2));
    if (c.arg(3)) mem.w32(c.arg(3), 0x12345678);
    if (c.arg(4)) mem.w32(c.arg(4), 255);
    if (c.arg(5)) mem.w32(c.arg(5), 0x3f);
    if (c.arg(6)) mem.wwstr(c.arg(6), "NTFS", c.arg(7));
    return 1;
  });
  const diskFree = (c: any) => {
    if (c.arg(1)) mem.w64(c.arg(1), 100n * 1024n ** 3n);
    if (c.arg(2)) mem.w64(c.arg(2), 200n * 1024n ** 3n);
    if (c.arg(3)) mem.w64(c.arg(3), 100n * 1024n ** 3n);
    return 1;
  };
  k.fn("GetDiskFreeSpaceExA", diskFree);
  k.fn("GetDiskFreeSpaceExW", diskFree);
  const diskFree2 = (c: any) => {
    mem.w32(c.arg(1), 8); mem.w32(c.arg(2), 512); mem.w32(c.arg(3), 0x10000000); mem.w32(c.arg(4), 0x20000000);
    return 1;
  };
  k.fn("GetDiskFreeSpaceA", diskFree2);
  k.fn("GetDiskFreeSpaceW", diskFree2);
  const searchPath = (dir: string | null, file: string, ext: string | null, buf: number, size: number, wide: boolean) => {
    const dirs = dir ? [dir] : [p.exePath.slice(0, p.exePath.lastIndexOf("\\")), p.cwd, "C:\\Windows\\System32", "C:\\Windows"];
    for (const d of dirs) {
      for (const f of [file, ext && !/\.[^\\.]+$/.test(file) ? file + ext : file]) {
        const full = fullPath(d + "\\" + f);
        if (vfs.exists(full)) {
          if (full.length + 1 > size) return full.length + 1;
          if (wide) mem.wwstr(buf, full); else mem.wcstr(buf, full);
          return full.length;
        }
      }
    }
    p.setLastError(ERROR.FILE_NOT_FOUND);
    return 0;
  };
  k.fn("SearchPathW", (c) => searchPath(c.arg(0) ? mem.wstr(c.arg(0)) : null, mem.wstr(c.arg(1)), c.arg(2) ? mem.wstr(c.arg(2)) : null, c.arg(4), c.arg(3), true));
  k.fn("SearchPathA", (c) => searchPath(c.arg(0) ? mem.cstr(c.arg(0)) : null, mem.cstr(c.arg(1)), c.arg(2) ? mem.cstr(c.arg(2)) : null, c.arg(4), c.arg(3), false));

  // ---- directory enumeration ----
  const wildToRegex = (pat: string) => {
    let re = "^";
    for (const ch of pat.toLowerCase()) {
      if (ch === "*") re += ".*";
      else if (ch === "?") re += ".";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(re + "$");
  };
  const startFind = (pattern: string): number | null => {
    const full = fullPath(pattern);
    const i = full.lastIndexOf("\\");
    const dir = full.slice(0, i) || full.slice(0, 2) + "\\", pat = full.slice(i + 1) || "*";
    const list = vfs.list(dir);
    if (!list) { p.setLastError(ERROR.PATH_NOT_FOUND); return null; }
    const re = wildToRegex(pat === "*.*" ? "*" : pat);
    const entries = list.filter((e) => re.test(e.name.toLowerCase()));
    if (dir.length > 3 && re.test(".")) entries.unshift({ name: ".", stat: { isDir: true, size: 0, mtime: 0, attrs: 0x10 } }, { name: "..", stat: { isDir: true, size: 0, mtime: 0, attrs: 0x10 } });
    // restore original-case names where the VFS keeps lowercase canonical names (mounted sources preserve case)
    if (!entries.length) { p.setLastError(ERROR.FILE_NOT_FOUND); return null; }
    return p.handles.alloc({ type: "find", entries, index: 0 } as FindObj);
  };
  const fillFindData = (e: FindObj["entries"][0], out: number, wide: boolean) => {
    mem.fill(out, 0, wide ? 592 : 320);
    mem.w32(out, e.stat.isDir ? FILE_ATTRIBUTE_DIRECTORY : e.stat.attrs || FILE_ATTRIBUTE_ARCHIVE);
    const t = toFt(e.stat.mtime);
    mem.w64(out + 4, t); mem.w64(out + 12, t); mem.w64(out + 20, t);
    mem.w32(out + 28, Math.floor(e.stat.size / 4294967296));
    mem.w32(out + 32, e.stat.size >>> 0);
    if (wide) mem.wwstr(out + 44, e.name, 260); else mem.wcstr(out + 44, e.name, 260);
  };
  const findFirst = (pattern: string, out: number, wide: boolean) => {
    const h = startFind(pattern);
    if (h === null) return INVALID_HANDLE;
    const o = p.handles.get(h) as FindObj;
    fillFindData(o.entries[o.index++], out, wide);
    return h;
  };
  k.fn("FindFirstFileW", (c) => findFirst(mem.wstr(c.arg(0)), c.arg(1), true));
  k.fn("FindFirstFileA", (c) => findFirst(mem.cstr(c.arg(0)), c.arg(1), false));
  k.fn("FindFirstFileExW", (c) => findFirst(mem.wstr(c.arg(0)), c.arg(2), true));
  k.fn("FindFirstFileExA", (c) => findFirst(mem.cstr(c.arg(0)), c.arg(2), false));
  const findNext = (h: number, out: number, wide: boolean) => {
    const o = p.handles.get(h) as FindObj | undefined;
    if (!o || o.type !== "find") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (o.index >= o.entries.length) { p.setLastError(ERROR.NO_MORE_FILES); return 0; }
    fillFindData(o.entries[o.index++], out, wide);
    return 1;
  };
  k.fn("FindNextFileW", (c) => findNext(c.arg(0), c.arg(1), true));
  k.fn("FindNextFileA", (c) => findNext(c.arg(0), c.arg(1), false));
  k.fn("FindClose", (c) => (p.handles.close(c.arg(0)) ? 1 : 0));

  // ---- pipes ----
  k.fn("CreatePipe", (c) => {
    const buf = { data: [] as number[], closedWrite: false };
    const r = p.handles.alloc({ type: "pipe", buf, end: "read" } as PipeObj);
    const w = p.handles.alloc({ type: "pipe", buf, end: "write" } as PipeObj);
    mem.wptr(c.arg(0), r);
    mem.wptr(c.arg(1), w);
    return 1;
  });
  k.fn("PeekNamedPipe", (c) => {
    const o = p.handles.get(c.arg(0)) as PipeObj | undefined;
    if (!o || o.type !== "pipe") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    if (c.arg(4)) mem.w32(c.arg(4), o.buf.data.length);
    return 1;
  });
  k.fn("CreateProcessW", () => { p.setLastError(ERROR.FILE_NOT_FOUND); return 0; });
  k.fn("CreateProcessA", () => { p.setLastError(ERROR.FILE_NOT_FOUND); return 0; });

  // ---- console ----
  k.fn("GetConsoleMode", (c) => { const o = p.handles.get(c.arg(0)); if (!o || o.type !== "console") { p.setLastError(ERROR.INVALID_HANDLE); return 0; } mem.w32(c.arg(1), 3); return 1; });
  k.fn("SetConsoleMode", () => 1);
  k.fn("GetConsoleOutputCP", () => 65001);
  k.fn("GetConsoleCP", () => 65001);
  k.fn("SetConsoleOutputCP", () => 1);
  k.fn("SetConsoleCP", () => 1);
  k.fn("AllocConsole", () => 1);
  k.fn("FreeConsole", () => 1);
  k.fn("AttachConsole", () => 1);
  k.fn("GetConsoleWindow", () => 0);
  k.fn("SetConsoleTitleA", () => 1);
  k.fn("SetConsoleTitleW", () => 1);
  k.fn("SetConsoleCtrlHandler", () => 1);
  k.fn("SetConsoleTextAttribute", () => 1);
  k.fn("FlushConsoleInputBuffer", () => 1);
  k.fn("VerifyConsoleIoHandle", () => 1);
  k.fn("GetNumberOfConsoleInputEvents", (c) => { mem.w32(c.arg(1), 0); return 1; });
  for (const n of ["ReadConsoleInputA", "ReadConsoleInputW", "PeekConsoleInputA", "PeekConsoleInputW"]) k.fn(n, (c) => { if (c.arg(3)) mem.w32(c.arg(3), 0); return 1; });
  for (const n of ["ReadConsoleA", "ReadConsoleW"]) k.fn(n, (c) => { if (c.arg(3)) mem.w32(c.arg(3), 0); return 1; });
  k.fn("GetConsoleScreenBufferInfo", (c) => {
    const a = c.arg(1);
    mem.fill(a, 0, 22);
    mem.w16(a, 120); mem.w16(a + 2, 30); mem.w16(a + 8, 7); mem.w16(a + 12, 119); mem.w16(a + 14, 29); mem.w16(a + 16, 119); mem.w16(a + 18, 29);
    mem.w16(a + 4, 0);
    return 1;
  });
  k.fn("GetConsoleCursorInfo", (c) => { mem.w32(c.arg(1), 25); mem.w32(c.arg(1) + 4, 1); return 1; });
  k.fn("GetLargestConsoleWindowSize", () => (30 << 16) | 120);
  k.fn("WriteConsoleA", (c) => {
    const o = p.handles.get(c.arg(0)) as ConsoleObj | undefined;
    if (!o || o.type !== "console") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    writeConsole(o, mem.bytes(c.arg(1), c.arg(2)));
    if (c.arg(3)) mem.w32(c.arg(3), c.arg(2));
    return 1;
  });
  k.fn("WriteConsoleW", (c) => {
    const o = p.handles.get(c.arg(0)) as ConsoleObj | undefined;
    if (!o || o.type !== "console") { p.setLastError(ERROR.INVALID_HANDLE); return 0; }
    writeConsole(o, new TextEncoder().encode(mem.wstrn(c.arg(1), c.arg(2))));
    if (c.arg(3)) mem.w32(c.arg(3), c.arg(2));
    return 1;
  });
  void canon;
  curStd = curStd;
}
