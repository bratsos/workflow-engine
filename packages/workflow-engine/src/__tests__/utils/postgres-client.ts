import { createRequire } from "node:module";
import { fromPrisma8 } from "../../persistence/prisma/index.js";

/** True when the suites run on Prisma 8 (PRISMA_MAJOR=8). */
export const isPrisma8 = process.env.PRISMA_MAJOR === "8";

/**
 * The Postgres client of the Prisma major under test (PRISMA_MAJOR, default 7):
 * the fixture's generated client on 6 and 7, `fromPrisma8` over its raw client
 * on 8, with the `$disconnect` the suites call.
 */
export function createPostgresClient(url: string): any {
  const fixture = createRequire(import.meta.url)(
    "../../../../prisma-fixtures/index.cjs",
  );
  if (!isPrisma8) return fixture.createPostgresClient(url);
  const db = fixture.createPostgresDb(url);
  return Object.assign(fromPrisma8(db), { $disconnect: () => db.close() });
}
