import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import { buildMetadata, version } from "./version.js";

describe("version identity", () => {
  it("uses the package version for runtime and build metadata", () => {
    expect(version).toBe(packageJson.version);
    expect(buildMetadata.version).toBe(packageJson.version);
  });
});
