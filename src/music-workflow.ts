import { z } from "zod";
import type { AnalyzeMusicInput, GenerateMusicInput, MusicProviderId } from "./providers/types.js";
import {
  createPrediction as createReplicatePrediction,
  getPrediction as getReplicatePrediction,
  cancelPrediction as cancelReplicatePrediction,
  prepareAnalysis,
  outputText,
  outputUrls,
  type PredictionPlan,
  type PredictionState,
} from "./providers/replicate.js";
import {
  createRunwareTask,
  getRunwareTask,
  cancelRunwareTask,
  prepareRunwareGeneration,
  type RunwarePlan,
  type RunwarePredictionState,
} from "./providers/runware.js";
import { AudioAssets, WorkflowStore, newId, sha256, type RecordValue } from "./workflow-store.js";

export type NativeAudio = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
export type Source = { audioId?: string; audio?: NativeAudio };
type Job = RecordValue & {
  kind: "job";
  action: "generate" | "analyze";
  provider?: MusicProviderId;
  status: string;
  requestKey: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  predictionId?: string;
  model?: string;
  modelVersion?: string;
  prompt?: string;
  sourceAudioId?: string;
  mode?: string;
  warnings: string[];
  analyzedRange?: { startSec: number; endSec: number };
  audioFormat?: string;
  providerOutput?: unknown;
  providerCostUsd?: number;
  result?: Record<string, unknown>;
  finalizingUntil?: number;
};
class ResultShapeError extends Error {}
const terminal = new Set(["succeeded", "failed", "canceled"]);
const StructuredAnalysis = z.object({
  summary: z.string().max(10000),
  observations: z.array(z.string().max(3000)).max(50),
  uncertainties: z.array(z.string().max(3000)).max(50),
  suggestions: z.array(z.string().max(3000)).max(50),
});
export function parseAnalysis(answer: string): { analysis?: z.infer<typeof StructuredAnalysis>; structuredStatus: string } {
  try {
    const value = JSON.parse(answer.trim().replace(/^\`\`\`(?:json)?\s*/, "").replace(/\s*\`\`\`$/, ""));
    const parsed = StructuredAnalysis.safeParse(value);
    if (parsed.success) return { analysis: parsed.data, structuredStatus: "validated" };
  } catch {
    /* Preserve the raw answer; never fabricate structured observations. */
  }
  return { structuredStatus: "unavailable" };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}
type ProviderPlan = PredictionPlan | RunwarePlan;
type ProviderState = PredictionState | RunwarePredictionState;

export class MusicWorkflow {
  constructor(
    readonly store: WorkflowStore,
    readonly assets: AudioAssets,
    readonly runwareApiKey?: string
  ) {}

  private async source(owner: string, source: Source) {
    if (source.audioId && source.audio) throw new Error("Pass an audioId or an attachment, not both.");
    if (source.audioId) return this.assets.require(owner, source.audioId);
    if (source.audio) {
      return this.assets.register(owner, {
        url: source.audio.download_url,
        fileName: source.audio.file_name,
        mimeType: source.audio.mime_type,
      });
    }
    return undefined;
  }

  async submit(
    owner: string,
    replicateToken: string,
    action: "generate" | "analyze",
    request: GenerateMusicInput | AnalyzeMusicInput,
    source: Source,
    requestKey = newId("request")
  ) {
    if (requestKey.length > 128 || !/^[\w.-]+$/.test(requestKey)) {
      throw new Error("requestKey must be 1–128 letters, digits, underscores, dots or hyphens.");
    }
    if (source.audioId && source.audio) throw new Error("Pass exactly one audio source.");
    if (action === "analyze" && !source.audioId && !source.audio) {
      throw new Error("Analysis requires an audioId or attachment.");
    }
    const fingerprint = await sha256(
      JSON.stringify(
        canonical({
          action,
          request,
          source: { audioId: source.audioId, fileId: source.audio?.file_id },
        })
      )
    );
    const prior = await this.store.findRequest<Job>(owner, requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error("requestKey was already used with different inputs. Use a new key for a new operation.");
      }
      return this.view(prior);
    }

    const job: Job = {
      id: newId("job"),
      kind: "job",
      revision: 0,
      action,
      provider: action === "generate" ? "runware" : "replicate",
      status: "preparing",
      requestKey,
      fingerprint,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      warnings: [],
    };
    if (!(await this.store.insert(owner, job, requestKey))) {
      const existing = await this.store.findRequest<Job>(owner, requestKey);
      if (!existing) {
        throw new Error(
          "At most three active or unreconciled music jobs are allowed per user. Finish or cancel an existing job before creating another."
        );
      }
      if (existing.fingerprint !== fingerprint) throw new Error("Concurrent request-key conflict.");
      return this.view(existing);
    }

    let startingPrediction = false;
    try {
      const audio = await this.source(owner, source);
      const file = audio ? await this.assets.file(owner, audio.id) : undefined;
      job.sourceAudioId = audio?.id;

      let plan: ProviderPlan;
      if (action === "generate") {
        if (!this.runwareApiKey?.trim()) {
          throw new Error("Runware generation is not configured on this deployment.");
        }
        const runwarePlan = prepareRunwareGeneration({
          ...(request as GenerateMusicInput),
          referenceAudioFile: file,
        });
        plan = runwarePlan;
        job.provider = "runware";
        // Persist the Runware task UUID before the network call so an ambiguous
        // response can be reconciled with getTaskDetails instead of resubmitted.
        job.predictionId = runwarePlan.taskUUID;
      } else {
        if (!replicateToken?.trim()) {
          throw new Error("Connect Replicate before using audio listening/analysis.");
        }
        plan = await prepareAnalysis(replicateToken, {
          ...(request as AnalyzeMusicInput),
          audioUrl: "",
          audioFile: file,
          structured: true,
        });
        job.provider = "replicate";
      }

      Object.assign(job, {
        model: plan.model,
        modelVersion: plan.version,
        prompt: plan.prompt,
        mode: plan.mode,
        warnings: plan.warnings,
        status: "submitting",
        updatedAt: Date.now(),
        analyzedRange: (request as AnalyzeMusicInput).analyzedRange,
        audioFormat: (request as GenerateMusicInput).audioFormat || "mp3",
      });
      if (!(await this.store.update(owner, job))) {
        throw new Error("Job changed before submission; no prediction was started.");
      }

      startingPrediction = true;
      const prediction =
        action === "generate"
          ? await createRunwareTask(this.runwareApiKey!, plan as RunwarePlan)
          : await createReplicatePrediction(replicateToken, plan as PredictionPlan);

      job.predictionId = prediction.id;
      job.status = prediction.status;
      if (prediction.metrics?.cost !== undefined) job.providerCostUsd = prediction.metrics.cost;
      job.updatedAt = Date.now();
      if (!(await this.store.update(owner, job))) throw new Error("Cannot persist prediction receipt.");
      return this.apply(owner, job, prediction);
    } catch (error) {
      // After a provider POST may have been accepted, do not automatically
      // resubmit. Runware can reconcile by taskUUID; Replicate preserves the
      // existing conservative submission_unknown behavior.
      job.status = startingPrediction ? "submission_unknown" : "failed";
      job.updatedAt = Date.now();
      job.result = {
        error: startingPrediction
          ? "Submission outcome requires reconciliation. Reuse this requestKey and poll this job; do not submit a new billable job blindly."
          : error instanceof Error
            ? error.message
            : "Input preparation failed.",
      };
      await this.store.update(owner, job);
      return this.view(job);
    }
  }

  private async require(owner: string, id: string) {
    const job = await this.store.get<Job>(owner, id);
    if (!job || job.kind !== "job") throw new Error("Job not found or not owned by this user.");
    return job;
  }

  async get(owner: string, replicateToken: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (job.status === "finalizing" && (job.finalizingUntil || 0) > Date.now()) return this.view(job);
    if (job.providerOutput !== undefined && ["storage_pending", "finalizing"].includes(job.status)) {
      return this.apply(owner, job, {
        id: job.predictionId!,
        status: "succeeded",
        output: job.providerOutput,
        metrics: job.providerCostUsd !== undefined ? { cost: job.providerCostUsd } : undefined,
      });
    }
    if (!job.predictionId) return this.view(job);

    if (job.provider === "runware") {
      if (!this.runwareApiKey?.trim()) throw new Error("Runware generation is not configured on this deployment.");
      return this.apply(owner, job, await getRunwareTask(this.runwareApiKey, job.predictionId));
    }
    if (!replicateToken?.trim()) throw new Error("Connect Replicate before polling this listening task.");
    return this.apply(owner, job, await getReplicatePrediction(replicateToken, job.predictionId));
  }

  async cancel(owner: string, replicateToken: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (!job.predictionId) {
      throw new Error("Submission is not yet reconciled. Check this job again; cancellation is not confirmed.");
    }

    if (job.provider === "runware") {
      if (!this.runwareApiKey?.trim()) throw new Error("Runware generation is not configured on this deployment.");
      const state = await cancelRunwareTask(this.runwareApiKey, job.predictionId);
      return this.apply(owner, job, state);
    }
    if (!replicateToken?.trim()) throw new Error("Connect Replicate before canceling this listening task.");
    return this.apply(owner, job, await cancelReplicatePrediction(replicateToken, job.predictionId));
  }

  private async apply(owner: string, job: Job, prediction: ProviderState): Promise<Record<string, unknown>> {
    if (prediction.metrics?.cost !== undefined) job.providerCostUsd = prediction.metrics.cost;

    if (prediction.status !== "succeeded") {
      job.status = prediction.status;
      job.updatedAt = Date.now();
      if (["failed", "canceled"].includes(prediction.status)) {
        const providerName = job.provider === "runware" ? "Runware" : "Replicate";
        const detail =
          typeof prediction.error === "string"
            ? prediction.error
            : prediction.error
              ? JSON.stringify(prediction.error)
              : "";
        job.result = {
          error: `${providerName} task ${prediction.id} is ${prediction.status}.${detail ? ` ${detail}` : ""}`,
        };
      }
      if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));
      return this.view(job);
    }

    job.providerOutput = prediction.output;
    job.status = "finalizing";
    job.finalizingUntil = Date.now() + 120000;
    if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));

    try {
      if (job.action === "analyze") {
        const answer = outputText(prediction.output);
        if (!answer) throw new ResultShapeError("No analysis text was returned.");
        job.result = {
          answer,
          ...parseAnalysis(answer),
          analyzedRange: job.analyzedRange || null,
          sourceAudioId: job.sourceAudioId,
        };
      } else {
        const urls = outputUrls(prediction.output);
        if (!urls.length) throw new ResultShapeError("No generated audio was returned.");
        if (urls.length > 4) {
          throw new Error("Unexpectedly many output files; inspect the provider task before importing them.");
        }
        const audios = [];
        const providerRetentionMs =
          job.provider === "runware" ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
        for (let index = 0; index < urls.length; index++) {
          const audio = await this.assets.register(
            owner,
            {
              url: urls[index],
              fileName: `${job.id}-${index}.${job.audioFormat}`,
              mimeType: job.audioFormat === "wav" ? "audio/wav" : "audio/mpeg",
              expiresAt: job.createdAt + providerRetentionMs,
              parentAudioId: job.sourceAudioId,
            },
            `audio_${job.id}_${index}`
          );
          audios.push(this.assets.view(audio));
        }
        job.result = {
          audioId: audios[0].audioId,
          audioIds: audios.map((audio) => audio.audioId),
          audioUrl: urls[0],
          audioUrls: urls,
          audios,
          referenceAudioUsed: !!job.sourceAudioId,
          sourceAudioId: job.sourceAudioId,
          ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
        };
      }
      job.status = "succeeded";
      delete job.providerOutput;
    } catch (error) {
      job.status = error instanceof ResultShapeError ? "failed" : "storage_pending";
      job.result = {
        error:
          error instanceof ResultShapeError
            ? error.message
            : "Provider generation completed, but output import is incomplete. Poll the same job to retry import without generating again.",
        audioUrls: job.action === "generate" ? outputUrls(prediction.output) : undefined,
        ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
      };
    }
    job.updatedAt = Date.now();
    delete job.finalizingUntil;
    if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));
    return this.view(job);
  }

  view(job: Job): Record<string, unknown> {
    return {
      jobId: job.id,
      requestKey: job.requestKey,
      status: job.status,
      provider: job.provider || "replicate",
      predictionId: job.predictionId,
      model: job.model,
      modelVersion: job.modelVersion,
      generationMode: job.mode,
      effectivePrompt: job.prompt,
      prompt: job.prompt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      warnings: job.warnings,
      ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
      pollAfterSeconds: terminal.has(job.status) ? undefined : 3,
      ...job.result,
    };
  }
}
