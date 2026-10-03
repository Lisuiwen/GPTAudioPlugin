import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Exercise the actual browser bundle, not a Node-only version of the Worker.
const source = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const migration = await readFile(new URL("../drizzle/0000_swift_chronomancer.sql", import.meta.url), "utf8");
const musicMigration = await readFile(new URL('../drizzle/0001_mute_quentin_quire.sql', import.meta.url), 'utf8');
const origin = "https://gpt-audio.example";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  db.exec(musicMigration);
  t.after(() => db.close());
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DB: { prepare(sql) { return { bind(...values) { return {
      async first() { return db.prepare(sql).get(...values) || null; },
      async run() { return db.prepare(sql).run(...values); },
    }; } }; } },
  };
  const rpc = (method, params = {}, userId) => worker.fetch(new Request(`${origin}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(userId ? { "oai-authenticated-user-id": userId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), env);
  const form = (path, userId, fields = {}, requestOrigin = origin) => worker.fetch(new Request(`${origin}${path}`, {
    method: "POST", headers: { origin: requestOrigin, ...(userId ? { "oai-authenticated-user-id": userId } : {}) }, body: new URLSearchParams(fields),
  }), env);
  return { db, env, rpc, form };
}

function mockProvider(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options) => {
    const request = input instanceof Request ? input : new Request(input, options);
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/v1/account") return Response.json({ username: "replicate-user", name: "Test User" });
    if (["audio.example", "replicate.example"].includes(url.hostname)) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    if (url.pathname.startsWith("/v1/models/")) return Response.json({ latest_version: { id: "test-version", openapi_schema: { components: { schemas: { Input: { properties: {
      prompt: { type: "string" }, audio: { type: "string" }, duration: { type: "integer" }, generate_audio: { type: "boolean" },
    }, required: ["prompt"] } } } } } });
    if (url.pathname === "/v1/files") return Response.json({ urls: { get: "https://replicate.example/upload.mp3" } });
    if (url.pathname === "/v1/predictions") {
      const { input: fields } = await request.clone().json();
      return Response.json({ id: "test-prediction", status: "succeeded", output: fields.generate_audio === false ? "The recording contains a steady rhythmic pulse." : "https://replicate.example/generated.mp3" });
    }
    throw new Error(`Unexpected network request: ${request.url}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("Sites discovery exposes the full workflow toolset and protects calls without platform identity", async (t) => {
  const f = fixture(t);
  const init = await f.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.version, "0.7.1");
  const listed = await f.rpc("tools/list");
  const { result: { tools } } = await listed.json();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["analyze_music", "generate_music", "get_music_provider_profile", "inspect_music_model", "get_service_status", "register_music_audio", "get_music_audio", "delete_music_audio", "get_music_job", "cancel_music_job", "compare_music"].sort());
  assert.ok(tools.every((tool) => tool._meta.securitySchemes[0].type === "noauth"));
  assert.equal((await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} })).status, 401);
  const absent = await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} }, "user-one");
  const { result } = await absent.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /https:\/\/gpt-audio.example\/connect/);
  assert.equal(result._meta?.["mcp/www_authenticate"], undefined);
});

test("Replicate credentials persist encrypted, remain user-scoped, and disconnect independently", async (t) => {
  const f = fixture(t);
  mockProvider(t);
  assert.equal((await f.form("/connect", "user-one", { replicate_token: "private-token" })).status, 200);
  const stored = f.db.prepare("SELECT * FROM replicate_connections WHERE user_id = ?").get("user-one");
  assert.equal(stored.username, "replicate-user");
  assert.ok(!stored.encrypted_token.includes("private-token"));
  // A fresh request derives access from persistent storage, without an OAuth session in memory.
  const profile = await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} }, "user-one");
  assert.equal((await profile.json()).result.structuredContent.id, "user-one");
  const other = await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} }, "user-two");
  assert.equal((await other.json()).result.isError, true);
  assert.equal((await f.form("/connect", "user-two", { replicate_token: "second-token" })).status, 200);
  assert.equal((await f.form("/disconnect", "user-one")).status, 200);
  assert.equal(f.db.prepare("SELECT count(*) AS total FROM replicate_connections").get().total, 1);
  const remaining = await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} }, "user-two");
  assert.equal((await remaining.json()).result.structuredContent.id, "user-two");
});

test("credential forms reject unauthenticated and cross-origin requests before contacting Replicate", async (t) => {
  const f = fixture(t);
  const calls = mockProvider(t);
  assert.equal((await f.form("/connect", undefined, { replicate_token: "token" })).status, 401);
  assert.equal((await f.form("/connect", "user-one", { replicate_token: "token" }, "https://untrusted.example")).status, 403);
  assert.equal((await f.form("/connect", "user-one", { replicate_token: "x".repeat(10000) })).status, 400);
  assert.equal(calls.length, 0);
  const page = await worker.fetch(new Request(origin, { headers: { "oai-authenticated-user-id": "user-one" } }), f.env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /charset=utf-8/);
});

test("bundle generates and analyzes attached audio through the existing Replicate adapter", async (t) => {
  const f = fixture(t);
  const calls = mockProvider(t);
  await f.form("/connect", "user-one", { replicate_token: "test-token" });
  const audio = { download_url: "https://audio.example/reference.mp3", file_id: "file-one", mime_type: "audio/mpeg" };
  const generated = await f.rpc("tools/call", { name: "generate_music", arguments: { model: "test/music", conversationSummary: "Test context", directorPrompt: "A quiet instrumental", referenceAudio: audio } }, "user-one");
  const generatedResult = (await generated.json()).result;
  assert.equal(generatedResult.isError, undefined, JSON.stringify(generatedResult));
  assert.equal(generatedResult.structuredContent.audioUrl, "https://replicate.example/generated.mp3");
  assert.equal(generatedResult.structuredContent.referenceAudioUsed, true);
  const analyzed = await f.rpc("tools/call", { name: "analyze_music", arguments: { model: "test/analysis", audio, question: "Describe the rhythm" } }, "user-one");
  const analyzedResult = (await analyzed.json()).result;
  assert.equal(analyzedResult.isError, undefined, JSON.stringify(analyzedResult));
  assert.match(analyzedResult.structuredContent.answer, /rhythmic pulse/);
  const predictions = calls.filter((request) => new URL(request.url).pathname === "/v1/predictions");
  assert.equal(predictions.length, 2);
  for (const request of predictions) {
    assert.equal(request.headers.get("authorization"), "Bearer test-token");
    assert.equal((await request.json()).input.audio, "https://replicate.example/upload.mp3");
  }
});

test("storage failure leaves discovery available and returns a recoverable error without credentials", async (t) => {
  const f = fixture(t);
  mockProvider(t);
  await f.form("/connect", "user-one", { replicate_token: "do-not-expose" });
  f.env.AUTH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const failed = await f.rpc("tools/call", { name: "get_music_provider_profile", arguments: {} }, "user-one");
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("do-not-expose"));
  f.env.DB = { prepare() { throw new Error("storage unavailable"); } };
  assert.equal((await f.rpc("tools/list")).status, 200);
  assert.equal((await f.form("/connect", "user-one", { replicate_token: "do-not-expose" })).status, 503);
});
