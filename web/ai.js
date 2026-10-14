// Claude-powered recipe extraction, called straight from the phone with the user's own API key.
// All AI calls go through extract(); a server-side proxy could replace it later without touching the UI.
import Anthropic from "./vendor/anthropic-sdk.js";

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
        required: ["section", "quantity", "unit", "name", "note", "aisle"],
        properties: {
          section: { type: "string", description: 'Group heading like "Sauce", or "" if none' },
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
        required: ["text", "timerMinutes"],
        properties: {
          text: { type: "string" },
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

- Copy the recipe faithfully. Do not invent ingredients, quantities or steps that aren't in the source.
- Ignore ads, life stories, comments and navigation on webpages.
- Quantities are numbers: "1 1/2" -> 1.5, "½" -> 0.5. Ranges use the lower bound and mention the range in the note. "to taste" -> quantity null.
- Keep units short (tsp, tbsp, cup, g, kg, ml, l, oz, lb, clove, can) or "" for countable items ("2 eggs").
- Split steps into one clear action group each. Keep the original wording where reasonable.
- For handwritten cards or photos of cookbook pages, read carefully; combine multiple photos into one recipe.
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

async function extract({ apiKey, tier, content, webFetch = false, notFound }) {
  if (!apiKey) throw new ImportError("Add your Anthropic API key in Settings to use AI import.");
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
        system: SYSTEM,
        output_config: {
          effort: tier === "strong" ? "medium" : "low",
          format: { type: "json_schema", schema: RECIPE_SCHEMA },
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
  if (response.stop_reason === "max_tokens") throw new ImportError("That recipe was too long to finish reading.");
  if (response.stop_reason === "pause_turn") {
    throw new ImportError("Reading that page took too long. Try a screenshot or paste the text instead.");
  }

  // With tools in play there can be several text blocks; the structured JSON is the last one.
  const text = response.content.filter((b) => b.type === "text").at(-1)?.text;
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch {
    throw new ImportError("Claude's answer couldn't be read. Please try again.");
  }
  if (!recipe.found) {
    throw new ImportError(notFound || "Couldn't find a recipe in that. Try a different page, photo, or paste the text.");
  }
  delete recipe.found;
  return { recipe, cost, model: model.label };
}

export function extractFromUrl(apiKey, tier, url) {
  return extract({
    apiKey,
    tier,
    webFetch: true,
    content: [{ type: "text", text: `Fetch this recipe page and extract the recipe: ${url}` }],
    notFound: "Couldn't read a recipe from that page (some sites block automated reading). Try a screenshot or paste the text instead.",
  });
}

export function extractFromImages(apiKey, tier, images) {
  return extract({
    apiKey,
    tier,
    content: [
      ...images.map(({ mediaType, data }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })),
      { type: "text", text: "Extract the recipe from these photo(s)." },
    ],
  });
}

export function extractFromText(apiKey, tier, text) {
  return extract({
    apiKey,
    tier,
    content: [{ type: "text", text: `${text}\n\nExtract the recipe from the text above.` }],
  });
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
