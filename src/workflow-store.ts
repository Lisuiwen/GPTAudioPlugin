import type { SitesDatabase } from "./sites-store.js";
import { downloadAudio, MAX_AUDIO_BYTES } from "./audio.js";

export type AudioBucket = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
};
export type RecordValue = { id: string; kind: "audio" | "job"; revision: number; [key: string]: unknown };
export class WorkflowStore {
  constructor(readonly db: SitesDatabase) {}
  async get<T extends RecordValue>(owner: string, id: string): Promise<T | undefined> {
    const row = await this.db.prepare("SELECT payload FROM music_records WHERE user_id = ? AND id = ?").bind(owner, id).first<{ payload: string }>();
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  async findRequest<T extends RecordValue>(owner: string, key: string): Promise<T | undefined> {
    const row = await this.db.prepare("SELECT payload FROM music_records WHERE user_id = ? AND request_key = ?").bind(owner, key).first<{ payload: string }>();
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  async insert(owner: string, value: RecordValue, requestKey?: string): Promise<boolean> {
    const row = await this.db.prepare("INSERT INTO music_records (user_id,id,kind,request_key,payload,revision,updated_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT DO NOTHING RETURNING id")
      .bind(owner, value.id, value.kind, requestKey || null, JSON.stringify({ ...value, revision: 0 }), Date.now()).first<{ id: string }>();
    return !!row;
  }
  async update(owner: string, value: RecordValue): Promise<boolean> {
    const next = { ...value, revision: value.revision + 1 };
    const row = await this.db.prepare("UPDATE music_records SET payload = ?, revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND revision = ? RETURNING id")
      .bind(JSON.stringify(next), next.revision, Date.now(), owner, value.id, value.revision).first<{ id: string }>();
    if (row) value.revision = next.revision;
    return !!row;
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM music_records WHERE user_id = ? AND id = ?").bind(owner, id).run();
  }
}
export type AudioRecord = RecordValue & {
  kind: "audio"; fileName: string; mimeType: string; createdAt: number;
  sourceUrl?: string; expiresAt?: number; objectKey?: string; parentAudioId?: string;
  storage: "object" | "temporary"; sha256?: string; byteLength?: number;
};
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
export async function sha256(text: string | ArrayBuffer): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export class AudioAssets {
  constructor(readonly store: WorkflowStore, readonly bucket?: AudioBucket) {}
  async register(owner: string, source: { url: string; fileName?: string; mimeType?: string; expiresAt?: number; parentAudioId?: string }, id = newId("audio")): Promise<AudioRecord> {
    const existing = await this.store.get<AudioRecord>(owner, id);
    if (existing) return existing;
    if (source.parentAudioId) await this.require(owner, source.parentAudioId);
    const file = await downloadAudio(source.url, source.fileName || "audio", source.mimeType);
    const data = await file.arrayBuffer();
    if (data.byteLength > MAX_AUDIO_BYTES) throw new Error("Audio exceeds storage limit.");
    const record: AudioRecord = { id, revision: 0, kind: "audio", fileName: file.name, mimeType: file.type || "audio/mpeg", createdAt: Date.now(), parentAudioId: source.parentAudioId, byteLength: data.byteLength, sha256: await sha256(data), storage: this.bucket ? "object" : "temporary" };
    if (this.bucket) {
      record.objectKey = `${await sha256(owner)}/${id}`;
      await this.bucket.put(record.objectKey, data, { httpMetadata: { contentType: record.mimeType } });
    } else { record.sourceUrl = source.url; record.expiresAt = source.expiresAt; }
    await this.store.insert(owner, record);
    return (await this.store.get<AudioRecord>(owner, id))!;
  }
  async require(owner: string, id: string): Promise<AudioRecord> {
    const record = await this.store.get<AudioRecord>(owner, id);
    if (!record || record.kind !== "audio") throw new Error("Audio not found or not owned by this user.");
    return record;
  }
  async file(owner: string, id: string): Promise<File> {
    const record = await this.require(owner, id);
    if (record.objectKey) {
      if (!this.bucket) throw new Error("Audio object storage binding is unavailable.");
      const object = await this.bucket.get(record.objectKey);
      if (!object) throw new Error("Stored audio is missing.");
      return new File([await object.arrayBuffer()], record.fileName, { type: record.mimeType });
    }
    if (!record.sourceUrl || (record.expiresAt && record.expiresAt <= Date.now())) throw new Error("Temporary audio expired. Provide a fresh source; no inference was started.");
    return downloadAudio(record.sourceUrl, record.fileName, record.mimeType);
  }
  async remove(owner: string, id: string): Promise<void> {
    const record = await this.require(owner, id);
    if (record.objectKey) {
      if (!this.bucket) throw new Error("Storage unavailable; audio was not marked deleted.");
      await this.bucket.delete(record.objectKey);
    }
    await this.store.remove(owner, id);
  }
  view(record: AudioRecord) {
    const { objectKey, sourceUrl, revision, ...safe } = record;
    return { ...safe, audioId: record.id, ...(sourceUrl ? { audioUrl: sourceUrl } : {}), warning: record.storage === "temporary" ? "Only a temporary provider URL is retained. Configure AUDIO_BUCKET for durable audio storage." : undefined };
  }
}
