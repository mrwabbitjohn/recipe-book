// Bundles the Anthropic SDK into one browser file (web/vendor/anthropic-sdk.js),
// so the app needs no build step and works offline. Re-run after updating the SDK.
import { build } from "esbuild";

await build({
  stdin: { contents: 'export { default } from "@anthropic-ai/sdk";', resolveDir: process.cwd(), loader: "js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "inline",
  outfile: "web/vendor/anthropic-sdk.js",
});
console.log("Wrote web/vendor/anthropic-sdk.js");
