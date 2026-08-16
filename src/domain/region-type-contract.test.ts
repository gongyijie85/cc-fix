import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return productionTypeScriptFiles(path);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function publiclyExportsRegionCode(path: string): boolean {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  return source.statements.some((statement) => {
    if (ts.isExportDeclaration(statement) && statement.exportClause
      && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.some((element) => element.name.text === "RegionCode");
    }

    if (!(
      ts.isTypeAliasDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
    )) return false;

    return statement.name?.text === "RegionCode"
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  });
}

describe("public RegionCode naming contract", () => {
  it("exports RegionCode only from the target-region domain", () => {
    const declarations = productionTypeScriptFiles(SRC_ROOT)
      .filter(publiclyExportsRegionCode)
      .map((path) => relative(SRC_ROOT, path).replaceAll("\\", "/"));

    expect(declarations).toEqual(["domain/region.ts"]);
  });

  it("names the legacy detection classification AccessRegionCode", () => {
    const detectionTypes = readFileSync(resolve(SRC_ROOT, "detection/types.ts"), "utf8");

    expect(detectionTypes).toMatch(
      /export\s+type\s+AccessRegionCode\s*=\s*"auto"\s*\|\s*"cn"\s*\|\s*"ru"\s*\|\s*"ir"/,
    );
  });

});
