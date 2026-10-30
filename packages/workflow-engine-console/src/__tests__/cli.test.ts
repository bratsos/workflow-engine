import { createRequire } from "node:module";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The one path that builds its own Prisma client. Prisma 6 takes the URL as
// `datasources`, Prisma 7 refuses that and needs `@prisma/adapter-pg`.
// Requires DATABASE_URL and PRISMA_MAJOR (6 or 7, default 7), like the
// Postgres suite; only reads, so it can run beside that suite.
describe.skipIf(!process.env.DATABASE_URL)(
  "--database-url builds a client for the installed Prisma major",
  () => {
    const databaseUrl = process.env.DATABASE_URL as string;
    const major = process.env.PRISMA_MAJOR || "7";
    // `@prisma/client` is not a dependency of this package, so the CLI's
    // dynamic imports are pointed at the fixture for the major under test.
    // The modules are the real ones; only where they come from changes.
    const fixtureRequire = createRequire(
      fileURLToPath(
        new URL(
          `../../../prisma-fixtures/v${major}/index.cjs`,
          import.meta.url,
        ),
      ),
    );

    afterEach(() => {
      vi.doUnmock("@prisma/client");
      vi.doUnmock("@prisma/adapter-pg");
      vi.restoreAllMocks();
    });

    function useFixture(adapter: () => Record<string, unknown>) {
      vi.resetModules();
      vi.doMock("@prisma/client", () => fixtureRequire("@prisma/client"));
      vi.doMock("@prisma/adapter-pg", adapter);
    }

    async function freePort(): Promise<number> {
      return new Promise((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address() as AddressInfo;
          probe.close(() => resolve(port));
        });
      });
    }

    const argv = (port: number) => [
      "--database-url",
      databaseUrl,
      "--allow-direct-connection",
      "--port",
      String(port),
    ];

    it("serves reads from the database", async () => {
      // Prisma 6 must never load the adapter package; Prisma 7 needs it.
      useFixture(() => {
        if (major === "6") throw new Error("adapter loaded on Prisma 6");
        return fixtureRequire("@prisma/adapter-pg");
      });
      const port = await freePort();
      const before = process.listeners("SIGTERM");
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await main(argv(port))).toBe(0);
      const shutdown = process
        .listeners("SIGTERM")
        .filter((listener) => !before.includes(listener));
      try {
        // A time-range filter and the queue counts: raw SQL with a bound
        // timestamp and a bound enum value, on whatever session timezone
        // the URL asks for.
        const from = encodeURIComponent(new Date(0).toISOString());
        const runs = await fetch(
          `http://127.0.0.1:${port}/api/runs?from=${from}`,
        );
        expect(runs.status).toBe(200);
        expect(
          Array.isArray(((await runs.json()) as { runs: unknown }).runs),
        ).toBe(true);
        const queue = await fetch(`http://127.0.0.1:${port}/api/queue`);
        expect(queue.status).toBe(200);
        expect(await queue.json()).toHaveProperty("countsByStatus");
      } finally {
        // The shutdown handler ends with process.exit, which must not end
        // the test run.
        const exited = new Promise<void>((resolve) => {
          vi.spyOn(process, "exit").mockImplementation((() => {
            resolve();
          }) as never);
        });
        for (const listener of shutdown) {
          (listener as () => void)();
          process.off("SIGTERM", listener);
        }
        await exited;
      }
    });

    it.runIf(major === "7")(
      "names the adapter package to install when Prisma 7 has none",
      async () => {
        useFixture(() => {
          throw new Error("Cannot find package '@prisma/adapter-pg'");
        });
        const stderr = captureStderr();
        try {
          expect(await main(argv(await freePort()))).toBe(1);
          expect(stderr.text()).toMatch(/@prisma\/adapter-pg/);
          expect(stderr.text()).toMatch(/install/);
        } finally {
          stderr.restore();
        }
      },
    );
  },
);
