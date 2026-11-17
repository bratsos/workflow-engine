export const WORKFLOW_ENGINE_TAG_PREFIX = "@bratsos/workflow-engine@";

export function releaseTagName(label: string): string {
  return `${WORKFLOW_ENGINE_TAG_PREFIX}${label}`;
}

export function selectSnapshotLabel(
  packageVersion: string,
  releaseTagExists: (tag: string) => boolean,
): string {
  return releaseTagExists(releaseTagName(packageVersion))
    ? `${packageVersion}+next`
    : packageVersion;
}

export function assertSnapshotWritable(
  label: string,
  path: string,
  releaseTagExists: (tag: string) => boolean,
  snapshotExists: (path: string) => boolean,
): void {
  const tag = releaseTagName(label);
  if (releaseTagExists(tag) && snapshotExists(path)) {
    throw new Error(
      `Refusing to overwrite ${path}: release tag "${tag}" exists, so released snapshots are immutable. Capture an unreleased shape under a new label.`,
    );
  }
}

interface ParsedLabel {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string> | undefined;
  next: boolean;
}

function parseLabel(label: string): ParsedLabel {
  const match = label.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(\+next)?$/,
  );
  if (!match)
    throw new Error(`Unsupported stored-row snapshot label: ${label}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ?.split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
    next: Boolean(match[5]),
  };
}

export function compareSnapshotLabels(left: string, right: string): number {
  const a = parseLabel(left);
  const b = parseLabel(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease === undefined && b.prerelease !== undefined) return 1;
  if (a.prerelease !== undefined && b.prerelease === undefined) return -1;
  if (a.prerelease && b.prerelease) {
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index++) {
      const leftPart = a.prerelease[index];
      const rightPart = b.prerelease[index];
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      if (leftPart === rightPart) continue;
      if (typeof leftPart === "number" && typeof rightPart === "number")
        return leftPart - rightPart;
      if (typeof leftPart === "number") return -1;
      if (typeof rightPart === "number") return 1;
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return Number(a.next) - Number(b.next);
}
