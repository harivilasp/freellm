import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";

export interface PromptInput {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
  multiline?: boolean;
}

export interface PromptDefinition {
  title: string;
  description: string;
  template: string;
  inputs: PromptInput[];
}

interface StoredPrompt extends PromptDefinition {
  id: string;
  ownerRouterKeyHash: string;
  createdAt: string;
}

export interface PromptSummary extends PromptDefinition {
  id: string;
  createdAt: string;
}

export interface PublicPrompt {
  id: string;
  title: string;
  description: string;
  inputs: PromptInput[];
}

interface PromptStore {
  prompts: StoredPrompt[];
}

export interface PromptValidationDetail {
  field: string;
  message: string;
}

export class PromptValidationError extends Error {
  constructor(public readonly details: PromptValidationDetail[]) {
    super("Prompt validation failed");
  }
}

const PROMPT_KEY_PREFIX = "freellm:prompt:";
const OWNER_PROMPTS_PREFIX = "freellm:owner-prompts:";
const RUN_LIMIT = 20;
const RUN_WINDOW_SECONDS = 60 * 60;
const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const localRunAttempts = new Map<string, { count: number; expiresAt: number }>();

function storePath(): string {
  return path.resolve(process.env.PROMPTS_PATH ?? ".freellm/prompts.json");
}

function redisClient(): Redis | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function promptKey(id: string): string {
  return `${PROMPT_KEY_PREFIX}${id}`;
}

function ownerPromptsKey(ownerRouterKeyHash: string): string {
  return `${OWNER_PROMPTS_PREFIX}${ownerRouterKeyHash}`;
}

async function loadLocalStore(): Promise<PromptStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as PromptStore;
    if (!Array.isArray(parsed.prompts)) throw new Error("Invalid prompt store");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { prompts: [] };
    }
    throw error;
  }
}

async function saveLocalStore(store: PromptStore): Promise<void> {
  const target = storePath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

function templateVariables(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map(
    (match) => match[1] as string,
  );
}

function normalizeDefinition(definition: PromptDefinition): PromptDefinition {
  const details: PromptValidationDetail[] = [];
  const title = definition.title?.trim();
  const description = definition.description?.trim() ?? "";
  const template = definition.template?.trim();
  const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];

  if (!title || title.length > 80) {
    details.push({ field: "title", message: "Title must be 1-80 characters" });
  }
  if (description.length > 300) {
    details.push({
      field: "description",
      message: "Description must be at most 300 characters",
    });
  }
  if (!template || template.length > 12_000) {
    details.push({
      field: "template",
      message: "Template must be 1-12,000 characters",
    });
  }
  if (inputs.length > 20) {
    details.push({ field: "inputs", message: "A prompt can have at most 20 inputs" });
  }

  const names = new Set<string>();
  const normalizedInputs = inputs.map((input, index) => {
    const name = input.name?.trim().toLowerCase();
    const label = input.label?.trim();
    if (!INPUT_NAME.test(name)) {
      details.push({
        field: `inputs.${index}.name`,
        message: "Use lowercase letters, numbers, and underscores",
      });
    }
    if (names.has(name)) {
      details.push({
        field: `inputs.${index}.name`,
        message: "Input names must be unique",
      });
    }
    names.add(name);
    if (!label || label.length > 80) {
      details.push({
        field: `inputs.${index}.label`,
        message: "Input label must be 1-80 characters",
      });
    }
    return {
      name,
      label,
      required: Boolean(input.required),
      ...(input.placeholder?.trim()
        ? { placeholder: input.placeholder.trim().slice(0, 160) }
        : {}),
      ...(input.multiline ? { multiline: true } : {}),
    };
  });

  if (template) {
    const variables = new Set(templateVariables(template));
    for (const variable of variables) {
      if (!names.has(variable)) {
        details.push({
          field: "template",
          message: `Template variable {{${variable}}} has no matching input`,
        });
      }
    }
    for (const name of names) {
      if (!variables.has(name)) {
        details.push({
          field: "inputs",
          message: `Input ${name} is not used in the template`,
        });
      }
    }
  }

  if (details.length > 0) throw new PromptValidationError(details);
  return {
    title,
    description,
    template,
    inputs: normalizedInputs,
  };
}

export function renderPrompt(
  template: string,
  inputs: PromptInput[],
  values: Record<string, unknown>,
): string {
  const details: PromptValidationDetail[] = [];
  const allowed = new Set(inputs.map((input) => input.name));
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) {
      details.push({ field: key, message: "Unknown input" });
    }
  }

  const normalized = new Map<string, string>();
  for (const input of inputs) {
    const raw = values[input.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (input.required && !value) {
      details.push({ field: input.name, message: `${input.label} is required` });
    }
    if (value.length > 8_000) {
      details.push({
        field: input.name,
        message: `${input.label} must be at most 8,000 characters`,
      });
    }
    normalized.set(input.name, value);
  }

  if (details.length > 0) throw new PromptValidationError(details);
  return template.replace(
    /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g,
    (_match, name: string) => normalized.get(name) ?? "",
  );
}

export async function createPrompt(
  ownerRouterKeyHash: string,
  definition: PromptDefinition,
): Promise<PromptSummary> {
  const normalized = normalizeDefinition(definition);
  const prompt: StoredPrompt = {
    ...normalized,
    id: `prm_${randomBytes(18).toString("base64url")}`,
    ownerRouterKeyHash,
    createdAt: new Date().toISOString(),
  };
  const redis = redisClient();
  if (redis) {
    await Promise.all([
      redis.set(promptKey(prompt.id), prompt),
      redis.sadd(ownerPromptsKey(ownerRouterKeyHash), prompt.id),
    ]);
  } else {
    const store = await loadLocalStore();
    store.prompts.push(prompt);
    await saveLocalStore(store);
  }
  return summarize(prompt);
}

export async function listPrompts(
  ownerRouterKeyHash: string,
): Promise<PromptSummary[]> {
  const redis = redisClient();
  let prompts: StoredPrompt[];
  if (redis) {
    const ids = await redis.smembers<string[]>(ownerPromptsKey(ownerRouterKeyHash));
    const records = await Promise.all(
      ids.map((id) => redis.get<StoredPrompt>(promptKey(id))),
    );
    prompts = records.filter((prompt): prompt is StoredPrompt => Boolean(prompt));
  } else {
    prompts = (await loadLocalStore()).prompts.filter(
      (prompt) => prompt.ownerRouterKeyHash === ownerRouterKeyHash,
    );
  }
  return prompts
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(summarize);
}

export async function getPromptForRun(id: string): Promise<StoredPrompt | undefined> {
  const redis = redisClient();
  if (redis) return (await redis.get<StoredPrompt>(promptKey(id))) ?? undefined;
  return (await loadLocalStore()).prompts.find((prompt) => prompt.id === id);
}

export async function getPublicPrompt(
  id: string,
): Promise<PublicPrompt | undefined> {
  const prompt = await getPromptForRun(id);
  return prompt
    ? {
        id: prompt.id,
        title: prompt.title,
        description: prompt.description,
        inputs: prompt.inputs,
      }
    : undefined;
}

export async function deletePrompt(
  ownerRouterKeyHash: string,
  id: string,
): Promise<boolean> {
  const prompt = await getPromptForRun(id);
  if (!prompt || prompt.ownerRouterKeyHash !== ownerRouterKeyHash) return false;
  const redis = redisClient();
  if (redis) {
    await Promise.all([
      redis.del(promptKey(id)),
      redis.srem(ownerPromptsKey(ownerRouterKeyHash), id),
    ]);
  } else {
    const store = await loadLocalStore();
    store.prompts = store.prompts.filter((candidate) => candidate.id !== id);
    await saveLocalStore(store);
  }
  return true;
}

export async function allowPromptRun(
  promptId: string,
  clientId: string,
): Promise<boolean> {
  const fingerprint = createHash("sha256")
    .update(`${promptId}:${clientId}`)
    .digest("hex");
  const redis = redisClient();
  if (redis) {
    const key = `freellm:prompt-run-limit:${fingerprint}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RUN_WINDOW_SECONDS);
    return count <= RUN_LIMIT;
  }

  const now = Date.now();
  const attempt = localRunAttempts.get(fingerprint);
  if (!attempt || attempt.expiresAt <= now) {
    localRunAttempts.set(fingerprint, {
      count: 1,
      expiresAt: now + RUN_WINDOW_SECONDS * 1000,
    });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= RUN_LIMIT;
}

function summarize(prompt: StoredPrompt): PromptSummary {
  return {
    id: prompt.id,
    title: prompt.title,
    description: prompt.description,
    template: prompt.template,
    inputs: prompt.inputs,
    createdAt: prompt.createdAt,
  };
}

