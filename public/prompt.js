const storageKey = "free-llm-router-key";
const $ = (selector) => document.querySelector(selector);

function promptId() {
  const pathMatch = location.pathname.match(/^\/p\/([^/]+)$/);
  return pathMatch?.[1] ?? new URLSearchParams(location.search).get("id");
}

function showError(message) {
  $("#prompt-loading").hidden = true;
  $("#prompt-app").hidden = true;
  $("#prompt-error").hidden = false;
  $("#prompt-error-message").textContent = message;
}

function createInput(input) {
  const wrapper = document.createElement("label");
  wrapper.setAttribute("for", `input-${input.name}`);
  wrapper.textContent = input.label;
  if (!input.required) {
    const optional = document.createElement("span");
    optional.className = "optional-label";
    optional.textContent = "Optional";
    wrapper.append(" ", optional);
  }

  const field = document.createElement(input.multiline ? "textarea" : "input");
  field.id = `input-${input.name}`;
  field.name = input.name;
  field.required = input.required;
  field.placeholder = input.placeholder ?? "";
  if (input.multiline) field.rows = 4;
  wrapper.append(field);
  return wrapper;
}

async function loadPrompt() {
  const id = promptId();
  if (!id) {
    showError("This link does not contain a prompt ID.");
    return;
  }

  try {
    const response = await fetch(`/api/public/prompts/${encodeURIComponent(id)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Prompt not found");

    const prompt = body.prompt;
    document.title = `${prompt.title} · Free LLM Router`;
    $("#public-prompt-title").textContent = prompt.title;
    $("#public-prompt-description").textContent =
      prompt.description || "Complete the fields below to generate an output.";
    $("#public-router-key").value = localStorage.getItem(storageKey) ?? "";
    prompt.inputs.forEach((input) => $("#public-inputs").append(createInput(input)));
    $("#prompt-loading").hidden = true;
    $("#prompt-app").hidden = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Prompt could not be loaded.");
  }
}

$("#public-prompt-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = promptId();
  const button = $("#public-submit");
  const result = $("#public-result");
  const output = $("#public-output");
  const values = Object.fromEntries(
    [...$("#public-inputs").querySelectorAll("input, textarea")].map((field) => [
      field.name,
      field.value,
    ]),
  );

  button.disabled = true;
  button.textContent = "Generating…";
  result.hidden = false;
  result.classList.remove("error");
  output.textContent = "Waiting for the model…";

  try {
    const response = await fetch(
      `/api/public/prompts/${encodeURIComponent(id)}/runs`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${$("#public-router-key").value.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ inputs: values }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      const details = body.details?.map((detail) => detail.message).join(" ");
      throw new Error(details || body.error?.message || body.error || "Request failed");
    }
    output.textContent = body.output;
  } catch (error) {
    result.classList.add("error");
    output.textContent = error instanceof Error ? error.message : "Request failed";
  } finally {
    button.disabled = false;
    button.textContent = "Generate output";
  }
});

loadPrompt();
