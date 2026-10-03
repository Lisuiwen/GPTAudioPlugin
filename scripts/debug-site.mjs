import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createLocalWorkflow } from "../dist/node-workflow.js";

const directory = resolve(process.env.MUSIC_DEBUG_DIR || ".data/workflow-debug");
await mkdir(directory, { recursive: true });
const keyPath = join(directory, "encryption.key");
let key;
try { key = await readFile(keyPath, "utf8"); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  key = randomBytes(32).toString("base64");
  await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
}
const local = createLocalWorkflow(directory);
await local.db.prepare("CREATE TABLE IF NOT EXISTS replicate_connections (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT, encrypted_token TEXT NOT NULL, updated_at INTEGER NOT NULL)").bind().run();
const source = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
let sha = "unknown";
try { sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
const env = { DB: local.db, AUDIO_BUCKET: local.bucket, AUTH_ENCRYPTION_KEY: key.trim(), BUILD_SHA: `${sha}:local-sites-harness` };
// This harness simulates the Sites gateway identity ONLY on loopback. It must
// never be deployed publicly or bound to 0.0.0.0.
const server = createServer(async (req, res) => {
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    if (req.headers.host !== `127.0.0.1:${address.port}`) { res.writeHead(403).end("Use the printed loopback address."); return; }
    if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end("Cross-origin requests rejected."); return; }
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 4 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    headers.set("oai-authenticated-user-id", "brook-local-debug");
    const request = new Request(new URL(req.url || "/", origin), { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    console.error("Local Sites harness request failed; no credentials logged.");
    if (!res.headersSent) res.writeHead(500);
    res.end("Local test server error");
  }
});
server.listen(Number(process.env.MUSIC_DEBUG_PORT || 8797), "127.0.0.1", () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ mode: "local-sites-harness", origin, connect: `${origin}/connect`, mcp: `${origin}/mcp`, storage: directory, buildSha: sha }));
  console.log("Enter Replicate credentials only in the local connection page. This server does not create predictions until a tool is called.");
});
const close = () => server.close(() => { local.close(); process.exit(0); });
process.on("SIGINT", close); process.on("SIGTERM", close);
