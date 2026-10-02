import { replicateProvider } from "./replicate.js";
import type {
  MusicProvider,
  MusicProviderId,
} from "./types.js";

const providers: Record<MusicProviderId, MusicProvider> = {
  replicate: replicateProvider,
};

export const DEFAULT_PROVIDER_ID: MusicProviderId = "replicate";
export const DEFAULT_MODEL = replicateProvider.defaultModel;
export const DEFAULT_ANALYSIS_MODEL = replicateProvider.defaultAnalysisModel;

export function getMusicProvider(
  provider: string | undefined
): MusicProvider {
  const id = (provider?.trim() || DEFAULT_PROVIDER_ID) as MusicProviderId;
  const selected = providers[id];

  if (!selected) {
    throw new Error(
      `Unsupported music provider "${provider}". Available providers: ${Object.keys(
        providers
      ).join(", ")}.`
    );
  }

  return selected;
}

export type {
  AnalyzeMusicInput,
  AnalyzeMusicResult,
  GenerateMusicInput,
  GenerateMusicResult,
  ModelCapabilities,
  MusicProvider,
  MusicProviderId,
} from "./types.js";
