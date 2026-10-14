// Free, offline recipe parser for pasted text. Less clever than Claude, but costs nothing.

const UNICODE_FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

// Accepts "1.5", "1 1/2", "½", "1½"
export function parseQty(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let total = 0;
  for (const part of s.replace(/(\d)([¼½¾⅓⅔⅛⅜⅝⅞])/g, "$1 $2").split(/\s+/)) {
    if (UNICODE_FRACTIONS[part]) total += UNICODE_FRACTIONS[part];
    else if (/^\d+\/\d+$/.test(part)) {
      const [a, b] = part.split("/").map(Number);
      total += b ? a / b : 0;
    } else if (part !== "" && !isNaN(Number(part))) total += Number(part);
    else return null;
  }
  return Math.round(total * 1000) / 1000;
}

const UNITS = {
  cup: /^(cups?|c\.?)$/i, tbsp: /^(tbsps?\.?|tablespoons?|tbs\.?|T)$/, tsp: /^(tsps?\.?|teaspoons?|t)$/,
  g: /^(g|grams?|gr)$/i, kg: /^(kgs?|kilograms?)$/i, ml: /^(ml|milliliters?|millilitres?)$/i,
  l: /^(l|liters?|litres?)$/i, oz: /^(oz\.?|ounces?)$/i, lb: /^(lbs?\.?|pounds?)$/i,
  clove: /^cloves?$/i, can: /^cans?$/i, pinch: /^pinch(es)?$/i, dash: /^dash(es)?$/i,
  slice: /^slices?$/i, stick: /^sticks?$/i, bunch: /^bunch(es)?$/i, package: /^(packages?|pkgs?\.?|packs?)$/i,
  sprig: /^sprigs?$/i, handful: /^handfuls?$/i, piece: /^pieces?$/i,
};

// Order matters: the first match wins ("chicken stock" is Pantry, "frozen peas" is Frozen).
const AISLES = [
  ["Pantry", /\b(stock|broth|sauce|paste|canned|tinned|diced tomato(es)?|coconut milk|condensed milk|evaporated milk|cornflour|flour|baked beans|beanz)\b/i],
  ["Frozen", /\b(frozen|ice)\b/i],
  ["Meat & Seafood", /\b(chicken|beef|pork|lamb|turkey|bacon|sausages?|ham|steaks?|fillets?|striploin|sirloin|scotch|tri-tip|brisket|ribs?|belly|mince|fish|salmon|tuna|shrimp|prawns?|cod)\b/i],
  ["Dairy & Eggs", /\b(milk|cream|butter|cheese|yogh?urt|eggs?|yolks?|parmesan|mozzarella|cheddar|ricotta|sour cream)\b/i],
  ["Spices", /\b(salt|pepper|peppercorns|cumin|paprika|cinnamon|oregano|thyme|rosemary|chil(l)?i (flakes|powder)|curry powder|five-spice|nutmeg|turmeric|spice|seasoning|bay lea)/i],
  ["Pantry", /\b(sugar|honey|rice|pasta|spaghetti|penne|noodles|oil|vinegar|soy|mustard|worcestershire|beans|lentils|oats|syrup|baking|vanilla|cocoa|chocolate|nuts?|yeast)\b/i],
  ["Produce", /\b(onions?|garlic|tomato(es)?|potato(es)?|carrots?|celery|lettuce|spinach|peppers?|capsicums?|chil(l)?ies|lemons?|limes?|apples?|bananas?|berries|herbs?|parsley|cilantro|coriander|basil|ginger|mushrooms?|zucchini|cucumber|avocado|scallions?|spring onions?|shallots?|kale|broccoli|corn)\b/i],
  ["Bakery", /\b(bread|buns?|rolls?|tortillas?|pita|baguette|naan|brioche)\b/i],
  ["Drinks", /\b(wine|beer|soda|sprite|juice)\b/i],
];

const guessAisle = (name) => AISLES.find(([, re]) => re.test(name))?.[0] || "Other";

const ING_HEADER = /^(ingredients?|you will need|what you need)\s*:?$/i;
const STEP_HEADER = /^(directions?|instructions?|method|steps|preparation|how to make( it)?)\s*:?$/i;
const NOTES_HEADER = /^(notes?|tips?|storage)\s*:?$/i;
const QTY_START = /^(\d|[¼½¾⅓⅔⅛⅜⅝⅞]|a |an |one |two |three |pinch)/i;

const cleanLine = (l) => l.replace(/^[\s\-•*▢□✓☐◦·–—]+/, "").trim();

export function parseIngredient(line) {
  let s = cleanLine(line);
  let note = "";
  const paren = s.match(/\(([^)]*)\)/);
  if (paren) {
    note = paren[1];
    s = s.replace(paren[0], " ").replace(/\s+/g, " ").trim();
  }
  const comma = s.indexOf(",");
  if (comma > 0) {
    note = [s.slice(comma + 1).trim(), note].filter(Boolean).join("; ");
    s = s.slice(0, comma).trim();
  }

  let quantity = null;
  // Quantity, allowing ranges like "1-2" (keep the lower bound, mention the range).
  const qm = s.match(/^((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?\s*[¼½¾⅓⅔⅛⅜⅝⅞]?|[¼½¾⅓⅔⅛⅜⅝⅞])(\s*(?:-|–|to)\s*[\d.\/¼½¾⅓⅔⅛]+)?\s*/);
  if (qm) {
    quantity = parseQty(qm[1]);
    if (qm[2]) note = [`${qm[1].trim()}${qm[2].trim()}`, note].filter(Boolean).join("; ");
    s = s.slice(qm[0].length);
  } else if (/^(a|an|one)\s/i.test(s)) {
    quantity = 1;
    s = s.replace(/^(a|an|one)\s+/i, "");
  }

  let unit = "";
  const firstWord = s.split(/\s+/)[0] || "";
  for (const [u, re] of Object.entries(UNITS)) {
    if (re.test(firstWord)) {
      unit = u;
      if (quantity == null && /^(pinch|dash|handful)$/.test(u)) quantity = 1;
      s = s.slice(firstWord.length).trim().replace(/^of\s+/i, "");
      break;
    }
  }
  const name = s.trim() || cleanLine(line);
  if (/to taste/i.test(name)) {
    return { section: "", quantity: null, unit: "", name: name.replace(/,?\s*to taste/i, "").trim(), note: "to taste", aisle: guessAisle(name) };
  }
  return { section: "", quantity, unit, name, note, aisle: guessAisle(name) };
}

function timerFrom(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|minutes?|mins?)\b/i);
  if (!m) return null;
  const n = Number(m[2] || m[1]); // use the upper end of a range so you check, not overcook
  return /^h/i.test(m[3]) ? n * 60 : n;
}

function minutesAfter(label, text) {
  const m = text.match(new RegExp(`${label}[^\\d\\n]{0,15}(\\d+)\\s*(hours?|hrs?|minutes?|mins?)`, "i"));
  if (!m) return null;
  return /^h/i.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
}

export function parseRecipeText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const recipe = {
    title: "", description: "", servings: null, prepMinutes: null, cookMinutes: null, totalMinutes: null,
    tags: [], ingredients: [], steps: [], notes: "", image: null, source: "Pasted text",
  };
  if (!lines.length) return recipe;

  const servings = text.match(/\b(?:serves|servings|yield|makes)\s*:?\s*(\d+)/i);
  if (servings) recipe.servings = Number(servings[1]);
  recipe.prepMinutes = minutesAfter("prep(?:aration)?(?: time)?", text);
  recipe.cookMinutes = minutesAfter("cook(?:ing)?(?: time)?", text);
  recipe.totalMinutes = minutesAfter("total(?: time)?", text);

  let mode = "intro";
  const intro = [];
  const notes = [];
  let section = "";
  const sawHeaders = lines.some((l) => ING_HEADER.test(l)) || lines.some((l) => STEP_HEADER.test(l));

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (ING_HEADER.test(line)) { mode = "ing"; continue; }
    if (STEP_HEADER.test(line)) { mode = "steps"; continue; }
    if (NOTES_HEADER.test(line)) { mode = "notes"; continue; }
    if (/^(serves|servings|yield|makes|prep|cook|total)\b.*\d/i.test(line) && line.length < 60) continue;

    if (!sawHeaders && mode !== "notes") {
      // No headings: short lines starting with a quantity are ingredients, sentences are steps.
      if (QTY_START.test(line) && line.length < 80) mode = "ing";
      else if (recipe.title && (line.length > 60 || /^(\d+[.)]|step\s*\d)/i.test(line))) mode = "steps";
    }

    if (mode === "intro") {
      if (!recipe.title && line.length < 90) recipe.title = line;
      else intro.push(line);
    } else if (mode === "ing") {
      if (/:$/.test(line) && line.length < 40) {
        section = line.slice(0, -1);
        continue;
      }
      recipe.ingredients.push({ ...parseIngredient(line), section });
    } else if (mode === "steps") {
      const stepText = line.replace(/^(step\s*)?\d+\s*[.):-]?\s+/i, "").trim();
      if (stepText) recipe.steps.push({ text: stepText, timerMinutes: timerFrom(stepText) });
    } else {
      notes.push(line);
    }
  }

  recipe.title ||= "Untitled recipe";
  recipe.description = intro.join(" ").slice(0, 300);
  recipe.notes = notes.join("\n");
  return recipe;
}
