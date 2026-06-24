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

1. A user signs in with Clerk (including Google OAuth).
2. The user creates a router; the server generates a high-entropy key beginning
   with `flm_` and attaches it to the signed-in account.
3. The user adds API keys from Groq, OpenRouter, Cerebras, NVIDIA, Mistral, or
   another configured provider.
4. The user's application sends its router key to the local `/v1` endpoint.
5. The router loads only that user's provider keys and tries providers in
   priority order until one succeeds.

Provider keys are never returned by the management API after they are saved.
Router keys are stored as SHA-256 hashes. Hosted provider keys are encrypted
with AES-256-GCM before being stored in managed Redis.

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

For hosted deployments, configure Upstash Redis using either the
`KV_REST_API_URL` / `KV_REST_API_TOKEN` or
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` variables. Also set
`ACCOUNT_ENCRYPTION_KEY` to a 32-byte base64url secret.

Configure Clerk with:

```text
CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```

The dashboard requires sign-in before router creation and recovers the user's
encrypted router key on later sessions.

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

## Hosted prompt apps

Signed-in router owners can create prompt templates containing variables such
as `{{topic}}`, then mark each input required or optional. Each template gets a
link such as `/p/prm_...`.

Running a prompt requires its prompt ID, any valid router key, and an inputs
object. All variables are validated before any provider request is made.
Invalid, missing, or unexpected inputs return HTTP 422 without calling an LLM.

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

Hosted deployments use managed Redis and require encrypted provider
credentials. Clerk sign-in protects router management and allows the encrypted
router key to be recovered across browsers. The router key remains the
credential for OpenAI-compatible `/v1` calls and hosted prompt execution.

Never log authorization headers, router keys, provider keys, or prompt data.

## Development

```bash
npm run typecheck
npm test
npm run build
```
