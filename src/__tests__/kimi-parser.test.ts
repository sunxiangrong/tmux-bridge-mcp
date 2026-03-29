import { describe, it, expect } from "vitest";
import { parseToolCalls, parseFuncArgs } from "../kimi-adapter.js";

describe("parseToolCalls", () => {
  it("parses JSON style tool call", () => {
    const output = '```tool\n{"name": "tmux_read", "args": {"target": "codex", "lines": 20}}\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("tmux_read");
    expect(calls[0].args).toEqual({ target: "codex", lines: 20 });
  });

  it("parses JSON array of tool calls", () => {
    const output = '```tool\n[{"name":"tmux_read","args":{"target":"a"}},{"name":"tmux_list","args":{}}]\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("tmux_read");
    expect(calls[0].args).toEqual({ target: "a" });
    expect(calls[1].name).toBe("tmux_list");
    expect(calls[1].args).toEqual({});
  });

  it("parses function-call style", () => {
    const output = '```tool\ntmux_read(target="codex", lines=20)\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("tmux_read");
    expect(calls[0].args.target).toBe("codex");
    expect(calls[0].args.lines).toBe(20);
  });

  it("parses multiple calls in one block (one per line)", () => {
    const output = '```tool\ntmux_read(target="codex", lines=20)\ntmux_list()\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("tmux_read");
    expect(calls[1].name).toBe("tmux_list");
  });

  it("returns no calls for empty block", () => {
    const output = '```tool\n\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(0);
  });

  it("skips malformed JSON with warning", () => {
    const output = '```tool\n{bad json\n```';
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(0);
  });

  it("returns no calls when no tool block present", () => {
    const output = "Here is some text without any tool blocks.";
    const calls = parseToolCalls(output);
    expect(calls).toHaveLength(0);
  });
});

describe("parseFuncArgs", () => {
  it("returns empty args for empty string", () => {
    expect(parseFuncArgs("")).toEqual({});
  });

  it("parses key=value with double quotes", () => {
    const args = parseFuncArgs('target="codex", lines=20');
    expect(args.target).toBe("codex");
    expect(args.lines).toBe(20);
  });

  it("parses single-quoted strings", () => {
    const args = parseFuncArgs("target='codex'");
    expect(args.target).toBe("codex");
  });

  it("parses nested quotes in text args", () => {
    const args = parseFuncArgs('text="he said \\"hello\\""');
    expect(args.text).toBe('he said "hello"');
  });
});
