import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

/** Читает тело запроса и возвращает непустой текст заявки, иначе бросает InvalidInput. */
async function readRequestText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("broken json");
  }
  const text = body && typeof body === "object" && !Array.isArray(body) ? body.text : undefined;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("empty or not a string");
  return text;
}

/** Ждёт модель не дольше timeoutMs. По таймауту отменяет вызов через AbortSignal. */
export async function askModel(text, { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("model timeout"), { code: "timeout" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Проверяет ответ модели. Возвращает { topic, draft } или null, если ответ не годится. */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

async function handleTriage(request, response, deps) {
  let text;
  try {
    text = await readRequestText(request);
  } catch (error) {
    if (error instanceof InvalidInput) return json(response, 400, { status: "invalid_input" });
    throw error;
  }

  let result = null;
  let reason = "invalid_model_output";
  try {
    result = parseModelOutput(await askModel(text, deps));
  } catch (error) {
    reason = error.code === "timeout" ? "model_timeout" : "model_error";
  }

  if (!result) {
    // Причина остаётся в логе сервера, менеджер получает один понятный статус.
    console.warn(`[triage] manual_review: ${reason}`);
    return json(response, 200, MANUAL_REVIEW);
  }
  return json(response, 200, { status: "ready", ...result });
}

/** Создаёт HTTP-сервер. deps позволяет подменить модель и таймаут в тестах. */
export function createTriageServer(deps = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, deps);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log(`Открыть: http://127.0.0.1:${port}`);
  });
}
