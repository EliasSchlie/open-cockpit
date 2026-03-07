// Session Info overlay — on-demand stats display for the current session.
// Triggered by ⌘I or command palette. Uses createOverlayDialog pattern.

import { createOverlayDialog } from "./overlay-dialog.js";
import { state, escapeHtml } from "./renderer-state.js";

function formatNumber(n) {
  if (n == null) return "0";
  return n.toLocaleString("en-US");
}

function formatCost(usd) {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function shortModel(model) {
  if (!model) return "unknown";
  // "claude-opus-4-6-20250514" → "Opus 4.6"
  const m = model.match(/claude-(\w+)-([\d]+)-([\d]+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return escapeHtml(model);
}

function tokenTotalCount(tokens) {
  return tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
}

function renderTokenGrid(tokens, label = "Tokens") {
  return `
    <div class="stats-section">
      <div class="stats-section-title">${label}</div>
      <div class="stats-grid">
        <div class="stats-cell">
          <span class="stats-label">Input</span>
          <span class="stats-value">${formatNumber(tokens.input)}</span>
        </div>
        <div class="stats-cell">
          <span class="stats-label">Output</span>
          <span class="stats-value">${formatNumber(tokens.output)}</span>
        </div>
        <div class="stats-cell">
          <span class="stats-label">Cache Write</span>
          <span class="stats-value">${formatNumber(tokens.cacheCreation)}</span>
        </div>
        <div class="stats-cell">
          <span class="stats-label">Cache Read</span>
          <span class="stats-value">${formatNumber(tokens.cacheRead)}</span>
        </div>
      </div>
    </div>`;
}

function renderSubAgentRow(sub) {
  const total = tokenTotalCount(sub.tokens);
  return `
    <tr>
      <td class="stats-sub-id" title="${escapeHtml(sub.sessionId)}">${escapeHtml(sub.sessionId.slice(0, 8))}…</td>
      <td>${shortModel(sub.model)}</td>
      <td class="stats-num">${sub.turns}</td>
      <td class="stats-num">${formatNumber(total)}</td>
      <td class="stats-num">${formatCost(sub.estimatedCostUSD)}</td>
    </tr>`;
}

function renderSessionTab(stats) {
  const hasSubAgents = stats.subAgents && stats.subAgents.length > 0;

  let subAgentsHtml = "";
  if (hasSubAgents) {
    subAgentsHtml = `
      <div class="stats-section">
        <div class="stats-section-title">Sub-Agents (${stats.subAgents.length})</div>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Model</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            ${stats.subAgents.map(renderSubAgentRow).join("")}
          </tbody>
        </table>
      </div>

      <div class="stats-section stats-totals">
        <div class="stats-section-title">Total (Session + Sub-Agents)</div>
        <div class="stats-grid">
          <div class="stats-cell">
            <span class="stats-label">Turns</span>
            <span class="stats-value">${formatNumber(stats.totalWithSubAgents.turns)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Tokens</span>
            <span class="stats-value">${formatNumber(tokenTotalCount(stats.totalWithSubAgents.tokens))}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Est. Cost</span>
            <span class="stats-value stats-cost">${formatCost(stats.totalWithSubAgents.estimatedCostUSD)}</span>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="stats-tab-panel active" data-tab="session">
      <div class="stats-overview">
        <div class="stats-grid">
          <div class="stats-cell">
            <span class="stats-label">Model</span>
            <span class="stats-value stats-model">${shortModel(stats.model)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Duration</span>
            <span class="stats-value">${formatDuration(stats.durationMs)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Turns</span>
            <span class="stats-value">${formatNumber(stats.turns)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Tool Uses</span>
            <span class="stats-value">${formatNumber(stats.toolUses)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Est. Cost</span>
            <span class="stats-value stats-cost">${formatCost(stats.estimatedCostUSD)}</span>
          </div>
        </div>
      </div>
      ${renderTokenGrid(stats.tokens)}
      ${subAgentsHtml}
    </div>`;
}

function renderAllSessionsTab(allStats) {
  const topModelsHtml = allStats.topModels
    .slice(0, 5)
    .map(
      (m) => `
      <div class="stats-model-row">
        <span class="stats-model">${shortModel(m.model)}</span>
        <span class="stats-num">${formatNumber(m.count)} responses</span>
      </div>`,
    )
    .join("");

  return `
    <div class="stats-tab-panel" data-tab="all">
      <div class="stats-overview">
        <div class="stats-grid">
          <div class="stats-cell">
            <span class="stats-label">Sessions</span>
            <span class="stats-value">${formatNumber(allStats.sessionCount)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Turns</span>
            <span class="stats-value">${formatNumber(allStats.turns)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Tool Uses</span>
            <span class="stats-value">${formatNumber(allStats.toolUses)}</span>
          </div>
          <div class="stats-cell">
            <span class="stats-label">Est. Total Cost</span>
            <span class="stats-value stats-cost">${formatCost(allStats.estimatedCostUSD)}</span>
          </div>
        </div>
      </div>
      ${renderTokenGrid(allStats.tokens)}
      ${
        topModelsHtml
          ? `
        <div class="stats-section">
          <div class="stats-section-title">Top Models</div>
          ${topModelsHtml}
        </div>`
          : ""
      }
    </div>`;
}

function renderLoading() {
  return `
    <div class="stats-loading">
      <span>Computing stats…</span>
    </div>`;
}

const TABS = [
  { id: "session", label: "Session" },
  { id: "all", label: "All Sessions" },
];

export async function openSessionInfo() {
  const sessionId = state.currentSessionId;
  if (!sessionId) return;

  const { overlay, close } = createOverlayDialog({
    id: "session-info",
    closeSelector: ".settings-close-btn",
    html: `
      <div class="settings-dialog stats-dialog">
        <div class="settings-header">
          <span>Session Info</span>
          <button class="close-dialog-btn settings-close-btn">✕</button>
        </div>
        <div class="settings-layout">
          <div class="settings-nav">
            ${TABS.map(
              (tab) =>
                `<button class="settings-nav-item${tab.id === "session" ? " active" : ""}" data-tab="${tab.id}">${tab.label}</button>`,
            ).join("")}
          </div>
          <div class="settings-content stats-content">
            ${renderLoading()}
          </div>
        </div>
      </div>
    `,
    onClose: () => window.api.setDialogOpen(false),
  });

  window.api.setDialogOpen(true);

  const content = overlay.querySelector(".stats-content");
  const navItems = overlay.querySelectorAll(".settings-nav-item");

  // Tab switching + lazy loading for "All Sessions"
  let allStatsLoaded = false;

  function switchTab(tabId) {
    navItems.forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.tab === tabId),
    );
    overlay
      .querySelectorAll(".stats-tab-panel")
      .forEach((panel) =>
        panel.classList.toggle("active", panel.dataset.tab === tabId),
      );
    if (tabId === "all" && !allStatsLoaded) {
      allStatsLoaded = true;
      loadAllSessionStats();
    }
  }

  navItems.forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab)),
  );

  // Load session stats (fast — single file)
  try {
    const stats = await window.api.getSessionStats(sessionId);
    content.innerHTML =
      renderSessionTab(stats) +
      `<div class="stats-tab-panel" data-tab="all">${renderLoading()}</div>`;
    switchTab("session");
  } catch {
    content.innerHTML = `<div class="stats-tab-panel active" data-tab="session">
      <div class="stats-error">Failed to load session stats</div>
    </div>`;
  }

  // Lazy: only loads when user clicks "All Sessions" tab
  async function loadAllSessionStats() {
    try {
      const allStats = await window.api.getAllSessionStats();
      const allPanel = overlay.querySelector(
        '.stats-tab-panel[data-tab="all"]',
      );
      if (allPanel) {
        const wasActive = allPanel.classList.contains("active");
        const newPanel = document.createElement("div");
        newPanel.innerHTML = renderAllSessionsTab(allStats);
        const realPanel = newPanel.firstElementChild;
        if (wasActive) realPanel.classList.add("active");
        allPanel.replaceWith(realPanel);
      }
    } catch {
      const allPanel = overlay.querySelector(
        '.stats-tab-panel[data-tab="all"]',
      );
      if (allPanel) {
        allPanel.innerHTML = `<div class="stats-error">Failed to load stats</div>`;
      }
    }
  }
}
