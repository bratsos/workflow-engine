import { describe, expect, it } from "vitest";
import {
  assertSnapshotWritable,
  compareSnapshotLabels,
  releaseTagName,
  selectSnapshotLabel,
} from "./snapshot-label.js";

describe("stored-row snapshot labels", () => {
  it("uses the package version before its release tag exists", () => {
    expect(selectSnapshotLabel("1.0.0-alpha.21", () => false)).toBe(
      "1.0.0-alpha.21",
    );
  });

  it("routes post-release captures to a replaceable +next label", () => {
    const version = "1.0.0-alpha.20";
    expect(
      selectSnapshotLabel(version, (tag) => tag === releaseTagName(version)),
    ).toBe("1.0.0-alpha.20+next");
  });

  it("refuses to overwrite an existing snapshot protected by a release tag", () => {
    const version = "1.0.0-alpha.20";
    const tag = releaseTagName(version);
    expect(() =>
      assertSnapshotWritable(
        version,
        "/snapshots/alpha.20/pending.json",
        (value) => value === tag,
        () => true,
      ),
    ).toThrow(`release tag "${tag}" exists`);
  });

  it("permits the first snapshot for a released label and replaceable next captures", () => {
    const version = "1.0.0-alpha.20";
    const tag = releaseTagName(version);
    expect(() =>
      assertSnapshotWritable(
        version,
        "/snapshots/alpha.20/pending.json",
        (value) => value === tag,
        () => false,
      ),
    ).not.toThrow();
    expect(() =>
      assertSnapshotWritable(
        `${version}+next`,
        "/snapshots/alpha.20+next/pending.json",
        (value) => value === tag,
        () => true,
      ),
    ).not.toThrow();
  });

  it("orders +next after its release and before the following prerelease", () => {
    expect(
      compareSnapshotLabels("1.0.0-alpha.20+next", "1.0.0-alpha.20"),
    ).toBeGreaterThan(0);
    expect(
      compareSnapshotLabels("1.0.0-alpha.21", "1.0.0-alpha.20+next"),
    ).toBeGreaterThan(0);
    expect(
      compareSnapshotLabels("1.0.0", "1.0.0-alpha.20+next"),
    ).toBeGreaterThan(0);
  });
});
