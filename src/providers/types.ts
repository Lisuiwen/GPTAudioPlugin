export type MusicProviderId = "replicate";
export type GenerationMode = "auto" | "generate" | "cover" | "reference" | "continue";
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
export type AnalyzeMusicInput = {
  model?: string;
  question: string;
  conversationSummary?: string;
  analysisFocus?: string[];
  audioUrl: string;
  audioFile?: File;
  audioName?: string;
  audioMimeType?: string;
  structured?: boolean;
  analyzedRange?: { startSec: number; endSec: number };
};
export type AnalyzeMusicResult = {
  provider: MusicProviderId;
  model: string;
  modelVersion?: string;
  prompt: string;
  answer: string;
  capabilities: ModelCapabilities;
};
export interface MusicProvider {
  readonly id: MusicProviderId;
  readonly defaultModel: string;
  readonly defaultAnalysisModel: string;
  inspectModel(credential: string, model?: string): Promise<ModelCapabilities>;
  generate(credential: string, request: GenerateMusicInput): Promise<GenerateMusicResult>;
  analyze(credential: string, request: AnalyzeMusicInput): Promise<AnalyzeMusicResult>;
}
