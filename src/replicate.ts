import { File } from "node:buffer";
import Replicate from "replicate";

export const DEFAULT_MODEL =
  process.env.REPLICATE_MODEL?.trim() ||
  "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";

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

export type ModelCapabilities = {
  model: string;
  supportsTextPrompt: boolean;
  promptField?: string;
  supportsAudioInput: boolean;
  audioField?: string;
  durationField?: string;
  continuationField?: string;
  outputFormatField?: string;
  inputFields: string[];
  requiredFields: string[];
  unsupportedRequiredFields: string[];
};

export type GenerateMusicInput = {
  model?: string;
  conversationSummary: string;
  directorPrompt: string;
  duration: number;
  referenceAudioUrl?: string;
  referenceAudioName?: string;
  referenceAudioMimeType?: string;
  continuation?: boolean;
};

export type GenerateMusicResult = {
  audioUrl: string;
  model: string;
  prompt: string;
  capabilities: ModelCapabilities;
};

const PROMPT_CANDIDATES = [
  "prompt",
  "text",
  "description",
  "caption",
  "lyrics",
];

const AUDIO_CANDIDATES = [
  "input_audio",
  "audio",
  "audio_file",
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
  replicateToken: string,
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
      Authorization: `Bearer ${replicateToken}`,
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
      openapi_schema?: unknown;
    };
  };

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

export async function inspectReplicateModel(
  replicateToken: string,
  model = DEFAULT_MODEL
): Promise<ModelCapabilities> {
  const schema = await fetchModelSchema(replicateToken, model);
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

  const providedByPlugin = new Set(
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
      !providedByPlugin.has(field) &&
      properties[field]?.default === undefined
  );

  return {
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

export async function generateMusic(
  replicateToken: string,
  request: GenerateMusicInput
): Promise<GenerateMusicResult> {
  const model = request.model?.trim() || DEFAULT_MODEL;
  const capabilities = await inspectReplicateModel(replicateToken, model);

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

  const finalPrompt = composePrompt(
    request.conversationSummary,
    request.directorPrompt
  );

  const input: Record<string, unknown> = {
    [capabilities.promptField]: finalPrompt,
  };

  if (capabilities.durationField) {
    input[capabilities.durationField] = request.duration;
  }

  if (capabilities.outputFormatField) {
    const propertyName = capabilities.outputFormatField;
    input[propertyName] = "mp3";
  }

  if (capabilities.continuationField && request.referenceAudioUrl) {
    input[capabilities.continuationField] = Boolean(request.continuation);
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

  const replicate = new Replicate({
    auth: replicateToken,
  });

  const output = await replicate.run(model as never, { input });
  const audioUrl = extractUrl(output);

  if (!audioUrl) {
    throw new Error(
      "Replicate completed without returning a recognizable audio URL."
    );
  }

  return {
    audioUrl,
    model,
    prompt: finalPrompt,
    capabilities,
  };
}
