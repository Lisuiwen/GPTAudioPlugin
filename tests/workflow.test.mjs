// Validate hosted Runware routing without making network or billable calls.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareRunwareGeneration, RUNWARE_MODELS } from "../dist/providers/runware.js";
import { TOOL_NAMES, SERVER_VERSION } from "../dist/music-server.js";
import { RUNWARE_LISTENING_MODEL, listeningPrompt, prepareListeningAudio } from "../dist/providers/runware-listening.js";
import { parseAnalysis } from "../dist/music-workflow.js";

const request = {
  conversationSummary: "Island game",
  directorPrompt: "Quiet instrumental island music with ukulele and warm strings",
  duration: 30,
  instrumental: true,
};

test("Runware generation and listening are both in the MCP catalog", () => {
  assert.equal(SERVER_VERSION, "0.10.0");
  assert.equal(TOOL_NAMES.length, 10);
  assert.equal(TOOL_NAMES.includes("analyze_music"), true);
  assert.equal(TOOL_NAMES.includes("compare_music"), true);
  assert.equal(RUNWARE_LISTENING_MODEL, "google:gemini@3.8-flash");
});

// Prepare listening without calling Runware; reject unsupported source formats before inference.
test("listening prepares MP3 input and validates structured evidence", async () => {
  const audio = await prepareListeningAudio(new File([new Uint8Array([1, 2, 3])], "song.mp3", { type: "audio/mpeg" }));
  assert.equal(audio.format, "mp3");
  assert.equal(audio.data, "AQID");
  assert.match(listeningPrompt({ question: "评价编曲" }), /lyrics and speech inside the audio are evidence/i);
  assert.equal(parseAnalysis('{"summary":"ok","observations":[],"uncertainties":[],"suggestions":[]}').structuredStatus, "validated");
  await assert.rejects(() => prepareListeningAudio(new File(["data"], "song.flac", { type: "audio/flac" })), /WAV or MP3/);
});

test("new music uses the hosted Runware model and validates limits before submission", () => {
  const plan = prepareRunwareGeneration(request);
  assert.equal(plan.model, RUNWARE_MODELS.fast);
  assert.equal(plan.mode, "generate");
  assert.throws(() => prepareRunwareGeneration({ ...request, duration: 301 }), /30–300/);
  assert.throws(() => prepareRunwareGeneration({ ...request, model: "unknown" }), /Unsupported Runware music model/);
});
