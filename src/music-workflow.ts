import { z } from "zod";
import type { AnalyzeMusicInput, GenerateMusicInput } from "./providers/types.js";
import { createPrediction, getPrediction, cancelPrediction, prepareAnalysis, prepareGeneration, outputText, outputUrls, type PredictionPlan, type PredictionState } from "./providers/replicate.js";
import { AudioAssets, WorkflowStore, newId, sha256, type RecordValue } from "./workflow-store.js";

export type NativeAudio = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
export type Source = { audioId?: string; audio?: NativeAudio };
type Job = RecordValue & {
  kind: "job"; action: "generate" | "analyze"; status: string; requestKey: string; fingerprint: string;
  createdAt: number; updatedAt: number; predictionId?: string; model?: string; modelVersion?: string;
  prompt?: string; sourceAudioId?: string; mode?: string; warnings: string[];
  analyzedRange?: { startSec: number; endSec: number }; audioFormat?: string;
  providerOutput?: unknown; result?: Record<string, unknown>; finalizingUntil?: number;
};
const terminal = new Set(["succeeded", "failed", "canceled"]);
const StructuredAnalysis = z.object({ summary: z.string().max(10000), observations: z.array(z.string().max(3000)).max(50), uncertainties: z.array(z.string().max(3000)).max(50), suggestions: z.array(z.string().max(3000)).max(50) });
export function parseAnalysis(answer: string): { analysis?: z.infer<typeof StructuredAnalysis>; structuredStatus: string } {
  try {
    const value = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
    const parsed = StructuredAnalysis.safeParse(value);
    if (parsed.success) return { analysis: parsed.data, structuredStatus: "validated" };
  } catch { /* Preserve the raw answer; never fabricate structured observations. */ }
  return { structuredStatus: "unavailable" };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}
export class MusicWorkflow {
  constructor(readonly store: WorkflowStore, readonly assets: AudioAssets) {}
  private async source(owner: string, source: Source) {
    if (source.audioId && source.audio) throw new Error("Pass an audioId or an attachment, not both.");
    if (source.audioId) return this.assets.require(owner, source.audioId);
    if (source.audio) return this.assets.register(owner, { url: source.audio.download_url, fileName: source.audio.file_name, mimeType: source.audio.mime_type });
    return undefined;
  }
  async submit(owner: string, token: string, action: "generate" | "analyze", request: GenerateMusicInput | AnalyzeMusicInput, source: Source, requestKey = newId("request")) {
    if (requestKey.length > 128 || !/^[\w.-]+$/.test(requestKey)) throw new Error("requestKey must be 1–128 letters, digits, underscores, dots or hyphens.");
    if (source.audioId && source.audio) throw new Error("Pass exactly one audio source.");
    if (action === "analyze" && !source.audioId && !source.audio) throw new Error("Analysis requires an audioId or attachment.");
    const fingerprint = await sha256(JSON.stringify(canonical({ action, request, source: { audioId: source.audioId, fileId: source.audio?.file_id } })));
    const prior = await this.store.findRequest<Job>(owner, requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("requestKey was already used with different inputs. Use a new key for a new operation.");
      return this.view(prior);
    }
    const job: Job = { id: newId("job"), kind: "job", revision: 0, action, status: "preparing", requestKey, fingerprint, createdAt: Date.now(), updatedAt: Date.now(), warnings: [] };
    if (!(await this.store.insert(owner, job, requestKey))) {
      const existing = await this.store.findRequest<Job>(owner, requestKey);
      if (!existing || existing.fingerprint !== fingerprint) throw new Error("Concurrent request-key conflict.");
      return this.view(existing);
    }
    let startingPrediction = false;
    try {
      const audio = await this.source(owner, source);
      const file = audio ? await this.assets.file(owner, audio.id) : undefined;
      job.sourceAudioId = audio?.id;
      const plan: PredictionPlan = action === "generate"
        ? await prepareGeneration(token, { ...request as GenerateMusicInput, referenceAudioFile: file })
        : await prepareAnalysis(token, { ...request as AnalyzeMusicInput, audioUrl: "", audioFile: file, structured: true });
      Object.assign(job, { model: plan.model, modelVersion: plan.version, prompt: plan.prompt, mode: plan.mode, warnings: plan.warnings, status: "submitting", updatedAt: Date.now(), analyzedRange: (request as AnalyzeMusicInput).analyzedRange, audioFormat: (request as GenerateMusicInput).audioFormat || "mp3" });
      if (!await this.store.update(owner, job)) throw new Error("Job changed before submission; no prediction was started.");
      startingPrediction = true;
      const prediction = await createPrediction(token, plan);
      job.predictionId = prediction.id;
      job.status = prediction.status;
      job.updatedAt = Date.now();
      if (!await this.store.update(owner, job)) throw new Error("Cannot persist prediction receipt.");
      return this.apply(owner, job, prediction);
    } catch (error) {
      // Once a POST might have reached Replicate, do not automatically retry it.
      // Exactly-once submission cannot be promised across a network/DB failure.
      job.status = startingPrediction ? "submission_unknown" : "failed";
      job.updatedAt = Date.now();
      job.result = { error: startingPrediction ? "Submission outcome requires reconciliation. Reuse this requestKey; do not submit a new billable job blindly." : error instanceof Error ? error.message : "Input preparation failed." };
      await this.store.update(owner, job);
      return this.view(job);
    }
  }
  private async require(owner: string, id: string) {
    const job = await this.store.get<Job>(owner, id);
    if (!job || job.kind !== "job") throw new Error("Job not found or not owned by this user.");
    return job;
  }
  async get(owner: string, token: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (job.status === "finalizing" && (job.finalizingUntil || 0) > Date.now()) return this.view(job);
    if (job.providerOutput !== undefined && ["storage_pending", "finalizing"].includes(job.status)) return this.apply(owner, job, { id: job.predictionId!, status: "succeeded", output: job.providerOutput });
    if (!job.predictionId) return this.view(job);
    return this.apply(owner, job, await getPrediction(token, job.predictionId));
  }
  async cancel(owner: string, token: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (!job.predictionId) throw new Error("Submission is not yet reconciled. Check this job again; cancellation is not confirmed.");
    const prediction = await cancelPrediction(token, job.predictionId);
    return this.apply(owner, job, prediction);
  }
  private async apply(owner: string, job: Job, prediction: PredictionState): Promise<Record<string, unknown>> {
    if (prediction.status !== "succeeded") {
      job.status = prediction.status;
      job.updatedAt = Date.now();
      if (["failed", "canceled"].includes(prediction.status)) job.result = { error: `Replicate prediction ${prediction.id} is ${prediction.status}. Cancellation does not guarantee zero charges.` };
      if (!await this.store.update(owner, job)) return this.view(await this.require(owner, job.id));
      return this.view(job);
    }
    job.providerOutput = prediction.output;
    job.status = "finalizing"; job.finalizingUntil = Date.now() + 120000;
    if (!await this.store.update(owner, job)) return this.view(await this.require(owner, job.id));
    try {
      if (job.action === "analyze") {
        const answer = outputText(prediction.output);
        if (!answer) throw new Error("No analysis text was returned.");
        job.result = { answer, ...parseAnalysis(answer), analyzedRange: job.analyzedRange || null, sourceAudioId: job.sourceAudioId };
      } else {
        const urls = outputUrls(prediction.output);
        if (!urls.length) throw new Error("No generated audio was returned.");
        if (urls.length > 4) throw new Error("Unexpectedly many output files; inspect the prediction before importing them.");
        const audios = [];
        for (let index = 0; index < urls.length; index++) {
          const audio = await this.assets.register(owner, { url: urls[index], fileName: `${job.id}-${index}.${job.audioFormat}`, mimeType: job.audioFormat === "wav" ? "audio/wav" : "audio/mpeg", expiresAt: job.createdAt + 3600000, parentAudioId: job.sourceAudioId }, `audio_${job.id}_${index}`);
          audios.push(this.assets.view(audio));
        }
        job.result = { audioId: audios[0].audioId, audioIds: audios.map(a => a.audioId), audioUrl: urls[0], audioUrls: urls, audios, referenceAudioUsed: !!job.sourceAudioId, sourceAudioId: job.sourceAudioId };
      }
      job.status = "succeeded";
      delete job.providerOutput;
    } catch {
      job.status = "storage_pending";
      job.result = { error: "Prediction completed, but output import is incomplete. Poll the same job to retry import without generating again.", audioUrls: job.action === "generate" ? outputUrls(prediction.output) : undefined };
    }
    job.updatedAt = Date.now(); delete job.finalizingUntil;
    if (!await this.store.update(owner, job)) return this.view(await this.require(owner, job.id));
    return this.view(job);
  }
  view(job: Job): Record<string, unknown> {
    return { jobId: job.id, requestKey: job.requestKey, status: job.status, provider: "replicate", predictionId: job.predictionId, model: job.model, modelVersion: job.modelVersion, generationMode: job.mode, effectivePrompt: job.prompt, prompt: job.prompt, createdAt: job.createdAt, updatedAt: job.updatedAt, warnings: job.warnings, pollAfterSeconds: terminal.has(job.status) ? undefined : 3, ...job.result };
  }
}
