import { describe, expect, it } from "vitest";
import { formatHelp } from "../src/cli/help.js";

describe("pi-team CLI", () => {
  it("formats help text", () => {
    expect(formatHelp()).toContain("Usage: pi-team");
  });
});
