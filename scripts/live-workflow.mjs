// Optional live Runware workflow probe; the default path makes no billable calls.
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
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  report = { runId: randomUUID(), endpoint: endpoint.href, events: [], startedAt: new Date().toISOString() };
}
if (report.endpoint !== endpoint.href) throw new Error("Report belongs to a different endpoint.");

// Save only job identifiers and status, never signed audio URLs or credentials.
async function save() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}

const client = new Client({ name: "gpt-audio-live-regression", version: "0.10.0" });

// Unwrap one MCP result and reject service-reported errors.
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const data = response.structuredContent || JSON.parse(response.content?.[0]?.text || "{}");
  if (response.isError) throw new Error(name + ": " + (data.error || "failed"));
  return data;
}

// Poll the existing job ID; never submit a replacement inference on timeout.
async function finished(job) {
  const deadline = Date.now() + 10 * 60000;
  while (!["succeeded", "failed", "canceled", "submission_unknown"].includes(job.status)) {
    if (Date.now() > deadline) throw new Error("Polling timeout; reuse job " + job.jobId);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    job = await call("get_music_job", { jobId: job.jobId });
    console.log(JSON.stringify({ jobId: job.jobId, status: job.status }));
  }
  assert.equal(job.status, "succeeded");
  return job;
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  report.tools = tools.map((tool) => tool.name);
  report.service = await call("get_service_status");
  assert.equal(report.tools.length, 8);
  await save();
  if (!billable) {
    console.log("Discovery and status passed. No inference was created.");
  } else {
    if (!report.service.runwareConfigured) throw new Error("RUNWARE_API_KEY is not configured.");
    const generationInput = {
      requestKey: "live-" + report.runId + "-generate",
      conversationSummary: "Short technical smoke test of an instrumental.",
      directorPrompt: "Instrumental, gentle ukulele and warm strings, relaxed island background music, no vocals.",
      generationMode: "generate",
      instrumental: true,
      duration: 30,
      audioFormat: "wav",
    };
    const submitted = await call("generate_music", generationInput);
    report.generationJobId = submitted.jobId;
    await save();
    const generated = await finished(submitted);
    report.audioId = generated.audioId;
    report.generationModel = generated.model;
    await save();
    assert.ok(generated.audioId);
    const retry = await call("generate_music", generationInput);
    assert.equal(retry.jobId, generated.jobId);
    report.status = "passed";
    report.completedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: report.status, generationJobId: report.generationJobId, audioId: report.audioId }));
  }
} catch (error) {
  report.status = "blocked_or_failed";
  report.error = error instanceof Error ? error.message : String(error);
  await save();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await client.close();
}
