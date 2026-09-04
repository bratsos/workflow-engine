import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkflowConsoleHandler } from "./handler";

/**
 * Adapt the fetch handler to Node's `http` request/response pair.
 *
 * Only Express, Fastify and bare `node:http` need this. Next.js route
 * handlers, Hono, Cloudflare Workers, Deno and Bun all speak `Request` and
 * `Response` natively, so they mount the handler directly — see the README.
 */
export function toNodeHandler(
  handler: WorkflowConsoleHandler,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async function nodeHandler(request, response) {
    try {
      const fetchRequest = await toFetchRequest(request);
      const fetchResponse = await handler(fetchRequest);
      response.statusCode = fetchResponse.status;
      fetchResponse.headers.forEach((value, key) => {
        response.setHeader(key, value);
      });
      const body = fetchResponse.body
        ? Buffer.from(await fetchResponse.arrayBuffer())
        : null;
      response.end(body ?? undefined);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          error: {
            code: "internal_error",
            message:
              error instanceof Error ? error.message : "Unexpected error.",
          },
        }),
      );
    }
  };
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const method = request.method ?? "GET";
  // `req.url` is path-and-query only; the Host header supplies the origin.
  // The origin is never used for routing — the handler derives its mount
  // path from the pathname — so a missing Host just needs a placeholder.
  const host = request.headers.host ?? "localhost";
  const protocol =
    (request.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const url = new URL(request.url ?? "/", `${protocol}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(request) : undefined;

  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
