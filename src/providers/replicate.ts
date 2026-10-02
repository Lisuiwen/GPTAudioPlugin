import { File } from "node:buffer";
import Replicate from "replicate";

import type {
  AnalyzeMusicInput,
  AnalyzeMusicResult,
  GenerateMusicInput,
  GenerateMusicResult,
  ModelCapabilities,
  MusicProvider,
} from "./types.js";

const DEFAULT_MODEL =
  process.env.REPLICATE_MODEL?.trim() ||
  "fishaudio/ace-step-1.5";

const DEFAULT_COVER_MODEL =
  process.env.REPLICATE_COVER_MODEL?.trim() ||
  "minimax/music-cover";

const DEFAULT_CONTINUATION_MODEL =
  process.env.REPLICATE_CONTINUATION_MODEL?.trim() ||
  "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";

const DEFAULT_ANALYSIS_MODEL =
  process.env.REPLICATE_ANALYSIS_MODEL?.trim() ||
  "lucataco/qwen2.5-omni-7b";

const latestModelVersions = new Map<string, string>();

type SchemaProperty = {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
};

type ModelSchema = {
  properties: Record<string, SchemaProperty>;
  required: string[];
};

const PROMPT_CANDIDATES = [
  "prompt",
  "tags",
  "text",
  "description",
  "caption",
  "lyrics",
];

const AUDIO_CANDIDATES = [
  "input_audio",
  "audio",
  "audio_file",
  "audio_url",
  "music_input",
  "audio_chords",
  "reference_audio",
  "reference_audio_file",
  "melody",
  "melody_audio",
  "conditioning_audio",
  "source_audio",
];

const DURATION_CANDIDATES = [
  "duration",
  "duration_seconds",
  "seconds",
  "length",
  "audio_length",
];

const CONTINUATION_CANDIDATES = [
  "continuation",
  "continue_audio",
  "extend",
];

const OUTPUT_FORMAT_CANDIDATES = [
  "output_format",
  "format",
  "audio_format",
];

function splitModelReference(model: string): {
  owner: string;
  name: string;
  version?: string;
} {
  const [path, version] = model.trim().split(":");
  const [owner, name] = path.split("/");

  if (!owner || !name) {
    throw new Error(
      'Replicate model must use "owner/name" or "owner/name:version".'
    );
  }

  return { owner, name, version };
}

function schemaFromOpenApi(openapi: unknown): ModelSchema {
  const document = openapi as {
    components?: {
      schemas?: {
        Input?: {
          properties?: Record<string, SchemaProperty>;
          required?: string[];
        };
      };
    };
  };

  const input = document?.components?.schemas?.Input;

  return {
    properties: input?.properties || {},
    required: input?.required || [],
  };
}

async function fetchModelSchema(
  credential: string,
  model: string
): Promise<ModelSchema> {
  const { owner, name, version } = splitModelReference(model);
  const endpoint = version
    ? `https://api.replicate.com/v1/models/${encodeURIComponent(
        owner
      )}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
    : `https://api.replicate.com/v1/models/${encodeURIComponent(
        owner
      )}/${encodeURIComponent(name)}`;

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Unable to inspect Replicate model ${model} (HTTP ${response.status}).`
    );
  }

  const data = (await response.json()) as {
    openapi_schema?: unknown;
    latest_version?: {
      id?: string;
      openapi_schema?: unknown;
    };
  };

  if (!version && data.latest_version?.id) {
    latestModelVersions.set(model, data.latest_version.id);
  }

  const openapi = version
    ? data.openapi_schema
    : data.latest_version?.openapi_schema || data.openapi_schema;

  if (!openapi) {
    throw new Error(
      `Replicate model ${model} did not expose an input OpenAPI schema.`
    );
  }

  return schemaFromOpenApi(openapi);
}

function runnableModelReference(model: string): string {
  const { owner, name, version } = splitModelReference(model);
  if (version) return `${owner}/${name}:${version}`;

  const latestVersion = latestModelVersions.get(model);
  if (!latestVersion) {
    throw new Error(
      `Replicate model ${model} did not expose a runnable latest version.`
    );
  }

  return `${owner}/${name}:${latestVersion}`;
}

function firstExisting(
  properties: Record<string, SchemaProperty>,
  candidates: string[]
): string | undefined {
  return candidates.find((name) => Boolean(properties[name]));
}

function inferAudioField(
  properties: Record<string, SchemaProperty>
): string | undefined {
  const exact = firstExisting(properties, AUDIO_CANDIDATES);
  if (exact) return exact;

  for (const [name, property] of Object.entries(properties)) {
    const searchable = [
      name,
      property.title || "",
      property.description || "",
      property.format || "",
    ]
      .join(" ")
      .toLowerCase();

    if (
      /(audio|melody|music|sound)/.test(searchable) &&
      !/(output|sample.rate|sample_rate)/.test(searchable)
    ) {
      return name;
    }
  }

  return undefined;
}

async function inspectModel(
  credential: string,
  model = DEFAULT_MODEL
): Promise<ModelCapabilities> {
  const schema = await fetchModelSchema(credential, model);
  const properties = schema.properties;

  const promptField = firstExisting(properties, PROMPT_CANDIDATES);
  const audioField = inferAudioField(properties);
  const durationField = firstExisting(properties, DURATION_CANDIDATES);
  const continuationField = firstExisting(
    properties,
    CONTINUATION_CANDIDATES
  );
  const outputFormatField = firstExisting(
    properties,
    OUTPUT_FORMAT_CANDIDATES
  );

  const providedByProvider = new Set(
    [
      promptField,
      audioField,
      durationField,
      continuationField,
      outputFormatField,
      "model_version",
      "normalization_strategy",
    ].filter(Boolean) as string[]
  );

  const unsupportedRequiredFields = schema.required.filter(
    (field) =>
      !providedByProvider.has(field) &&
      properties[field]?.default === undefined
  );

  return {
    provider: "replicate",
    model,
    supportsTextPrompt: Boolean(promptField),
    promptField,
    supportsAudioInput: Boolean(audioField),
    audioField,
    durationField,
    continuationField,
    outputFormatField,
    inputFields: Object.keys(properties),
    requiredFields: schema.required,
    unsupportedRequiredFields,
  };
}

function composePrompt(
  conversationSummary: string,
  directorPrompt: string
): string {
  return [
    directorPrompt.trim(),
    "",
    "Creative context from the current ChatGPT conversation:",
    conversationSummary.trim(),
  ].join("\n");
}

type ResolvedGenerationRoute = {
  model: string;
  generationMode: GenerateMusicResult["generationMode"];
};

function requireReferenceAudio(
  request: GenerateMusicInput,
  mode: string
): string {
  if (!request.referenceAudioUrl) {
    throw new Error(`${mode} mode requires a reference audio attachment.`);
  }
  return request.referenceAudioUrl;
}

export function selectReplicateGenerationRoute(
  request: GenerateMusicInput
): ResolvedGenerationRoute {
  const requestedMode = request.generationMode || "auto";
  const explicitModel = request.model?.trim();

  if (explicitModel) {
    return {
      model: explicitModel,
      generationMode:
        requestedMode === "auto" ? "custom" : requestedMode,
    };
  }

  if (requestedMode === "cover") {
    requireReferenceAudio(request, "cover");
    return { model: DEFAULT_COVER_MODEL, generationMode: "cover" };
  }

  if (requestedMode === "reference") {
    requireReferenceAudio(request, "reference");
    return {
      model: DEFAULT_CONTINUATION_MODEL,
      generationMode: "reference",
    };
  }

  if (requestedMode === "continue") {
    requireReferenceAudio(request, "continue");
    return {
      model: DEFAULT_CONTINUATION_MODEL,
      generationMode: "continue",
    };
  }

  if (requestedMode === "generate") {
    return { model: DEFAULT_MODEL, generationMode: "generate" };
  }

  if (request.referenceAudioUrl) {
    if (request.continuation) {
      return {
        model: DEFAULT_CONTINUATION_MODEL,
        generationMode: "continue",
      };
    }

    if (request.instrumental === false) {
      return { model: DEFAULT_COVER_MODEL, generationMode: "cover" };
    }

    return {
      model: DEFAULT_CONTINUATION_MODEL,
      generationMode: "reference",
    };
  }

  return { model: DEFAULT_MODEL, generationMode: "generate" };
}

function clampText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : trimmed.slice(0, maxLength);
}

async function buildGenerationInput(
  request: GenerateMusicInput,
  model: string,
  capabilities: ModelCapabilities,
  finalPrompt: string,
  generationMode: GenerateMusicResult["generationMode"]
): Promise<Record<string, unknown>> {
  if (model.startsWith("fishaudio/ace-step-1.5")) {
    const instrumental = request.instrumental !== false;
    if (!instrumental && !request.lyrics?.trim()) {
      throw new Error(
        "ACE-Step vocal generation requires lyrics. Provide lyrics or set instrumental=true."
      );
    }

    return {
      prompt: clampText(finalPrompt, 512),
      lyrics: instrumental
        ? "[Instrumental]"
        : clampText(request.lyrics || "", 4096),
      duration: Math.max(1, Math.min(600, request.duration)),
    };
  }

  if (model.startsWith("minimax/music-2.6")) {
    const instrumental = request.instrumental !== false;
    const input: Record<string, unknown> = {
      prompt: clampText(finalPrompt, 2000),
      is_instrumental: instrumental,
      audio_format: "mp3",
    };

    if (!instrumental) {
      if (request.lyrics?.trim()) {
        input.lyrics = clampText(request.lyrics, 3500);
      } else {
        input.lyrics_optimizer = request.autoLyrics !== false;
      }
    }

    return input;
  }

  if (model.startsWith("minimax/music-cover")) {
    const audioUrl = requireReferenceAudio(request, "cover");
    const input: Record<string, unknown> = {
      prompt: clampText(finalPrompt, 2000),
      audio_url: audioUrl,
      audio_format: "mp3",
    };

    if (request.lyrics?.trim()) {
      input.lyrics = clampText(request.lyrics, 3000);
    }

    return input;
  }

  if (!capabilities.promptField) {
    throw new Error(
      `Model ${model} does not expose a recognizable text prompt input.`
    );
  }

  if (capabilities.unsupportedRequiredFields.length) {
    throw new Error(
      `Model ${model} requires additional inputs that GPTAudioPlugin does not map yet: ${capabilities.unsupportedRequiredFields.join(
        ", "
      )}.`
    );
  }

  if (request.referenceAudioUrl && !capabilities.audioField) {
    throw new Error(
      `Model ${model} does not accept a recognizable audio input. Remove the reference audio or choose an audio-conditioned model.`
    );
  }

  const input: Record<string, unknown> = {
    [capabilities.promptField]: finalPrompt,
  };

  if (capabilities.durationField) {
    input[capabilities.durationField] = model.startsWith("meta/musicgen")
      ? Math.min(30, request.duration)
      : request.duration;
  }

  if (capabilities.outputFormatField) {
    input[capabilities.outputFormatField] = "mp3";
  }

  if (capabilities.continuationField && request.referenceAudioUrl) {
    input[capabilities.continuationField] =
      generationMode === "continue" || Boolean(request.continuation);
  }

  if (
    model.startsWith("meta/musicgen") &&
    capabilities.inputFields.includes("model_version")
  ) {
    input.model_version = request.referenceAudioUrl
      ? "stereo-melody-large"
      : "stereo-large";
  }

  if (
    model.startsWith("meta/musicgen") &&
    capabilities.inputFields.includes("normalization_strategy")
  ) {
    input.normalization_strategy = "peak";
  }

  if (request.referenceAudioUrl && capabilities.audioField) {
    input[capabilities.audioField] = await downloadReferenceAudio(
      request.referenceAudioUrl,
      request.referenceAudioName,
      request.referenceAudioMimeType
    );
  }

  return input;
}

async function downloadReferenceAudio(
  url: string,
  fileName = "reference-audio",
  mimeType = "audio/mpeg"
): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Unable to download the ChatGPT reference audio (HTTP ${response.status}).`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new Error("Reference audio exceeds Replicate's 100MB file limit.");
  }

  return new File([buffer], fileName, {
    type: mimeType,
  });
}

function extractText(output: unknown): string | undefined {
  if (!output) return undefined;

  if (typeof output === "string") {
    return output.trim() || undefined;
  }

  if (Array.isArray(output)) {
    const parts = output
      .map((item) => extractText(item))
      .filter(Boolean) as string[];
    return parts.length ? parts.join("\n").trim() : undefined;
  }

  if (typeof output === "object") {
    const value = output as {
      text?: unknown;
      output?: unknown;
      response?: unknown;
      answer?: unknown;
      message?: unknown;
    };

    for (const candidate of [
      value.text,
      value.answer,
      value.response,
      value.message,
      value.output,
    ]) {
      const text = extractText(candidate);
      if (text) return text;
    }
  }

  return undefined;
}

function composeAnalysisPrompt(request: AnalyzeMusicInput): string {
  const focus = request.analysisFocus?.length
    ? `Focus especially on: ${request.analysisFocus.join(", ")}.`
    : "Consider melody, harmony, rhythm, instrumentation, arrangement, structure, production, mood, and performance where relevant.";

  return [
    "You are listening to the attached music/audio directly.",
    "Answer the user's question using evidence from what you actually hear.",
    "Do not invent exact BPM, key, chords, instruments, timestamps, or production details when uncertain.",
    "When useful, distinguish confident observations from tentative interpretations.",
    focus,
    request.conversationSummary?.trim()
      ? `Relevant conversation context: ${request.conversationSummary.trim()}`
      : "",
    `User question: ${request.question.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractUrl(output: unknown): string | undefined {
  if (!output) return undefined;

  if (typeof output === "string") {
    return output.startsWith("http") ? output : undefined;
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const url = extractUrl(item);
      if (url) return url;
    }
    return undefined;
  }

  if (typeof output === "object") {
    const maybeOutput = output as {
      url?: string | (() => string | URL);
      href?: string;
      output?: unknown;
    };

    if (typeof maybeOutput.url === "function") {
      return String(maybeOutput.url());
    }

    if (typeof maybeOutput.url === "string") {
      return maybeOutput.url;
    }

    if (typeof maybeOutput.href === "string") {
      return maybeOutput.href;
    }

    if (maybeOutput.output) {
      return extractUrl(maybeOutput.output);
    }
  }

  return undefined;
}

async function generate(
  credential: string,
  request: GenerateMusicInput
): Promise<GenerateMusicResult> {
  const route = selectReplicateGenerationRoute(request);
  const model = route.model;
  const capabilities = await inspectModel(credential, model);

  const finalPrompt = composePrompt(
    request.conversationSummary,
    request.directorPrompt
  );

  const input = await buildGenerationInput(
    request,
    model,
    capabilities,
    finalPrompt,
    route.generationMode
  );

  const replicate = new Replicate({
    auth: credential,
  });

  const output = await replicate.run(runnableModelReference(model) as never, {
    input,
  });
  const audioUrl = extractUrl(output);

  if (!audioUrl) {
    throw new Error(
      "Replicate completed without returning a recognizable audio URL."
    );
  }

  return {
    provider: "replicate",
    audioUrl,
    model,
    generationMode: route.generationMode,
    prompt: finalPrompt,
    capabilities,
  };
}


async function analyze(
  credential: string,
  request: AnalyzeMusicInput
): Promise<AnalyzeMusicResult> {
  const model = request.model?.trim() || DEFAULT_ANALYSIS_MODEL;
  const capabilities = await inspectModel(credential, model);

  if (!capabilities.promptField) {
    throw new Error(
      `Analysis model ${model} does not expose a recognizable text prompt input.`
    );
  }

  if (!capabilities.audioField) {
    throw new Error(
      `Analysis model ${model} does not expose a recognizable audio input.`
    );
  }

  const finalPrompt = composeAnalysisPrompt(request);
  const input: Record<string, unknown> = {
    [capabilities.promptField]: finalPrompt,
    [capabilities.audioField]: await downloadReferenceAudio(
      request.audioUrl,
      request.audioName,
      request.audioMimeType
    ),
  };

  if (capabilities.inputFields.includes("generate_audio")) {
    input.generate_audio = false;
  }

  if (capabilities.inputFields.includes("system_prompt")) {
    input.system_prompt =
      "You are a careful music and audio critic. Listen to the provided audio directly and answer the user's question with grounded, concise observations. State uncertainty instead of guessing.";
  }

  const replicate = new Replicate({ auth: credential });
  const output = await replicate.run(runnableModelReference(model) as never, {
    input,
  });
  const answer = extractText(output);

  if (!answer) {
    throw new Error(
      "Replicate analysis completed without returning recognizable text."
    );
  }

  return {
    provider: "replicate",
    model,
    prompt: finalPrompt,
    answer,
    capabilities,
  };
}

export const replicateProvider: MusicProvider = {
  id: "replicate",
  defaultModel: DEFAULT_MODEL,
  defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
  inspectModel,
  generate,
  analyze,
};
