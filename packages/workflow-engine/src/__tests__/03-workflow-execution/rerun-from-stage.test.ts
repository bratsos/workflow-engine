/**
 * Rerun From Stage Tests (Kernel)
 *
 * Tests for the ability to rerun a workflow starting from a specific stage.
 * All tests are skipped pending implementation of run.rerunFrom kernel command.
 */

import { describe, it } from "vitest";

describe("I want to rerun a workflow from a specific stage", () => {
  describe("basic rerun functionality", () => {
    it.skip("TODO: needs run.rerunFrom kernel command — should rerun from stage 3 after a complete run, skipping stages 1 and 2", () => {});

    it.skip("TODO: needs run.rerunFrom kernel command — should rerun from stage 2 and execute stages 2, 3, 4", () => {});

    it.skip("TODO: needs run.rerunFrom kernel command — should rerun from stage 1 (first stage) using workflow input", () => {});
  });

  describe("error handling", () => {
    it.skip("TODO: needs run.rerunFrom kernel command — should throw error when stage does not exist", () => {});

    it.skip("TODO: needs run.rerunFrom kernel command — should throw error when previous stages have not been executed", () => {});
  });

  describe("workflow context", () => {
    it.skip("TODO: needs run.rerunFrom kernel command — should have access to previous stage outputs in workflowContext", () => {});
  });

  describe("stage records cleanup", () => {
    it.skip("TODO: needs run.rerunFrom kernel command — should delete stage records for rerun stages", () => {});
  });
});
