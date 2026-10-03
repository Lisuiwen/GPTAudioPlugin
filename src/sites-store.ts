import type { AuthSession } from "./session.js";

export type ConnectionRecord = {
  user_id: string;
  username: string;
  name: string | null;
  encrypted_token: string;
  updated_at: number;
};

// Keep runtime access independent of the schema authoring library.
export type SitesDatabase = {
  prepare(sql: string): {
    bind(...values: Array<string | number | null>): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type SitesEnvironment = { DB: SitesDatabase; AUTH_ENCRYPTION_KEY: string };

export class ConnectionInputError extends Error {}

async function encryptionKey(encoded: string): Promise<CryptoKey> {
  if (!encoded) throw new Error("AUTH_ENCRYPTION_KEY is required.");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("AUTH_ENCRYPTION_KEY must contain 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export async function readConnection(env: SitesEnvironment, userId: string): Promise<ConnectionRecord | null> {
  return env.DB.prepare("SELECT * FROM replicate_connections WHERE user_id = ?").bind(userId).first<ConnectionRecord>();
}

export async function connectReplicate(env: SitesEnvironment, userId: string, token: string): Promise<void> {
  if (!token || token.length > 4096) throw new ConnectionInputError("请输入有效的 Replicate API 令牌。");
  const response = await fetch("https://api.replicate.com/v1/account", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ConnectionInputError(`Replicate 拒绝了此令牌（HTTP ${response.status}），请检查后重试。`);
  const account = await response.json() as { username?: string; name?: string };
  if (!account.username) throw new Error("Replicate 未返回有效账号，请稍后重试。");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env.AUTH_ENCRYPTION_KEY);
  // Bind the ciphertext to its Sites user so a copied record cannot grant another user's access.
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, key, new TextEncoder().encode(token));
  await env.DB.prepare(`INSERT INTO replicate_connections (user_id, username, name, encrypted_token, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username, name = excluded.name, encrypted_token = excluded.encrypted_token, updated_at = excluded.updated_at`)
    .bind(userId, account.username, account.name || null, `${encode(iv)}.${encode(new Uint8Array(encrypted))}`, Date.now()).run();
}

export async function readSession(env: SitesEnvironment, userId: string): Promise<AuthSession | undefined> {
  const record = await readConnection(env, userId);
  if (!record) return undefined;
  const [iv, ciphertext] = record.encrypted_token.split(".");
  const key = await encryptionKey(env.AUTH_ENCRYPTION_KEY);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: new TextEncoder().encode(userId) }, key, decode(ciphertext));
  return {
    profileId: userId,
    username: record.username,
    name: record.name || undefined,
    replicateToken: new TextDecoder().decode(plaintext),
    scope: ["replicate.read", "replicate.run"],
  };
}

export async function disconnectReplicate(env: SitesEnvironment, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM replicate_connections WHERE user_id = ?").bind(userId).run();
}
