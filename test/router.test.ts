import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRouter } from "../src/router.js";
import type { ProviderRuntime } from "../src/types.js";

function provider(id: string, priority: number): ProviderRuntime {
  return {
    id,
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-model`,
    priority,
    cooldownMs: 60_000,
    apiKeyValue: "secret",
    cooldownUntil: 0,
    failures: 0,
  };
}

test("fails over after a 429 response", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("first")) {
      return new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = provider("first", 10);
  const second = provider("second", 20);
  const router = new ProviderRouter([first, second], fetcher);
  const result = await router.chatCompletion({
    model: "free-router",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, [
    "https://first.example/v1/chat/completions",
    "https://second.example/v1/chat/completions",
  ]);
  assert.ok(first.cooldownUntil > Date.now());
});

test("forwards streaming responses without buffering", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("data: hello\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });

  const router = new ProviderRouter([provider("stream", 10)], fetcher);
  const result = await router.chatCompletion({ stream: true, messages: [] });

  assert.equal(result.response.headers.get("content-type"), "text/event-stream");
  assert.equal(await result.response.text(), "data: hello\n\ndata: [DONE]\n\n");
});

test("skips a provider while it is cooling down", async () => {
  const calls: string[] = [];
  const first = provider("first", 10);
  first.cooldownUntil = Date.now() + 60_000;

  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter([first, provider("second", 20)], fetcher);
  const result = await router.chatCompletion({ messages: [] });

  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, ["https://second.example/v1/chat/completions"]);
});
