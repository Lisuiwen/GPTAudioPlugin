import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkflow } from "../dist/node-workflow.js";
import { capabilitiesFromSchema, selectReplicateGenerationRoute, prepareGeneration } from "../dist/providers/replicate.js";
import { sliceWav, publicAudioUrl } from "../dist/audio.js";
import { parseAnalysis } from "../dist/music-workflow.js";
import { TOOL_NAMES, SERVER_VERSION } from "../dist/music-server.js";
const bundle = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const origin = "https://workflow.example";

function wav(seconds = 4) {
  const rate = 8000, size = seconds * rate * 2;
  const bytes = new Uint8Array(44 + size), v = new DataView(bytes.buffer);
  const str = (at, s) => bytes.set(new TextEncoder().encode(s), at);
  str(0, "RIFF"); v.setUint32(4, size + 36, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, size, true);
  for (let i = 0; i < seconds * rate; i++) v.setInt16(44 + i * 2, Math.round(12000 * Math.sin(2 * Math.PI * 220 * i / rate)), true);
  return bytes;
}
const schema = (name) => {
  const common = { prompt: { type: "string", description: "music and audio" } };
  if (name.includes("music-cover")) return { properties: { ...common, bitrate: { type: "integer", description: "Audio bitrate" }, audio_url: { type: "string", format: "uri" }, audio_format: { type: "string" }, lyrics: { type: "string" } }, required: ["audio_url", "prompt"] };
  if (name.includes("music-2.6")) return { properties: { ...common, lyrics: { type: "string" }, is_instrumental: { type: "boolean" }, lyrics_optimizer: { type: "boolean" }, audio_format: { type: "string" } } };
  if (name.includes("ace-step")) return { properties: { ...common, lyrics: { type: "string", default: "[Instrumental]" }, duration: { type: "number", minimum: 1, maximum: 600 }, audio_format: { type: "string" }, seed: { type: "integer" } } };
  if (name.includes("musicgen")) return { properties: { ...common, input_audio: { type: "string", format: "uri" }, duration: { type: "number", minimum: 1, maximum: 30 }, continuation: { type: "boolean" }, model_version: { type: "string" }, normalization_strategy: { type: "string" }, output_format: { type: "string" } } };
  return { properties: { ...common, audio: { type: "string", format: "uri" }, generate_audio: { type: "boolean" }, system_prompt: { type: "string" } } };
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "music-workflow-"));
  let local = createLocalWorkflow(directory);
  await local.db.prepare("CREATE TABLE replicate_connections (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT, encrypted_token TEXT NOT NULL, updated_at INTEGER NOT NULL)").bind().run();
  const env = { DB: local.db, AUDIO_BUCKET: options.temporary ? undefined : local.bucket, AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"), BUILD_SHA: "test-build" };
  const original = globalThis.fetch;
  const predictions = new Map(), calls = [], uploads = [];
  let failOutput = false;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url); calls.push({ url: req.url, method: req.method });
    if (url.pathname === "/v1/account") return Response.json({ username: "tester", name: "Test User" });
    if (url.hostname === "audio.example") {
      if (failOutput) return new Response("gone", { status: 503 });
      return new Response(wav(), { headers: { "content-type": "audio/wav" } });
    }
    if (url.pathname.startsWith("/v1/models/")) {
      const s = schema(url.pathname);
      return Response.json({ latest_version: { id: "version-test", openapi_schema: { components: { schemas: { Input: s } } } } });
    }
    if (url.pathname === "/v1/files") {
      const form = await req.formData(); uploads.push(form);
      return Response.json({ urls: { get: "https://audio.example/upload.wav" } });
    }
    if (url.pathname === "/v1/predictions" && req.method === "POST") {
      if (options.unknownSubmission) throw new Error("Simulated lost response");
      const fields = await req.json();
      const id = `prediction-${predictions.size + 1}`;
      const p = { id, status: options.immediate ? "succeeded" : "processing", input: fields.input, output: fields.input.generate_audio === false ? JSON.stringify({ summary: "A repeating tone", observations: ["Steady pulse"], uncertainties: ["Instrument family uncertain"], suggestions: ["Reduce density"] }) : ["https://audio.example/generated.wav"], created_at: new Date().toISOString() };
      predictions.set(id, p); return Response.json(p);
    }
    const m = /^\/v1\/predictions\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const p = predictions.get(m[1]);
      if (!p) return Response.json({ error: "missing" }, { status: 404 });
      if (m[2] && !["succeeded", "failed"].includes(p.status)) p.status = "canceled";
      return Response.json(p);
    }
    throw new Error(`Unexpected network request: ${req.method} ${req.url}`);
  };
  t.after(async () => { globalThis.fetch = original; local.close(); await rm(directory, { recursive: true, force: true }); });
  async function rpc(method, params = {}, owner = "alice") {
    const response = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(owner ? { "oai-authenticated-user-id": owner } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
    assert.equal(response.status, 200); return (await response.json()).result;
  }
  async function call(name, args = {}, owner = "alice") { return rpc("tools/call", { name, arguments: args }, owner); }
  async function connect(owner) {
    const response = await worker.fetch(new Request(`${origin}/connect`, { method: "POST", headers: { origin, "oai-authenticated-user-id": owner }, body: new URLSearchParams({ replicate_token: "test-not-a-secret" }) }), env);
    assert.equal(response.status, 200);
  }
  await connect("alice"); await connect("bob");
  return { call, rpc, env, predictions, calls, uploads, source: { download_url: "https://audio.example/source.wav", file_id: "test-file", mime_type: "audio/wav", file_name: "source.wav" }, complete(id) { predictions.get(id).status = "succeeded"; }, failOutput(value) { failOutput = value; }, restart() { local.close(); local = createLocalWorkflow(directory); env.DB = local.db; if (!options.temporary) env.AUDIO_BUCKET = local.bucket; } };
}
const generation = { conversationSummary: "Island game", directorPrompt: "Quiet instrumental island music", duration: 4, audioFormat: "wav", requestKey: "generation-one" };
const data = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent; };

test("exact schema mapping never treats prompt, bitrate, or output-format as audio", () => {
  for (const name of ["fishaudio/ace-step-1.5", "minimax/music-2.6"]) {
    const c = capabilitiesFromSchema(name, schema(name)); assert.equal(c.supportsAudioInput, false); assert.equal(c.audioField, undefined);
  }
  const cover = capabilitiesFromSchema("minimax/music-cover", schema("music-cover"));
  assert.equal(cover.audioField, "audio_url"); assert.deepEqual(cover.unsupportedRequiredFields, []);
  assert.equal(capabilitiesFromSchema("custom/example", { properties: { audio: { type: "integer" }, prompt: { type: "string" } } }).audioField, undefined);
});
test("routing uses operation intent instead of instrumental flag to force a cover", () => {
  assert.equal(selectReplicateGenerationRoute(generation).model, "fishaudio/ace-step-1.5");
  assert.equal(selectReplicateGenerationRoute({ ...generation, instrumental: false }).model, "minimax/music-2.6");
  assert.equal(selectReplicateGenerationRoute({ ...generation, instrumental: false, referenceAudioUrl: "https://audio.example/a.wav" }).generationMode, "reference");
  assert.equal(selectReplicateGenerationRoute({ ...generation, generationMode: "cover", referenceAudioUrl: "https://audio.example/a.wav" }).model, "minimax/music-cover");
  assert.throws(() => selectReplicateGenerationRoute({ ...generation, generationMode: "continue" }), /requires source/);
  assert.throws(() => selectReplicateGenerationRoute({ ...generation, generationMode: "generate", referenceAudioUrl: "https://audio.example/a.wav" }), /cannot discard/);
});
test("WAV slicing is sample aligned and rejects unavailable ranges or MP3", async () => {
  const clip = await sliceWav(new File([wav()], "a.wav"), 1, 2.5);
  assert.equal(clip.size, 44 + 1.5 * 8000 * 2);
  await assert.rejects(sliceWav(new File([wav()], "a.wav"), 3, 9), /exceeds audio duration/);
  await assert.rejects(sliceWav(new File([new Uint8Array([1, 2, 3])], "a.mp3"), 0, 1), /requires PCM WAV/);
  assert.throws(() => publicAudioUrl("https://127.0.0.1/audio"), /Local and numeric/);
  assert.throws(() => publicAudioUrl("http://audio.example/a"), /HTTPS/);
});
test("structured listening validates JSON and preserves failure rather than fabricating fields", () => {
  assert.equal(parseAnalysis("The music is calm").structuredStatus, "unavailable");
  assert.equal(parseAnalysis('{"summary":"x","observations":[],"uncertainties":[],"suggestions":[]}').structuredStatus, "validated");
});
test("Sites bundle exposes eleven tools and the exact native file parameter contract", async t => {
  const f = await fixture(t);
  const { tools } = await f.rpc("tools/list", {}, undefined);
  assert.deepEqual(tools.map(x => x.name).sort(), [...TOOL_NAMES].sort());
  const status = data(await f.call("get_service_status"));
  assert.equal(status.version, SERVER_VERSION); assert.equal(status.buildSha, "test-build"); assert.equal(status.durableAudio, true);
  for (const tool of tools) for (const name of tool._meta["openai/fileParams"] || []) {
    let prop = tool.inputSchema.properties[name];
    if (prop.$ref) prop = prop.$ref.split("/").slice(1).reduce((v, key) => v[key], tool.inputSchema);
    assert.deepEqual(Object.keys(prop.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
    assert.deepEqual(prop.required.sort(), ["download_url", "file_id"]);
  }
});
test("generation job survives restart; duplicate requestKey never creates another prediction", async t => {
  const f = await fixture(t);
  const first = data(await f.call("generate_music", generation));
  assert.equal(first.status, "processing"); assert.equal(f.predictions.size, 1);
  assert.equal(data(await f.call("generate_music", generation)).jobId, first.jobId);
  f.restart();
  assert.equal(data(await f.call("generate_music", generation)).jobId, first.jobId);
  assert.equal(f.predictions.size, 1);
  f.complete(first.predictionId);
  const done = data(await f.call("get_music_job", { jobId: first.jobId }));
  assert.equal(done.status, "succeeded"); assert.ok(done.audioId); assert.equal(done.audios[0].storage, "object");
  assert.equal(data(await f.call("get_music_job", { jobId: first.jobId })).audioId, done.audioId);
  assert.equal(f.predictions.size, 1);
});
test("generated audioId goes directly into cropped listening without re-uploading a ChatGPT file", async t => {
  const f = await fixture(t, { immediate: true });
  const generated = data(await f.call("generate_music", generation));
  const listened = data(await f.call("analyze_music", { audioId: generated.audioId, startSec: 1, endSec: 2, question: "Describe rhythm", requestKey: "listen-one" }));
  assert.equal(listened.status, "succeeded"); assert.equal(listened.structuredStatus, "validated");
  assert.deepEqual(listened.analyzedRange, { startSec: 1, endSec: 2 });
  assert.equal(f.predictions.size, 2);
  const uploadedFiles = f.uploads.flatMap(form => [...form.values()].filter(v => v instanceof Blob));
  assert.ok(uploadedFiles.some(file => file.size === 44 + 8000 * 2));
});
test("cross-user audio and job access is denied before inference, including parent references", async t => {
  const f = await fixture(t, { immediate: true });
  const g = data(await f.call("generate_music", generation));
  for (const [name, args] of [["get_music_job", { jobId: g.jobId }], ["get_music_audio", { audioId: g.audioId }], ["analyze_music", { audioId: g.audioId, question: "listen" }], ["delete_music_audio", { audioId: g.audioId }]]) {
    assert.equal((await f.call(name, args, "bob")).isError, true);
  }
  assert.equal(f.predictions.size, 1);
});
test("same idempotency key with changed requirements fails before another charge", async t => {
  const f = await fixture(t);
  await f.call("generate_music", generation);
  assert.equal((await f.call("generate_music", { ...generation, directorPrompt: "different" })).isError, true);
  assert.equal(f.predictions.size, 1);
});
test("unsupported reference, too-long prompt and excessive MusicGen duration are rejected", async t => {
  const f = await fixture(t);
  for (const args of [
    { ...generation, model: "fishaudio/ace-step-1.5", referenceAudio: f.source, requestKey: "bad-audio" },
    { ...generation, directorPrompt: "x".repeat(513), requestKey: "bad-prompt" },
    { ...generation, model: "meta/musicgen", duration: 90, requestKey: "bad-duration" },
  ]) assert.equal((await f.call("generate_music", args)).isError, true);
  assert.equal(f.predictions.size, 0);
});
test("MiniMax vocals disable instrumental mode and enable auto lyrics without false duration claims", async t => {
  const f = await fixture(t);
  const p = await prepareGeneration("test", { ...generation, instrumental: false });
  assert.equal(p.input.is_instrumental, false); assert.equal(p.input.lyrics_optimizer, true); assert.ok(!("duration" in p.input)); assert.ok(p.warnings.length);
  await assert.rejects(prepareGeneration("test", { ...generation, instrumental: false, autoLyrics: false }), /requires lyrics/);
});
test("cancellation uses real provider state and is user-scoped", async t => {
  const f = await fixture(t);
  const g = data(await f.call("generate_music", generation));
  assert.equal((await f.call("cancel_music_job", { jobId: g.jobId }, "bob")).isError, true);
  const canceled = await f.call("cancel_music_job", { jobId: g.jobId });
  assert.equal(canceled.structuredContent.status, "canceled"); assert.equal(f.predictions.size, 1);
});
test("output storage failure is retryable without another prediction", async t => {
  const f = await fixture(t);
  const g = data(await f.call("generate_music", generation));
  f.complete(g.predictionId); f.failOutput(true);
  assert.equal(data(await f.call("get_music_job", { jobId: g.jobId })).status, "storage_pending");
  f.failOutput(false);
  assert.equal(data(await f.call("get_music_job", { jobId: g.jobId })).status, "succeeded");
  assert.equal(f.predictions.size, 1);
});
test("comparison creates two resumable independent listens with a shared rubric", async t => {
  const f = await fixture(t, { immediate: true });
  const a = data(await f.call("register_music_audio", { audio: f.source }));
  const b = data(await f.call("register_music_audio", { audio: { ...f.source, file_id: "file-b" }, parentAudioId: a.audioId }));
  const args = { audioIdA: a.audioId, audioIdB: b.audioId, question: "Which is less dense?", requestKey: "compare-one" };
  const compared = data(await f.call("compare_music", args));
  assert.equal(compared.jobs.length, 2); assert.equal(compared.comparisonType, "independent-listening-same-rubric");
  await f.call("compare_music", args); assert.equal(f.predictions.size, 2);
});
test("unconfigured object storage explicitly reports temporary assets; deletion removes ownership", async t => {
  const f = await fixture(t, { temporary: true });
  const a = data(await f.call("register_music_audio", { audio: f.source }));
  assert.equal(a.storage, "temporary"); assert.match(a.warning, /temporary/);
  await f.call("delete_music_audio", { audioId: a.audioId });
  assert.equal((await f.call("get_music_audio", { audioId: a.audioId })).isError, true);
});


test("lost submission response is recorded as unknown and never blindly retried", async t => {
  const f = await fixture(t, { unknownSubmission: true });
  const first = await f.call("generate_music", generation);
  assert.equal(first.structuredContent.status, "submission_unknown");
  const again = await f.call("generate_music", generation);
  assert.equal(again.structuredContent.jobId, first.structuredContent.jobId);
  assert.equal(f.calls.filter(x => x.method === "POST" && x.url.endsWith("/v1/predictions")).length, 1);
});
test("concurrent duplicate submissions reserve one job before creating a prediction", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call("generate_music", generation), f.call("generate_music", generation)]);
  assert.equal(results[0].structuredContent.jobId, results[1].structuredContent.jobId);
  assert.equal(f.predictions.size, 1);
});
test("per-user quota rejects the fourth active job without a paid submission", async t => {
  const f = await fixture(t);
  for (let i=0; i<3; i++) data(await f.call("generate_music", {...generation, requestKey: "quota-"+i}));
  const fourth=await f.call("generate_music", {...generation, requestKey: "quota-four"});
  assert.equal(fourth.isError, true); assert.match(fourth.structuredContent.error, /three active/);
  assert.equal(f.predictions.size, 3);
});
