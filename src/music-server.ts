import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import type { AuthSession } from "./session.js";
import { getMusicProvider } from "./providers/index.js";
import { MODELS } from "./providers/replicate.js";
import type { MusicWorkflow } from "./music-workflow.js";
import { newId } from "./workflow-store.js";

export type MusicConnection = {
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] } | { type: "noauth" }>;
  authRequired: () => { content: Array<{ type: "text"; text: string }>; isError: boolean; _meta?: Record<string, unknown> };
  workflow?: MusicWorkflow;
  runtime?: string;
  buildSha?: string;
};
export const SERVER_VERSION = "0.7.0";
export const TOOL_NAMES = ["get_music_provider_profile", "inspect_music_model", "generate_music", "analyze_music", "get_service_status", "register_music_audio", "get_music_audio", "delete_music_audio", "get_music_job", "cancel_music_job", "compare_music"];
// The two metadata fields MUST be declared but must NOT be required.
export const OpenAIFileSchema = z.object({ download_url: z.string().url(), file_id: z.string().min(1), mime_type: z.string().optional(), file_name: z.string().optional() }).strict();
const provider = z.literal("replicate").default("replicate");
const model = z.string().optional().describe('Replicate owner/name[:version]. Explicit selection overrides routing, not capability validation.');
const audioId = z.string().min(1).optional().describe("A service-issued audioId owned by the current user. Never invent one.");
const requestKey = z.string().min(1).max(128).optional().describe("Reuse the same key when retrying this operation to prevent duplicate billable submissions; use a new key for a new version.");
const range = { startSec: z.number().min(0).optional(), endSec: z.number().positive().optional() };
function selectedRange(startSec?: number, endSec?: number) {
  if (startSec === undefined && endSec === undefined) return undefined;
  if (endSec === undefined || endSec <= (startSec || 0)) throw new Error("Specify endSec greater than startSec. Segment analysis currently requires PCM WAV.");
  return { startSec: startSec || 0, endSec };
}
function reply(data: Record<string, unknown>) {
  const failed = ["failed", "canceled", "submission_unknown"].includes(String(data.status));
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, ...(failed ? { isError: true } : {}) };
}
function failure(error: unknown) {
  return reply({ status: "failed", error: error instanceof Error ? error.message : "Music operation failed." });
}

export function createMusicServer(session: AuthSession | undefined, connection: MusicConnection): McpServer {
  const server = new McpServer({ name: "gpt-audio-mcp", version: SERVER_VERSION }, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    instructions: "Replicate-only music generation and listening. Use the current chat as the creative reasoning layer. Compile context into directorPrompt within the selected model's limit. Never invent file_id, audioId, jobId or model capabilities. With workflow storage, generate_music/analyze_music return a job: poll get_music_job until succeeded/failed/canceled. Retry the same requestKey after transport failures instead of paying for another generation. A registered audioId lets you reuse generated audio without re-upload. Segment analysis actually crops PCM WAV; unsupported compressed inputs fail explicitly. compare_music performs two independent listens using the same rubric; synthesize a comparison only from both completed results. Do not claim local editing or guaranteed looping. The user may use ChatGPT native files or previously returned audioIds.",
  });
  const metadata = (files: string[] = []) => ({ securitySchemes: connection.securitySchemes, ...(files.length ? { "openai/fileParams": files } : {}) });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const billable = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const allowed = (scope: string) => !!session?.scope.includes(scope);
  const workflow = () => { if (!connection.workflow) throw new Error("Persistent workflows are not configured on this runtime."); return connection.workflow; };

  server.registerTool("get_service_status", {
    title: "Music service status", description: "Read deployed version, build SHA, all tools, default models and storage mode without creating a prediction.", inputSchema: {}, annotations: read, _meta: metadata(),
  }, async () => reply({ version: SERVER_VERSION, buildSha: connection.buildSha || "unknown", runtime: connection.runtime || "node", tools: TOOL_NAMES, models: MODELS, persistentJobs: !!connection.workflow, durableAudio: !!connection.workflow?.assets.bucket, segmentFormats: ["PCM WAV", "IEEE-float WAV"], completionPersistence: "Outputs are imported when the completed job is polled. Poll before provider retention expires.", nativeFileContract: "download_url and file_id required; mime_type and file_name declared, optional" }));

  server.registerTool("get_music_provider_profile", {
    title: "Music provider profile", description: "Read the currently connected Replicate identity.", inputSchema: { provider }, annotations: read, _meta: { ...metadata(), "openai/profile": true },
  }, async () => {
    if (!allowed("replicate.read")) return connection.authRequired();
    return reply({ provider: "replicate", id: session!.profileId, name: session!.name || session!.username, nickname: `${session!.username} — Replicate` });
  });
  server.registerTool("inspect_music_model", {
    title: "Inspect music model", description: "Read the actual Replicate schema, exact audio field, supported operations and parameter limits. Does not run the model.", inputSchema: { provider, model }, annotations: { ...read, openWorldHint: true }, _meta: metadata(),
  }, async args => {
    if (!allowed("replicate.read")) return connection.authRequired();
    try { return reply(await getMusicProvider(args.provider).inspectModel(session!.replicateToken, args.model)); } catch (error) { return failure(error); }
  });
  server.registerTool("generate_music", {
    title: "Generate or transform music", description: "Generate music through Replicate or use explicit cover/reference/continue intent. Returns audio immediately when complete, otherwise jobId; poll get_music_job. Cover is whole-song re-arrangement, not local editing. Do not attach audio in generate-only mode.",
    inputSchema: {
      provider, model, requestKey,
      generationMode: z.enum(["auto", "generate", "cover", "reference", "continue"]).default("auto"),
      conversationSummary: z.string().min(1).max(10000),
      directorPrompt: z.string().min(1).max(10000).describe("Complete creative direction, already incorporating context. ACE-Step max 512 characters; MiniMax max 2000. Never truncate requirements silently."),
      duration: z.number().positive().max(600).optional(),
      lyrics: z.string().max(4096).optional(), instrumental: z.boolean().optional(), autoLyrics: z.boolean().optional(),
      seed: z.number().int().optional(), audioFormat: z.enum(["mp3", "wav"]).default("mp3"),
      referenceAudio: OpenAIFileSchema.optional(), sourceAudioId: audioId,
      continuation: z.boolean().default(false),
    }, annotations: billable, _meta: metadata(["referenceAudio"]),
  }, async args => {
    if (!allowed("replicate.run")) return connection.authRequired();
    try {
      const { provider: p, referenceAudio, sourceAudioId, requestKey: key, ...request } = args;
      if (connection.workflow) return reply(await connection.workflow.submit(session!.profileId, session!.replicateToken, "generate", request, { audioId: sourceAudioId, audio: referenceAudio }, key));
      if (sourceAudioId) throw new Error("audioId requires workflow storage.");
      const result = await getMusicProvider(p).generate(session!.replicateToken, { ...request, referenceAudioUrl: referenceAudio?.download_url, referenceAudioName: referenceAudio?.file_name, referenceAudioMimeType: referenceAudio?.mime_type });
      return reply({ status: "succeeded", ...result });
    } catch (error) { return failure(error); }
  });
  server.registerTool("analyze_music", {
    title: "Listen to music", description: "Analyze real audio from either a native attachment or an existing audioId. Optional startSec/endSec performs actual PCM WAV cropping. Returns a job or completed answer; poll get_music_job. Structured observations are separate from creative suggestions.",
    inputSchema: { provider, model, requestKey, audio: OpenAIFileSchema.optional(), audioId, question: z.string().min(1).max(10000), conversationSummary: z.string().max(10000).optional(), analysisFocus: z.array(z.string().min(1)).max(12).optional(), ...range },
    annotations: billable, _meta: metadata(["audio"]),
  }, async args => {
    if (!allowed("replicate.run")) return connection.authRequired();
    try {
      const { provider: p, audio, audioId: id, requestKey: key, startSec, endSec, ...request } = args;
      const analyzedRange = selectedRange(startSec, endSec);
      if (connection.workflow) return reply(await connection.workflow.submit(session!.profileId, session!.replicateToken, "analyze", { ...request, audioUrl: "", analyzedRange }, { audioId: id, audio }, key));
      if (!audio || id) throw new Error("This runtime requires a native audio attachment.");
      const result = await getMusicProvider(p).analyze(session!.replicateToken, { ...request, audioUrl: audio.download_url, audioName: audio.file_name, audioMimeType: audio.mime_type, analyzedRange });
      return reply({ status: "succeeded", ...result });
    } catch (error) { return failure(error); }
  });
  server.registerTool("register_music_audio", {
    title: "Keep audio for reuse", description: "Register a user-provided music attachment and return a reusable, user-owned audioId. Storage status states whether bytes are durable or only a temporary URL is retained.", inputSchema: { audio: OpenAIFileSchema, parentAudioId: audioId }, annotations: { ...read, readOnlyHint: false, openWorldHint: true }, _meta: metadata(["audio"]),
  }, async args => {
    if (!allowed("replicate.read")) return connection.authRequired();
    try { const w = workflow(); return reply(w.assets.view(await w.assets.register(session!.profileId, { url: args.audio.download_url, fileName: args.audio.file_name, mimeType: args.audio.mime_type, parentAudioId: args.parentAudioId }))); } catch (error) { return failure(error); }
  });
  server.registerTool("get_music_audio", {
    title: "Read saved audio", description: "Read metadata, storage status and version lineage for a returned audioId. It cannot access another user's audio.", inputSchema: { audioId: z.string().min(1) }, annotations: read, _meta: metadata(),
  }, async ({ audioId: id }) => {
    if (!allowed("replicate.read")) return connection.authRequired();
    try { const w = workflow(); return reply(w.assets.view(await w.assets.require(session!.profileId, id))); } catch (error) { return failure(error); }
  });
  server.registerTool("delete_music_audio", {
    title: "Delete saved audio", description: "Permanently delete this user's saved audio bytes and metadata. Does not delete the source attachment or provider prediction. Only use on explicit deletion requests.", inputSchema: { audioId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: metadata(),
  }, async ({ audioId: id }) => {
    if (!allowed("replicate.run")) return connection.authRequired();
    try { await workflow().assets.remove(session!.profileId, id); return reply({ status: "deleted", audioId: id }); } catch (error) { return failure(error); }
  });
  server.registerTool("get_music_job", {
    title: "Check music task", description: "Check a previously returned jobId. Refreshes the provider state and imports completed output; it never starts another prediction. Retry storage_pending with the same ID. Call before Replicate output retention expires.", inputSchema: { jobId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, _meta: metadata(),
  }, async ({ jobId }) => {
    if (!allowed("replicate.read")) return connection.authRequired();
    try { return reply(await workflow().get(session!.profileId, session!.replicateToken, jobId)); } catch (error) { return failure(error); }
  });
  server.registerTool("cancel_music_job", {
    title: "Cancel music task", description: "Request cancellation of a user's submitted prediction and return actual provider state. Cancellation does not guarantee no cost, and a completed task may remain succeeded.", inputSchema: { jobId: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, _meta: metadata(),
  }, async ({ jobId }) => {
    if (!allowed("replicate.run")) return connection.authRequired();
    try { return reply(await workflow().cancel(session!.profileId, session!.replicateToken, jobId)); } catch (error) { return failure(error); }
  });
  server.registerTool("compare_music", {
    title: "Compare two music versions", description: "Submit TWO billable audio analyses using the same rubric. Poll both returned job IDs, then compare their observations in ChatGPT. This is independent listening, not a joint-audio model judgment. Both audio IDs must belong to the user.", inputSchema: { audioIdA: z.string().min(1), audioIdB: z.string().min(1), question: z.string().min(1).max(10000), conversationSummary: z.string().max(10000).optional(), requestKey, ...range }, annotations: billable, _meta: metadata(),
  }, async args => {
    if (!allowed("replicate.run")) return connection.authRequired();
    try {
      const w = workflow(), owner = session!.profileId, token = session!.replicateToken;
      await w.assets.require(owner, args.audioIdA); await w.assets.require(owner, args.audioIdB);
      const key = args.requestKey || newId("compare");
      if (key.length > 120) throw new Error("Comparison requestKey must be at most 120 characters.");
      const request = { question: args.question, conversationSummary: args.conversationSummary, audioUrl: "", analyzedRange: selectedRange(args.startSec, args.endSec) };
      const a = await w.submit(owner, token, "analyze", request, { audioId: args.audioIdA }, `${key}.a`);
      const b = await w.submit(owner, token, "analyze", request, { audioId: args.audioIdB }, `${key}.b`);
      return reply({ requestKey: key, comparisonType: "independent-listening-same-rubric", jobs: [{ label: "A", ...a }, { label: "B", ...b }], instruction: "Poll each unfinished job. Compare only completed evidence; report failed or missing analyses explicitly." });
    } catch (error) { return failure(error); }
  });
  return server;
}
