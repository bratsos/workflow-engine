import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { isInvokedAsBin } from "../../cli/codemod";

const distFile = resolve(
  fileURLToPath(new URL("../../../dist/cli/codemod.js", import.meta.url)),
);

describe("codemod bin entry symlink support", () => {
  it("recognizes invocation when argv[1] is a symlink to import.meta.url target", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "we-codemod-guard-"));
    const originalArgv1 = process.argv[1];
    try {
      const realFile = join(tempDir, "real-script.js");
      const symlinkFile = join(tempDir, "symlink-script.js");
      writeFileSync(realFile, "// real script", "utf8");
      symlinkSync(realFile, symlinkFile);

      process.argv[1] = symlinkFile;
      expect(isInvokedAsBin(pathToFileURL(realFile).href)).toBe(true);

      const otherFile = join(tempDir, "other-script.js");
      writeFileSync(otherFile, "// other script", "utf8");
      expect(isInvokedAsBin(pathToFileURL(otherFile).href)).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(distFile))(
    "runs built codemod binary through a symlink without silently exiting 0",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "we-codemod-symlink-"));
      try {
        const symlinkPath = join(tempDir, "codemod-link.js");
        symlinkSync(distFile, symlinkPath);

        let output = "";
        try {
          output = execFileSync(
            process.execPath,
            [symlinkPath, "--from", "0.11.0", tempDir],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
        } catch (error: unknown) {
          const execError = error as { stdout?: string; stderr?: string };
          output = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        }

        expect(output.trim().length).toBeGreaterThan(0);
        const mentionsInvalidFrom = /invalid --from/i.test(output);
        const printsReport = /workflow-engine-codemod/i.test(output);
        expect(mentionsInvalidFrom || printsReport).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
