# Recipe Book

A recipe book that lives on your phone (Android, or iPhone via Safari → Add to Home Screen). AI (free Gemini, or Claude) reads recipes from links, photos (cookbook
pages, handwritten cards, screenshots) or pasted text and turns them into ingredients, steps and timers.

There's no server and nothing to keep running. The app files are hosted for free on GitHub Pages.
Your recipes are stored on the phone, and AI requests go straight from the phone to the AI you pick
in Settings, using your own key:

- **Gemini (free, default)**: Google's free tier, `gemini-3.8-flash`. Get a key at aistudio.google.com/apikey.
- **Claude (paid)**: Claude Haiku 5.5 for imports and questions, Opus 5.5 for "Try harder".

## Using it

- **Import**: tap *Import* and choose Link, Photo/Video or Text, or use *Share → Recipe Book* from
  Chrome, YouTube or your gallery. You review everything before saving.
  - YouTube links (including Shorts) and video files are watched by Gemini, sound and on-screen text
    included. TikTok/Instagram block apps from reading their links: save the video, then share the file.
  - When the source gives no amount ("a splash"), the AI fills in a sensible one and marks it **≈**.
  - With Gemini everything is free; *Try harder* re-reads with more thinking.
  - With Claude, imports cost well under 1¢ and *Try harder* uses Opus (about 5–10¢).
  - *Quick parse* on pasted text is free and works offline.
- **Ask AI** (on every recipe, or ⇄ next to an ingredient): ask about substitutions or technique;
  if a swap works it proposes exact edits, which you can apply and undo.
- **Photos**: recipes without a photo get one automatically: the AI writes search phrases, free openly
  licensed photos come from Openverse, and the AI picks the one that best shows the dish. Use
  *Change photo* on a recipe to pick another or use your own.
- **Cooking**: tap steps to mark them done. Step timers beep, and the screen stays awake.
- **Ingredients** (top-right button): scale servings, tick what you have, pick where to buy each item
  (remembered next time), and add items to the shopping list.
- **Shopping list**: grouped by store, quantities merge across recipes, share the list.
- **Settings**: your API key, an estimate of what you've spent, and backup/restore.

## Back up your recipes

Recipes exist only on the phone. Use **Settings → Save backup** now and then and save the file to
Google Drive. If you clear Chrome's data, uninstall the app or lose the phone, restoring that file
is the only way to get them back.

## Developing

```bash
npm start
```

Serves `web/` at http://localhost:3000. Pushing to `main` publishes `web/` to GitHub Pages via
`.github/workflows/deploy.yml`. After changing app files, bump `VERSION` in `web/sw.js` so installed
copies update.

- `web/app.js`: screens
- `web/localapi.js`: data operations on the phone (IndexedDB via `web/store.js`)
- `web/ai.js`: AI calls (prompts, schemas, Claude). This is the single place to swap in a server later if the app grows beyond one user.
- `web/gemini.js`: the Gemini provider
- `web/photos.js`: photo search (Openverse) and download
- `web/parse.js`: the free text parser
- `web/vendor/anthropic-sdk.js`: bundled Anthropic SDK (`npm run build:sdk` to rebuild)
