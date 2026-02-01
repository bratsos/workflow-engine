/**
 * Prisma Enum Compatibility Layer
 *
 * Provides compatibility between Prisma 6.x (string enums) and Prisma 7.x (typed enums).
 * Prisma 7.x introduced runtime enum validation, requiring actual enum values instead of strings.
 *
 * This utility resolves enum values from the Prisma client's $Enums property when available,
 * falling back to string values for older Prisma versions.
 *
 * @example
 * ```typescript
 * const helper = createEnumHelper(prisma);
 *
 * // Instead of: status: "PENDING"
 * // Use: status: helper.status("PENDING")
 * ```
 */

type PrismaClient = any;

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
 * Supports both Prisma 6.x (returns string) and Prisma 7.x (returns typed enum).
 */
export function createEnumHelper(prisma: PrismaClient): PrismaEnumHelper {
  const resolveEnum = (enumName: string, value: string): unknown => {
    try {
      // Prisma 7.x exposes enums via $Enums
      const enumObj = prisma.$Enums?.[enumName];
      if (enumObj && value in enumObj) {
        return enumObj[value];
      }
    } catch {
      // Ignore - fall through to string
    }
    // Fallback for Prisma 6.x or if enum not found
    return value;
  };

  return {
    status: (value: string) => resolveEnum("Status", value),
    artifactType: (value: string) => resolveEnum("ArtifactType", value),
    logLevel: (value: string) => resolveEnum("LogLevel", value),
  };
}
