import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { MusicWorkflow } from "./music-workflow.js";
import { AudioAssets, WorkflowStore, type AudioBucket } from "./workflow-store.js";
import type { SitesDatabase } from "./sites-store.js";

export const MUSIC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS music_records (
 user_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
 request_key TEXT, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,id), UNIQUE(user_id,request_key)
);`;

export function createLocalWorkflow(directory: string, runwareApiKey = process.env.RUNWARE_API_KEY) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const sqlite = new DatabaseSync(join(root, "music.sqlite"));
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  sqlite.exec(MUSIC_SCHEMA_SQL);
  const db: SitesDatabase = {
    prepare(sql) { return { bind(...values) { return {
      async first<T>() { return (sqlite.prepare(sql).get(...values) || null) as T | null; },
      async run() { return sqlite.prepare(sql).run(...values); },
    }; } }; },
  };
  const filePath = (key: string) => {
    if (!/^[a-f0-9]{64}\/audio_[\w-]+$/.test(key)) throw new Error("Invalid audio object key.");
    return join(root, "audio", ...key.split("/"));
  };
  const bucket: AudioBucket = {
    async put(key, data) {
      const path = filePath(key); await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temporary, new Uint8Array(data), { mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    },
    async get(key) {
      try { const bytes = await readFile(filePath(key)); return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; } }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async delete(key) { await rm(filePath(key), { force: true }); },
  };
  const store = new WorkflowStore(db);
  return { db, bucket, workflow: new MusicWorkflow(store, new AudioAssets(store, bucket), runwareApiKey), close: () => sqlite.close() };
}
