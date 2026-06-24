import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  findAccount,
  findAccountForUser,
  getAccountForUser,
  getProviderKeys,
  setProviderKey,
} from "../src/accounts.js";

test("persists provider credentials encrypted at rest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const { routerKey } = await createAccount("Encrypted router");
    await setProviderKey(routerKey, "example", "provider-secret-value");

    const stored = await readFile(storePath, "utf8");
    assert.doesNotMatch(stored, /provider-secret-value/);
    assert.match(stored, /v1\./);
    assert.equal((await findAccount(routerKey))?.name, "Encrypted router");
    assert.deepEqual(await getProviderKeys(routerKey), {
      example: "provider-secret-value",
    });
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a user's router key after sign-in and enforces ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-user-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const created = await createAccount("Signed-in router", "user_123");
    const recovered = await getAccountForUser("user_123");
    assert.equal(recovered?.routerKey, created.routerKey);
    assert.equal(recovered?.account.id, created.account.id);
    assert.equal(
      (await findAccountForUser(created.routerKey, "user_123"))?.id,
      created.account.id,
    );
    assert.equal(
      await findAccountForUser(created.routerKey, "different_user"),
      undefined,
    );
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
