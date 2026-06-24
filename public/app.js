import { Clerk } from "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.21.0/+esm";

const storageKey = "free-llm-router-key";
const state = {
  routerKey: localStorage.getItem(storageKey),
  sessionToken: null,
  providers: [],
  prompts: [],
  account: null,
};

const $ = (selector) => document.querySelector(selector);
const authGate = $("#auth-gate");
const welcome = $("#welcome");
const dashboard = $("#dashboard");
const toast = $("#toast");
const modal = $("#key-modal");

function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2400);
}

async function api(path, options = {}) {
  const freshSessionToken =
    (await window.freeLlmClerk?.session?.getToken()) ?? state.sessionToken;
  state.sessionToken = freshSessionToken;
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(freshSessionToken
        ? { "x-clerk-session-token": freshSessionToken }
        : {}),
      ...(state.routerKey ? { authorization: `Bearer ${state.routerKey}` } : {}),
      ...options.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error ?? "Request failed");
  return body;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function renderProviders(query = "") {
  const normalized = query.trim().toLowerCase();
  const providers = state.providers.filter((provider) =>
    `${provider.name} ${provider.model} ${provider.description}`.toLowerCase().includes(normalized),
  );
  $("#provider-list").innerHTML = providers.map((provider) => `
    <article class="provider-card">
      <div class="provider-icon">${escapeHtml(provider.name.slice(0, 1))}</div>
      <div>
        <h3>${escapeHtml(provider.name)}</h3>
        <p>${escapeHtml(provider.description)}</p>
        <div class="provider-meta">
          <span>${escapeHtml(provider.model)}</span>
          <span>${escapeHtml(provider.freeTier)}</span>
        </div>
      </div>
      <div class="provider-actions">
        <span class="status ${provider.configured ? "connected" : ""}">
          ${provider.configured ? "Connected" : "Available"}
        </span>
        <button type="button" data-add="${provider.id}">
          ${provider.configured ? "Replace key" : "Add key"}
        </button>
        ${provider.configured ? `<button class="remove" type="button" data-remove="${provider.id}">Remove</button>` : ""}
      </div>
    </article>
  `).join("") || "<p>No providers match that search.</p>";
}

function inputNames(value) {
  return [...new Set(value.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean))];
}

function inputLabel(name) {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderPrompts() {
  $("#prompt-list").innerHTML = state.prompts.map((prompt) => {
    const promptUrl = `${location.origin}/p/${encodeURIComponent(prompt.id)}`;
    const required = prompt.inputs.filter((input) => input.required).map((input) => input.name);
    const optional = prompt.inputs.filter((input) => !input.required).map((input) => input.name);
    return `
      <article class="prompt-card">
        <div>
          <h3>${escapeHtml(prompt.title)}</h3>
          <p>${escapeHtml(prompt.description || "Hosted prompt form")}</p>
          <div class="provider-meta">
            <span>Required: ${escapeHtml(required.join(", ") || "none")}</span>
            <span>Optional: ${escapeHtml(optional.join(", ") || "none")}</span>
          </div>
        </div>
        <div class="prompt-link">
          <code>${escapeHtml(promptUrl)}</code>
          <div>
            <a class="secondary link-button" href="${escapeHtml(promptUrl)}" target="_blank" rel="noreferrer">Open</a>
            <button class="secondary" type="button" data-copy-value="${escapeHtml(promptUrl)}">Copy link</button>
            <button class="secondary danger" type="button" data-delete-prompt="${prompt.id}">Delete</button>
          </div>
        </div>
      </article>
    `;
  }).join("") || '<p class="empty-state">No prompt links yet.</p>';
}

async function loadPrompts() {
  const payload = await api("/api/prompts");
  state.prompts = payload.prompts;
  renderPrompts();
}

function render() {
  welcome.hidden = true;
  dashboard.hidden = false;
  $("#router-name").textContent = state.account.name;
  const count = state.account.configuredProviderIds.length;
  $("#provider-count").textContent = String(count);
  $("#provider-summary").textContent = count ? "Ready to route requests" : "Add your first provider";
  $("#test-button").disabled = count === 0;
  $("#test-hint").textContent = count
    ? "This uses your saved router key and provider credentials."
    : "Connect a provider to run a test.";
  $("#base-url").textContent = `${location.origin}/v1`;
  $("#router-key-preview").textContent = `${state.account.routerKeyPrefix}••••••••••••`;
  $("#usage-code").textContent = `curl ${location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${state.routerKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free-router",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
  renderProviders($("#provider-search").value);
  renderPrompts();
}

async function loadDashboard() {
  if (!state.routerKey) return;
  try {
    const payload = await api("/api/me");
    state.account = payload.account;
    state.providers = payload.providers;
    render();
    await loadPrompts();
  } catch {
    localStorage.removeItem(storageKey);
    state.routerKey = null;
    welcome.hidden = false;
    dashboard.hidden = true;
  }
}

async function showSignedInState(clerk) {
  state.sessionToken = await clerk.session.getToken();
  $("#auth-user").textContent =
    clerk.user.firstName || clerk.user.primaryEmailAddress?.emailAddress || "Signed in";
  $("#auth-user").hidden = false;
  $("#sign-out").hidden = false;
  authGate.hidden = true;

  const payload = await api("/api/user/router");
  if (payload.router) {
    state.routerKey = payload.router.routerKey;
    localStorage.setItem(storageKey, state.routerKey);
    await loadDashboard();
  } else {
    localStorage.removeItem(storageKey);
    state.routerKey = null;
    welcome.hidden = false;
    dashboard.hidden = true;
  }
}

async function loadClerkUi(publishableKey) {
  const encodedDomain = publishableKey.split("_")[2];
  if (!encodedDomain) throw new Error("Invalid Clerk publishable key");
  const clerkDomain = atob(encodedDomain).slice(0, -1);

  await new Promise((resolve, reject) => {
    const existing = document.querySelector("[data-clerk-ui-bundle]");
    if (existing && window.__internal_ClerkUICtor) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.dataset.clerkUiBundle = "true";
    script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Secure sign-in UI could not be loaded.")),
      { once: true },
    );
    document.head.append(script);
  });
}

async function initializeAuth() {
  try {
    const configResponse = await fetch("/api/auth/config");
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error ?? "Authentication unavailable");

    await loadClerkUi(config.publishableKey);
    const clerk = new Clerk(config.publishableKey);
    await clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
    });
    window.freeLlmClerk = clerk;
    if (clerk.user) {
      await showSignedInState(clerk);
      return;
    }

    authGate.hidden = false;
    $("#clerk-sign-in").replaceChildren();
    clerk.mountSignIn($("#clerk-sign-in"), {
      fallbackRedirectUrl: "/",
      signUpFallbackRedirectUrl: "/",
    });
  } catch (error) {
    $("#clerk-sign-in").textContent =
      error instanceof Error ? error.message : "Sign-in could not be loaded.";
  }
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: $("#account-name").value }),
    });
    state.routerKey = payload.routerKey;
    localStorage.setItem(storageKey, state.routerKey);
    await loadDashboard();
    notify("Router created. Save your router key now.");
  } catch (error) {
    notify(error.message);
  }
});

async function signOut() {
  await window.freeLlmClerk?.signOut();
  localStorage.removeItem(storageKey);
  location.reload();
}

$("#disconnect").addEventListener("click", signOut);
$("#sign-out").addEventListener("click", signOut);

$("#provider-search").addEventListener("input", (event) => renderProviders(event.target.value));

$("#provider-list").addEventListener("click", async (event) => {
  const addButton = event.target.closest("[data-add]");
  const removeButton = event.target.closest("[data-remove]");
  if (addButton) {
    const provider = state.providers.find((candidate) => candidate.id === addButton.dataset.add);
    $("#modal-provider-id").value = provider.id;
    $("#modal-title").textContent = `${provider.configured ? "Replace" : "Add"} ${provider.name} key`;
    $("#modal-description").textContent = provider.freeTier;
    $("#provider-website").href = provider.website;
    $("#provider-key").value = "";
    modal.hidden = false;
    $("#provider-key").focus();
  }
  if (removeButton && confirm("Remove this provider key from your router?")) {
    try {
      await api(`/api/providers/${encodeURIComponent(removeButton.dataset.remove)}`, { method: "DELETE" });
      await loadDashboard();
      notify("Provider key removed.");
    } catch (error) {
      notify(error.message);
    }
  }
});

$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const providerId = $("#modal-provider-id").value;
    await api(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: $("#provider-key").value }),
    });
    modal.hidden = true;
    await loadDashboard();
    notify("Provider key saved.");
  } catch (error) {
    notify(error.message);
  }
});

$("#test-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#test-button");
  const result = $("#test-result");
  const status = $("#test-status");
  const provider = $("#test-provider");
  const output = $("#test-output");

  button.disabled = true;
  button.textContent = "Sending…";
  result.hidden = false;
  result.classList.remove("error");
  status.textContent = "Waiting for response";
  provider.textContent = "";
  output.textContent = "";

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "free-router",
        stream: false,
        messages: [{ role: "user", content: $("#test-prompt").value.trim() }],
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message ?? "Test request failed");
    }

    const content = body.choices?.[0]?.message?.content;
    status.textContent = "Router is working";
    provider.textContent = response.headers.get("x-free-llm-provider")
      ? `Handled by ${response.headers.get("x-free-llm-provider")}`
      : "Request completed";
    output.textContent =
      typeof content === "string" ? content : JSON.stringify(body, null, 2);
  } catch (error) {
    result.classList.add("error");
    status.textContent = "Test failed";
    provider.textContent = "";
    output.textContent = error instanceof Error ? error.message : "Request failed";
  } finally {
    button.disabled = state.account.configuredProviderIds.length === 0;
    button.textContent = "Send test request";
  }
});

$("#prompt-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const requiredNames = inputNames($("#prompt-required-inputs").value);
  const optionalNames = inputNames($("#prompt-optional-inputs").value).filter(
    (name) => !requiredNames.includes(name),
  );
  const allNames = [...requiredNames, ...optionalNames];
  const invalid = allNames.find((name) => !/^[a-z][a-z0-9_]{0,39}$/.test(name));
  if (invalid) {
    notify(`Invalid input name: ${invalid}`);
    return;
  }

  try {
    await api("/api/prompts", {
      method: "POST",
      body: JSON.stringify({
        title: $("#prompt-title").value,
        description: $("#prompt-description").value,
        template: $("#prompt-template").value,
        inputs: [
          ...requiredNames.map((name) => ({
            name,
            label: inputLabel(name),
            required: true,
            multiline: true,
          })),
          ...optionalNames.map((name) => ({
            name,
            label: inputLabel(name),
            required: false,
            multiline: true,
          })),
        ],
      }),
    });
    event.target.reset();
    await loadPrompts();
    notify("Prompt link created.");
  } catch (error) {
    notify(error.message);
  }
});

$("#prompt-list").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete-prompt]");
  if (!deleteButton) return;
  if (!confirm("Delete this prompt link? Existing links will stop working.")) return;
  try {
    await api(`/api/prompts/${encodeURIComponent(deleteButton.dataset.deletePrompt)}`, {
      method: "DELETE",
    });
    await loadPrompts();
    notify("Prompt link deleted.");
  } catch (error) {
    notify(error.message);
  }
});

document.querySelectorAll("[data-close-modal]").forEach((element) =>
  element.addEventListener("click", () => { modal.hidden = true; }),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") modal.hidden = true;
});

document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy], [data-copy-key], [data-copy-value]");
  if (!copy) return;
  const value = copy.hasAttribute("data-copy-key")
    ? state.routerKey
    : copy.hasAttribute("data-copy-value")
      ? copy.dataset.copyValue
      : document.getElementById(copy.dataset.copy).textContent;
  await navigator.clipboard.writeText(value);
  notify("Copied to clipboard.");
});

initializeAuth();
