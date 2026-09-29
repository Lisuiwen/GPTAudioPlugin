import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const SCOPES = ["replicate.read", "replicate.run"];

type ReplicateAccount = {
  type?: string;
  username?: string;
  name?: string;
  github_url?: string;
};

type ProfileRecord = {
  id: string;
  username: string;
  name?: string;
  encryptedReplicateToken: string;
  createdAt: number;
  updatedAt: number;
};

type TokenRecord = {
  profileId: string;
  expiresAt: number;
  scope: string;
};

type Store = {
  profiles: Record<string, ProfileRecord>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  profileId: string;
  expiresAt: number;
};

export type AuthSession = {
  profileId: string;
  username: string;
  name?: string;
  replicateToken: string;
  scope: string[];
};

const dataDir = resolve(process.cwd(), ".data");
const storePath = resolve(dataDir, "auth-store.json");
const keyPath = resolve(dataDir, "auth.key");
const authorizationCodes = new Map<string, AuthorizationCodeRecord>();

function ensureDataDir(): void {
  mkdirSync(dataDir, { recursive: true });
}

function readStore(): Store {
  ensureDataDir();

  if (!existsSync(storePath)) {
    return {
      profiles: {},
      accessTokens: {},
      refreshTokens: {},
    };
  }

  try {
    return JSON.parse(readFileSync(storePath, "utf8")) as Store;
  } catch {
    return {
      profiles: {},
      accessTokens: {},
      refreshTokens: {},
    };
  }
}

function writeStore(store: Store): void {
  ensureDataDir();
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function getEncryptionKey(): Buffer {
  const configured = process.env.AUTH_ENCRYPTION_KEY?.trim();
  if (configured) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length !== 32) {
      throw new Error("AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }
    return decoded;
  }

  ensureDataDir();

  if (existsSync(keyPath)) {
    const decoded = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (decoded.length === 32) return decoded;
  }

  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("base64"), "utf8");
  return key;
}

function encryptSecret(value: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptSecret(value: string): string {
  const [ivPart, tagPart, encryptedPart] = value.split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Stored credential is invalid.");
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function base64urlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pruneStore(store: Store): void {
  const now = Date.now();

  for (const [key, record] of Object.entries(store.accessTokens)) {
    if (record.expiresAt <= now) delete store.accessTokens[key];
  }

  for (const [key, record] of Object.entries(store.refreshTokens)) {
    if (record.expiresAt <= now) delete store.refreshTokens[key];
  }

  for (const [code, record] of authorizationCodes.entries()) {
    if (record.expiresAt <= now) authorizationCodes.delete(code);
  }
}

export function getPublicBaseUrl(port: number): string {
  return (
    process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") ||
    `http://127.0.0.1:${port}`
  );
}

export function getResourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl}/.well-known/oauth-protected-resource`;
}

export function oauthChallenge(baseUrl: string): string {
  return `Bearer resource_metadata="${getResourceMetadataUrl(
    baseUrl
  )}", error="insufficient_scope", error_description="Connect your Replicate account to continue"`;
}

export function authenticateRequest(
  req: IncomingMessage
): AuthSession | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;

  const accessToken = header.slice("Bearer ".length).trim();
  if (!accessToken) return undefined;

  const store = readStore();
  pruneStore(store);

  const record = store.accessTokens[tokenHash(accessToken)];
  if (!record || record.expiresAt <= Date.now()) {
    writeStore(store);
    return undefined;
  }

  const profile = store.profiles[record.profileId];
  if (!profile) return undefined;

  return {
    profileId: profile.id,
    username: profile.username,
    name: profile.name,
    replicateToken: decryptSecret(profile.encryptedReplicateToken),
    scope: record.scope.split(" ").filter(Boolean),
  };
}

export async function validateReplicateToken(
  replicateToken: string
): Promise<ReplicateAccount> {
  const response = await fetch("https://api.replicate.com/v1/account", {
    headers: {
      Authorization: `Bearer ${replicateToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Replicate rejected this token (HTTP ${response.status}). Create or copy a valid API token and try again.`
    );
  }

  return (await response.json()) as ReplicateAccount;
}

function upsertProfile(
  replicateToken: string,
  account: ReplicateAccount
): ProfileRecord {
  const store = readStore();
  pruneStore(store);

  const username = account.username?.trim() || "replicate-user";
  const existing = Object.values(store.profiles).find(
    (profile) => profile.username === username
  );
  const now = Date.now();

  const profile: ProfileRecord = {
    id: existing?.id || `prf_${randomBytes(12).toString("base64url")}`,
    username,
    name: account.name?.trim() || undefined,
    encryptedReplicateToken: encryptSecret(replicateToken),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  store.profiles[profile.id] = profile;
  writeStore(store);
  return profile;
}

function issueTokens(
  profileId: string,
  scope: string
): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} {
  const store = readStore();
  pruneStore(store);

  const accessToken = createOpaqueToken("gpa");
  const refreshToken = createOpaqueToken("gpr");
  const now = Date.now();

  store.accessTokens[tokenHash(accessToken)] = {
    profileId,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    scope,
  };

  store.refreshTokens[tokenHash(refreshToken)] = {
    profileId,
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
    scope,
  };

  writeStore(store);

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAuthorizationPage(
  res: ServerResponse,
  params: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    error?: string;
  }
): void {
  const error = params.error
    ? `<div class="error">${htmlEscape(params.error)}</div>`
    : "";

  const hidden = Object.entries({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state || "",
    code_challenge: params.codeChallenge,
    resource: params.resource,
    scope: params.scope,
  })
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${key}" value="${htmlEscape(value)}" />`
    )
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Connect Replicate</title>
  <style>
    body{font-family:Inter,system-ui,sans-serif;margin:0;background:#f6f7f8;color:#111}
    main{max-width:520px;margin:56px auto;padding:24px;background:#fff;border:1px solid #ddd;border-radius:16px}
    h1{font-size:22px;margin-top:0}.muted{color:#666;line-height:1.55;font-size:14px}
    a.button,button{display:inline-block;border:0;border-radius:10px;padding:10px 14px;font-weight:700;text-decoration:none;cursor:pointer}
    a.button{background:#f0f0f0;color:#111;margin-bottom:16px}
    button{background:#111;color:#fff;width:100%;margin-top:12px}
    input[type=password]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #bbb;border-radius:10px}
    label{display:grid;gap:7px;font-size:13px;font-weight:700}.error{padding:10px;background:#fff0f0;border:1px solid #e2a3a3;border-radius:10px;margin:12px 0;font-size:13px}
    ol{font-size:14px;line-height:1.6;padding-left:20px}
  </style>
</head>
<body>
  <main>
    <h1>Connect Replicate</h1>
    <p class="muted">Replicate does not currently expose a third-party OAuth consent flow. GPTAudioPlugin therefore verifies and stores your own Replicate API token locally, then completes ChatGPT's OAuth connection.</p>
    ${error}
    <ol>
      <li>Open Replicate and create or copy an API token.</li>
      <li>Return here and paste the token below.</li>
      <li>The token is validated with Replicate and encrypted on this MCP server.</li>
    </ol>
    <a class="button" href="https://replicate.com/account/api-tokens" target="_blank" rel="noreferrer">Open Replicate API tokens ↗</a>
    <form method="post" action="/authorize">
      ${hidden}
      <label>
        Replicate API token
        <input name="replicate_token" type="password" autocomplete="off" placeholder="r8_…" required />
      </label>
      <button type="submit">Connect Replicate</button>
    </form>
  </main>
</body>
</html>`;

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    Location: location,
    "cache-control": "no-store",
  });
  res.end();
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function normalizeScope(scope: string | null): string {
  const requested = (scope || SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean)
    .filter((item) => SCOPES.includes(item));

  return (requested.length ? requested : SCOPES).join(" ");
}

function isAllowedRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);

    if (
      url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname.endsWith(".openai.com"))
    ) {
      return true;
    }

    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export async function handleAuthHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  baseUrl: string
): Promise<boolean> {
  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp")
  ) {
    json(res, 200, {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/oauth-authorization-server"
  ) {
    json(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/authorize") {
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const responseType = url.searchParams.get("response_type") || "";
    const codeChallengeMethod =
      url.searchParams.get("code_challenge_method") || "";
    const resource =
      url.searchParams.get("resource") || `${baseUrl}/mcp`;
    const scope = normalizeScope(url.searchParams.get("scope"));
    const state = url.searchParams.get("state") || undefined;

    if (
      responseType !== "code" ||
      codeChallengeMethod !== "S256" ||
      !clientId ||
      !codeChallenge ||
      !isAllowedRedirectUri(redirectUri)
    ) {
      json(res, 400, {
        error: "invalid_request",
        error_description:
          "Authorization requires response_type=code, PKCE S256, a client_id, and an approved redirect_uri.",
      });
      return true;
    }

    renderAuthorizationPage(res, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      resource,
      scope,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/authorize") {
    const form = await readForm(req);
    const clientId = form.get("client_id") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const codeChallenge = form.get("code_challenge") || "";
    const resource = form.get("resource") || `${baseUrl}/mcp`;
    const scope = normalizeScope(form.get("scope"));
    const state = form.get("state") || undefined;
    const replicateToken = form.get("replicate_token")?.trim() || "";

    if (!clientId || !codeChallenge || !isAllowedRedirectUri(redirectUri)) {
      json(res, 400, {
        error: "invalid_request",
        error_description: "The authorization request is incomplete.",
      });
      return true;
    }

    try {
      const account = await validateReplicateToken(replicateToken);
      const profile = upsertProfile(replicateToken, account);
      const code = createOpaqueToken("gpc");

      authorizationCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        resource,
        scope,
        profileId: profile.id,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });

      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      if (state) callback.searchParams.set("state", state);
      callback.searchParams.set("iss", baseUrl);
      redirect(res, callback.toString());
    } catch (error) {
      renderAuthorizationPage(res, {
        clientId,
        redirectUri,
        state,
        codeChallenge,
        resource,
        scope,
        error: error instanceof Error ? error.message : "Replicate authentication failed.",
      });
    }

    return true;
  }

  if (req.method === "POST" && url.pathname === "/token") {
    const form = await readForm(req);
    const grantType = form.get("grant_type") || "";

    if (grantType === "authorization_code") {
      const code = form.get("code") || "";
      const codeVerifier = form.get("code_verifier") || "";
      const redirectUri = form.get("redirect_uri") || "";
      const clientId = form.get("client_id") || "";
      const record = authorizationCodes.get(code);

      if (
        !record ||
        record.expiresAt <= Date.now() ||
        record.clientId !== clientId ||
        record.redirectUri !== redirectUri ||
        !safeEqual(base64urlSha256(codeVerifier), record.codeChallenge)
      ) {
        json(res, 400, {
          error: "invalid_grant",
          error_description: "Authorization code or PKCE verifier is invalid.",
        });
        return true;
      }

      authorizationCodes.delete(code);
      const tokens = issueTokens(record.profileId, record.scope);

      json(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        scope: record.scope,
      });
      return true;
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") || "";
      const store = readStore();
      pruneStore(store);
      const record = store.refreshTokens[tokenHash(refreshToken)];

      if (!record || record.expiresAt <= Date.now()) {
        writeStore(store);
        json(res, 400, {
          error: "invalid_grant",
          error_description: "Refresh token is invalid or expired.",
        });
        return true;
      }

      delete store.refreshTokens[tokenHash(refreshToken)];
      writeStore(store);

      const tokens = issueTokens(record.profileId, record.scope);
      json(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        scope: record.scope,
      });
      return true;
    }

    json(res, 400, {
      error: "unsupported_grant_type",
    });
    return true;
  }

  return false;
}
