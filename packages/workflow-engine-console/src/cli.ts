#!/usr/bin/env node
/**
 * `workflow-console` — serve the console locally, with no host application.
 *
 * The mounted handler assumes the consumer has a web app to mount into. A
 * worker-only repository has none, and that is a real gap rather than an
 * edge case. This command closes it with the *same* handler plus a server:
 * there is no second implementation of anything here.
 *
 * It is a development tool and binds to loopback only. The interesting
 * decision is where the database access comes from. The whole point of the
 * mounted design is that the console runs on the connection the consumer
 * already has, inside their transaction, under their row-level security —
 * so the default path here asks the consumer for a module that builds the
 * reader exactly the way their own code does. Falling back to a connection
 * string of our own would quietly discard that property, so it is not the
 * default: it requires an explicit acknowledgement.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import type { ConsoleKernel } from "./actions";
import { createWorkflowConsole } from "./handler";
import { toNodeHandler } from "./node";
import type { ConsoleReadPort } from "./read-port";

/**
 * What a `--config` module must default-export, or export as `console`:
 * either the object or a zero-argument function returning it.
 *
 * Building it is the consumer's job precisely because they know how their
 * client is constructed — which role it connects as, which `SET LOCAL`
 * calls their RLS policies expect, whether it is a transaction client.
 */
export interface ConsoleDevConfig {
  reader: ConsoleReadPort;
  kernel?: ConsoleKernel;
  /** Called once when the server shuts down, to close whatever the module opened. */
  dispose?: () => void | Promise<void>;
}

interface CliOptions {
  configPath?: string;
  port: number;
  host: string;
  actions: boolean;
  allowDirectConnection: boolean;
  databaseUrl?: string;
  pollIntervalMs: number;
  help: boolean;
}

const HELP = `workflow-console — serve the workflow engine console locally

  A DEVELOPMENT TOOL. It binds to loopback (127.0.0.1) and refuses any other
  interface: it ships no authentication, so anything that can reach it can
  read every run in the database.

Usage
  workflow-console --config ./console.config.mjs [options]
  workflow-console --database-url postgres://... --allow-direct-connection

Options
  --config <path>            Module that builds the reader the way your own
                             application does. Default-export (or export as
                             \`console\`) an object { reader, kernel?, dispose? },
                             or a function returning one. This is the path that
                             preserves row-level security, because your code
                             constructs the client.
  --database-url <url>       Connect directly with Prisma instead. Requires
                             --allow-direct-connection.
  --allow-direct-connection  Acknowledge that a direct connection is a second
                             session and therefore a second security context:
                             row-level security scoped to your application's
                             session will NOT apply, and this connection sees
                             whatever its role can see, across all tenants.
  --port <n>                 Default 7799.
  --host <addr>              Default 127.0.0.1. Only loopback is accepted.
  --actions                  Enable cancel / rerun / replay. Off by default;
                             needs a kernel from the --config module.
  --poll <ms>                UI poll interval. Default 5000.
  --help                     This text.
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 7799,
    host: "127.0.0.1",
    actions: false,
    allowDirectConnection: false,
    pollIntervalMs: 5000,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--config":
        options.configPath = next();
        break;
      case "--database-url":
        options.databaseUrl = next();
        break;
      case "--allow-direct-connection":
        options.allowDirectConnection = true;
        break;
      case "--port": {
        const port = Number(next());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("--port must be an integer between 1 and 65535.");
        }
        options.port = port;
        break;
      }
      case "--host":
        options.host = next();
        break;
      case "--actions":
        options.actions = true;
        break;
      case "--poll": {
        const poll = Number(next());
        if (!Number.isFinite(poll) || poll < 0) {
          throw new Error("--poll must be a non-negative number.");
        }
        options.pollIntervalMs = poll;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }
  return options;
}

/** Loopback only. A dev console with no auth must not be reachable off-box. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `--host ${host} is refused. This console ships no authentication, so it binds to loopback only. Put the mounted handler in your application if you need it reachable.`,
    );
  }
}

async function loadConfigModule(path: string): Promise<ConsoleDevConfig> {
  const url = pathToFileURL(
    path.startsWith("/") ? path : `${process.cwd()}/${path}`,
  ).href;
  const module: Record<string, unknown> = await import(url);
  const candidate = module.default ?? module.console;
  const resolved =
    typeof candidate === "function"
      ? await (
          candidate as () => ConsoleDevConfig | Promise<ConsoleDevConfig>
        )()
      : candidate;
  if (
    typeof resolved !== "object" ||
    resolved === null ||
    !("reader" in resolved)
  ) {
    throw new Error(
      `${path} must export { reader, kernel?, dispose? } as its default export (or as \`console\`), or a function returning it.`,
    );
  }
  return resolved as ConsoleDevConfig;
}

/**
 * The escape hatch: our own Prisma client from a connection string.
 *
 * Deliberately behind an explicit flag. `@prisma/client` is imported
 * dynamically so the package does not depend on it for the mounted path,
 * which is the path that matters.
 */
async function connectDirectly(databaseUrl: string): Promise<ConsoleDevConfig> {
  const { createPrismaConsoleReadPort } = await import("./prisma-read-port");
  // Loaded through a variable specifier so TypeScript does not try to
  // resolve `@prisma/client` at build time: this package does not depend on
  // it, and this is the one path that touches it.
  const prismaSpecifier = "@prisma/client";
  const prismaModule: Record<string, unknown> = await import(
    prismaSpecifier
  ).catch(() => {
    throw new Error(
      "--database-url needs @prisma/client installed in this project.",
    );
  });
  const PrismaClient = prismaModule.PrismaClient as
    | (new (
        args: unknown,
      ) => {
        $disconnect(): Promise<void>;
      })
    | undefined;
  if (!PrismaClient) {
    throw new Error("@prisma/client did not export PrismaClient.");
  }
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  return {
    reader: createPrismaConsoleReadPort(
      client as unknown as Parameters<typeof createPrismaConsoleReadPort>[0],
    ),
    dispose: () => client.$disconnect(),
  };
}

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    assertLoopback(options.host);

    let config: ConsoleDevConfig;
    if (options.configPath) {
      config = await loadConfigModule(options.configPath);
    } else {
      const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
      if (!databaseUrl) {
        process.stderr.write(
          "Nothing to connect to. Pass --config <path> (preferred: your code builds the client, so row-level security still applies) or --database-url with --allow-direct-connection.\n",
        );
        return 2;
      }
      if (!options.allowDirectConnection) {
        process.stderr.write(
          "Refusing to open a database connection of my own.\n\n" +
            "A direct connection is a second session and therefore a second security context: row-level security scoped to your application's session will not apply, and this console would read whatever its role can read, across every tenant.\n\n" +
            "Either pass --config <path> to a module that builds the reader the way your own code does, or re-run with --allow-direct-connection to accept that.\n",
        );
        return 2;
      }
      config = await connectDirectly(databaseUrl);
    }

    if (options.actions && !config.kernel) {
      process.stderr.write(
        "--actions needs a kernel. Export one from your --config module; writes go through kernel commands, not SQL.\n",
      );
      await config.dispose?.();
      return 2;
    }

    const handler = createWorkflowConsole({
      reader: config.reader,
      kernel: config.kernel,
      actions: options.actions,
      pollIntervalMs: options.pollIntervalMs,
      // Local, single-operator, already behind loopback: there is no
      // principal to distinguish, so everything the console offers is
      // allowed. The mounted handler defaults the other way, to deny.
      authorize: () => true,
    });

    const server = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) => {
      server.listen(options.port, options.host, resolve);
    });

    process.stdout.write(
      `Workflow console on http://${options.host}:${options.port}/\n` +
        `  ${options.actions ? "actions enabled" : "read-only"}, polling every ${options.pollIntervalMs}ms\n` +
        "  Development tool: loopback only, no authentication. Do not expose it.\n",
    );

    const shutdown = () => {
      server.close(() => {
        void Promise.resolve(config.dispose?.()).then(() => process.exit(0));
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// Only run when invoked as a program, so the exported pieces stay testable.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
