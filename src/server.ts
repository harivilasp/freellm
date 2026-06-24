import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createAccount,
  deleteProviderKey,
  findAccount,
  findAccountForUser,
  getAccountForUser,
  getProviderKeys,
  hashRouterKey,
  setProviderKey,
} from "./accounts.js";
import { clerkPublishableKey, sessionUserId } from "./auth.js";
import { loadProviderConfigs, loadProviders } from "./config.js";
import { readPublicFile } from "./dashboard.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import {
  allowPromptRun,
  createPrompt,
  deletePrompt,
  getPromptForRun,
  getPublicPrompt,
  listPrompts,
  PromptValidationError,
  renderPrompt,
} from "./prompts.js";
import { AllProvidersFailedError, ProviderRouter } from "./router.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function clientId(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return firstForwarded?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const providedBody = (request as IncomingMessage & { body?: unknown }).body;
  if (providedBody !== undefined && providedBody !== null) {
    const parsed =
      typeof providedBody === "string" || Buffer.isBuffer(providedBody)
        ? (JSON.parse(String(providedBody)) as unknown)
        : providedBody;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON body must be an object");
  }
  return body as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

async function providerResponse(routerKey: string): Promise<{
  account: Awaited<ReturnType<typeof findAccount>>;
  providers: Array<Record<string, unknown>>;
} | undefined> {
  const account = await findAccount(routerKey);
  if (!account) return undefined;
  const configs = await loadProviderConfigs();
  return {
    account,
    providers: configs.map((provider) => ({
      id: provider.id,
      model: provider.model,
      baseUrl: provider.baseUrl,
      configured: account.configuredProviderIds.includes(provider.id),
      ...(PROVIDER_CATALOG[provider.id] ?? {
        name: provider.id,
        website: provider.baseUrl,
        description: "OpenAI-compatible provider.",
        freeTier: "See provider website",
        category: "Inference platform",
      }),
    })),
  };
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/config") {
        const publishableKey = clerkPublishableKey();
        sendJson(
          response,
          publishableKey ? 200 : 503,
          publishableKey
            ? { publishableKey }
            : { error: "Authentication is not configured" },
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/user/router") {
        const userId = await sessionUserId(request);
        if (!userId) {
          sendJson(response, 401, { error: "Sign in required" });
          return;
        }
        sendJson(response, 200, { router: (await getAccountForUser(userId)) ?? null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/accounts") {
        const userId = await sessionUserId(request);
        if (!userId) {
          sendJson(response, 401, { error: "Sign in required" });
          return;
        }
        const existing = await getAccountForUser(userId);
        if (existing) {
          sendJson(response, 200, existing);
          return;
        }
        const body = await readJsonBody(request);
        const name =
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 80)
            : "My router";
        sendJson(response, 201, await createAccount(name, userId));
        return;
      }

      if (url.pathname === "/api/me" || url.pathname.startsWith("/api/providers")) {
        const routerKey = bearerToken(request);
        const userId = await sessionUserId(request);
        if (!routerKey || !userId || !(await findAccountForUser(routerKey, userId))) {
          sendJson(response, 401, { error: "Signed-in router access required" });
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/me") {
          const payload = await providerResponse(routerKey);
          sendJson(response, payload ? 200 : 401, payload ?? { error: "Invalid router key" });
          return;
        }

        const match = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
        const matchedProviderId = match?.[1];
        if (matchedProviderId && request.method === "PUT") {
          const providerId = decodeURIComponent(matchedProviderId);
          const configs = await loadProviderConfigs();
          if (!configs.some((provider) => provider.id === providerId)) {
            sendJson(response, 404, { error: "Unknown provider" });
            return;
          }
          const body = await readJsonBody(request);
          if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) {
            sendJson(response, 400, { error: "Enter a valid API key" });
            return;
          }
          const account = await setProviderKey(routerKey, providerId, body.apiKey.trim());
          sendJson(response, account ? 200 : 401, account ?? { error: "Invalid router key" });
          return;
        }

        if (matchedProviderId && request.method === "DELETE") {
          const account = await deleteProviderKey(
            routerKey,
            decodeURIComponent(matchedProviderId),
          );
          sendJson(response, account ? 200 : 401, account ?? { error: "Invalid router key" });
          return;
        }
      }

      if (url.pathname === "/api/prompts" || url.pathname.startsWith("/api/prompts/")) {
        const routerKey = bearerToken(request);
        const userId = await sessionUserId(request);
        if (!routerKey || !userId || !(await findAccountForUser(routerKey, userId))) {
          sendJson(response, 401, { error: "Signed-in router access required" });
          return;
        }
        const ownerRouterKeyHash = hashRouterKey(routerKey);

        if (request.method === "GET" && url.pathname === "/api/prompts") {
          sendJson(response, 200, { prompts: await listPrompts(ownerRouterKeyHash) });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/prompts") {
          const body = await readJsonBody(request);
          const prompt = await createPrompt(ownerRouterKeyHash, {
            title: typeof body.title === "string" ? body.title : "",
            description:
              typeof body.description === "string" ? body.description : "",
            template: typeof body.template === "string" ? body.template : "",
            inputs: Array.isArray(body.inputs)
              ? (body.inputs as Array<{
                  name: string;
                  label: string;
                  required: boolean;
                  placeholder?: string;
                  multiline?: boolean;
                }>)
              : [],
          });
          response.setHeader("location", `/api/prompts/${prompt.id}`);
          sendJson(response, 201, { prompt });
          return;
        }

        const promptMatch = url.pathname.match(/^\/api\/prompts\/([^/]+)$/);
        if (promptMatch?.[1] && request.method === "DELETE") {
          const deleted = await deletePrompt(
            ownerRouterKeyHash,
            decodeURIComponent(promptMatch[1]),
          );
          if (!deleted) {
            sendJson(response, 404, { error: "Prompt not found" });
            return;
          }
          response.writeHead(204);
          response.end();
          return;
        }
      }

      const publicPromptMatch = url.pathname.match(
        /^\/api\/public\/prompts\/([^/]+)$/,
      );
      if (publicPromptMatch?.[1] && request.method === "GET") {
        const prompt = await getPublicPrompt(decodeURIComponent(publicPromptMatch[1]));
        sendJson(
          response,
          prompt ? 200 : 404,
          prompt ? { prompt } : { error: "Prompt not found" },
        );
        return;
      }

      const promptRunMatch = url.pathname.match(
        /^\/api\/public\/prompts\/([^/]+)\/runs$/,
      );
      if (promptRunMatch?.[1] && request.method === "POST") {
        const promptId = decodeURIComponent(promptRunMatch[1]);
        const routerKey = bearerToken(request);
        if (!routerKey) {
          sendJson(response, 401, { error: "Router key required" });
          return;
        }
        if (!(await allowPromptRun(promptId, clientId(request)))) {
          response.setHeader("retry-after", "3600");
          sendJson(response, 429, { error: "Prompt run limit reached. Try again later." });
          return;
        }

        const prompt = await getPromptForRun(promptId);
        if (!prompt) {
          sendJson(response, 404, { error: "Prompt not found" });
          return;
        }
        const body = await readJsonBody(request);
        const values =
          body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
            ? (body.inputs as Record<string, unknown>)
            : {};
        const rendered = renderPrompt(prompt.template, prompt.inputs, values);
        const providerKeys = await getProviderKeys(routerKey);
        if (!providerKeys) {
          sendJson(response, 401, { error: "Invalid router key" });
          return;
        }
        const providers = providerKeys
          ? await loadProviders(undefined, providerKeys)
          : [];
        if (providers.length === 0) {
          sendJson(response, 503, {
            error: "This prompt does not currently have a provider available",
          });
          return;
        }

        const result = await new ProviderRouter(providers).chatCompletion({
          model: "free-router",
          stream: false,
          messages: [{ role: "user", content: rendered }],
        });
        const completion = (await result.response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const output = completion.choices?.[0]?.message?.content;
        if (typeof output !== "string") {
          sendJson(response, 502, { error: "Provider returned an invalid response" });
          return;
        }
        response.setHeader("x-free-llm-provider", result.providerId);
        sendJson(response, 200, { output });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [{ id: "free-router", object: "model", owned_by: "local" }],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const routerKey = bearerToken(request);
        const providerKeys = routerKey ? await getProviderKeys(routerKey) : undefined;
        if (!providerKeys) {
          sendJson(response, 401, {
            error: { message: "Invalid router API key", type: "authentication_error" },
          });
          return;
        }

        const providers = await loadProviders(undefined, providerKeys);
        if (providers.length === 0) {
          sendJson(response, 400, {
            error: {
              message: "Add at least one provider API key in the dashboard",
              type: "configuration_error",
            },
          });
          return;
        }

        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const body = await readJsonBody(request);
        const result = await new ProviderRouter(providers).chatCompletion(
          body,
          controller.signal,
        );

        response.statusCode = result.response.status;
        response.setHeader("x-free-llm-provider", result.providerId);
        for (const header of ["content-type", "cache-control"]) {
          const value = result.response.headers.get(header);
          if (value) response.setHeader(header, value);
        }
        if (!result.response.body) {
          response.end();
          return;
        }
        Readable.fromWeb(
          result.response.body as import("node:stream/web").ReadableStream,
        ).pipe(response);
        return;
      }

      if (request.method === "GET") {
        const asset = await readPublicFile(url.pathname);
        if (asset) {
          response.writeHead(200, {
            "content-type": asset.contentType,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
            "content-security-policy":
              "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://*.clerk.accounts.dev; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.clerk.accounts.dev https://api.clerk.com; img-src 'self' data: https:; frame-src https://*.clerk.accounts.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.clerk.accounts.dev",
          });
          response.end(asset.body);
          return;
        }
      }

      sendJson(response, 404, { error: { message: "Not found", type: "not_found" } });
  } catch (error) {
    if (error instanceof PromptValidationError) {
      sendJson(response, 422, {
        error: "Prompt validation failed",
        details: error.details,
      });
      return;
    }
    if (error instanceof AllProvidersFailedError) {
      sendJson(response, 503, {
        error: {
          message: error.message,
          type: "providers_exhausted",
          attempts: error.attempts,
        },
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, 400, {
      error: { message, type: "invalid_request_error" },
    });
  }
}

export async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  server.listen(port, () => {
    console.log(`Free LLM Router dashboard: http://localhost:${port}`);
    console.log(`OpenAI-compatible endpoint: http://localhost:${port}/v1`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
