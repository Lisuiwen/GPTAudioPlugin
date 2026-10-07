import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import type { AuthSession } from "./session.js";
import { getMusicProvider } from "./providers/index.js";
import { MODELS as REPLICATE_MODELS } from "./providers/replicate.js";
import { RUNWARE_MODELS } from "./providers/runware.js";
import type { MusicWorkflow } from "./music-workflow.js";
import { newId } from "./workflow-store.js";

export type MusicConnection = {
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] } | { type: "noauth" }>;
  authRequired: () => {
    content: Array<{ type: "text"; text: string }>;
    isError: boolean;
    _meta?: Record<string, unknown>;
  };
  workflow?: MusicWorkflow;
  runtime?: string;
  buildSha?: string;
  ownerId?: string;
  runwareApiKey?: string;
};

export const SERVER_VERSION = "0.8.0";
export const TOOL_NAMES = [
  "get_music_provider_profile",
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

const generationProvider = z.literal("runware").default("runware");
const analysisProvider = z.literal("replicate").default("replicate");
const inspectProvider = z.enum(["runware", "replicate"]).default("runware");
const model = z
  .string()
  .optional()
  .describe(
    "Music model ID. Generation defaults to runware:ace-step@v1.5-xl-turbo; use runware:ace-step@v1.5-xl-base when higher-quality, slower ACE-Step editing is worth the extra cost. Listening defaults to the Replicate Qwen audio model."
  );
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

function selectedRange(startSec?: number, endSec?: number) {
  if (startSec === undefined && endSec === undefined) return undefined;
  if (endSec === undefined || endSec <= (startSec || 0)) {
    throw new Error("Specify endSec greater than startSec. Segment analysis currently requires PCM WAV.");
  }
  return { startSec: startSec || 0, endSec };
}

function reply(data: Record<string, unknown>) {
  const failed = ["failed", "canceled", "submission_unknown"].includes(String(data.status));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(failed ? { isError: true } : {}),
  };
}

function failure(error: unknown) {
  return reply({
    status: "failed",
    error: error instanceof Error ? error.message : "Music operation failed.",
  });
}

export function createMusicServer(
  session: AuthSession | undefined,
  connection: MusicConnection
): McpServer {
  const server = new McpServer(
    { name: "gpt-audio-mcp", version: SERVER_VERSION },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "GPTAudioMCP v0.8.0. Music generation and reference-audio editing use hosted ACE-Step 1.5 on Runware; audio listening/critique remains on Replicate Qwen. Compile the current conversation into directorPrompt instead of blindly appending raw chat. Runware hosted generation accepts 30–300 seconds when no source audio is supplied. With source audio, use reference/cover, or use repaint/continue with repaintingStart and repaintingEnd. XL Turbo is the default; choose XL Base only when the user prioritizes quality over speed/cost. Never invent file_id, audioId, jobId or model capabilities. Persistent workflows return a job/result; poll get_music_job for unfinished or submission_unknown tasks using the same requestKey. A registered audioId can be reused without re-uploading in chat. Segment listening actually crops PCM WAV; unsupported compressed segment inputs fail explicitly. compare_music performs two independent Replicate listens with the same rubric. Runware does not provide server-side cancellation for in-flight audio inference, so do not claim cancellation stops billing.",
    }
  );

  const metadata = (files: string[] = []) => ({
    securitySchemes: connection.securitySchemes,
    ...(files.length ? { "openai/fileParams": files } : {}),
  });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const billable = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const allowed = (scope: string) => !!session?.scope.includes(scope);
  const owner = () => session?.profileId || connection.ownerId;
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
        "Runware generation is not configured. Add RUNWARE_API_KEY to this deployment, then retry."
      );
    }
    return key;
  };

  server.registerTool(
    "get_service_status",
    {
      title: "Music service status",
      description:
        "Read the deployed GPTAudioMCP version/schema revision, build SHA, current Runware ACE-Step generation models, Replicate listening model and storage mode without creating an inference task.",
      inputSchema: {},
      annotations: read,
      _meta: metadata(),
    },
    async () =>
      reply({
        version: SERVER_VERSION,
        schemaRevision: "music-tools-v080-runware",
        buildSha: connection.buildSha || "unknown",
        runtime: connection.runtime || "node",
        tools: TOOL_NAMES,
        providers: {
          generation: "runware",
          listening: "replicate",
        },
        models: {
          runware: RUNWARE_MODELS,
          listening: REPLICATE_MODELS.analysis,
        },
        runwareConfigured: !!connection.runwareApiKey?.trim(),
        replicateListeningConnected: !!session?.replicateToken,
        persistentJobs: !!connection.workflow,
        durableAudio: !!connection.workflow?.assets.bucket,
        segmentFormats: ["PCM WAV", "IEEE-float WAV"],
        completionPersistence:
          "Runware URLs are normally retained for seven days; completed outputs are imported when the job is finalized. Configure AUDIO_BUCKET for durable service-owned copies.",
        nativeFileContract:
          "download_url and file_id required; mime_type and file_name declared, optional",
      })
  );

  server.registerTool(
    "get_music_provider_profile",
    {
      title: "Music provider profile",
      description:
        "Read provider connection status. Runware generation uses the deployment API key; Replicate is an optional per-user connection used for listening/analysis.",
      inputSchema: { provider: inspectProvider },
      annotations: read,
      _meta: { ...metadata(), "openai/profile": true },
    },
    async ({ provider }) => {
      if (provider === "runware") {
        return reply({
          provider: "runware",
          configured: !!connection.runwareApiKey?.trim(),
          name: "Runware hosted ACE-Step 1.5",
          models: RUNWARE_MODELS,
        });
      }
      if (!allowed("replicate.read")) return connection.authRequired();
      return reply({
        provider: "replicate",
        id: session!.profileId,
        name: session!.name || session!.username,
        nickname: `${session!.username} — Replicate listening`,
      });
    }
  );

  server.registerTool(
    "inspect_music_model",
    {
      title: "Inspect music model",
      description:
        "Read the selected provider's supported operations and parameter limits without running inference. Runware inspection is available from the deployed contract; Replicate inspection reads the live model schema.",
      inputSchema: { provider: inspectProvider, model },
      annotations: { ...read, openWorldHint: true },
      _meta: metadata(),
    },
    async (args) => {
      try {
        if (args.provider === "runware") {
          return reply(await getMusicProvider("runware").inspectModel(runwareKey(), args.model));
        }
        if (!allowed("replicate.read")) return connection.authRequired();
        return reply(
          await getMusicProvider("replicate").inspectModel(session!.replicateToken, args.model)
        );
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
        "GPTAudioMCP v0.8.0. Generate or edit music with hosted ACE-Step 1.5 on Runware. XL Turbo is the default. Supports new music, audio-driven reference/cover, bounded repaint, and continuation/extension via repaint ranges. New generation supports 30–300 seconds. Source-audio requests do not accept duration. Returns audio immediately when complete or a resumable jobId.",
      inputSchema: {
        provider: generationProvider,
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
        const { provider: _provider, referenceAudio, sourceAudioId, requestKey: key, ...request } =
          args;
        const keyValue = runwareKey();

        if (connection.workflow) {
          return reply(
            await connection.workflow.submit(
              id,
              session?.replicateToken || "",
              "generate",
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

  server.registerTool(
    "analyze_music",
    {
      title: "Listen to music",
      description:
        "Analyze real audio through the connected Replicate listening model from either a native attachment or an existing audioId. Optional startSec/endSec performs actual PCM WAV cropping. Structured observations are separated from creative suggestions.",
      inputSchema: {
        provider: analysisProvider,
        model,
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
    async (args) => {
      if (!allowed("replicate.run")) return connection.authRequired();
      try {
        const id = requireOwner();
        const {
          provider: _provider,
          audio,
          audioId: sourceId,
          requestKey: key,
          startSec,
          endSec,
          ...request
        } = args;
        const analyzedRange = selectedRange(startSec, endSec);
        if (connection.workflow) {
          return reply(
            await connection.workflow.submit(
              id,
              session!.replicateToken,
              "analyze",
              { ...request, audioUrl: "", analyzedRange },
              { audioId: sourceId, audio },
              key
            )
          );
        }
        if (!audio || sourceId) throw new Error("This runtime requires a native audio attachment.");
        const result = await getMusicProvider("replicate").analyze(session!.replicateToken, {
          ...request,
          audioUrl: audio.download_url,
          audioName: audio.file_name,
          audioMimeType: audio.mime_type,
          analyzedRange,
        });
        return reply({ status: "succeeded", ...result });
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
        "Check a previously returned jobId. Reconciles Runware by task UUID or refreshes Replicate listening state, and retries completed-output import without starting another inference.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: metadata(),
    },
    async ({ jobId }) => {
      try {
        return reply(
          await workflow().get(requireOwner(), session?.replicateToken || "", jobId)
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
        "Request cancellation where the provider supports it. Replicate listening jobs may be canceled. Runware audio inference has no server-side cancellation; the tool reports that limitation instead of falsely claiming billing stopped.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: metadata(),
    },
    async ({ jobId }) => {
      try {
        return reply(
          await workflow().cancel(requireOwner(), session?.replicateToken || "", jobId)
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "compare_music",
    {
      title: "Compare two music versions",
      description:
        "Submit TWO billable Replicate audio analyses using the same rubric. Poll both returned job IDs, then compare their observations in ChatGPT. This is independent listening, not a joint-audio model judgment.",
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
      if (!allowed("replicate.run")) return connection.authRequired();
      try {
        const w = workflow();
        const id = requireOwner();
        await w.assets.require(id, args.audioIdA);
        await w.assets.require(id, args.audioIdB);
        const key = args.requestKey || newId("compare");
        if (key.length > 120) {
          throw new Error("Comparison requestKey must be at most 120 characters.");
        }
        const request = {
          question: args.question,
          conversationSummary: args.conversationSummary,
          audioUrl: "",
          analyzedRange: selectedRange(args.startSec, args.endSec),
        };
        const a = await w.submit(
          id,
          session!.replicateToken,
          "analyze",
          request,
          { audioId: args.audioIdA },
          `${key}.a`
        );
        const b = await w.submit(
          id,
          session!.replicateToken,
          "analyze",
          request,
          { audioId: args.audioIdB },
          `${key}.b`
        );
        return reply({
          requestKey: key,
          comparisonType: "independent-listening-same-rubric",
          jobs: [
            { label: "A", ...a },
            { label: "B", ...b },
          ],
          instruction:
            "Poll each unfinished job. Compare only completed evidence; report failed or missing analyses explicitly.",
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}
