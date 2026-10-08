// Validate hosted Runware routing without making network or billable calls.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareRunwareGeneration, RUNWARE_MODELS } from "../dist/providers/runware.js";
import { TOOL_NAMES, SERVER_VERSION } from "../dist/music-server.js";

const request = {
  conversationSummary: "Island game",
  directorPrompt: "Quiet instrumental island music with ukulele and warm strings",
  duration: 30,
  instrumental: true,
};

test("Runware is the only provider in the MCP catalog", () => {
  assert.equal(SERVER_VERSION, "0.9.0");
  assert.equal(TOOL_NAMES.length, 8);
  assert.equal(TOOL_NAMES.includes("analyze_music"), false);
  assert.equal(TOOL_NAMES.includes("compare_music"), false);
});

test("new music uses the hosted Runware model and validates limits before submission", () => {
  const plan = prepareRunwareGeneration(request);
  assert.equal(plan.model, RUNWARE_MODELS.fast);
  assert.equal(plan.mode, "generate");
  assert.throws(() => prepareRunwareGeneration({ ...request, duration: 301 }), /30–300/);
  assert.throws(() => prepareRunwareGeneration({ ...request, model: "unknown" }), /Unsupported Runware music model/);
});
