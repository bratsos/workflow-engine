import { UI_CSS, UI_CSS_NAME, UI_JS, UI_JS_NAME } from "./generated/ui-bundle";
import type { ConsoleCapabilities } from "./read-port";

export interface UiAsset {
  body: string;
  contentType: string;
}

/**
 * The prebuilt UI, keyed by the filename the document asks for. Names carry
 * a content hash, so these are safe to serve `immutable`.
 */
export const UI_ASSETS: Record<string, UiAsset> = {
  [UI_JS_NAME]: {
    body: UI_JS,
    contentType: "application/javascript; charset=utf-8",
  },
  [UI_CSS_NAME]: { body: UI_CSS, contentType: "text/css; charset=utf-8" },
};

export interface IndexHtmlOptions {
  basePath: string;
  readOnly: boolean;
  pollIntervalMs: number;
  forcePollInterval: boolean;
  capabilities: ConsoleCapabilities;
  nonce?: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * `</script>` inside a JSON island would end the block early; escaping the
 * slash keeps the JSON valid and the document intact.
 */
function escapeJsonForScript(value: string): string {
  return value.replace(/</g, "\\u003c");
}

/**
 * The console's entry document.
 *
 * Configuration is embedded in the page rather than fetched, so the SPA
 * boots already knowing its mount path, its read-only state and which views
 * this reader can serve — no round trip, and no flash of a tab that is
 * about to disappear. The mount path is a runtime value on purpose: baking
 * it in at build time, as pg-boss's dashboard does, means a consumer cannot
 * move where the console is mounted without rebuilding it.
 */
export function renderIndexHtml(options: IndexHtmlOptions): string {
  const config = escapeJsonForScript(
    JSON.stringify({
      basePath: options.basePath,
      readOnly: options.readOnly,
      pollIntervalMs: options.pollIntervalMs,
      forcePollInterval: options.forcePollInterval,
      capabilities: options.capabilities,
    }),
  );
  const nonce =
    options.nonce === undefined ? "" : ` nonce="${escapeHtml(options.nonce)}"`;
  const base = escapeHtml(options.basePath);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Workflow console</title>
<link rel="stylesheet" href="${base}/assets/${UI_CSS_NAME}">
</head>
<body>
<div id="workflow-console"></div>
<script type="application/json" id="workflow-console-config"${nonce}>${config}</script>
<script src="${base}/assets/${UI_JS_NAME}"${nonce} defer></script>
</body>
</html>
`;
}
