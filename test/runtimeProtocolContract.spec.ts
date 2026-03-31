import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "../src/runtime-adapter";

function readProtocolSpecVersion(): string {
  const specPath = path.resolve(
    __dirname,
    "..",
    "openapi",
    "runtime-enforcement.yaml",
  );
  const source = fs.readFileSync(specPath, "utf8");
  const match = source.match(/^\s*version:\s*([0-9-]+)\s*$/m);
  if (!match?.[1]) {
    throw new Error(`Unable to locate protocol version in ${specPath}`);
  }
  return match[1];
}

describe("runtime protocol contract", () => {
  it("keeps the public SDK runtime version aligned with sec0-runtime-protocol", () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(readProtocolSpecVersion());
  });
});
