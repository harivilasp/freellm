export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  model: string;
  priority?: number;
  cooldownMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface RouterConfig {
  providers: ProviderConfig[];
}

export interface ProviderRuntime extends ProviderConfig {
  apiKeyValue: string | undefined;
  cooldownUntil: number;
  failures: number;
}

export interface AttemptFailure {
  provider: string;
  status?: number;
  message: string;
}
