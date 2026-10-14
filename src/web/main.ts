// Page controller: drag-and-drop, worker lifecycle, window/canvas layout, and input forwarding.
import type { FromWorker, InitMsg, ToWorker } from "./protocol.ts";
import type { TreeNode } from "./vfs.ts";
import type { GamepadState, HostEvent, WindowInfo } from "../win32/host.ts";
import { KEYMAP } from "./keymap.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface WinView { info: WindowInfo; wrap: HTMLDivElement; title: HTMLDivElement; canvas: HTMLCanvasElement; idx: number }

const emu: any = (window as any).__emu = {
  state: "idle", exitCode: null as number | null, crash: null as string | null, stdout: "", stderr: "", log: [] as string[], windows: {} as Record<number, any>, fps: 0, messageBoxes: [] as string[],
  worker: null as Worker | null,
};

let worker: Worker | null = null;
const wins = new Map<number, WinView>();
const pool: { canvas: HTMLCanvasElement; used: boolean }[] = [];
let screenW = 1280, screenH = 720, scale = 1;
let lockWanted = false;
let cursorHidden = false;
let padTimer = 0;

function setState(s: string, msg = "") {
  emu.state = s;
  $("status").textContent = msg || s;
  document.body.dataset.state = s;
}

// ------------------------------------------------------------------------------------------------------------------
// reading dropped content
// ------------------------------------------------------------------------------------------------------------------
async function readEntries(reader: any): Promise<any[]> {
  const out: any[] = [];
  for (;;) {
    const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
}
async function entryToNode(entry: any, budget: { files: number }): Promise<TreeNode | null> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    budget.files++;
    return { name: entry.name, file };
  }
  if (entry.isDirectory) {
    const kids: TreeNode[] = [];
    for (const e of await readEntries(entry.createReader())) {
      const n = await entryToNode(e, budget);
      if (n) kids.push(n);
    }
    return { name: entry.name, children: kids };
  }
  return null;
}
export async function treeFromDataTransfer(dt: DataTransfer): Promise<TreeNode[]> {
  const roots: TreeNode[] = [];
  const budget = { files: 0 };
  const items = [...dt.items].filter((i) => i.kind === "file");
  const entries = items.map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const e of entries) {
      const n = await entryToNode(e, budget);
      if (n) roots.push(n);
    }
  } else {
    for (const f of dt.files) roots.push({ name: f.name, file: f });
  }
  return roots;
}
function treeFromFileList(files: FileList): TreeNode[] {
  const root: TreeNode = { name: "", children: [] };
  for (const f of files) {
    const rel = (f as any).webkitRelativePath || f.name;
    const parts = rel.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.children!.find((c) => c.name === parts[i] && c.children);
      if (!next) { next = { name: parts[i], children: [] }; cur.children!.push(next); }
      cur = next;
    }
    cur.children!.push({ name: parts[parts.length - 1], file: f });
  }
  return root.children!;
}

/** All .exe files in the tree: [path, size, depth] */
function findExes(nodes: TreeNode[], prefix = "", depth = 0, out: { path: string; size: number; depth: number }[] = []) {
  for (const n of nodes) {
    const p = prefix ? prefix + "/" + n.name : n.name;
    if (n.children) findExes(n.children, p, depth + 1, out);
    else if (/\.exe$/i.test(n.name)) out.push({ path: p, size: n.file!.size, depth });
  }
  return out;
}
const JUNK = /(unins|setup|install|redist|vcredist|dxsetup|dotnet|crash|report|helper|updater|launcher_|cef|webhelper|vc_redist)/i;
function pickExe(exes: { path: string; size: number; depth: number }[]) {
  const good = exes.filter((e) => !JUNK.test(e.path.split("/").pop()!));
  const pool = good.length ? good : exes;
  pool.sort((a, b) => a.depth - b.depth || b.size - a.size);
  return pool[0];
}

// ------------------------------------------------------------------------------------------------------------------
// layout
// ------------------------------------------------------------------------------------------------------------------
function chooseScreen(): { w: number; h: number } {
  const sel = ($("res") as HTMLSelectElement).value;
  if (sel !== "auto") { const [w, h] = sel.split("x").map(Number); return { w, h }; }
  const stage = $("stage");
  const w = Math.max(640, Math.min(3840, stage.clientWidth)), h = Math.max(480, Math.min(2160, stage.clientHeight));
  return { w: w & ~1, h: h & ~1 };
}
function layout() {
  const stage = $("stage");
  const sc = $("screen");
  scale = Math.min(stage.clientWidth / screenW, stage.clientHeight / screenH);
  sc.style.width = screenW + "px";
  sc.style.height = screenH + "px";
  sc.style.transform = `scale(${scale})`;
  sc.style.left = Math.max(0, (stage.clientWidth - screenW * scale) / 2) + "px";
  sc.style.top = Math.max(0, (stage.clientHeight - screenH * scale) / 2) + "px";
}
function placeWindow(v: WinView) {
  const i = v.info;
  const hasCaption = (i.style & 0xc00000) === 0xc00000;
  const border = Math.max(0, Math.round((i.w - i.cw) / 2));
  const capH = hasCaption ? Math.max(0, i.h - i.ch - border * 2) : 0;
  v.wrap.style.left = i.x + "px";
  v.wrap.style.top = i.y + "px";
  v.wrap.style.width = i.w + "px";
  v.wrap.style.height = i.h + "px";
  v.wrap.style.display = i.visible ? "block" : "none";
  v.wrap.classList.toggle("framed", border > 0 || hasCaption);
  v.title.style.display = hasCaption ? "block" : "none";
  v.title.style.height = capH + "px";
  v.title.textContent = i.title;
  v.canvas.style.left = border + "px";
  v.canvas.style.top = (border + capH) + "px";
  v.canvas.style.width = i.cw + "px";
  v.canvas.style.height = i.ch + "px";
  emu.windows[i.hwnd] = { title: i.title, x: i.x, y: i.y, w: i.w, h: i.h, cw: i.cw, ch: i.ch, visible: i.visible };
}

// ------------------------------------------------------------------------------------------------------------------
// worker messages
// ------------------------------------------------------------------------------------------------------------------
const decoder = new TextDecoder("latin1");
function appendLog(cls: string, text: string) {
  const log = $("log");
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text;
  log.appendChild(line);
  while (log.childElementCount > 2000) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
}
function onWorker(m: FromWorker) {
  switch (m.type) {
    case "ready": setState("running", "running"); break;
    case "window": {
      if (m.op === "destroy") {
        const v = wins.get(m.info.hwnd);
        if (v) { v.wrap.style.display = "none"; wins.delete(m.info.hwnd); delete emu.windows[m.info.hwnd]; }
        break;
      }
      let v = wins.get(m.info.hwnd);
      if (!v) {
        const slot = pool[m.canvas];
        const wrap = document.createElement("div");
        wrap.className = "win";
        const title = document.createElement("div");
        title.className = "title";
        wrap.appendChild(title);
        wrap.appendChild(slot.canvas);
        $("screen").appendChild(wrap);
        v = { info: m.info, wrap, title, canvas: slot.canvas, idx: m.canvas };
        slot.canvas.dataset.hwnd = String(m.info.hwnd);
        wins.set(m.info.hwnd, v);
      }
      v.info = m.info;
      placeWindow(v);
      break;
    }
    case "stdout": {
      const t = decoder.decode(m.bytes);
      if (m.stream === "out") emu.stdout += t; else emu.stderr += t;
      for (const l of t.split(/\r?\n/)) if (l) appendLog(m.stream === "out" ? "out" : "err", l);
      break;
    }
    case "log": emu.log.push(m.text); appendLog("sys", m.text); break;
    case "cursor": cursorHidden = !m.visible; $("screen").style.cursor = cursorHidden ? "none" : "default"; break;
    case "lock": lockWanted = m.on; if (!m.on && document.pointerLockElement) document.exitPointerLock(); break;
    case "fullscreen": if (m.on) void $("stage").requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) void document.exitFullscreen(); break;
    case "screen": screenW = m.w; screenH = m.h; layout(); break;
    case "messagebox": emu.messageBoxes.push(m.title + ": " + m.text); appendLog("sys", `[MessageBox] ${m.title}: ${m.text}`); break;
    case "clipboard": void navigator.clipboard?.writeText(m.text).catch(() => {}); break;
    case "stats": emu.fps = m.fps; $("fps").textContent = m.fps.toFixed(0) + " fps"; break;
    case "exit": emu.exitCode = m.code; setState("exited", `exited with code ${m.code}`); stopPads(); break;
    case "crash": emu.crash = m.message; appendLog("err", "CRASH: " + m.message + (m.stack ? "\n" + m.stack : "")); setState("crashed", "crashed: " + m.message); stopPads(); break;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// input
// ------------------------------------------------------------------------------------------------------------------
const send = (m: ToWorker, t?: Transferable[]) => worker?.postMessage(m, t ?? []);
const sendEv = (ev: HostEvent) => send({ type: "event", ev });
function canvasAt(e: MouseEvent): { hwnd: number; x: number; y: number } | null {
  const t = e.target as HTMLElement;
  let c: HTMLCanvasElement | null = null;
  if (t instanceof HTMLCanvasElement) c = t;
  else if (document.pointerLockElement instanceof HTMLCanvasElement) c = document.pointerLockElement;
  if (!c || !c.dataset.hwnd) return null;
  const hwnd = Number(c.dataset.hwnd);
  const v = wins.get(hwnd);
  if (!v) return null;
  const r = c.getBoundingClientRect();
  return { hwnd, x: ((e.clientX - r.left) * v.info.cw) / r.width, y: ((e.clientY - r.top) * v.info.ch) / r.height };
}
function installInput() {
  const screen = $("screen");
  screen.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement) {
      const hit = canvasAt(e);
      sendEv({ t: "mouse", x: 0, y: 0, dx: e.movementX / scale, dy: e.movementY / scale, hwnd: hit?.hwnd, locked: true });
      return;
    }
    const hit = canvasAt(e);
    if (hit) sendEv({ t: "mouse", x: hit.x, y: hit.y, dx: e.movementX / scale, dy: e.movementY / scale, hwnd: hit.hwnd });
  });
  screen.addEventListener("mousedown", (e) => {
    if (lockWanted && !document.pointerLockElement && e.target instanceof HTMLCanvasElement) void e.target.requestPointerLock?.();
    const hit = canvasAt(e);
    if (hit) sendEv({ t: "button", btn: Math.min(e.button, 4) as 0, down: true, x: hit.x, y: hit.y, hwnd: hit.hwnd });
    e.preventDefault();
  });
  window.addEventListener("mouseup", (e) => {
    const hit = canvasAt(e);
    sendEv({ t: "button", btn: Math.min(e.button, 4) as 0, down: false, x: hit?.x ?? 0, y: hit?.y ?? 0, hwnd: hit?.hwnd });
  });
  screen.addEventListener("wheel", (e) => {
    const hit = canvasAt(e);
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    sendEv({ t: "wheel", delta: (-e.deltaY * unit * 120) / 100, x: hit?.x ?? 0, y: hit?.y ?? 0, hwnd: hit?.hwnd });
    if (e.deltaX) sendEv({ t: "wheel", delta: (e.deltaX * unit * 120) / 100, horizontal: true, x: hit?.x ?? 0, y: hit?.y ?? 0, hwnd: hit?.hwnd });
    e.preventDefault();
  }, { passive: false });
  screen.addEventListener("contextmenu", (e) => e.preventDefault());
  const key = (e: KeyboardEvent, down: boolean) => {
    if (emu.state !== "running") return;
    const k = KEYMAP[e.code];
    if (!k) return;
    if (e.code === "F12" || (e.ctrlKey && e.shiftKey && (e.code === "KeyI" || e.code === "KeyJ")) || e.code === "F5") return;
    const text = down && e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined;
    sendEv({ t: "key", down, vk: k[0], scan: k[1], ext: k[2], repeat: e.repeat, text });
    e.preventDefault();
  };
  window.addEventListener("keydown", (e) => key(e, true), true);
  window.addEventListener("keyup", (e) => key(e, false), true);
  window.addEventListener("blur", () => sendEv({ t: "focus", focused: false }));
  window.addEventListener("focus", () => sendEv({ t: "focus", focused: true }));
  document.addEventListener("visibilitychange", () => sendEv({ t: "focus", focused: !document.hidden }));
  document.addEventListener("pointerlockchange", () => {
    if (!document.pointerLockElement && lockWanted) { /* ESC pressed: the next click re-locks */ }
  });
  window.addEventListener("resize", layout);
}
const XB: number[] = [0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, 0, 0, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008];
function stopPads() { if (padTimer) cancelAnimationFrame(padTimer); padTimer = 0; }
function pollPads() {
  const pads: (GamepadState | null)[] = [null, null, null, null];
  const list = navigator.getGamepads?.() ?? [];
  let n = 0;
  for (const g of list) {
    if (!g || n >= 4) continue;
    let buttons = 0;
    g.buttons.forEach((b, i) => { if (b.pressed && XB[i]) buttons |= XB[i]; });
    const ax = (i: number) => Math.max(-32768, Math.min(32767, Math.round((g.axes[i] ?? 0) * 32767)));
    pads[n++] = {
      connected: true, buttons, lt: Math.round((g.buttons[6]?.value ?? 0) * 255), rt: Math.round((g.buttons[7]?.value ?? 0) * 255),
      lx: ax(0), ly: -ax(1), rx: ax(2), ry: -ax(3),
    };
  }
  if (n || (pollPads as any).had) { send({ type: "gamepads", pads }); (pollPads as any).had = n > 0; }
  padTimer = requestAnimationFrame(pollPads);
}

// ------------------------------------------------------------------------------------------------------------------
// launching
// ------------------------------------------------------------------------------------------------------------------
async function loadSysdll(): Promise<InitMsg["sysdll"]> {
  try {
    const r = await fetch("sysdll/manifest.json");
    if (!r.ok) return null;
    return { base: new URL("sysdll", location.href).href, manifest: await r.json() };
  } catch { return null; }
}

export async function launch(tree: TreeNode[], exe: string, args = "") {
  if (worker) { worker.terminate(); worker = null; }
  for (const v of wins.values()) v.wrap.remove();
  wins.clear();
  emu.windows = {}; emu.stdout = ""; emu.stderr = ""; emu.log = []; emu.exitCode = null; emu.crash = null;
  $("log").textContent = "";
  document.body.classList.add("running");
  setState("starting", "starting " + exe);
  const scr = chooseScreen();
  screenW = scr.w; screenH = scr.h;
  layout();
  const canvases: OffscreenCanvas[] = [];
  const holder = $("pool");
  holder.textContent = "";
  pool.length = 0;
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("canvas");
    c.width = 16; c.height = 16;
    holder.appendChild(c);
    canvases.push(c.transferControlToOffscreen());
    pool.push({ canvas: c, used: false });
  }
  const sysdll = await loadSysdll();
  worker = new Worker("worker.js", { type: "module" });
  emu.worker = worker;
  worker.onmessage = (e) => onWorker(e.data as FromWorker);
  worker.onerror = (e) => { appendLog("err", "worker error: " + e.message); setState("crashed", "worker error: " + e.message); emu.crash = e.message; };
  const init: InitMsg = { type: "init", canvases, screen: { w: screenW, h: screenH, refresh: 60 }, tree, exe, args, sysdll, opts: { strict: false } };
  worker.postMessage(init, canvases);
  stopPads();
  padTimer = requestAnimationFrame(pollPads);
  $("screen").focus();
}
(window as any).__launch = launch;

async function handleTree(tree: TreeNode[]) {
  const exes = findExes(tree);
  if (!exes.length) { setState("idle", "no .exe found in what you dropped"); return; }
  // when a single top-level directory was dropped, treat its content as the root
  const best = pickExe(exes);
  const listEl = $("exelist");
  listEl.textContent = "";
  if (exes.length > 1) {
    for (const e of exes.sort((a, b) => a.depth - b.depth || b.size - a.size).slice(0, 12)) {
      const b = document.createElement("button");
      b.textContent = `${e.path} (${(e.size / 1048576).toFixed(1)} MB)`;
      b.onclick = () => void launch(tree, e.path);
      listEl.appendChild(b);
    }
  }
  await launch(tree, best.path);
}

function boot() {
  installInput();
  const drop = $("drop");
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) document.addEventListener(ev, stop);
  document.addEventListener("dragenter", () => document.body.classList.add("dragging"));
  document.addEventListener("dragleave", (e) => { if (!(e as DragEvent).relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", async (e) => {
    document.body.classList.remove("dragging");
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    setState("reading", "reading dropped files...");
    handleTree(await treeFromDataTransfer(dt)).catch((err) => setState("idle", "error: " + err));
  });
  ($("file") as HTMLInputElement).onchange = (e) => {
    const fl = (e.target as HTMLInputElement).files;
    if (fl) void handleTree(treeFromFileList(fl));
  };
  ($("folder") as HTMLInputElement).onchange = (e) => {
    const fl = (e.target as HTMLInputElement).files;
    if (fl) void handleTree(treeFromFileList(fl));
  };
  $("stop").onclick = () => { worker?.terminate(); worker = null; document.body.classList.remove("running"); setState("idle", "stopped"); stopPads(); };
  $("fs").onclick = () => void $("stage").requestFullscreen?.();
  $("logtoggle").onclick = () => $("log").classList.toggle("hidden");
  void drop;
  setState("idle", "drop a Windows x64 .exe (or its game folder) here");
}
boot();
