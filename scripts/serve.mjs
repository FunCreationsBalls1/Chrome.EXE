// Minimal static file server for dist/ (cross-origin isolation headers enabled, WebGPU needs a secure context: localhost is one).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, process.env.DIR ?? "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".map": "application/json", ".dll": "application/octet-stream", ".wasm": "application/wasm", ".exe": "application/octet-stream", ".css": "text/css" };

export function serve(port = Number(process.env.PORT ?? 8080), host = "127.0.0.1") {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(dir, p));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port: server.address().port })));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await serve();
  console.log(`serving ${dir} at http://localhost:${port}/`);
}
