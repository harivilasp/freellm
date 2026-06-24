import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderConfig, ProviderRuntime, RouterConfig } from "./types.js";

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return (
    typeof provider.id === "string" &&
    typeof provider.baseUrl === "string" &&
    typeof provider.model === "string" &&
    (provider.apiKeyEnv === undefined || typeof provider.apiKeyEnv === "string") &&
    (provider.apiKey === undefined || typeof provider.apiKey === "string")
  );
}

export async function loadProviderConfigs(
  configPath = process.env.PROVIDERS_CONFIG ?? "providers.json",
): Promise<ProviderConfig[]> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RouterConfig>;

  if (!Array.isArray(parsed.providers) || !parsed.providers.every(isProviderConfig)) {
    throw new Error(`Invalid provider configuration in ${absolutePath}`);
  }

  const ids = new Set<string>();
  for (const provider of parsed.providers) {
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    ids.add(provider.id);
  }

  return parsed.providers;
}

export async function loadProviders(
  configPath = process.env.PROVIDERS_CONFIG ?? "providers.json",
  providerKeys: Record<string, string> = {},
): Promise<ProviderRuntime[]> {
  const providerConfigs = await loadProviderConfigs(configPath);

  return providerConfigs
    .filter((provider) => provider.enabled !== false)
    .map((provider) => {
      const apiKeyValue =
        providerKeys[provider.id] ??
        (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey);

      return {
        ...provider,
        baseUrl: provider.baseUrl.replace(/\/+$/, ""),
        apiKeyValue,
        cooldownUntil: 0,
        failures: 0,
      };
    })
    .filter((provider) => {
      if (provider.apiKeyEnv && !provider.apiKeyValue) {
        console.warn(
          `Skipping ${provider.id}: environment variable ${provider.apiKeyEnv} is empty`,
        );
        return false;
      }
      return true;
    });
}
