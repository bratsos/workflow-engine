import { createRequire } from "node:module";

/** True when the suites run on Prisma 8 (PRISMA_MAJOR=8). */
export const isPrisma8 = process.env.PRISMA_MAJOR === "8";

// The engine is reached through vitest's alias to its source. The specifier is
// a variable so `tsc` does not pull that source into this package's typecheck.
const engine = "@bratsos/workflow-engine/persistence";
const fromPrisma8 = isPrisma8 ? (await import(engine)).fromPrisma8 : undefined;

/**
 * The Postgres client of the Prisma major under test (PRISMA_MAJOR, default 7):
 * the fixture's generated client on 6 and 7, `fromPrisma8` over its raw client
 * on 8, with the `$disconnect` the suites call.
 */
export function createPostgresClient(url: string): any {
  const fixture = createRequire(import.meta.url)(
    "../../../prisma-fixtures/index.cjs",
  );
  if (!fromPrisma8) return fixture.createPostgresClient(url);
  const db = fixture.createPostgresDb(url);
  return Object.assign(fromPrisma8(db), { $disconnect: () => db.close() });
}
