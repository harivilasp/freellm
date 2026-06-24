import type {
  AttemptFailure,
  ProviderRuntime,
} from "./types.js";

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: AttemptFailure[]) {
    super("All configured providers failed");
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export class ProviderRouter {
  private cursor = 0;

  constructor(
    private readonly providers: ProviderRuntime[],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  listProviders(): Array<{
    id: string;
    model: string;
    available: boolean;
    cooldownUntil: number;
  }> {
    const now = Date.now();
    return this.providers.map((provider) => ({
      id: provider.id,
      model: provider.model,
      available: provider.cooldownUntil <= now,
      cooldownUntil: provider.cooldownUntil,
    }));
  }

  async chatCompletion(
    incomingBody: Record<string, unknown>,
    requestSignal?: AbortSignal,
  ): Promise<{ response: Response; providerId: string }> {
    const candidates = this.orderedCandidates();
    const attempts: AttemptFailure[] = [];

    for (const provider of candidates) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Provider request timed out")),
        provider.timeoutMs ?? 120_000,
      );
      const abortFromRequest = () => controller.abort(requestSignal?.reason);
      requestSignal?.addEventListener("abort", abortFromRequest, { once: true });

      try {
        const response = await this.fetcher(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(provider.apiKeyValue
              ? { authorization: `Bearer ${provider.apiKeyValue}` }
              : {}),
            ...provider.headers,
          },
          body: JSON.stringify({
            ...incomingBody,
            model: provider.model,
          }),
          signal: controller.signal,
        });

        if (response.ok) {
          provider.failures = 0;
          this.cursor = (this.providers.indexOf(provider) + 1) % this.providers.length;
          return { response, providerId: provider.id };
        }

        const message = await readErrorMessage(response);
        attempts.push({ provider: provider.id, status: response.status, message });

        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
          continue;
        }

        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        this.coolDown(provider, retryAfterMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ provider: provider.id, message });
        this.coolDown(provider);
      } finally {
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", abortFromRequest);
      }
    }

    throw new AllProvidersFailedError(attempts);
  }

  private orderedCandidates(): ProviderRuntime[] {
    const now = Date.now();
    const available = this.providers.filter(
      (provider) => provider.cooldownUntil <= now,
    );
    const pool = available.length > 0 ? available : this.providers;

    return [...pool].sort((left, right) => {
      const leftPriority = left.priority ?? 100;
      const rightPriority = right.priority ?? 100;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;

      const leftIndex =
        (this.providers.indexOf(left) - this.cursor + this.providers.length) %
        this.providers.length;
      const rightIndex =
        (this.providers.indexOf(right) - this.cursor + this.providers.length) %
        this.providers.length;
      return leftIndex - rightIndex;
    });
  }

  private coolDown(provider: ProviderRuntime, retryAfterMs?: number): void {
    provider.failures += 1;
    const exponentialBackoff = Math.min(
      (provider.cooldownMs ?? 60_000) * 2 ** (provider.failures - 1),
      15 * 60_000,
    );
    provider.cooldownUntil =
      Date.now() + Math.max(retryAfterMs ?? 0, exponentialBackoff);
  }
}
