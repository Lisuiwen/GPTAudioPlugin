// Shared capability and generation contracts for hosted Runware models.
// Production music inference is handled by the single Runware provider.
export type MusicProviderId = "runware";
export type GenerationMode = "auto" | "generate" | "cover" | "reference" | "repaint" | "continue";
export type ModelCapabilities = {
  provider: MusicProviderId;
  model: string;
  modelVersion?: string;
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
  supportedModes?: string[];
  promptMaxLength?: number;
  durationMin?: number;
  durationMax?: number;
};
export type GenerateMusicInput = {
  model?: string;
  generationMode?: GenerationMode;
  conversationSummary: string;
  directorPrompt: string;
  duration?: number;
  instrumental?: boolean;
  lyrics?: string;
  autoLyrics?: boolean;
  seed?: number;
  audioFormat?: "mp3" | "wav";
  referenceAudioUrl?: string;
  referenceAudioFile?: File;
  referenceAudioName?: string;
  referenceAudioMimeType?: string;
  continuation?: boolean;
  repaintingStart?: number;
  repaintingEnd?: number;
  strength?: number;
};
export type GenerateMusicResult = {
  provider: MusicProviderId;
  audioUrl: string;
  audioUrls?: string[];
  model: string;
  modelVersion?: string;
  generationMode?: string;
  prompt: string;
  warnings?: string[];
  referenceAudioUsed?: boolean;
  capabilities: ModelCapabilities;
};
export interface MusicProvider {
  readonly id: MusicProviderId;
  readonly defaultModel: string;
  inspectModel(credential: string, model?: string): Promise<ModelCapabilities>;
  generate(credential: string, request: GenerateMusicInput): Promise<GenerateMusicResult>;
}
