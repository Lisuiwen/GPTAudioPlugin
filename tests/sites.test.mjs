// Exercise the bundled Sites Worker and its Runware generation and listening flows.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const source = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const migration = await readFile(new URL("../drizzle/0001_mute_quentin_quire.sql", import.meta.url), "utf8");
const origin = "https://gpt-audio.example";

// Create only the music table, proving the retired connection table is not needed.
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  t.after(() => db.close());
  const env = {
    RUNWARE_API_KEY: "test-runware-key",
    BUILD_SHA: "test-build",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() { return db.prepare(sql).get(...values) || null; },
              async run() { return db.prepare(sql).run(...values); },
            };
          },
        };
      },
    },
  };
  // Call the actual Worker transport; all test identities are injected locally.
  async function rpc(method, params = {}, userId = "alice") {
    return worker.fetch(new Request(origin + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(userId ? { "oai-authenticated-user-id": userId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), env);
  }
  return { env, rpc };
}

test("old connection URL has no token form and catalog exposes Runware tools", async (t) => {
  const f = fixture(t);
  const page = await worker.fetch(new Request(origin + "/connect", {
    headers: { "oai-authenticated-user-id": "alice" },
  }), f.env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Runware 已配置/);
  assert.doesNotMatch(html, /Replicate|<form|<input/i);

  const retired = await worker.fetch(new Request(origin + "/connect", {
    method: "POST",
    headers: { "oai-authenticated-user-id": "alice" },
  }), f.env);
  assert.equal(retired.status, 410);

  const listResponse = await f.rpc("tools/list");
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(listed, [
    "analyze_music",
    "cancel_music_job",
    "compare_music",
    "delete_music_audio",
    "generate_music",
    "get_music_audio",
    "get_music_job",
    "get_service_status",
    "inspect_music_model",
    "register_music_audio",
  ]);
  const statusResponse = await f.rpc("tools/call", { name: "get_service_status", arguments: {} });
  assert.equal(statusResponse.status, 200);
  const status = (await statusResponse.json()).result.structuredContent;
  assert.equal(status.version, "0.10.0");
  assert.equal(status.providers.generation, "runware");
  assert.equal(status.providers.listening, "runware");
  assert.equal(status.models.listening, "google:gemini@3.8-flash");
  assert.equal(status.runwareConfigured, true);
  assert.equal(status.tools.length, 10);
  const unauthenticated = await f.rpc("tools/call", { name: "get_service_status", arguments: {} }, "");
  assert.equal(unauthenticated.status, 401);
});

// Mock all provider calls: verify real MCP routing and idempotency without paid inference.
test("Runware Gemini listening and A/B comparison use saved audio with one submission per key", async (t) => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "audio.example") {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await request.json();
      assert.equal(body.model, "google:gemini@3.8-flash");
      assert.equal(body.messages[0].content[1].type, "input_audio");
      assert.equal(body.messages[0].content[1].input_audio.format, "mp3");
      prompts.push(body.messages[0].content[0].text);
      return Response.json({ id: `chat-${prompts.length}`, choices: [{ message: { content: JSON.stringify({
        summary: "可听出节奏层次", observations: ["鼓点清晰"], uncertainties: [], suggestions: ["可以收紧低频"],
      }) } }], usage: { cost: 0.002 } });
    }
    throw new Error("Unexpected network request");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const audio = { download_url: "https://audio.example/a.mp3", file_id: "file-a", mime_type: "audio/mpeg" };
  const first = await f.rpc("tools/call", { name: "analyze_music", arguments: { requestKey: "listen-a", audio, question: "评价编曲" } });
  const firstJob = (await first.json()).result.structuredContent;
  assert.equal(firstJob.status, "succeeded");
  assert.equal(firstJob.structuredStatus, "validated");
  assert.equal(firstJob.model, "google:gemini@3.8-flash");
  const repeat = await f.rpc("tools/call", { name: "analyze_music", arguments: { requestKey: "listen-a", audio, question: "评价编曲" } });
  assert.equal((await repeat.json()).result.structuredContent.jobId, firstJob.jobId);
  assert.equal(prompts.length, 1);

  const firstAudioId = firstJob.sourceAudioId;
  const registered = await f.rpc("tools/call", { name: "register_music_audio", arguments: {
    audio: { download_url: "https://audio.example/b.mp3", file_id: "file-b", mime_type: "audio/mpeg" },
  } });
  const secondAudioId = (await registered.json()).result.structuredContent.audioId;
  const compared = await f.rpc("tools/call", { name: "compare_music", arguments: {
    requestKey: "compare-1", audioIdA: firstAudioId, audioIdB: secondAudioId, question: "哪首编曲更清晰？",
  } });
  const comparison = (await compared.json()).result.structuredContent;
  assert.equal(comparison.jobs.length, 2);
  assert.deepEqual(comparison.jobs.map((job) => job.status), ["succeeded", "succeeded"]);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1], prompts[2]);
});

// An ambiguous compatible-API response must not trigger a second billable call.
test("uncertain listening is retained under its request key and cannot be retried automatically", async (t) => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "audio.example") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    if (url.pathname === "/v1/chat/completions") { submissions++; throw new Error("Connection dropped"); }
    throw new Error("Unexpected network request");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const args = { requestKey: "uncertain-one", audio: { download_url: "https://audio.example/a.mp3", file_id: "file-a" }, question: "评价音色" };
  const first = await f.rpc("tools/call", { name: "analyze_music", arguments: args });
  const firstJob = (await first.json()).result.structuredContent;
  assert.equal(firstJob.status, "submission_unknown");
  assert.equal(firstJob.pollAfterSeconds, undefined);
  const repeat = await f.rpc("tools/call", { name: "analyze_music", arguments: args });
  assert.equal((await repeat.json()).result.structuredContent.jobId, firstJob.jobId);
  assert.equal(submissions, 1);
});

test("Runware generation uses one submission for a repeated request key", async (t) => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.runware.ai") {
      const task = (await request.json())[0];
      if (task.taskType !== "audioInference") throw new Error("Unexpected provider request");
      submissions++;
      return Response.json({ data: [{
        taskType: "audioInference",
        taskUUID: task.taskUUID,
        audioURL: "https://audio.example/generated.mp3",
        cost: 0.0009,
      }] });
    }
    if (url.hostname === "audio.example") {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error("Unexpected network request");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const args = {
    requestKey: "repeat-one",
    conversationSummary: "Quiet instrumental",
    directorPrompt: "Warm strings and gentle percussion for a quiet instrumental track",
    duration: 30,
    instrumental: true,
  };
  const first = await f.rpc("tools/call", { name: "generate_music", arguments: args });
  assert.equal(first.status, 200);
  const firstJob = (await first.json()).result.structuredContent;
  assert.equal(firstJob.status, "succeeded");
  assert.ok(firstJob.audioId);
  const repeated = await f.rpc("tools/call", { name: "generate_music", arguments: args });
  assert.equal((await repeated.json()).result.structuredContent.jobId, firstJob.jobId);
  assert.equal(submissions, 1);
  const otherUser = await f.rpc("tools/call", { name: "get_music_job", arguments: { jobId: firstJob.jobId } }, "bob");
  assert.equal((await otherUser.json()).result.isError, true);
});
