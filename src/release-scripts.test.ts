import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const declaredSemver = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\d.])/g;

describe("legacy release scripts", () => {
  it("derives the install banner version without redeclaring it", async () => {
    const installSource = await readFile(new URL("../scripts/install.ps1", import.meta.url), "utf8");

    expect(installSource).toContain("package.json");
    expect(installSource.match(declaredSemver) ?? []).toEqual([]);
  });

  it("validates release contracts before npm publish", async () => {
    const publishSource = await readFile(new URL("../scripts/publish.ps1", import.meta.url), "utf8");
    const validationPosition = publishSource.search(/^pnpm release:validate\s*$/m);
    const validationFailureGuardPosition = publishSource.indexOf("if ($LASTEXITCODE -ne 0)");
    const buildPosition = publishSource.search(/^pnpm build\s*$/m);
    const publishPosition = publishSource.search(/^npm publish\b/m);

    expect(validationPosition).toBeGreaterThanOrEqual(0);
    expect(validationFailureGuardPosition).toBeGreaterThan(validationPosition);
    expect(validationFailureGuardPosition).toBeLessThan(buildPosition);
    expect(validationPosition).toBeLessThan(buildPosition);
    expect(validationPosition).toBeLessThan(publishPosition);
  });
});
