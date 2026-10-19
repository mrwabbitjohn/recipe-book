// Claude-powered recipe extraction, called straight from the phone with the user's own API key.
// All AI calls go through extract(); a server-side proxy could replace it later without touching the UI.
import Anthropic from "./vendor/anthropic-sdk.js";
import { geminiStructured, GEMINI_MODEL } from "./gemini.js";

export const MODELS = {
  cheap: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", inPerM: 0.1, outPerM: 0.5 },
  strong: { id: "claude-opus-5-5", label: "Claude Opus 5.5", inPerM: 4, outPerM: 20 },
};

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "found", "title", "description", "servings", "prepMinutes", "cookMinutes",
    "totalMinutes", "tags", "imageUrl", "ingredients", "steps", "notes",
  ],
  properties: {
    found: { type: "boolean", description: "false if the input contains no recipe" },
    title: { type: "string" },
    description: { type: "string", description: "One or two sentence summary" },
    servings: nullable("number"),
    prepMinutes: nullable("number"),
    cookMinutes: nullable("number"),
    totalMinutes: nullable("number"),
    tags: { type: "array", items: { type: "string" } },
    imageUrl: { type: "string", description: "Absolute URL of the main photo of the dish on a webpage, or ''" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "quantity", "unit", "name", "note", "aisle", "estimated"],
        properties: {
          section: { type: "string", description: 'Group heading like "Sauce", or "" if none' },
          estimated: { type: "boolean", description: "true if you filled in or firmed up the amount because the source didn't give one" },
          quantity: nullable("number"),
          unit: { type: "string" },
          name: { type: "string", description: "Plain ingredient name, e.g. 'yellow onion'" },
          note: { type: "string", description: "Prep notes, e.g. 'finely diced'" },
          aisle: {
            type: "string",
            enum: [
              "Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Pantry",
              "Spices", "Frozen", "Drinks", "Other",
            ],
          },
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "timerMinutes", "ingredients"],
        properties: {
          text: { type: "string" },
          ingredients: {
            type: "array",
            items: { type: "integer" },
            description: "Numbers (1 = first in your ingredients list) of the ingredients added or used in this step",
          },
          timerMinutes: {
            ...nullable("number"),
            description: "Main wait/cook time in this step, if any (e.g. 'simmer 20 minutes' -> 20)",
          },
        },
      },
    },
    notes: { type: "string", description: "Tips, storage, substitutions; '' if none" },
  },
};

const SYSTEM = `You turn recipes into clean structured data for a personal recipe app.

- Copy the recipe faithfully. Do not invent ingredients or steps that aren't in the source.
- Ignore ads, life stories, comments and navigation on webpages.
- Quantities are numbers: "1 1/2" -> 1.5, "½" -> 0.5. Ranges use the lower bound and mention the range in the note.
- Amounts the source gives exactly are copied as-is with estimated=false.
- When the source gives no amount or only a vague one ("a splash of soy sauce", "some garlic", "a handful of basil"), fill in a sensible typical amount for this recipe and its servings, set estimated=true, and keep the source's wording in the note (e.g. note "a splash"). Salt and pepper "to taste" can stay quantity null with estimated=false.
- If the source doesn't say how many it serves, estimate servings from the amounts.
- Keep units short (tsp, tbsp, cup, g, kg, ml, l, oz, lb, clove, can) or "" for countable items ("2 eggs").
- Split steps into one clear action group each. Keep the original wording where reasonable.
- For handwritten cards or photos of cookbook pages, read carefully; combine multiple photos into one recipe.
- For each step, list the ingredients that step adds or uses (by their position in your ingredients list), so the cook sees them right at that step. Don't repeat ingredients that were combined in an earlier step (e.g. "pour in the sauce" doesn't list the sauce's ingredients again).
- For cooking videos, use everything: what's said, on-screen text and captions, and what you can see being added. Turn timings mentioned or shown into step timers.
- If there is no recipe in the input, set found=false and leave the other fields empty.`;

export class ImportError extends Error {}

const webFetchTool = (type) => ({ type, name: "web_fetch", max_uses: 3 });
// Newer web fetch (with dynamic filtering) is for the larger models; the basic one for Haiku.
const WEB_FETCH_TYPES = { cheap: ["web_fetch_20250910", "web_fetch_20260209"], strong: ["web_fetch_20260209", "web_fetch_20250910"] };

function costOf(usage, model) {
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (input * model.inPerM + (usage.output_tokens || 0) * model.outPerM) / 1_000_000;
}

async function callClaude(client, tier, params) {
  if (tier === "strong") {
    // Opus can hand a declined request to a fallback model server-side.
    return client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  }
  return client.messages.create(params); // Haiku has no server-side fallback
}

// The provider to use and its key, as chosen in Settings: { provider: "gemini" | "claude", geminiKey, claudeKey }.
export const providerLabel = (cfg, tier = "cheap") =>
  cfg.provider === "gemini" ? GEMINI_MODEL.label : MODELS[tier].label;

// One structured-output call (Gemini or Claude), with friendly errors.
// fast: small jobs (photo search, step tagging, tests) that need little thinking.
// quick: a single attempt with no retries, for "Test AI".
async function callStructured({ cfg, tier, system, schema, content, webFetch = false, effort, fast = false, quick = false }) {
  if (cfg.provider === "gemini") {
    // Gemini's free tier has one model; "try harder" just thinks harder.
    return geminiStructured({
      apiKey: cfg.geminiKey, system, schema, content, webFetch, quick,
      thinking: fast ? "minimal" : tier === "strong" ? "high" : "low",
    });
  }
  if (fast) effort = "low";
  const apiKey = cfg.claudeKey;
  if (!apiKey) throw new ImportError("Add your Anthropic API key in Settings to use AI features.");
  const model = MODELS[tier];
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const messages = [{ role: "user", content }];
  let cost = 0;
  let response;
  let toolTypes = webFetch ? [...WEB_FETCH_TYPES[tier]] : [];

  try {
    // Server-side tools (web fetch) can pause a long turn; resume it a few times.
    for (let i = 0; i < 5; i++) {
      const params = {
        model: model.id,
        max_tokens: 16000,
        system,
        output_config: {
          effort: effort || (tier === "strong" ? "medium" : "low"),
          format: { type: "json_schema", schema },
        },
        messages,
        ...(webFetch ? { tools: [webFetchTool(toolTypes[0])] } : {}),
      };
      try {
        response = await callClaude(client, tier, params);
      } catch (err) {
        // If this model doesn't accept this web fetch version, try the other one once.
        if (err instanceof Anthropic.BadRequestError && webFetch && toolTypes.length > 1 && /web_fetch|tool/i.test(err.message)) {
          toolTypes.shift();
          i--;
          continue;
        }
        throw err;
      }
      cost += costOf(response.usage, model);
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ImportError("Your Anthropic API key was rejected. Check it in Settings.");
    } else if (err instanceof Anthropic.PermissionDeniedError) {
      throw new ImportError("Your API key isn't allowed to do this. Check your Anthropic account.");
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new ImportError("Claude is rate limiting requests right now. Try again in a minute.");
    } else if (err instanceof Anthropic.APIConnectionError) {
      throw new ImportError("Couldn't reach Claude. Check your internet connection.");
    } else if (err instanceof Anthropic.APIError) {
      const msg = /credit balance/i.test(err.message)
        ? "Your Anthropic account is out of credit. Add some at console.anthropic.com."
        : `Claude API error (${err.status}): ${err.message}`;
      throw new ImportError(msg);
    }
    throw err;
  }

  if (response.stop_reason === "refusal") throw new ImportError("Claude declined to process this input.");
  if (response.stop_reason === "max_tokens") throw new ImportError("Claude's answer was cut off. Please try again.");
  if (response.stop_reason === "pause_turn") {
    throw new ImportError("Reading that page took too long. Try a screenshot or paste the text instead.");
  }

  // With tools in play there can be several text blocks; the structured JSON is the last one.
  const text = response.content.filter((b) => b.type === "text").at(-1)?.text;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("Claude's answer couldn't be read. Please try again.");
  }
  return { data, cost, model: model.label };
}

async function extract({ cfg, tier, content, webFetch = false, notFound }) {
  const { data: recipe, cost, model } = await callStructured({
    cfg, tier, system: SYSTEM, schema: RECIPE_SCHEMA, content, webFetch,
  });
  if (!recipe.found) {
    throw new ImportError(notFound || "Couldn't find a recipe in that. Try a different page, photo, or paste the text.");
  }
  delete recipe.found;
  return { recipe, cost, model };
}

export function extractFromUrl(cfg, tier, url) {
  return extract({
    cfg,
    tier,
    webFetch: true,
    content: [{ type: "text", text: `Fetch this recipe page and extract the recipe: ${url}` }],
    notFound: "Couldn't read a recipe from that page (some sites block automated reading). Try a screenshot or paste the text instead.",
  });
}

export function extractFromImages(cfg, tier, images) {
  return extract({
    cfg,
    tier,
    content: [
      ...images.map(({ mediaType, data }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })),
      { type: "text", text: "Extract the recipe from these photo(s)." },
    ],
  });
}

// Cooking videos (YouTube links, or a video file from TikTok/Instagram/the gallery). Gemini only:
// Claude can't watch video, so this uses the Gemini key even when Claude is the chosen provider.
export function extractFromVideo(cfg, tier, video) {
  if (!cfg.geminiKey) {
    throw new ImportError("Reading videos needs a free Gemini key (Claude can't watch video). Add one in Settings.");
  }
  const part = video.uri
    ? { type: "video", uri: video.uri }
    : { type: "video", data: video.data, mime_type: video.mimeType };
  return extract({
    cfg: { ...cfg, provider: "gemini" },
    tier,
    content: [part, { type: "text", text: "Watch this cooking video, including what's said and any on-screen text, and extract the recipe." }],
    notFound: "Couldn't find a recipe in that video.",
  });
}

export function extractFromText(cfg, tier, text) {
  return extract({
    cfg,
    tier,
    content: [{ type: "text", text: `${text}\n\nExtract the recipe from the text above.` }],
  });
}

// ---------- questions about a saved recipe (substitutions, swaps, tweaks) ----------
const AISLE_ENUM = RECIPE_SCHEMA.properties.ingredients.items.properties.aisle.enum;

const ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "ingredientChanges", "stepChanges", "noteToAdd"],
  properties: {
    answer: { type: "string", description: "Plain-language answer, 1-4 short sentences" },
    ingredientChanges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "number", "quantity", "unit", "name", "note", "aisle"],
        properties: {
          action: { type: "string", enum: ["replace", "add", "remove"] },
          number: { ...nullable("integer"), description: "Ingredient number from the list; null for add" },
          quantity: nullable("number"),
          unit: { type: "string" },
          name: { type: "string" },
          note: { type: "string" },
          aisle: { type: "string", enum: AISLE_ENUM },
        },
      },
    },
    stepChanges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "text", "timerMinutes"],
        properties: {
          number: { type: "integer", description: "Step number from the list" },
          text: { type: "string", description: "The full new text of that step" },
          timerMinutes: nullable("number"),
        },
      },
    },
    noteToAdd: { type: "string", description: "Short tip to add to the recipe notes, or ''" },
  },
};

const ASK_SYSTEM = `You are the cooking helper inside a personal recipe app. The user asks about one of their saved recipes: usually whether they can swap an ingredient, but also technique, equipment or timing questions.

- Answer briefly and practically, like a friend who cooks a lot. Plain language, no headings.
- If they want to swap or change something and it's a reasonable alternative, propose exact edits:
  - Convert amounts sensibly (e.g. 1 garlic clove ≈ 1 tsp jarred minced garlic; 1 tbsp fresh herbs ≈ 1 tsp dried).
  - Update every step whose wording or technique depends on the change (e.g. you don't pound jarred garlic; it burns faster, so add it later). Give the full new text for each changed step, keeping the "Title: text" style if the step uses it. Keep or adjust its timer.
  - Use "replace" to swap an ingredient in place, "add"/"remove" only when needed.
- If it's a poor substitute, say why, suggest a better option, and propose no edits.
- For questions that don't change the recipe, propose no edits. Never touch unrelated ingredients or steps.
- Keep units short (tsp, tbsp, cup, g, kg, ml, l, clove, can).`;

function recipeAsText(r) {
  const ings = r.ingredients
    .map((i, n) => `${n + 1}. ${[i.quantity, i.unit, i.name].filter((x) => x !== null && x !== "").join(" ")}${i.note ? ` (${i.note})` : ""}`)
    .join("\n");
  const steps = r.steps
    .map((s, n) => `${n + 1}. ${s.text}${s.timerMinutes ? ` [timer: ${s.timerMinutes} min]` : ""}`)
    .join("\n");
  return `Recipe: ${r.title}${r.servings ? ` (serves ${r.servings})` : ""}\n\nIngredients:\n${ings}\n\nSteps:\n${steps}${r.notes ? `\n\nNotes:\n${r.notes}` : ""}`;
}

export async function askAboutRecipe(cfg, recipe, question) {
  const { data, cost, model } = await callStructured({
    cfg,
    tier: "cheap",
    effort: "medium",
    system: ASK_SYSTEM,
    schema: ASK_SCHEMA,
    content: [{ type: "text", text: `${recipeAsText(recipe)}\n\nMy question: ${question}` }],
  });
  return { ...data, cost, model };
}

// ---------- finding a cover photo ----------
// Uses Gemini when there's a key (free), even if Claude is the chosen provider.
const photoCfg = (cfg) => (cfg.geminiKey ? { ...cfg, provider: "gemini" } : cfg);

const QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: { queries: { type: "array", items: { type: "string" } } },
};

export async function photoQueries(cfg, recipe) {
  const { data, cost } = await callStructured({
    cfg: photoCfg(cfg),
    tier: "cheap",
    fast: true,
    system: "You write photo-library search phrases for dishes. Return 3 short phrases (1-3 words each), most specific first, using the dish's common name as people would tag a food photo (e.g. 'pad kra pao', 'thai basil pork', 'basil stir fry'). For sauces, dips, marinades or drinks, search for the thing itself. English, lowercase, no brand names.",
    schema: QUERY_SCHEMA,
    content: [{ type: "text", text: `Dish: ${recipe.title}\n${recipe.description || ""}\nMain ingredients: ${(recipe.ingredientNames || recipe.ingredients?.map((i) => i.name) || []).slice(0, 8).join(", ")}` }],
  });
  return { queries: data.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, 3), cost };
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["photo"],
  properties: {
    photo: { ...nullable("integer"), description: "Number of the best photo, or null if none clearly shows this dish" },
  },
};

// thumbs: [{ mediaType, data }] small previews, in candidate order.
export async function pickPhoto(cfg, recipe, thumbs) {
  const content = [];
  thumbs.forEach((t, n) => {
    content.push({ type: "text", text: `Photo ${n + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: t.mediaType, data: t.data } });
  });
  content.push({ type: "text", text: `Which photo best shows "${recipe.title}" as a finished dish, appetising and clearly that food? Prefer close-ups of the food over menus, people or packaging. Answer null if none really fits.` });
  const { data, cost } = await callStructured({
    cfg: photoCfg(cfg),
    tier: "cheap",
    fast: true,
    system: "You choose cover photos for recipes in a personal recipe app.",
    schema: PICK_SCHEMA,
    content,
  });
  const n = data.photo;
  return { index: Number.isInteger(n) && n >= 1 && n <= thumbs.length ? n - 1 : null, cost };
}

// ---------- which ingredients each step uses (for recipes saved before steps were tagged) ----------
const LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "ingredients"],
        properties: {
          step: { type: "integer" },
          ingredients: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

// Returns { links: Map(stepIndex -> [ingredientIndex]), cost }.
export async function linkStepIngredients(cfg, recipe) {
  const { data, cost } = await callStructured({
    cfg: photoCfg(cfg),
    tier: "cheap",
    fast: true,
    system: "You annotate recipes for a cooking app. For every step, list the numbers of the ingredients that step adds or uses, so the cook can see them right at that step. Don't repeat ingredients already combined in an earlier step (\"pour in the sauce\" doesn't list the sauce's ingredients again). A step that uses none gets an empty list.",
    schema: LINK_SCHEMA,
    content: [{ type: "text", text: recipeAsText(recipe) }],
  });
  const links = new Map();
  for (const s of data.steps || []) {
    const ings = (s.ingredients || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= recipe.ingredients.length).map((n) => n - 1);
    if (Number.isInteger(s.step) && s.step >= 1 && s.step <= recipe.steps.length) links.set(s.step - 1, ings);
  }
  return { links, cost };
}

// "Test AI" in Settings: one tiny request to the selected provider, no retries.
export async function testAI(cfg) {
  const { data, model } = await callStructured({
    cfg, tier: "cheap", fast: true, quick: true,
    system: "Reply with three short search phrases for the dish.",
    schema: QUERY_SCHEMA,
    content: [{ type: "text", text: "Dish: Spaghetti Bolognese" }],
  });
  return { reply: (data.queries || []).join(", "), model };
}

// Cheap call used by Settings to check that a key works.
export async function testKey(apiKey) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
  try {
    await client.models.retrieve(MODELS.cheap.id);
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return "That key was rejected. Double-check you copied all of it.";
    if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection.";
    if (err instanceof Anthropic.APIError) return `Anthropic said: ${err.message}`;
    return String(err.message || err);
  }
}
