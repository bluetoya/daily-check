import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  attachSyncSpace,
  createDbPool,
  healthcheck,
  regenerateSyncKey,
  runMigrations,
  syncChanges,
  type AttachInput,
  type RegenerateKeyInput,
  type SyncInput,
} from "./storage.js";

loadEnvFiles();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST?.trim() || "localhost";
const databaseUrl = process.env.DATABASE_URL;
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN ?? "http://localhost:1420,tauri://localhost")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

if (!databaseUrl) {
  throw new Error("DATABASE_URL 환경변수가 필요합니다.");
}

const pool = createDbPool(databaseUrl);
await runMigrations(pool);

const server = http.createServer(async (request, response) => {
  setCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      await healthcheck(pool);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/sync/attach") {
      const body = await readJson<AttachInput>(request);
      const result = await attachSyncSpace(pool, body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/sync") {
      const body = await readJson<SyncInput>(request);
      const result = await syncChanges(pool, {
        ...body,
        changes: body.changes ?? [],
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/sync/regenerate-key") {
      const body = await readJson<RegenerateKeyInput>(request);
      const result = await regenerateSyncKey(pool, body);
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { ok: false, message: "Not found" });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      message: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
    });
  }
});

server.listen(port, host, () => {
  console.log(`sync server listening on http://${host}:${port}`);
});

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("요청 본문이 비어 있습니다.");
  }

  return JSON.parse(raw) as T;
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(request: http.IncomingMessage, response: http.ServerResponse) {
  const origin = request.headers.origin?.trim();
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function loadEnvFiles() {
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").trim();
  const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const originalKeys = new Set(Object.keys(process.env));
  const candidates = [
    ".env",
    `.env.${appEnv}`,
    ".env.local",
    `.env.${appEnv}.local`,
  ];

  for (const candidate of candidates) {
    const envPath = path.resolve(baseDir, candidate);
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator < 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!key || originalKeys.has(key)) {
        continue;
      }

      process.env[key] = value;
    }
  }
}
