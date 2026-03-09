import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const htmlSource = fs.readFileSync(
  path.join(__dirname, "../src/index.html"),
  "utf-8",
);

const cssSource = fs.readFileSync(
  path.join(__dirname, "../src/styles.css"),
  "utf-8",
);

describe("Command palette HTML", () => {
  it("has the command palette container", () => {
    expect(htmlSource).toContain('id="command-palette"');
  });

  it("has the input field", () => {
    expect(htmlSource).toContain('id="command-palette-input"');
  });

  it("has the list container", () => {
    expect(htmlSource).toContain('id="command-palette-list"');
  });

  it("has the dialog wrapper", () => {
    expect(htmlSource).toContain('id="command-palette-dialog"');
  });

  it("input has placeholder text", () => {
    expect(htmlSource).toContain('placeholder="Type a command..."');
  });

  it("input has autocomplete and spellcheck disabled", () => {
    expect(htmlSource).toContain('autocomplete="off"');
    expect(htmlSource).toContain('spellcheck="false"');
  });
});

describe("Command palette CSS", () => {
  it("palette uses shared overlay-picker class", () => {
    expect(htmlSource).toContain('class="overlay-picker"');
  });

  it("overlay picker is hidden by default (display: none)", () => {
    expect(cssSource).toContain(".overlay-picker {");
    expect(cssSource).toContain("display: none;");
  });

  it("overlay picker shows when .visible class applied", () => {
    expect(cssSource).toContain(".overlay-picker.visible {");
    expect(cssSource).toContain("display: flex;");
  });

  it("has styling for selected items", () => {
    expect(cssSource).toContain(".overlay-picker-item.selected");
  });

  it("has z-index for overlay", () => {
    expect(cssSource).toContain("z-index: 1000;");
  });
});

describe("Sidebar collapse CSS", () => {
  it("has collapsed state styles", () => {
    expect(cssSource).toContain("#sidebar.collapsed");
    expect(cssSource).toContain("width: 0;");
    expect(cssSource).toContain("min-width: 0;");
  });
});
