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
  return content.map((part) =>
    part.type === "image"
      ? { type: "image", data: part.source.data, mime_type: part.source.media_type }
      : { type: "text", text: part.text });
}

function friendlyError(status, body) {
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  const reason = err?.details?.find((d) => d.reason)?.reason || err?.status || "";
  const message = err?.message || "";
  if (reason === "API_KEY_INVALID" || /api key not valid/i.test(message)) {
    return new GeminiError("Your Gemini API key was rejected. Check it in Settings.");
  }
  if (status === 429) {
    return new GeminiError("You've hit Gemini's free limit for now. Wait a minute (or until tomorrow if it's the daily limit), or switch to Claude in Settings.");
  }
  if (status === 403) return new GeminiError("Your Gemini key isn't allowed to use this. Check it at aistudio.google.com.");
  if (status >= 500) return new GeminiError("Gemini is having trouble right now. Try again in a minute.");
  return new GeminiError(`Gemini error (${status}): ${message || "request failed"}`);
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
  if (!res.ok) throw friendlyError(res.status, data);
  return data;
}

function outputText(interaction) {
  const outputs = (interaction.steps || []).filter((s) => s.type === "model_output");
  const last = outputs.at(-1);
  return (last?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

// Pulls a JSON object out of free text (used when structured output isn't available with tools).
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

export async function geminiStructured({ apiKey, system, schema, content, webFetch = false, thinking = "low" }) {
  if (!apiKey) throw new GeminiError("Add your Gemini API key in Settings to use AI features.");
  const base = {
    model: GEMINI_MODEL.id,
    input: toGeminiInput(content),
    system_instruction: system,
    generation_config: { thinking_level: thinking, max_output_tokens: 16000 },
    store: false,
    ...(webFetch ? { tools: [{ type: "url_context" }] } : {}),
  };
  const geminiSchema = toGeminiSchema(schema);

  let interaction;
  let structured = true;
  try {
    interaction = await post(apiKey, {
      ...base,
      response_format: { type: "text", mime_type: "application/json", schema: geminiSchema },
    });
  } catch (err) {
    // Structured output together with tools is a preview feature; fall back to asking for JSON in text.
    if (!webFetch || !(err instanceof GeminiError) || !/\(400\)/.test(err.message)) throw err;
    structured = false;
    interaction = await post(apiKey, {
      ...base,
      system_instruction: `${system}\n\nReply with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${JSON.stringify(geminiSchema)}`,
    });
  }

  if (interaction.status === "failed") {
    const msg = interaction.errors?.[0]?.message || "the request failed";
    throw new GeminiError(`Gemini couldn't finish: ${msg}`);
  }
  if (interaction.status === "incomplete") throw new GeminiError("Gemini's answer was cut off. Please try again.");

  const text = outputText(interaction);
  let data;
  try {
    data = structured ? JSON.parse(text) : parseLooseJson(text);
  } catch {
    throw new GeminiError("Gemini's answer couldn't be read. Please try again.");
  }
  return { data, cost: 0, model: GEMINI_MODEL.label };
}

// Cheap check used by Settings: list models with the key.
export async function testGeminiKey(apiKey) {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": apiKey },
    });
    if (res.ok) return null;
    return friendlyError(res.status, await res.json().catch(() => null)).message;
  } catch {
    return "Couldn't reach Google. Check your internet connection.";
  }
}
