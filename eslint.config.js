// Minimal ESLint config — catches undefined variables and common errors.
// Not a style linter (prettier handles formatting).

const nodeGlobals = {
  require: "readonly",
  module: "readonly",
  exports: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  AbortController: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  HTMLElement: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  customElements: "readonly",
  navigator: "readonly",
  getComputedStyle: "readonly",
  localStorage: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  DragEvent: "readonly",
  Event: "readonly",
  ClipboardEvent: "readonly",
  AudioContext: "readonly",
  Audio: "readonly",
  OscillatorNode: "readonly",
  GainNode: "readonly",
};

// Renderer files use ES modules (bundled by esbuild)
const rendererFiles = [
  "src/agent-picker.js",
  "src/command-palette.js",
  "src/dock-helpers.js",
  "src/dock-layout.js",
  "src/editor.js",
  "src/overlay-dialog.js",
  "src/pool-ui.js",
  "src/renderer.js",
  "src/renderer-state.js",
  "src/session-search.js",
  "src/session-sidebar.js",
  "src/stats-ui.js",
  "src/terminal-manager.js",
];

module.exports = [
  // Main process + preload (CommonJS)
  {
    files: ["src/**/*.js", "bin/*"],
    ignores: rendererFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "error",
    },
  },
  // Renderer (ES modules, browser + node globals via preload)
  {
    files: rendererFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
