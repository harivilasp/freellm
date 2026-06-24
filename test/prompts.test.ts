import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PromptValidationError,
  createPrompt,
  deletePrompt,
  getPublicPrompt,
  listPrompts,
  renderPrompt,
} from "../src/prompts.js";

test("renders required and optional prompt inputs", () => {
  const output = renderPrompt(
    "Write a {{tone}} email to {{recipient}} about {{topic}}. {{extra}}",
    [
      { name: "tone", label: "Tone", required: true },
      { name: "recipient", label: "Recipient", required: true },
      { name: "topic", label: "Topic", required: true },
      { name: "extra", label: "Extra instructions", required: false },
    ],
    {
      tone: "friendly",
      recipient: "Sam",
      topic: "the launch",
    },
  );

  assert.equal(
    output,
    "Write a friendly email to Sam about the launch. ",
  );
});

test("rejects missing required inputs", () => {
  assert.throws(
    () =>
      renderPrompt(
        "Summarize {{text}}",
        [{ name: "text", label: "Text", required: true }],
        {},
      ),
    (error) =>
      error instanceof PromptValidationError &&
      error.details.some((detail) => detail.field === "text"),
  );
});

test("rejects template variables without matching input definitions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-prompts-"));
  const previousPath = process.env.PROMPTS_PATH;
  process.env.PROMPTS_PATH = path.join(directory, "prompts.json");

  try {
    await assert.rejects(
      createPrompt("owner-hash", {
        title: "Broken prompt",
        description: "",
        template: "Hello {{name}} from {{company}}",
        inputs: [{ name: "name", label: "Name", required: true }],
      }),
      PromptValidationError,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PROMPTS_PATH;
    else process.env.PROMPTS_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists, lists, exposes, and deletes prompts by owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-prompts-"));
  const previousPath = process.env.PROMPTS_PATH;
  process.env.PROMPTS_PATH = path.join(directory, "prompts.json");

  try {
    const created = await createPrompt("owner-hash", {
      title: "Email writer",
      description: "Generate a polished email.",
      template: "Write to {{recipient}} about {{topic}}.",
      inputs: [
        { name: "recipient", label: "Recipient", required: true },
        { name: "topic", label: "Topic", required: false },
      ],
    });

    assert.equal((await listPrompts("owner-hash")).length, 1);
    assert.equal((await listPrompts("different-owner")).length, 0);
    assert.deepEqual(await getPublicPrompt(created.id), {
      id: created.id,
      title: "Email writer",
      description: "Generate a polished email.",
      inputs: [
        { name: "recipient", label: "Recipient", required: true },
        { name: "topic", label: "Topic", required: false },
      ],
    });
    assert.equal(await deletePrompt("different-owner", created.id), false);
    assert.equal(await deletePrompt("owner-hash", created.id), true);
    assert.equal(await getPublicPrompt(created.id), undefined);
  } finally {
    if (previousPath === undefined) delete process.env.PROMPTS_PATH;
    else process.env.PROMPTS_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
