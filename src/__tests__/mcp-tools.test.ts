import { describe, it, expect } from "vitest";
import { err } from "../index.js";

describe("err helper", () => {
  it("formats Error objects", () => {
    const result = err(new Error("test"));
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: test" }],
      isError: true,
    });
  });

  it("formats string errors", () => {
    const result = err("string error");
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: string error" }],
      isError: true,
    });
  });

  it("formats number errors", () => {
    const result = err(42);
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: 42" }],
      isError: true,
    });
  });
});
