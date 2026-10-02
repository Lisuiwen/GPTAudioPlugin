export type MusicProviderId = "replicate";

export type ModelCapabilities = {
  provider: MusicProviderId;
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
  provider: MusicProviderId;
  audioUrl: string;
  model: string;
  prompt: string;
  capabilities: ModelCapabilities;
};

export type AnalyzeMusicInput = {
  model?: string;
  question: string;
  conversationSummary?: string;
  analysisFocus?: string[];
  audioUrl: string;
  audioName?: string;
  audioMimeType?: string;
};

export type AnalyzeMusicResult = {
  provider: MusicProviderId;
  model: string;
  prompt: string;
  answer: string;
  capabilities: ModelCapabilities;
};

export interface MusicProvider {
  readonly id: MusicProviderId;
  readonly defaultModel: string;
  readonly defaultAnalysisModel: string;
  inspectModel(
    credential: string,
    model?: string
  ): Promise<ModelCapabilities>;
  generate(
    credential: string,
    request: GenerateMusicInput
  ): Promise<GenerateMusicResult>;
  analyze(
    credential: string,
    request: AnalyzeMusicInput
  ): Promise<AnalyzeMusicResult>;
}
