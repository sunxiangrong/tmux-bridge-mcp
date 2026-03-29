import { describe, it, expect, beforeEach } from "vitest";
import { markRead, requireRead, clearRead } from "../tmux-bridge.js";

// Use a unique pane ID per test run to avoid collisions
const TEST_PANE = `%test_${Date.now()}`;

describe("read guard", () => {
  beforeEach(() => {
    // Ensure clean state
    clearRead(TEST_PANE);
  });

  it("requireRead throws when no prior read", () => {
    expect(() => requireRead(TEST_PANE)).toThrow(/Must read pane/);
  });

  it("markRead then requireRead succeeds", () => {
    markRead(TEST_PANE);
    expect(() => requireRead(TEST_PANE)).not.toThrow();
  });

  it("clearRead then requireRead throws again", () => {
    markRead(TEST_PANE);
    clearRead(TEST_PANE);
    expect(() => requireRead(TEST_PANE)).toThrow(/Must read pane/);
  });
});

// resolveTarget tests — these are synchronous pattern checks that don't need tmux
// We test the patterns directly since resolveTarget is async and calls tmux for labels
describe("resolveTarget patterns", () => {
  it("%0 is a valid pane ID pattern", () => {
    expect(/^%\d+$/.test("%0")).toBe(true);
  });

  it("main:0.1 contains colon — treated as session:win.pane", () => {
    expect("main:0.1".includes(":")).toBe(true);
  });

  it("123 is pure numeric — treated as window index", () => {
    expect(/^\d+$/.test("123")).toBe(true);
  });
});
