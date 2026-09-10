import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { payMe } from "../../examples/pay-me/main.ts";

const PORT = Number(process.env["PORT"] ?? 8788);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ORIGIN = `http://localhost:${PORT}`;
const ENDPOINT = "/lnurlp/tips";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const answering = payMe(
  { innerHTML: "" },
  `${ORIGIN}${ENDPOINT}`,
  process.env["PAYME_SECRET"] ?? randomUUID(),
);

async function fileAt(pathname: string): Promise<Response> {
  const asked = join(HERE, pathname === "/" ? "tip-jar.html" : pathname.slice(1));

  try {
    return new Response(await readFile(asked), {
      headers: {
        "content-type": TYPES[extname(asked)] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("not here", { status: 404 });
  }
}

createServer(async (incoming, outgoing) => {
  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    outgoing.writeHead(405).end();

    return;
  }

  const url = URL.parse(incoming.url ?? "/", ORIGIN);
  if (url === null) {
    outgoing.writeHead(400).end();

    return;
  }

  const answer =
    url.pathname === ENDPOINT ? await answering(new Request(url)) : await fileAt(url.pathname);

  outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
  outgoing.end(Buffer.from(await answer.arrayBuffer()));
})
  .on("error", (failure: NodeJS.ErrnoException) => {
    console.error(
      failure.code === "EADDRINUSE"
        ? `something already holds port ${PORT}, pass PORT= to move this one`
        : String(failure.message),
    );
    process.exitCode = 1;
  })
  .listen(PORT, () => {
    console.log(
      `${ORIGIN} serves the demo, and ${ORIGIN}${ENDPOINT} answers as a lightning address`,
    );
  });
