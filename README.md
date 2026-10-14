# Recipe Book

A recipe book that lives on your Android phone. Claude reads recipes from links, photos (cookbook
pages, handwritten cards, screenshots) or pasted text and turns them into ingredients, steps and timers.

There's no server and nothing to keep running. The app files are hosted for free on GitHub Pages.
Your recipes are stored on the phone, and AI imports go straight from the phone to Claude using your
own API key.

## Using it

- **Import**: tap *Import* and choose Link, Photo or Text, or use *Share → Recipe Book* from Chrome
  or your gallery. You review everything before saving.
  - Normal imports use Claude Haiku 5.5 and cost well under 1¢.
  - *Try harder* re-reads one import with Claude Opus 5.5 (about 5–10¢).
  - *Quick parse* on pasted text is free and works offline.
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
- `web/ai.js`: Claude calls. This is the single place to swap in a server later if the app grows beyond one user.
- `web/parse.js`: the free text parser
- `web/vendor/anthropic-sdk.js`: bundled Anthropic SDK (`npm run build:sdk` to rebuild)
