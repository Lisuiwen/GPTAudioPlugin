import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import { getMusicProvider } from "./providers/index.js";
import { RUNWARE_MODELS } from "./providers/runware.js";
import { RUNWARE_LISTENING_MODEL } from "./providers/runware-listening.js";
import type { MusicWorkflow } from "./music-workflow.js";
import { newId } from "./workflow-store.js";

// Runtime dependencies are supplied by Sites or the local development server.
export type MusicConnection = {
  workflow?: MusicWorkflow;
  runtime?: string;
  buildSha?: string;
  ownerId?: string;
  runwareApiKey?: string;
};

export const SERVER_VERSION = "0.10.0";
export const TOOL_NAMES = [
  "inspect_music_model",
  "generate_music",
  "analyze_music",
  "get_service_status",
  "register_music_audio",
  "get_music_audio",
  "delete_music_audio",
  "get_music_job",
  "cancel_music_job",
  "compare_music",
];

// The two metadata fields MUST be declared but must NOT be required.
export const OpenAIFileSchema = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().min(1),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .strict();

const model = z.string().optional().describe("Runware ACE-Step model ID; XL Turbo is the default and XL Base is the slower high-quality option.");
const audioId = z
  .string()
  .min(1)
  .optional()
  .describe("A service-issued audioId owned by the current user. Never invent one.");
const requestKey = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "Reuse the same key when retrying this operation to prevent duplicate billable submissions; use a new key for a new version."
  );
const range = {
  startSec: z.number().min(0).optional(),
  endSec: z.number().positive().optional(),
};

// Explicit ranges are cropped from PCM WAV before submitting any paid inference.
function selectedRange(startSec?: number, endSec?: number) {
  if (startSec === undefined && endSec === undefined) return undefined;
  if (endSec === undefined || endSec <= (startSec || 0)) {
    throw new Error("Specify endSec greater than startSec. Segment listening requires PCM WAV.");
  }
  return { startSec: startSec || 0, endSec };
}
// Return machine-readable results while marking failed jobs as tool errors.
function reply(data: Record<string, unknown>) {
  const failed = ["failed", "canceled", "submission_unknown"].includes(String(data.status));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(failed ? { isError: true } : {}),
  };
}

// Keep expected operation failures inside the MCP response.
function failure(error: unknown) {
  return reply({
    status: "failed",
    error: error instanceof Error ? error.message : "Music operation failed.",
  });
}

// Register the single-provider catalog for one Sites or local request.
export function createMusicServer(connection: MusicConnection): McpServer {
  const server = new McpServer(
    { name: "gpt-audio-mcp", version: SERVER_VERSION },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "GPTAudioMCP v0.10.0 uses Runware ACE-Step for generation and Gemini 3.8 Flash for listening and music comparison. Compile chat context into directorPrompt. New generation accepts 30–300 seconds; source-audio edits use repaint ranges. Never invent file_id, audioId, jobId or model capabilities. Listening and comparison are billable; do not call them for status checks. Segment listening actually crops PCM WAV. A/B comparison performs two independent listens with the same rubric. Poll generation jobs with get_music_job; compatible Gemini listening cannot be reconciled after an ambiguous submission. Runware cannot cancel in-flight inference or stop its billing.",
    }
  );

  const metadata = (files: string[] = []) => ({
    securitySchemes: [{ type: "noauth" as const }],
    ...(files.length ? { "openai/fileParams": files } : {}),
  });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const billable = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const owner = () => connection.ownerId;
  const requireOwner = () => {
    const id = owner();
    if (!id) throw new Error("Authenticated user identity is required.");
    return id;
  };
  const workflow = () => {
    if (!connection.workflow) {
      throw new Error("Persistent workflows are not configured on this runtime.");
    }
    return connection.workflow;
  };
  const runwareKey = () => {
    const key = connection.runwareApiKey?.trim();
    if (!key) {
      throw new Error(
        "Runware is not configured. Add RUNWARE_API_KEY to this deployment, then retry."
      );
    }
    return key;
  };

  // The status call is read-only and never submits a provider task.
  server.registerTool(
    "get_service_status",
    {
      title: "Music service status",
      description: "Read the deployed version, Runware models, key configuration and storage mode without inference.",
      inputSchema: {},
      annotations: read,
      _meta: metadata(),
    },
    async () => reply({
      version: SERVER_VERSION,
      schemaRevision: "music-tools-v0100-runware-listening",
      buildSha: connection.buildSha || "unknown",
      runtime: connection.runtime || "node",
      tools: TOOL_NAMES,
      providers: { generation: "runware", listening: "runware" },
      models: { runware: RUNWARE_MODELS, listening: RUNWARE_LISTENING_MODEL },
      runwareConfigured: !!connection.runwareApiKey?.trim(),
      segmentFormats: ["PCM WAV", "IEEE-float WAV"],
      persistentJobs: !!connection.workflow,
      durableAudio: !!connection.workflow?.assets.bucket,
      completionPersistence: "Runware URLs normally last seven days. Configure AUDIO_BUCKET for durable service-owned copies.",
      nativeFileContract: "download_url and file_id required; mime_type and file_name optional",
    })
  );

  // Capability inspection reads the deployed Runware contract without inference.
  server.registerTool(
    "inspect_music_model",
    {
      title: "Inspect music model",
      description: "Read Runware ACE-Step capabilities and limits without creating an inference task.",
      inputSchema: { model },
      annotations: read,
      _meta: metadata(),
    },
    async ({ model }) => {
      try {
        return reply(await getMusicProvider("runware").inspectModel("", model));
      } catch (error) {
        return failure(error);
      }
    }
  );
  server.registerTool(
    "generate_music",
    {
      title: "Generate or transform music",
      description:
        "GPTAudioMCP v0.10.0. Generate or edit music with hosted ACE-Step 1.5 on Runware. XL Turbo is the default. Supports new music, audio-driven reference/cover, bounded repaint, and continuation/extension via repaint ranges. New generation supports 30–300 seconds. Source-audio requests do not accept duration. Returns audio immediately when complete or a resumable jobId.",
      inputSchema: {
        model,
        requestKey,
        generationMode: z
          .enum(["auto", "generate", "cover", "reference", "repaint", "continue"])
          .default("auto"),
        conversationSummary: z.string().min(1).max(10000),
        directorPrompt: z
          .string()
          .min(2)
          .max(3000)
          .describe(
            "Complete creative direction already incorporating chat context. Runware ACE-Step hosted prompt limit is 3000 characters; never truncate requirements silently."
          ),
        duration: z
          .number()
          .min(30)
          .max(300)
          .optional()
          .describe(
            "Requested duration for NEW generation only, 30–300 seconds. Do not send with source audio; use repaintingStart/repaintingEnd for edits or extension."
          ),
        lyrics: z.string().max(3000).optional(),
        instrumental: z.boolean().optional(),
        autoLyrics: z.boolean().optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        audioFormat: z.enum(["mp3", "wav"]).default("mp3"),
        referenceAudio: OpenAIFileSchema.optional(),
        sourceAudioId: audioId,
        continuation: z.boolean().default(false),
        repaintingStart: z
          .number()
          .min(-300)
          .max(300)
          .optional()
          .describe(
            "Start of the ACE-Step repaint range in seconds. Negative values can prepend audio. Required together with repaintingEnd for repaint/continue."
          ),
        repaintingEnd: z
          .number()
          .min(0)
          .max(300)
          .optional()
          .describe(
            "End of the repaint range in seconds. Values beyond the source duration append audio. Required together with repaintingStart for repaint/continue."
          ),
        strength: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Source-audio influence strength. Defaults are chosen by mode; higher values retain more source influence."
          ),
      },
      annotations: billable,
      _meta: metadata(["referenceAudio"]),
    },
    async (args) => {
      try {
        const id = requireOwner();
        const { referenceAudio, sourceAudioId, requestKey: key, ...request } = args;
        const keyValue = runwareKey();

        if (connection.workflow) {
          return reply(
            await connection.workflow.submit(
              id,
              request,
              { audioId: sourceAudioId, audio: referenceAudio },
              key
            )
          );
        }
        if (sourceAudioId) throw new Error("audioId requires workflow storage.");
        const result = await getMusicProvider("runware").generate(keyValue, {
          ...request,
          referenceAudioUrl: referenceAudio?.download_url,
          referenceAudioName: referenceAudio?.file_name,
          referenceAudioMimeType: referenceAudio?.mime_type,
        });
        return reply({ status: "succeeded", ...result });
      } catch (error) {
        return failure(error);
      }
    }
  );

  // Restored listening tool accepts an attachment or an existing owner-scoped audioId.
  server.registerTool(
    "analyze_music",
    {
      title: "Listen to music",
      description:
        "Billable listening through Runware Gemini 3.8 Flash. Analyze actual audio from a native attachment or saved audioId. Optional startSec/endSec crops PCM WAV before submission. Returns structured observations, uncertainties and creative suggestions when the model follows the JSON rubric.",
      inputSchema: {
        requestKey,
        audio: OpenAIFileSchema.optional(),
        audioId,
        question: z.string().min(1).max(10000),
        conversationSummary: z.string().max(10000).optional(),
        analysisFocus: z.array(z.string().min(1)).max(12).optional(),
        ...range,
      },
      annotations: billable,
      _meta: metadata(["audio"]),
    },
    async ({ audio, audioId: sourceId, requestKey: key, startSec, endSec, ...request }) => {
      try {
        const id = requireOwner();
        runwareKey();
        return reply(await workflow().analyze(
          id,
          { ...request, analyzedRange: selectedRange(startSec, endSec) },
          { audioId: sourceId, audio },
          key
        ));
      } catch (error) {
        return failure(error);
      }
    }
  );


  server.registerTool(
    "register_music_audio",
    {
      title: "Keep audio for reuse",
      description:
        "Register a user-provided music attachment and return a reusable, user-owned audioId. Storage status states whether bytes are durable or only a temporary URL is retained.",
      inputSchema: { audio: OpenAIFileSchema, parentAudioId: audioId },
      annotations: { ...read, readOnlyHint: false, openWorldHint: true },
      _meta: metadata(["audio"]),
    },
    async (args) => {
      try {
        const w = workflow();
        const id = requireOwner();
        return reply(
          w.assets.view(
            await w.assets.register(id, {
              url: args.audio.download_url,
              fileName: args.audio.file_name,
              mimeType: args.audio.mime_type,
              parentAudioId: args.parentAudioId,
            })
          )
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "get_music_audio",
    {
      title: "Read saved audio",
      description:
        "Read metadata, storage status and version lineage for a returned audioId. It cannot access another user's audio.",
      inputSchema: { audioId: z.string().min(1) },
      annotations: read,
      _meta: metadata(),
    },
    async ({ audioId: id }) => {
      try {
        const w = workflow();
        return reply(w.assets.view(await w.assets.require(requireOwner(), id)));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "delete_music_audio",
    {
      title: "Delete saved audio",
      description:
        "Permanently delete this user's saved audio bytes and metadata. Does not delete the source attachment or provider inference. Only use on explicit deletion requests.",
      inputSchema: { audioId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: metadata(),
    },
    async ({ audioId: id }) => {
      try {
        await workflow().assets.remove(requireOwner(), id);
        return reply({ status: "deleted", audioId: id });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "get_music_job",
    {
      title: "Check music task",
      description:
        "Check a returned jobId. Generation tasks can be reconciled by Runware UUID; Gemini 3.8 Flash listening uses a synchronous compatible endpoint and cannot reconcile an uncertain submission.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: metadata(),
    },
    async ({ jobId }) => {
      try {
        return reply(
          await workflow().get(requireOwner(), jobId)
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "cancel_music_job",
    {
      title: "Cancel music task",
      description:
        "Read a finished task or report that Runware cannot cancel an in-flight inference or stop its billing. Gemini 3.8 Flash listening cannot be canceled.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: metadata(),
    },
    async ({ jobId }) => {
      try {
        return reply(
          await workflow().cancel(requireOwner(), jobId)
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  // A/B comparison keeps two independent jobs so each audio has an auditable critique.
  server.registerTool(
    "compare_music",
    {
      title: "Compare two music versions",
      description:
        "Submit TWO billable Gemini 3.8 Flash listens through Runware with the same question and range. Poll returned job IDs as needed; compare only completed audible evidence. Both audioIds must belong to the current user.",
      inputSchema: {
        audioIdA: z.string().min(1),
        audioIdB: z.string().min(1),
        question: z.string().min(1).max(10000),
        conversationSummary: z.string().max(10000).optional(),
        requestKey,
        ...range,
      },
      annotations: billable,
      _meta: metadata(),
    },
    async (args) => {
      try {
        const id = requireOwner();
        const w = workflow();
        runwareKey();
        await w.assets.require(id, args.audioIdA);
        await w.assets.require(id, args.audioIdB);
        const key = args.requestKey || newId("compare");
        if (key.length > 126 || !/^[\w.-]+$/.test(key)) throw new Error("Comparison requestKey must be at most 126 letters, digits, underscores, dots or hyphens.");
        const request = {
          question: args.question,
          conversationSummary: args.conversationSummary,
          analyzedRange: selectedRange(args.startSec, args.endSec),
        };
        const a = await w.analyze(id, request, { audioId: args.audioIdA }, `${key}.a`);
        const b = await w.analyze(id, request, { audioId: args.audioIdB }, `${key}.b`);
        return reply({
          requestKey: key,
          comparisonType: "independent-listening-same-rubric",
          jobs: [{ label: "A", ...a }, { label: "B", ...b }],
          instruction: "Compare only completed evidence. Report failed or uncertain analyses explicitly; do not resubmit an uncertain call automatically.",
        });
      } catch (error) {
        return failure(error);
      }
    }
  );


  return server;
}
