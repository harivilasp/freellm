import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";

interface StoredAccount {
  id: string;
  name: string;
  ownerUserId?: string;
  encryptedRouterKey?: string;
  routerKeyHash: string;
  routerKeyPrefix: string;
  createdAt: string;
  providerKeys: Record<string, string>;
}

interface AccountStore {
  accounts: StoredAccount[];
}

export interface AccountSummary {
  id: string;
  name: string;
  routerKeyPrefix: string;
  createdAt: string;
  configuredProviderIds: string[];
}

const ACCOUNT_INDEX_KEY = "freellm:accounts";
const ACCOUNT_KEY_PREFIX = "freellm:account:";
const USER_ACCOUNT_PREFIX = "freellm:user-account:";
const CREATE_LIMIT = 50;
const CREATE_WINDOW_SECONDS = 60 * 60;
const localCreateAttempts = new Map<string, { count: number; expiresAt: number }>();

function storePath(): string {
  return path.resolve(process.env.ACCOUNTS_PATH ?? ".freellm/accounts.json");
}

function redisClient(): Redis | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function encryptionKey(): Buffer | undefined {
  const encoded = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new Error("ACCOUNT_ENCRYPTION_KEY must be a 32-byte base64url value");
  }
  return key;
}

function encryptCredential(value: string): string {
  const key = encryptionKey();
  if (!key) {
    if (redisClient()) {
      throw new Error("ACCOUNT_ENCRYPTION_KEY is required for hosted storage");
    }
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

function decryptCredential(value: string): string {
  if (!value.startsWith("v1.")) return value;
  const key = encryptionKey();
  if (!key) throw new Error("ACCOUNT_ENCRYPTION_KEY is required to read credentials");

  const payload = Buffer.from(value.slice(3), "base64url");
  if (payload.length < 29) throw new Error("Invalid encrypted credential");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

export function hashRouterKey(routerKey: string): string {
  return createHash("sha256").update(routerKey).digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function accountKey(routerKeyHash: string): string {
  return `${ACCOUNT_KEY_PREFIX}${routerKeyHash}`;
}

async function loadLocalStore(): Promise<AccountStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as AccountStore;
    if (!Array.isArray(parsed.accounts)) throw new Error("Invalid account store");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { accounts: [] };
    }
    throw error;
  }
}

async function saveLocalStore(store: AccountStore): Promise<void> {
  const target = storePath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function readStoredAccount(
  routerKeyHash: string,
): Promise<StoredAccount | undefined> {
  const redis = redisClient();
  if (redis) {
    return (await redis.get<StoredAccount>(accountKey(routerKeyHash))) ?? undefined;
  }

  const store = await loadLocalStore();
  return store.accounts.find((account) =>
    safeHashEquals(account.routerKeyHash, routerKeyHash),
  );
}

async function writeStoredAccount(account: StoredAccount): Promise<void> {
  const redis = redisClient();
  if (redis) {
    const writes: Array<Promise<unknown>> = [
      redis.set(accountKey(account.routerKeyHash), account),
      redis.sadd(ACCOUNT_INDEX_KEY, account.routerKeyHash),
    ];
    if (account.ownerUserId) {
      writes.push(
        redis.set(`${USER_ACCOUNT_PREFIX}${account.ownerUserId}`, account.routerKeyHash),
      );
    }
    await Promise.all(writes);
    return;
  }

  const store = await loadLocalStore();
  const index = store.accounts.findIndex((candidate) =>
    safeHashEquals(candidate.routerKeyHash, account.routerKeyHash),
  );
  if (index >= 0) store.accounts[index] = account;
  else store.accounts.push(account);
  await saveLocalStore(store);
}

function summarize(account: StoredAccount): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    routerKeyPrefix: account.routerKeyPrefix,
    createdAt: account.createdAt,
    configuredProviderIds: Object.keys(account.providerKeys),
  };
}

export async function allowAccountCreation(clientId: string): Promise<boolean> {
  const fingerprint = createHash("sha256").update(clientId).digest("hex");
  const redis = redisClient();
  if (redis) {
    const key = `freellm:create-limit:${fingerprint}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CREATE_WINDOW_SECONDS);
    return count <= CREATE_LIMIT;
  }

  const now = Date.now();
  const attempt = localCreateAttempts.get(fingerprint);
  if (!attempt || attempt.expiresAt <= now) {
    localCreateAttempts.set(fingerprint, {
      count: 1,
      expiresAt: now + CREATE_WINDOW_SECONDS * 1000,
    });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= CREATE_LIMIT;
}

export async function createAccount(
  name: string,
  ownerUserId?: string,
): Promise<{ account: AccountSummary; routerKey: string }> {
  const routerKey = `flm_${randomBytes(32).toString("base64url")}`;
  const account: StoredAccount = {
    id: randomUUID(),
    name,
    ...(ownerUserId
      ? {
          ownerUserId,
          encryptedRouterKey: encryptCredential(routerKey),
        }
      : {}),
    routerKeyHash: hashRouterKey(routerKey),
    routerKeyPrefix: routerKey.slice(0, 12),
    createdAt: new Date().toISOString(),
    providerKeys: {},
  };

  await writeStoredAccount(account);
  return { account: summarize(account), routerKey };
}

export async function getAccountForUser(
  userId: string,
): Promise<{ account: AccountSummary; routerKey: string } | undefined> {
  const redis = redisClient();
  let account: StoredAccount | undefined;
  if (redis) {
    const routerKeyHash = await redis.get<string>(`${USER_ACCOUNT_PREFIX}${userId}`);
    if (routerKeyHash) account = await readStoredAccount(routerKeyHash);
  } else {
    account = (await loadLocalStore()).accounts.find(
      (candidate) => candidate.ownerUserId === userId,
    );
  }
  if (!account?.encryptedRouterKey) return undefined;
  return {
    account: summarize(account),
    routerKey: decryptCredential(account.encryptedRouterKey),
  };
}

export async function findAccountForUser(
  routerKey: string,
  userId: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  return account?.ownerUserId === userId ? summarize(account) : undefined;
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const redis = redisClient();
  if (!redis) {
    return (await loadLocalStore()).accounts.map(summarize);
  }

  const hashes = await redis.smembers<string[]>(ACCOUNT_INDEX_KEY);
  if (hashes.length === 0) return [];
  const accounts = await Promise.all(
    hashes.map((hash) => redis.get<StoredAccount>(accountKey(hash))),
  );
  return accounts.filter((account): account is StoredAccount => Boolean(account)).map(summarize);
}

export async function findAccount(
  routerKey: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  return account ? summarize(account) : undefined;
}

export async function getProviderKeys(
  routerKey: string,
): Promise<Record<string, string> | undefined> {
  return getProviderKeysByHash(hashRouterKey(routerKey));
}

export async function getProviderKeysByHash(
  routerKeyHash: string,
): Promise<Record<string, string> | undefined> {
  const account = await readStoredAccount(routerKeyHash);
  if (!account) return undefined;
  return Object.fromEntries(
    Object.entries(account.providerKeys).map(([providerId, apiKey]) => [
      providerId,
      decryptCredential(apiKey),
    ]),
  );
}

export async function setProviderKey(
  routerKey: string,
  providerId: string,
  apiKey: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  account.providerKeys[providerId] = encryptCredential(apiKey);
  await writeStoredAccount(account);
  return summarize(account);
}

export async function deleteProviderKey(
  routerKey: string,
  providerId: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  delete account.providerKeys[providerId];
  await writeStoredAccount(account);
  return summarize(account);
}
