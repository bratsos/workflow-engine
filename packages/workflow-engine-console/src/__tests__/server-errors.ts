import { connect, createServer, type Server, type Socket } from "node:net";

/**
 * A local TCP relay to a Postgres server that counts the ErrorResponse
 * messages the server sends: every error the server raises for a statement
 * of any client, whatever the client or Prisma major. Point a client at
 * `url`.
 */
export async function countServerErrors(databaseUrl: string): Promise<{
  url: string;
  errors: string[];
  close: () => Promise<void>;
}> {
  const target = new URL(databaseUrl);
  const errors: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    // Before the startup message a client may send SSLRequest or
    // GSSENCRequest; the server answers each with one untyped byte.
    let untyped = 0;
    let startup = true;
    let fromClient = Buffer.alloc(0);
    client.on("data", (chunk) => {
      if (startup) {
        fromClient = Buffer.concat([fromClient, chunk]);
        while (fromClient.length >= 8) {
          const length = fromClient.readInt32BE(0);
          const code = fromClient.readInt32BE(4);
          if (code !== 80877103 && code !== 80877104) {
            startup = false;
            break;
          }
          untyped++;
          fromClient = fromClient.subarray(length);
        }
      }
      upstream.write(chunk);
    });
    let fromServer = Buffer.alloc(0);
    upstream.on("data", (chunk) => {
      client.write(chunk);
      fromServer = Buffer.concat([fromServer, chunk]);
      for (;;) {
        if (untyped > 0) {
          if (fromServer.length < 1) break;
          untyped--;
          fromServer = fromServer.subarray(1);
          continue;
        }
        if (fromServer.length < 5) break;
        const length = fromServer.readInt32BE(1);
        if (fromServer.length < 1 + length) break;
        if (fromServer[0] === 0x45) {
          // Fields: a type byte, then a NUL-terminated string; M is the message.
          const fields = fromServer.subarray(5, 1 + length).toString("utf8");
          const message = fields
            .split("\0")
            .find((field) => field.startsWith("M"));
          errors.push(message?.slice(1) ?? fields);
        }
        fromServer = fromServer.subarray(1 + length);
      }
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as { port: number };
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
