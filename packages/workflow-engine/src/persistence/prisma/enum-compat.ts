/**
 * Prisma Enum Compatibility Layer
 *
 * Resolves enum values from the Prisma client's $Enums property when a client
 * exposes one, and falls back to the plain string otherwise.
 *
 * Neither Prisma 6 nor 7 puts `$Enums` on a client instance (it is a
 * module-level export of the generated client), so with those clients this
 * always returns the string. Both majors accept the string, and the
 * values are identical.
 *
 * @example
 * ```typescript
 * const helper = createEnumHelper(prisma);
 *
 * // Instead of: status: "PENDING"
 * // Use: status: helper.status("PENDING")
 * ```
 */

import type { EnginePrismaClient } from "./prisma-client-type";

// Structural client type -- see prisma-client-type.ts. Only `$Enums` is
// used here, but the full structural type is accepted so callers (and
// createEnumHelper's own callers, which share one `prisma` instance
// across several adapters) don't need a second, narrower client type.
type PrismaClient = EnginePrismaClient;

export interface PrismaEnumHelper {
  /** Resolve Status enum value (unified enum for workflows, stages, and jobs) */
  status(value: string): unknown;
  /** Resolve ArtifactType enum value */
  artifactType(value: string): unknown;
  /** Resolve LogLevel enum value */
  logLevel(value: string): unknown;
}

/**
 * Creates an enum helper that resolves enum values from the Prisma client.
 *
 * Returns the enum object's value when the client has `$Enums`, else the string.
 */
export function createEnumHelper(
  prisma: PrismaClient,
  options: { statusEnumName?: string } = {},
): PrismaEnumHelper {
  const statusEnumName = options.statusEnumName ?? "Status";
  const resolveEnum = (enumName: string, value: string): unknown => {
    try {
      // A client that exposes its enums via $Enums (Prisma 6 and 7 do not)
      const enumObj = prisma.$Enums?.[enumName];
      if (enumObj && value in enumObj) {
        return enumObj[value];
      }
    } catch {
      // Ignore - fall through to string
    }
    // The string, which is what Prisma 6 and 7 clients take
    return value;
  };

  return {
    status: (value: string) => resolveEnum(statusEnumName, value),
    artifactType: (value: string) => resolveEnum("ArtifactType", value),
    logLevel: (value: string) => resolveEnum("LogLevel", value),
  };
}
