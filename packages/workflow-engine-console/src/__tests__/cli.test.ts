import { describe, expect, it, vi } from "vitest";
import { assertLoopback, main, parseArgs } from "../cli";

function captureStderr(): { text: () => string; restore: () => void } {
  let buffer = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      buffer += String(chunk);
      return true;
    });
  return { text: () => buffer, restore: () => spy.mockRestore() };
}

function captureStdout(): { text: () => string; restore: () => void } {
  let buffer = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      buffer += String(chunk);
      return true;
    });
  return { text: () => buffer, restore: () => spy.mockRestore() };
}

describe("parseArgs", () => {
  it("defaults to loopback, read-only, and a 5s poll", () => {
    const options = parseArgs([]);
    expect(options.host).toBe("127.0.0.1");
    expect(options.actions).toBe(false);
    expect(options.allowDirectConnection).toBe(false);
    expect(options.pollIntervalMs).toBe(5000);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "99999"])).toThrow(/--port/);
  });

  it("rejects a flag whose value is missing", () => {
    expect(() => parseArgs(["--config"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--config", "--actions"])).toThrow(/needs a value/);
  });
});

describe("assertLoopback", () => {
  it("accepts loopback addresses", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(() => assertLoopback(host)).not.toThrow();
    }
  });

  it("refuses a public interface, because it ships no authentication", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      expect(() => assertLoopback(host)).toThrow(/loopback only/);
    }
  });
});

describe("the direct-connection acknowledgement", () => {
  it("refuses to open its own connection without the explicit flag", async () => {
    const stderr = captureStderr();
    try {
      const code = await main([
        "--database-url",
        "postgres://localhost/whatever",
      ]);
      expect(code).toBe(2);
      // The refusal has to say *why*, or it is just an obstacle.
      expect(stderr.text()).toMatch(/second security context/);
      expect(stderr.text()).toMatch(/row-level security/);
      expect(stderr.text()).toMatch(/--allow-direct-connection/);
    } finally {
      stderr.restore();
    }
  });

  it("says what to do when given nothing to connect to", async () => {
    const stderr = captureStderr();
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(await main([])).toBe(2);
      expect(stderr.text()).toMatch(/--config/);
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
      stderr.restore();
    }
  });

  it("refuses a non-loopback host before connecting to anything", async () => {
    const stderr = captureStderr();
    try {
      expect(
        await main([
          "--host",
          "0.0.0.0",
          "--database-url",
          "postgres://localhost/x",
          "--allow-direct-connection",
        ]),
      ).toBe(1);
      expect(stderr.text()).toMatch(/loopback only/);
    } finally {
      stderr.restore();
    }
  });
});

describe("--help", () => {
  it("states that it is a development tool bound to loopback", async () => {
    const stdout = captureStdout();
    try {
      expect(await main(["--help"])).toBe(0);
      expect(stdout.text()).toMatch(/DEVELOPMENT TOOL/);
      expect(stdout.text()).toMatch(/loopback/);
    } finally {
      stdout.restore();
    }
  });
});
