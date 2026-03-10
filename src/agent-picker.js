// Agent picker: overlay for selecting and running named agents
import { dom, state, escapeHtml } from "./renderer-state.js";
import { createOverlayDialog } from "./overlay-dialog.js";

let _actions = {};

export function initAgentPicker(actions) {
  _actions = actions;

  dom.agentPickerInput.addEventListener("input", () => {
    selectedIndex = 0;
    renderList(dom.agentPickerInput.value);
  });

  dom.agentPickerInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAgentPicker();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(Math.min(selectedIndex + 1, filteredAgents.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(Math.max(selectedIndex - 1, 0));
      return;
    }
    if (e.key === "Enter" && filteredAgents.length > 0) {
      e.preventDefault();
      const agent = filteredAgents[selectedIndex];
      closeAgentPicker();
      runAgent(agent);
      return;
    }
  });

  dom.agentPicker.addEventListener("click", (e) => {
    if (e.target === dom.agentPicker) closeAgentPicker();
  });
}

// --- State ---
let selectedIndex = 0;
let filteredAgents = [];
let allAgents = [];

// --- Open/close ---

export async function showAgentPicker() {
  // Fetch agents from API
  try {
    const cwd = state.currentSessionCwd || undefined;
    allAgents = (await window.api.listAgents(cwd)) || [];
  } catch {
    allAgents = [];
  }

  if (allAgents.length === 0) {
    _actions.showNotification(
      "No agents found. Create scripts in the agents/ directory.",
    );
    return;
  }

  dom.agentPicker.classList.add("visible");
  dom.agentPickerInput.value = "";
  selectedIndex = 0;
  renderList("");
  dom.agentPickerInput.focus();
  window.api.setDialogOpen(true);
}

function closeAgentPicker() {
  dom.agentPicker.classList.remove("visible");
  dom.agentPickerInput.value = "";
  filteredAgents = [];
  window.api.setDialogOpen(false);
  _actions.focusTerminal();
}

// --- Run agent ---

function promptForArgs(agent) {
  return new Promise((resolve) => {
    let resolved = false;
    function finish(result) {
      if (resolved) return;
      resolved = true;
      window.api.setDialogOpen(false);
      close();
      resolve(result);
    }

    const hasArgs = agent.args && agent.args.length > 0;

    const fieldsHtml = hasArgs
      ? agent.args
          .map(
            (arg, i) => `
          <div class="field-group">
            <label>${escapeHtml(arg.name)}${arg.required === false ? " (optional)" : ""}${arg.description ? " — " + escapeHtml(arg.description) : ""}</label>
            <input type="text" class="agent-arg-field" data-index="${i}"
              placeholder="${escapeHtml(arg.default || arg.name)}" />
          </div>`,
          )
          .join("")
      : `<div class="field-group">
          <label>Arguments (optional)</label>
          <input type="text" class="agent-arg-field" data-index="0" placeholder="e.g. --staged src/" />
        </div>`;

    const { overlay, close } = createOverlayDialog({
      id: "agent-args-dialog",
      escapeClose: false,
      closeSelector: null,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          window.api.setDialogOpen(false);
          resolve(null);
        }
      },
      onKeydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(collectArgs());
        }
      },
      html: `
        <div class="custom-session-dialog">
          <div class="setup-script-title">Run Agent: ${escapeHtml(agent.name)}</div>
          ${agent.description ? `<div class="agent-dialog-desc">${escapeHtml(agent.description)}</div>` : ""}
          ${fieldsHtml}
          <div class="dialog-buttons">
            <button class="btn-cancel">Cancel</button>
            <button class="btn-spawn">Run</button>
          </div>
        </div>
      `,
    });

    function collectArgs() {
      const fields = overlay.querySelectorAll(".agent-arg-field");
      const values = Array.from(fields).map((f) => f.value.trim());
      return values.filter(Boolean).join(" ");
    }

    window.api.setDialogOpen(true);
    const firstInput = overlay.querySelector(".agent-arg-field");
    const cancelBtn = overlay.querySelector(".btn-cancel");
    const runBtn = overlay.querySelector(".btn-spawn");
    cancelBtn.addEventListener("click", () => finish(null));
    runBtn.addEventListener("click", () => finish(collectArgs()));
    if (firstInput) firstInput.focus();
  });
}

async function runAgent(agent) {
  const args = await promptForArgs(agent);
  if (args === null) return; // cancelled

  _actions.showNotification(`Running agent: ${agent.name}`);

  try {
    const sessionId = await window.api.runAgent(agent.path, args);
    if (sessionId) {
      _actions.navigateToSession(sessionId);
    } else {
      _actions.showNotification(
        `Agent "${agent.name}" finished without creating a session`,
      );
    }
  } catch (err) {
    _actions.showNotification(`Agent failed: ${err.message}`);
  }
}

// --- Rendering ---

function renderList(query) {
  const q = query.toLowerCase().trim();

  filteredAgents = q
    ? allAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.description && a.description.toLowerCase().includes(q)),
      )
    : [...allAgents];

  selectedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredAgents.length - 1),
  );

  const list = dom.agentPickerList;
  list.innerHTML = "";

  if (filteredAgents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agent-picker-empty";
    empty.textContent = "No matching agents";
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < filteredAgents.length; i++) {
    const a = filteredAgents[i];
    const item = document.createElement("div");
    item.className = `agent-picker-item${i === selectedIndex ? " selected" : ""}`;

    const scopeClass =
      a.scope === "local" ? "agent-scope-local" : "agent-scope-global";
    const desc = a.description
      ? `<span class="agent-picker-desc">${escapeHtml(a.description)}</span>`
      : "";

    item.innerHTML = `
      <div class="agent-picker-main">
        <span class="agent-picker-name">${escapeHtml(a.name)}</span>
        <span class="agent-picker-scope ${scopeClass}">${a.scope}</span>
      </div>
      ${desc}
    `;

    item.addEventListener("click", () => {
      closeAgentPicker();
      runAgent(a);
    });
    item.addEventListener("mouseenter", () => updateSelection(i));
    list.appendChild(item);
  }
}

function updateSelection(newIndex) {
  const items = dom.agentPickerList.querySelectorAll(".agent-picker-item");
  if (items[selectedIndex]) items[selectedIndex].classList.remove("selected");
  selectedIndex = newIndex;
  if (items[selectedIndex]) {
    items[selectedIndex].classList.add("selected");
    items[selectedIndex].scrollIntoView({ block: "nearest" });
  }
}
