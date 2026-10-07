import { Buffer } from "buffer";
import type {
  AnalyzeMusicInput,
  AnalyzeMusicResult,
  GenerateMusicInput,
  GenerateMusicResult,
  ModelCapabilities,
  MusicProvider,
} from "./types.js";

const env = (key: string, fallback: string) =>
  (typeof process !== "undefined" ? process.env[key]?.trim() : undefined) || fallback;

export const RUNWARE_MODELS = {
  fast: env("RUNWARE_MODEL", "runware:ace-step@v1.5-xl-turbo"),
  advanced: env("RUNWARE_ADVANCED_MODEL", "runware:ace-step@v1.5-xl-base"),
};

export type RunwarePlan = {
  model: string;
  version: string;
  mode: string;
  prompt: string;
  input: Record<string, unknown>;
  sourceFile?: File;
  sourceUrl?: string;
  warnings: string[];
  capabilities: ModelCapabilities;
  taskUUID: string;
};

export type RunwarePredictionState = {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  metrics?: Record<string, number>;
};

type RunwareErrorItem = {
  code?: string;
  message?: string;
  parameter?: string;
  taskUUID?: string;
  retryAfter?: number;
};

type RunwareEnvelope = {
  data?: Array<Record<string, unknown>>;
  errors?: RunwareErrorItem[];
};

class RunwareApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryAfter?: number
  ) {
    super(message);
  }
}

const versionOf = (model: string) => model.split("@")[1] || model;

function assertRunwareModel(model: string): void {
  if (![RUNWARE_MODELS.fast, RUNWARE_MODELS.advanced].includes(model)) {
    throw new Error(
      `Unsupported Runware music model "${model}". Use ${RUNWARE_MODELS.fast} or ${RUNWARE_MODELS.advanced}.`
    );
  }
}

export function runwareCapabilities(model = RUNWARE_MODELS.fast): ModelCapabilities {
  assertRunwareModel(model);
  return {
    provider: "runware",
    model,
    modelVersion: versionOf(model),
    supportsTextPrompt: true,
    promptField: "positivePrompt",
    supportsAudioInput: true,
    audioField: "inputs.audio",
    durationField: "duration",
    outputFormatField: "outputFormat",
    inputFields: [
      "taskType",
      "taskUUID",
      "model",
      "positivePrompt",
      "negativePrompt",
      "duration",
      "seed",
      "steps",
      "CFGScale",
      "strength",
      "inputs.audio",
      "settings.lyrics",
      "settings.bpm",
      "settings.keyScale",
      "settings.timeSignature",
      "settings.vocalLanguage",
      "settings.repaintingStart",
      "settings.repaintingEnd",
      "outputFormat",
      "deliveryMethod",
      "includeCost",
    ],
    requiredFields: ["taskType", "taskUUID", "model", "positivePrompt"],
    unsupportedRequiredFields: [],
    supportedModes: ["generate", "reference", "cover", "repaint", "continue"],
    promptMaxLength: 3000,
    durationMin: 30,
    durationMax: 300,
  };
}

export function selectRunwareGenerationRoute(request: GenerateMusicInput) {
  const hasAudio = !!(request.referenceAudioFile || request.referenceAudioUrl);
  let mode = request.generationMode || "auto";

  if (request.continuation && !["auto", "continue"].includes(mode)) {
    throw new Error("continuation conflicts with generationMode.");
  }
  if (mode === "auto") {
    mode = request.continuation ? "continue" : hasAudio ? "reference" : "generate";
  }
  if (mode !== "generate" && !hasAudio) {
    throw new Error(`${mode} requires source audio.`);
  }
  if (mode === "generate" && hasAudio) {
    throw new Error(
      "generate mode cannot discard source audio. Select reference/cover/repaint/continue, or omit the source."
    );
  }
  if (!["generate", "reference", "cover", "repaint", "continue"].includes(mode)) {
    throw new Error(`Runware ACE-Step does not expose generationMode "${mode}".`);
  }

  const model = request.model?.trim() || RUNWARE_MODELS.fast;
  assertRunwareModel(model);
  return { model, generationMode: mode };
}

function checkedText(value: string, label: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}–${max} characters; nothing was truncated.`);
  }
  return text;
}

export function prepareRunwareGeneration(request: GenerateMusicInput): RunwarePlan {
  const { model, generationMode: mode } = selectRunwareGenerationRoute(request);
  const c = runwareCapabilities(model);
  const prompt = checkedText(request.directorPrompt, "directorPrompt", 2, 3000);
  const warnings: string[] = [];
  const settings: Record<string, unknown> = {};
  const input: Record<string, unknown> = {
    taskType: "audioInference",
    taskUUID: crypto.randomUUID(),
    model,
    positivePrompt: prompt,
    outputType: "URL",
    outputFormat: (request.audioFormat || "mp3").toUpperCase(),
    includeCost: true,
    numberResults: 1,
    deliveryMethod: "sync",
  };

  const hasAudio = !!(request.referenceAudioFile || request.referenceAudioUrl);
  if (!hasAudio) {
    const duration = request.duration ?? 60;
    if (!Number.isFinite(duration) || duration < 30 || duration > 300) {
      throw new Error("Runware ACE-Step hosted generation currently supports 30–300 seconds per request.");
    }
    input.duration = duration;
  } else if (request.duration !== undefined) {
    warnings.push(
      "Runware does not accept duration together with source audio; duration was not sent. Use repaintingStart/repaintingEnd for bounded edits or extension."
    );
  }

  if (request.seed !== undefined) {
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 2147483647) {
      throw new Error("seed must be an integer from 0 to 2147483647.");
    }
    input.seed = request.seed;
  }

  if (request.instrumental !== false) {
    if (request.lyrics?.trim()) throw new Error("Lyrics conflict with instrumental=true.");
    settings.lyrics = "[Instrumental]";
    settings.vocalLanguage = "unknown";
  } else if (request.lyrics?.trim()) {
    settings.lyrics = checkedText(request.lyrics, "lyrics", 10, 3000);
  } else if (request.autoLyrics === false) {
    throw new Error("Vocal generation requires lyrics or autoLyrics=true.");
  }

  if (hasAudio) {
    input.strength =
      request.strength ??
      (mode === "cover" ? 0.8 : mode === "repaint" ? 0.7 : mode === "continue" ? 0.65 : 0.5);

    if (request.repaintingStart !== undefined || request.repaintingEnd !== undefined) {
      const start = request.repaintingStart;
      const end = request.repaintingEnd;
      if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("repaintingStart and repaintingEnd must both be set, with repaintingEnd greater than repaintingStart.");
      }
      if (start < -300 || start > 300 || end < 0 || end > 300) {
        throw new Error("Runware repainting range must stay within -300..300 seconds.");
      }
      settings.repaintingStart = start;
      settings.repaintingEnd = end;
    } else if (mode === "repaint" || mode === "continue") {
      throw new Error(
        `${mode} on Runware requires repaintingStart and repaintingEnd. For extension, set repaintingStart at the source endpoint and repaintingEnd to the new target endpoint.`
      );
    }
  }

  if (Object.keys(settings).length) input.settings = settings;

  return {
    model,
    version: versionOf(model),
    mode,
    prompt,
    input,
    sourceFile: request.referenceAudioFile,
    sourceUrl: request.referenceAudioUrl,
    warnings,
    capabilities: c,
    taskUUID: String(input.taskUUID),
  };
}

async function postRunware(
  apiKey: string,
  tasks: Array<Record<string, unknown>>,
  timeoutMs = 180000
): Promise<Array<Record<string, unknown>>> {
  if (!apiKey?.trim()) {
    throw new Error("RUNWARE_API_KEY is not configured on this deployment.");
  }
  const response = await fetch("https://api.runware.ai/v1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(tasks),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let envelope: RunwareEnvelope = {};
  try {
    envelope = (await response.json()) as RunwareEnvelope;
  } catch {
    throw new RunwareApiError(`Runware returned an unreadable response (HTTP ${response.status}).`);
  }

  const firstError = envelope.errors?.[0];
  if (!response.ok || firstError) {
    const detail = firstError?.message || `HTTP ${response.status}`;
    throw new RunwareApiError(
      `Runware request failed: ${detail}`,
      firstError?.code,
      firstError?.retryAfter
    );
  }
  return envelope.data || [];
}

async function uploadMedia(apiKey: string, file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const mime = file.type || "audio/mpeg";
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const taskUUID = crypto.randomUUID();
  const data = await postRunware(apiKey, [
    { taskType: "mediaStorage", taskUUID, operation: "upload", media: dataUri },
  ]);
  const mediaUUID = data[0]?.mediaUUID;
  if (typeof mediaUUID !== "string") {
    throw new Error("Runware media upload returned no mediaUUID.");
  }
  return mediaUUID;
}

async function deleteMedia(apiKey: string, mediaUUID: string): Promise<void> {
  try {
    await postRunware(apiKey, [
      {
        taskType: "mediaStorage",
        taskUUID: crypto.randomUUID(),
        operation: "delete",
        media: mediaUUID,
      },
    ]);
  } catch {
    // Cleanup failure must not erase a completed music result.
  }
}

export async function createRunwareTask(
  apiKey: string,
  plan: RunwarePlan
): Promise<RunwarePredictionState> {
  const input = structuredClone(plan.input);
  let mediaUUID: string | undefined;
  let safeToDelete = false;

  if (plan.sourceFile) {
    mediaUUID = await uploadMedia(apiKey, plan.sourceFile);
    (input.inputs as Record<string, unknown> | undefined) ??= {};
    (input.inputs as Record<string, unknown>).audio = mediaUUID;
  } else if (plan.sourceUrl) {
    input.inputs = { audio: plan.sourceUrl };
  }

  try {
    const data = await postRunware(apiKey, [input]);
    safeToDelete = true;
    const result = data.find(item => item.taskUUID === plan.taskUUID) || data[0];
    if (!result) throw new Error("Runware returned no task result.");
    if (result.status === "processing") {
      return { id: plan.taskUUID, status: "processing" };
    }
    const audioURL = result.audioURL;
    if (typeof audioURL !== "string") {
      throw new Error("Runware task completed without an audioURL.");
    }
    return {
      id: plan.taskUUID,
      status: "succeeded",
      output: [audioURL],
      metrics: typeof result.cost === "number" ? { cost: result.cost } : undefined,
    };
  } catch (error) {
    if (error instanceof RunwareApiError) safeToDelete = true;
    throw error;
  } finally {
    if (mediaUUID && safeToDelete) await deleteMedia(apiKey, mediaUUID);
  }
}

export async function getRunwareTask(
  apiKey: string,
  taskUUID: string
): Promise<RunwarePredictionState> {
  if (!/^[0-9a-f-]{36}$/i.test(taskUUID)) throw new Error("Invalid Runware task UUID.");
  try {
    const data = await postRunware(apiKey, [
      { taskType: "getTaskDetails", taskUUID },
    ]);
    const detail = data[0];
    const response = detail?.response as RunwareEnvelope | undefined;
    const error = response?.errors?.[0];
    if (error) {
      return {
        id: taskUUID,
        status: "failed",
        error: error.message || error.code || "Runware task failed.",
      };
    }
    const result = response?.data?.find(item => item.taskUUID === taskUUID) || response?.data?.[0];
    if (!result) return { id: taskUUID, status: "processing" };
    if (result.status === "processing") return { id: taskUUID, status: "processing" };
    if (typeof result.audioURL === "string") {
      return {
        id: taskUUID,
        status: "succeeded",
        output: [result.audioURL],
        metrics: typeof result.cost === "number" ? { cost: result.cost } : undefined,
      };
    }
    return { id: taskUUID, status: "processing" };
  } catch (error) {
    if (error instanceof RunwareApiError && error.code === "taskNotFound") {
      return { id: taskUUID, status: "processing" };
    }
    throw error;
  }
}

export async function cancelRunwareTask(
  apiKey: string,
  taskUUID: string
): Promise<RunwarePredictionState> {
  const state = await getRunwareTask(apiKey, taskUUID);
  if (["succeeded", "failed"].includes(state.status)) return state;
  throw new Error(
    "Runware does not provide server-side cancellation for this inference task. Stopping the client wait would not stop billing; keep polling this task instead."
  );
}

export async function inspectRunwareModel(
  _credential: string,
  model = RUNWARE_MODELS.fast
): Promise<ModelCapabilities> {
  return runwareCapabilities(model);
}

async function generate(
  apiKey: string,
  request: GenerateMusicInput
): Promise<GenerateMusicResult> {
  const plan = prepareRunwareGeneration(request);
  const result = await createRunwareTask(apiKey, plan);
  if (result.status !== "succeeded") {
    throw new Error("Runware generation is still processing; use the persistent workflow runtime for polling.");
  }
  const urls = Array.isArray(result.output)
    ? result.output.filter((value): value is string => typeof value === "string")
    : [];
  if (!urls.length) throw new Error("Runware did not return an audio file.");
  return {
    provider: "runware",
    model: plan.model,
    modelVersion: plan.version,
    generationMode: plan.mode,
    prompt: plan.prompt,
    capabilities: plan.capabilities,
    audioUrl: urls[0],
    audioUrls: urls,
    warnings: plan.warnings,
    referenceAudioUsed: !!(plan.sourceFile || plan.sourceUrl),
  };
}

async function analyze(
  _credential: string,
  _request: AnalyzeMusicInput
): Promise<AnalyzeMusicResult> {
  throw new Error("Runware is configured for music generation/editing only. Audio listening remains on Replicate.");
}

export const runwareProvider: MusicProvider = {
  id: "runware",
  defaultModel: RUNWARE_MODELS.fast,
  defaultAnalysisModel: "",
  inspectModel: inspectRunwareModel,
  generate,
  analyze,
};
