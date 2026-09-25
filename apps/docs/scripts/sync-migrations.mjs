/**
 * Copies the migration guides that the site publishes verbatim from the
 * agent skill, which is their single source, into docs/migrations/.
 *
 * The copies are generated (and gitignored) so the site can never drift
 * from the guide the package ships. The older guides on the site are
 * hand-written summaries of theirs and are left alone. Relative links to
 * the skill's reference files do not exist on the site, so they are
 * rewritten to the files on GitHub.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(
  here,
  "../../../packages/workflow-engine/skills/workflow-engine/migrations",
);
const target = join(here, "../docs/migrations");
const referencesOnGitHub =
  "https://github.com/bratsos/workflow-engine/blob/main/packages/workflow-engine/skills/workflow-engine/references/";

/** Guides the site publishes as-is from the skill. */
export const GENERATED_GUIDES = [
  "migrate-0.11-to-0.12.md",
  "migrate-0.12-to-0.13.md",
  "migrate-0.13-to-1.0.md",
];

for (const name of GENERATED_GUIDES) {
  const markdown = readFileSync(join(source, name), "utf8").replace(
    /\]\(\.\.\/references\/([^)]+)\)/g,
    (_match, path) => `](${referencesOnGitHub}${path})`,
  );
  const banner = `<!-- Generated from packages/workflow-engine/skills/workflow-engine/migrations/${name} by apps/docs/scripts/sync-migrations.mjs. Edit the source, not this file. -->\n\n`;
  writeFileSync(join(target, name), banner + markdown);
}

console.log(`Synced ${GENERATED_GUIDES.length} migration guides from the skill.`);
