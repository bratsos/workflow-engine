/**
 * Test helpers: an in-memory `ConsoleReadPort` over plain fixtures, so the
 * handler and the UI can be exercised without a database.
 */
export {
  type ConsoleFixtures,
  createInMemoryConsoleReadPort,
  InMemoryConsoleReadPort,
  type InMemoryConsoleReadPortOptions,
} from "./in-memory-read-port";
