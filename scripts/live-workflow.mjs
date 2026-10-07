import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL || "http://127.0.0.1:8797/mcp");
const reportPath = resolve(process.env.MUSIC_LIVE_REPORT || ".data/live-workflow-report.json");
const billable = process.argv.includes("--billable");
let report;
try { report = JSON.parse(await readFile(reportPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; report = { runId: randomUUID(), endpoint: endpoint.href, events: [], startedAt: new Date().toISOString() }; }
if (report.endpoint !== endpoint.href) throw new Error("Report belongs to a different endpoint. Choose a new MUSIC_LIVE_REPORT path.");
const save = async () => { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); };
const client = new Client({ name: "gpt-audio-live-regression", version: "0.8.0" });
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const data = response.structuredContent || JSON.parse(response.content?.[0]?.text || "{}");
  if (response.isError) throw new Error(`${name}: ${data.error || response.content?.[0]?.text || "failed"}`);
  return data;
}
async function finished(job) {
  const deadline = Date.now() + 10 * 60000;
  while (!["succeeded", "failed", "canceled", "submission_unknown"].includes(job.status)) {
    if (Date.now() > deadline) throw new Error(`Polling timeout; reuse job ${job.jobId}. Do not submit another generation.`);
    await new Promise(r => setTimeout(r, 3000));
    job = await call("get_music_job", { jobId: job.jobId });
    console.log(JSON.stringify({ jobId: job.jobId, status: job.status }));
  }
  assert.equal(job.status, "succeeded");
  return job;
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  report.tools = tools.map(t => t.name); report.service = await call("get_service_status");
  assert.equal(report.tools.length, 11);
  // Do not log identities, tokens, signed audio URLs, or uploaded file bodies.
  const profile = await client.callTool({ name: "get_music_provider_profile", arguments: { provider: "replicate" } });
  report.connected = !profile.isError;
  await save();
  if (!report.service?.runwareConfigured) throw new Error("RUNWARE_API_KEY is not configured in this local test runtime.");\n  if (!report.connected) throw new Error("Replicate listening is not connected in this local test runtime. Enter the token privately at /connect; never paste it into chat.");
  if (!billable) {
    console.log("Discovery and connection checks passed. No predictions created. Add --billable for one short generation plus one cropped analysis.");
  } else {
    const generationInput = { requestKey: `live-${report.runId}-generate`, conversationSummary: "End-to-end technical smoke test of a quiet island-game instrumental.", directorPrompt: "Instrumental, gentle ukulele and warm strings, relaxed island game background music, no vocals.", generationMode: "generate", instrumental: true, duration: 30, audioFormat: "wav" };
    const submitted = await call("generate_music", generationInput);
    report.generationJobId = submitted.jobId; await save();
    const generated = await finished(submitted);
    report.audioId = generated.audioId; report.generationModel = generated.model; report.generationModelVersion = generated.modelVersion; await save();
    assert.ok(generated.audioId);
    const retry = await call("generate_music", generationInput);
    assert.equal(retry.jobId, generated.jobId);
    report.idempotentRetryPassed = true;
    const analyzed = await finished(await call("analyze_music", { requestKey: `live-${report.runId}-analyze`, audioId: generated.audioId, startSec: 0, endSec: 4, question: "Describe the audible instruments and rhythm of this clip. Separate observations from uncertain interpretations and suggestions." }));
    report.analysisJobId = analyzed.jobId; report.analysisModel = analyzed.model; report.analysisModelVersion = analyzed.modelVersion;
    report.analyzedRange = analyzed.analyzedRange; report.structuredStatus = analyzed.structuredStatus; report.answer = analyzed.answer;
    assert.deepEqual(report.analyzedRange, { startSec: 0, endSec: 4 }); assert.ok(report.answer);
    report.status = "passed"; delete report.error; report.completedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: report.status, generationJobId: report.generationJobId, audioId: report.audioId, analysisJobId: report.analysisJobId, structuredStatus: report.structuredStatus, reportPath }));
  }
} catch (error) {
  report.status = "blocked_or_failed"; report.error = error instanceof Error ? error.message : String(error); await save();
  console.error(report.error); process.exitCode = 1;
} finally { await client.close(); }
