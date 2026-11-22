/**
 * In memory: the owed-cancel scenarios (`owed-cancel-scenarios.ts`). The same
 * scenarios run on SQLite and Postgres in `sqlite8-kernel-concurrency.test.ts`.
 */

import { describe } from "vitest";
import { owedCancelScenarios } from "../utils/owed-cancel-scenarios.js";

describe("provider batches owed a cancel, and those of rows a redrive deletes", () => {
  owedCancelScenarios(() => undefined);
});
