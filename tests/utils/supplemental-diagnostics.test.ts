import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runSupplementalDiagnosticProviders,
  supplementalDiagnosticProviders,
} from "../../src/utils/supplemental-diagnostics.js";

function makeFixture(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

describe("supplementalDiagnosticProviders", () => {
  it("detects TypeScript projects from tsconfig.json", () => {
    const dir = makeFixture("supplemental-tsconfig-");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ files: [] }));

    expect(supplementalDiagnosticProviders[0].detect(dir)).toBe(true);
  });

  it("detects TypeScript projects from package.json dependencies", () => {
    const dir = makeFixture("supplemental-package-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5.7.0" } }),
    );

    expect(supplementalDiagnosticProviders[0].detect(dir)).toBe(true);
  });

  it("detects TypeScript projects from discovered source files", () => {
    const dir = makeFixture("supplemental-source-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "const value = 1;\n");

    expect(supplementalDiagnosticProviders[0].detect(dir)).toBe(true);
  });
});

describe("runSupplementalDiagnosticProviders", () => {
  it("formats deprecated TypeScript suggestion diagnostics as warnings", async () => {
    const dir = makeFixture("supplemental-deprecated-");
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        files: ["index.ts"],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.ts"),
      `interface Legacy {
  /** @deprecated use next */
  old: string;
}

const value: Legacy = { old: "x" };
value.old;
`,
    );

    const output = await runSupplementalDiagnosticProviders(dir);

    expect(output).toContain("TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:");
    expect(output).toMatch(/index\.ts:\d+:\d+ warning TS\d+:/);
    expect(output).toContain("deprecated");
  });

  it("filters out non-deprecation suggestion diagnostics", async () => {
    const dir = makeFixture("supplemental-filter-");
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        files: ["index.ts"],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.ts"),
      `const value: number = 1;
value;
`,
    );

    const output = await runSupplementalDiagnosticProviders(dir);

    expect(output).toBe("");
  });

  it("returns no output for directories with no TypeScript setup", async () => {
    const dir = makeFixture("supplemental-empty-");

    const output = await runSupplementalDiagnosticProviders(dir);

    expect(output).toBe("");
  });

  it("reports useful info when detected TypeScript setup is invalid", async () => {
    const dir = makeFixture("supplemental-invalid-");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{");

    const output = await runSupplementalDiagnosticProviders(dir);

    expect(output).toContain("TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:");
    expect(output).toContain("info: typescript-language-service-suggestions could not run:");
  });
});
