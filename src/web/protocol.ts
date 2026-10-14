// Messages exchanged between the page (main.ts) and the emulator worker (worker.ts).
import type { GamepadState, HostEvent, WindowInfo } from "../win32/host.ts";
import type { TreeNode } from "./vfs.ts";

export interface InitMsg {
  type: "init";
  canvases: OffscreenCanvas[];
  screen: { w: number; h: number; refresh: number };
  tree: TreeNode[];
  /** path of the executable relative to the tree root, with forward slashes */
  exe: string;
  args: string;
  sysdll: { base: string; manifest: Record<string, number> } | null;
  /** options */
  opts: { trace?: boolean; strict?: boolean; maxMemoryPages?: number; /** how GPU frames reach the screen: through the WebGPU canvas (default) or by pixel read-back into a 2D canvas (headless test environments) */ present?: "gpu" | "readback"; debugShaders?: boolean };
}
export type ToWorker =
  | InitMsg
  | { type: "event"; ev: HostEvent }
  | { type: "events"; evs: HostEvent[] }
  | { type: "gamepads"; pads: (GamepadState | null)[] }
  | { type: "screen"; w: number; h: number }
  | { type: "stop" };

export type FromWorker =
  | { type: "ready" }
  | { type: "window"; op: "create" | "update" | "destroy"; info: WindowInfo; canvas: number }
  | { type: "stdout"; stream: "out" | "err"; bytes: Uint8Array }
  | { type: "log"; text: string }
  | { type: "cursor"; visible: boolean; shape?: string }
  | { type: "lock"; on: boolean }
  | { type: "fullscreen"; on: boolean }
  | { type: "screen"; w: number; h: number }
  | { type: "messagebox"; title: string; text: string }
  | { type: "clipboard"; text: string }
  | { type: "stats"; fps: number; jit: Record<string, number> }
  | { type: "exit"; code: number }
  | { type: "crash"; message: string; stack?: string };
