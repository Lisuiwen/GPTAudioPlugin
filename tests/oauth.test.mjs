import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverPath = resolve("dist/server.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gpt-audio-test-"));
  const dataDir = join(directory, "persistent");
  await mkdir(dataDir);
  const processes = new Set();
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    dataDir,
    async start(cwd = directory) {
      const child = spawn(process.execPath, [serverPath], {
        cwd,
        env: { ...process.env, PORT: "0", PUBLIC_BASE_URL: "http://127.0.0.1", AUTH_DATA_DIR: dataDir, AUTH_ENCRYPTION_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processes.add(child);
      let output = "";
      const url = await new Promise((resolveUrl, reject) => {
        const timer = setTimeout(() => reject(new Error("Server startup timed out")), 10000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/listening on 0\.0\.0\.0:(\d+)\/mcp/);
          if (match) {
            clearTimeout(timer);
            resolveUrl(`http://127.0.0.1:${match[1]}`);
          }
        });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
      });
      return {
        url,
        async stop() {
          const exited = once(child, "exit");
          child.kill();
          await exited;
          processes.delete(child);
        },
      };
    },
  };
}

async function seed(dataDir) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update("test-credential", "utf8"), cipher.final()]);
  const encryptedReplicateToken = [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
  const profile = { id: "test-profile", username: "test-user", encryptedReplicateToken, createdAt: Date.now(), updatedAt: Date.now() };
  const record = { profileId: profile.id, scope: "replicate.read replicate.run", expiresAt: Date.now() + 60000 };
  const codeVerifier = "test-verifier-for-persisted-authorization-code";
  const store = {
    profiles: { [profile.id]: profile },
    accessTokens: { [hash("valid-access")]: record, [hash("expired-access")]: { ...record, expiresAt: 1 } },
    refreshTokens: { [hash("valid-refresh")]: record, [hash("expired-refresh")]: { ...record, expiresAt: 1 } },
    authorizationCodes: { [hash("valid-code")]: { ...record, clientId: "test-client", redirectUri: "http://127.0.0.1/callback", resource: "http://127.0.0.1/mcp", codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url") } },
  };
  await writeFile(join(dataDir, "auth.key"), key.toString("base64"), "utf8");
  await writeFile(join(dataDir, "auth-store.json"), JSON.stringify(store), "utf8");
  return { codeVerifier };
}

async function rpc(url, method, params = {}, token) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function exchange(url, fields) {
  return fetch(`${url}/token`, { method: "POST", body: new URLSearchParams(fields) });
}

test("SDK discovery lists four tools and unauthenticated calls request OAuth without contacting Replicate", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const client = new Client({ name: "gpt-audio-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["analyze_music", "generate_music", "get_music_provider_profile", "inspect_music_model"]);
  const result = await client.callTool({ name: "get_music_provider_profile", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result._meta["mcp/www_authenticate"][0], /resource_metadata=/);
});

test("rotated OAuth tokens and credentials survive restart in a different working directory", async (t) => {
  const f = await fixture(t);
  await seed(f.dataDir);
  let server = await f.start();
  const response = await exchange(server.url, { grant_type: "refresh_token", refresh_token: "valid-refresh" });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await exchange(server.url, { grant_type: "refresh_token", refresh_token: "valid-refresh" })).status, 400);
  await server.stop();
  const differentCwd = join(f.directory, "different-cwd");
  await mkdir(differentCwd);
  server = await f.start(differentCwd);
  const profileResponse = await rpc(server.url, "tools/call", { name: "get_music_provider_profile", arguments: {} }, tokens.access_token);
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal(profile.result.structuredContent.id, "test-profile");
  assert.equal((await exchange(server.url, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status, 200);
});

test("expired credentials return a reauthorization challenge and expired refresh tokens fail", async (t) => {
  const f = await fixture(t);
  await seed(f.dataDir);
  const server = await f.start();
  const response = await rpc(server.url, "tools/list", {}, "expired-access");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /error="invalid_token"/);
  const refresh = await exchange(server.url, { grant_type: "refresh_token", refresh_token: "expired-refresh" });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json()).error, "invalid_grant");
});

test("authorization codes survive restart and are consumed once", async (t) => {
  const f = await fixture(t);
  const { codeVerifier } = await seed(f.dataDir);
  let server = await f.start();
  await server.stop();
  server = await f.start();
  const fields = { grant_type: "authorization_code", code: "valid-code", code_verifier: codeVerifier, client_id: "test-client", redirect_uri: "http://127.0.0.1/callback" };
  assert.equal((await exchange(server.url, fields)).status, 200);
  assert.equal((await exchange(server.url, fields)).status, 400);
});

test("corrupted auth storage is preserved and does not stop anonymous tool discovery", async (t) => {
  const f = await fixture(t);
  const storePath = join(f.dataDir, "auth-store.json");
  await writeFile(storePath, "{broken", "utf8");
  const server = await f.start();
  assert.equal((await exchange(server.url, { grant_type: "refresh_token", refresh_token: "anything" })).status, 500);
  assert.equal(await readFile(storePath, "utf8"), "{broken");
  assert.equal((await rpc(server.url, "tools/list")).status, 200);
});

test("legacy stores migrate without losing existing refresh tokens", async (t) => {
  const f = await fixture(t);
  await seed(f.dataDir);
  const storePath = join(f.dataDir, "auth-store.json");
  const legacy = JSON.parse(await readFile(storePath, "utf8"));
  delete legacy.authorizationCodes;
  await writeFile(storePath, JSON.stringify(legacy), "utf8");
  const server = await f.start();
  assert.equal((await exchange(server.url, { grant_type: "refresh_token", refresh_token: "valid-refresh" })).status, 200);
  const migrated = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(migrated.profiles["test-profile"].username, "test-user");
  assert.deepEqual(migrated.authorizationCodes, {});
});

test("read-only OAuth scope cannot generate or analyze audio", async (t) => {
  const f = await fixture(t);
  await seed(f.dataDir);
  const storePath = join(f.dataDir, "auth-store.json");
  const store = JSON.parse(await readFile(storePath, "utf8"));
  store.accessTokens[hash("valid-access")].scope = "replicate.read";
  await writeFile(storePath, JSON.stringify(store), "utf8");
  const server = await f.start();
  for (const [name, args] of [
    ["generate_music", { conversationSummary: "test", directorPrompt: "test" }],
    ["analyze_music", { audio: { download_url: "https://example.com/audio.mp3", file_id: "test" }, question: "test" }],
  ]) {
    const response = await rpc(server.url, "tools/call", { name, arguments: args }, "valid-access");
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.match(result._meta["mcp/www_authenticate"][0], /insufficient_scope/);
  }
});
