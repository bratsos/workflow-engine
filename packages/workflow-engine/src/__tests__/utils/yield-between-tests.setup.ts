import { afterEach } from "vitest";
import { yieldToHost } from "./yield-to-host.js";

// Files of fast SQLite tests run as one stretch of microtasks; end it per test.
afterEach(yieldToHost);
