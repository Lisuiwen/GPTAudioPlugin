import Replicate from "replicate";

const DEFAULT_MODEL =
  "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";

export type GenerateMusicInput = {
  contextSummary: string;
  prompt?: string;
  duration: number;
  referenceAudioUrl?: string;
  continuation?: boolean;
};

export type GenerateMusicResult = {
  audioUrl: string;
  model: string;
  prompt: string;
};

function requireToken(): string {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing. Copy .env.example to .env and add your Replicate token."
    );
  }
  return token;
}

function getModel(): string {
  return process.env.REPLICATE_MODEL?.trim() || DEFAULT_MODEL;
}

function composePrompt(contextSummary: string, prompt?: string): string {
  const context = contextSummary.trim();
  const extra = prompt?.trim();

  if (!extra) return context;

  return [
    "Creative context from the current ChatGPT conversation:",
    context,
    "",
    "Additional music direction from the user:",
    extra,
  ].join("\n");
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
  }

  return undefined;
}

export async function generateMusic(
  request: GenerateMusicInput
): Promise<GenerateMusicResult> {
  const model = getModel();
  const finalPrompt = composePrompt(request.contextSummary, request.prompt);

  const input: Record<string, unknown> = {
    prompt: finalPrompt,
    duration: request.duration,
    output_format: "mp3",
    normalization_strategy: "peak",
    model_version: request.referenceAudioUrl
      ? "stereo-melody-large"
      : "stereo-large",
    continuation: Boolean(request.referenceAudioUrl && request.continuation),
  };

  if (request.referenceAudioUrl) {
    input.input_audio = request.referenceAudioUrl;
  }

  const replicate = new Replicate({
    auth: requireToken(),
  });

  const output = await replicate.run(model as never, { input });
  const audioUrl = extractUrl(output);

  if (!audioUrl) {
    throw new Error("Replicate completed without returning an audio URL.");
  }

  return {
    audioUrl,
    model,
    prompt: finalPrompt,
  };
}
