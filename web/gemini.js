// Google Gemini (free tier) as an alternative AI provider, via the Interactions REST API.
// Mirrors ai.js's structured call: same content parts in, parsed JSON out.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_MODEL = { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" };

export class GeminiError extends Error {}

// Gemini wants nullable fields as type arrays ({"type": ["number", "null"]}), not anyOf.
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = toGeminiSchema(v);
  const variants = out.anyOf;
  if (Array.isArray(variants) && variants.length === 2 && variants.some((v) => v.type === "null")) {
    const other = variants.find((v) => v.type !== "null");
    delete out.anyOf;
    Object.assign(out, other, { type: [other.type, "null"] });
  }
  return out;
}

// Claude-style content parts -> Gemini input parts.
function toGeminiInput(content) {
  return content.map((part) => {
    if (part.type === "image") return { type: "image", data: part.source.data, mime_type: part.source.media_type };
    if (part.type === "video") return part; // already in Gemini's shape: { type, uri } or { type, data, mime_type }
    return { type: "text", text: part.text };
  });
}

// Second free model with its own quota, used when the main one is overloaded or rate limited.
// (gemini-2.5-flash was used here before, but Google no longer offers it to new accounts.)
const FALLBACK_MODEL = { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" };

function errorInfo(status, body) {
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  return {
    status,
    reason: err?.details?.find((d) => d.reason)?.reason || err?.status || "",
    message: err?.message || "",
  };
}

function friendlyError({ status, reason, message }) {
  if (reason === "API_KEY_INVALID" || /api key not valid/i.test(message)) {
    return new GeminiError("Your Gemini API key was rejected. Check it in Settings.");
  }
  if (status === 429) {
    const daily = /per ?day|daily|RequestsPerDay/i.test(message);
    return new GeminiError(`${daily ? "You've used today's free Gemini requests. They reset tomorrow" : "Gemini's free per-minute limit was hit. Wait a minute and try again"}, or switch to Claude in Settings.${message ? ` (Google said: "${message.slice(0, 220)}")` : ""}`);
  }
  if (status === 403) return new GeminiError(`Your Gemini key isn't allowed to use this. Google said: ${message || reason || "permission denied"}`);
  const said = message ? ` Google said: "${message}"` : "";
  if (status >= 500) return new GeminiError(`Gemini had a problem (error ${status}).${said} Try again in a minute.`);
  return new GeminiError(`Gemini error (${status}).${said}`);
}

class HttpFailure extends Error {
  constructor(info) {
    super(info.message || `HTTP ${info.status}`);
    this.info = info;
  }
}

async function post(apiKey, body) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiError("Couldn't reach Gemini. Check your internet connection.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpFailure(errorInfo(res.status, data));
  return data;
}

function outputText(interaction) {
  const outputs = (interaction.steps || []).filter((s) => s.type === "model_output");
  const last = outputs.at(-1);
  return (last?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

// Pulls a JSON object out of free text (used when structured output isn't accepted).
function parseLooseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("no json");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Space requests out a little so bursts (background photo search, step tagging) stay under the
// free tier's per-minute limit.
const MIN_GAP_MS = 2500;
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await sleep(wait);
}

// quick: one attempt, no retries or fallback model (for "Test AI", which should answer fast).
export async function geminiStructured({ apiKey, system, schema, content, webFetch = false, thinking = "low", quick = false }) {
  if (!apiKey) throw new GeminiError("Add your Gemini API key in Settings to use AI features.");
  const geminiSchema = toGeminiSchema(schema);
  const jsonInstructions = `${system}\n\nReply with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${JSON.stringify(geminiSchema)}`;

  // Each attempt is a little more conservative than the last, so a temporary overload,
  // an unsupported request option, or a busy model doesn't stop the import.
  const attempts = quick ? [{ model: GEMINI_MODEL, structured: true }] : [
    { model: GEMINI_MODEL, structured: true },
    { model: GEMINI_MODEL, structured: true, waitMs: 1500 },
    { model: GEMINI_MODEL, structured: false },
    { model: FALLBACK_MODEL, structured: false },
  ];

  let lastInfo = null;
  let primaryInfo = null; // the main model's error is the one worth showing
  let sendThinking = true; // dropped if a model rejects the thinking level
  for (let i = 0; i < attempts.length; i++) {
    const { model, structured, waitMs } = attempts[i];
    if (waitMs) await sleep(waitMs);
    await pace();
    const body = {
      model: model.id,
      input: toGeminiInput(content),
      system_instruction: structured ? system : jsonInstructions,
      generation_config: {
        max_output_tokens: 16000,
        ...(sendThinking ? { thinking_level: thinking } : {}),
      },
      store: false,
      ...(webFetch ? { tools: [{ type: "url_context" }] } : {}),
      ...(structured ? { response_format: { type: "text", mime_type: "application/json", schema: geminiSchema } } : {}),
    };

    let interaction;
    try {
      interaction = await post(apiKey, body);
    } catch (err) {
      if (!(err instanceof HttpFailure)) throw err;
      lastInfo = err.info;
      if (model === GEMINI_MODEL && !primaryInfo) primaryInfo = err.info;
      const { status, reason, message } = err.info;
      // A model that doesn't accept this thinking level: retry the same attempt without it.
      if (status === 400 && sendThinking && /thinking/i.test(message)) {
        sendThinking = false;
        if (primaryInfo === err.info) primaryInfo = null;
        i--;
        continue;
      }
      if (reason === "API_KEY_INVALID" || /api key not valid/i.test(message) || status === 403) throw friendlyError(err.info);
      if (status === 429) {
        // Try the fallback model's separate quota once, otherwise report the limit.
        if (model !== FALLBACK_MODEL) {
          i = attempts.length - 2;
          continue;
        }
        throw friendlyError(primaryInfo || err.info);
      }
      // A 400 on a structured attempt usually means the schema/format wasn't accepted: skip to plain JSON.
      if (status === 400 && structured) {
        i = 1;
        continue;
      }
      if (status >= 500 || status === 404) continue;
      throw friendlyError(err.info);
    }

    if (interaction.status === "failed") {
      lastInfo = { status: 500, reason: "", message: interaction.errors?.[0]?.message || "the request failed" };
      if (model === GEMINI_MODEL && !primaryInfo) primaryInfo = lastInfo;
      continue;
    }
    if (interaction.status === "incomplete") throw new GeminiError("Gemini's answer was cut off. Please try again.");

    const text = outputText(interaction);
    try {
      return { data: structured ? JSON.parse(text) : parseLooseJson(text), cost: 0, model: model.label };
    } catch {
      lastInfo = { status: 500, reason: "", message: "the answer wasn't valid JSON" };
    }
  }
  throw friendlyError(primaryInfo || lastInfo || { status: 500, reason: "", message: "" });
}

// Cheap check used by Settings: list models with the key.
export async function testGeminiKey(apiKey) {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": apiKey },
    });
    if (res.ok) return null;
    return friendlyError(errorInfo(res.status, await res.json().catch(() => null))).message;
  } catch {
    return "Couldn't reach Google. Check your internet connection.";
  }
}
