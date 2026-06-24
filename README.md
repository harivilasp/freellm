# Free LLM Router

A self-hosted, OpenAI-compatible router for free-tier LLM APIs.

Each user creates one private router key, adds their own API keys from multiple
providers, and calls a single endpoint. If a provider is rate-limited,
unavailable, or times out, the request automatically moves to the next
configured provider.

The included website shows which provider keys have already been added, which
providers are still available, and where to create each provider key.

Provider ideas and free-tier details are based on
[awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

## How it works

1. A user opens the dashboard and creates a router.
2. The server generates a high-entropy key beginning with `flm_`.
3. The user adds API keys from Groq, OpenRouter, Cerebras, NVIDIA, Mistral, or
   another configured provider.
4. The user's application sends its router key to the local `/v1` endpoint.
5. The router loads only that user's provider keys and tries providers in
   priority order until one succeeds.

Provider keys are never returned by the management API after they are saved.
Router keys are stored as SHA-256 hashes. Provider keys are stored in a
permission-restricted local file.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open [http://localhost:8787](http://localhost:8787).

Data is stored in `.freellm/accounts.json`, which is excluded from Git. Set
`ACCOUNTS_PATH` to use another location:

```bash
ACCOUNTS_PATH=/secure/path/accounts.json npm start
```

## Create a router

Use the website, or create one directly:

```bash
curl http://localhost:8787/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"My development router"}'
```

The response includes the full router key once:

```json
{
  "account": {
    "id": "account-id",
    "name": "My development router",
    "routerKeyPrefix": "flm_example",
    "createdAt": "2026-06-24T00:00:00.000Z",
    "configuredProviderIds": []
  },
  "routerKey": "flm_save_this_secret"
}
```

## Add a provider key

The dashboard handles this flow. The management API is also available:

```bash
curl -X PUT http://localhost:8787/api/providers/groq-llama \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"your-groq-key"}'
```

Remove a provider key:

```bash
curl -X DELETE http://localhost:8787/api/providers/groq-llama \
  -H "Authorization: Bearer $ROUTER_API_KEY"
```

## Call the router

### OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.ROUTER_API_KEY,
  baseURL: "http://localhost:8787/v1",
});

const response = await client.chat.completions.create({
  model: "free-router",
  messages: [{ role: "user", content: "Write a TypeScript function." }],
});

console.log(response.choices[0].message);
```

### cURL

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-router",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

The `x-free-llm-provider` response header identifies the provider that handled
the request. Streaming responses are forwarded without buffering.

## Provider configuration

Providers are defined in `providers.json`:

- `id`: stable provider identifier used by the dashboard and management API
- `baseUrl`: OpenAI-compatible API base URL
- `model`: provider-specific model sent upstream
- `priority`: lower values are tried first
- `cooldownMs`: initial cooldown after a retryable failure
- `timeoutMs`: optional per-attempt timeout
- `headers`: optional provider-specific headers
- `enabled`: set to `false` to hide and disable an entry

The current dashboard includes OpenAI-compatible providers from the reference
list. APIs that require custom request formats, such as Gemini, Cohere,
Cloudflare Workers AI, and Ollama, need provider adapters before they can be
added safely.

## Failover behavior

The router tries another configured provider after network errors, timeouts,
HTTP 429 responses, and common transient HTTP errors. `Retry-After` is honored
when present.

HTTP 400, 401, and 403 responses also move to the next provider, but do not put
the failed provider into cooldown. If every provider fails, the endpoint
returns HTTP 503 with sanitized attempt details.

## Security and production deployment

The included JSON account store is intended for local use and small
self-hosted deployments. Provider keys are plaintext at rest, protected only
by filesystem permissions.

Before offering this as a public hosted service:

- store accounts and encrypted provider credentials in a database or secret
  manager;
- add account login, recovery, router-key rotation, and revocation;
- add TLS, request rate limits, audit logs, CSRF protection, and abuse controls;
- isolate tenant state and cache router cooldowns per account;
- validate provider ownership and applicable provider terms;
- never log authorization headers, router keys, provider keys, or prompt data.

## Development

```bash
npm run typecheck
npm test
npm run build
```
