import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { CLUSTER_KEY } from "../../src/testing.ts";
import { runAGateway } from "./main.ts";

function statusOf(socketPath: string, path: string): Promise<number> {
  return new Promise((settle, fail) => {
    request({ socketPath, path, method: "GET" }, (answer) => {
      answer.resume();
      settle(answer.statusCode ?? 0);
    })
      .on("error", fail)
      .end();
  });
}

test("the gateway boots in this process on the socket it was given, answers health there, and is gone after stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tbg-"));
  const socket = join(directory, "gateway.sock");
  const gateway = await runAGateway(CLUSTER_KEY, socket, join(directory, "ledger.db"));

  try {
    expect(gateway.at).toBe(socket);
    expect(await statusOf(socket, "/health")).toBe(200);
  } finally {
    await gateway.stop();
  }

  await expect(statusOf(socket, "/health")).rejects.toThrow();
  rmSync(directory, { recursive: true, force: true });
});
