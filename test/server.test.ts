import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrompt } from "../src/prompts.js";
import { handleRequest } from "../src/server.js";

function responseRecorder(): {
  response: ServerResponse;
  result: { status?: number; body?: unknown };
} {
  const result: { status?: number; body?: unknown } = {};
  const response = {
    setHeader() {},
    writeHead(status: number) {
      result.status = status;
      return response;
    },
    end(body?: string) {
      if (body) result.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { response, result };
}

test("public prompt validation fails before checking the router key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-server-"));
  const previousPath = process.env.PROMPTS_PATH;
  process.env.PROMPTS_PATH = path.join(directory, "prompts.json");

  try {
    const prompt = await createPrompt("owner-hash", {
      title: "Required input",
      description: "",
      template: "Summarize {{text}}",
      inputs: [{ name: "text", label: "Text", required: true }],
    });
    const request = {
      method: "POST",
      url: `/api/public/prompts/${prompt.id}/runs`,
      headers: {
        host: "localhost",
        authorization: "Bearer invalid-router-key",
      },
      socket: { remoteAddress: "127.0.0.1" },
      body: { inputs: {} },
    } as unknown as IncomingMessage;
    const { response, result } = responseRecorder();

    await handleRequest(request, response);

    assert.equal(result.status, 422);
    assert.deepEqual(result.body, {
      error: "Prompt validation failed",
      details: [{ field: "text", message: "Text is required" }],
    });
  } finally {
    if (previousPath === undefined) delete process.env.PROMPTS_PATH;
    else process.env.PROMPTS_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
