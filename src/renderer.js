const md = require("markdown-it")();

const sessionList = document.getElementById("session-list");
const refreshBtn = document.getElementById("refresh-btn");
const emptyState = document.getElementById("empty-state");
const editorContainer = document.getElementById("editor-container");
const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const editorProject = document.getElementById("editor-project");
const saveStatus = document.getElementById("save-status");

let currentSessionId = null;
let saveTimeout = null;

async function loadSessions() {
  const sessions = await window.api.getSessions();
  sessionList.innerHTML = "";

  if (sessions.length === 0) {
    sessionList.innerHTML =
      '<li style="padding: 12px; color: var(--text-dim); font-size: 13px;">No sessions found</li>';
    return;
  }

  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = `session-item${s.sessionId === currentSessionId ? " active" : ""}`;
    li.innerHTML = `
      <div class="session-project">
        <span class="session-status ${s.alive ? "alive" : "dead"}"></span>
        ${s.project || "~"}
      </div>
      <div class="session-id">${s.sessionId.slice(0, 8)}…</div>
    `;
    li.addEventListener("click", () => selectSession(s));
    sessionList.appendChild(li);
  }
}

async function selectSession(session) {
  currentSessionId = session.sessionId;

  // Update sidebar selection
  document.querySelectorAll(".session-item").forEach((el, i) => {
    el.classList.toggle(
      "active",
      el
        .querySelector(".session-id")
        .textContent.startsWith(session.sessionId.slice(0, 8)),
    );
  });

  // Show editor
  emptyState.classList.add("hidden");
  editorContainer.classList.remove("hidden");
  editorProject.textContent = session.project
    ? `${session.project} — ${session.cwd}`
    : session.sessionId;

  // Load intention content
  const content = await window.api.readIntention(session.sessionId);
  editor.value = content;
  updatePreview();
  saveStatus.textContent = "";
}

function updatePreview() {
  preview.innerHTML = md.render(editor.value || "*No content yet*");
}

function scheduleSave() {
  if (!currentSessionId) return;
  saveStatus.textContent = "Editing...";
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await window.api.writeIntention(currentSessionId, editor.value);
    saveStatus.textContent = "Saved";
    setTimeout(() => {
      if (saveStatus.textContent === "Saved") saveStatus.textContent = "";
    }, 2000);
  }, 500);
}

editor.addEventListener("input", () => {
  updatePreview();
  scheduleSave();
});

refreshBtn.addEventListener("click", loadSessions);

// Auto-refresh session list every 10s
setInterval(loadSessions, 10000);

// Initial load
loadSessions();
