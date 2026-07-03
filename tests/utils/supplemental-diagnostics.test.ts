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

  it("does not detect TypeScript projects only from skipped generated directories", () => {
    const dir = makeFixture("supplemental-skipped-");
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "generated.ts"), "const value = 1;\n");

    expect(supplementalDiagnosticProviders[0].detect(dir)).toBe(false);
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
    expect(output).toContain("info: could not read tsconfig.json:");
  });

  it("uses nested tsconfig projects instead of a synthetic root project", async () => {
    const dir = makeFixture("supplemental-nested-tsconfig-");
    const appDir = path.join(dir, "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "tsconfig.json"),
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
      path.join(appDir, "index.ts"),
      `interface Legacy {
  /** @deprecated use next */
  old: string;
}

const value: Legacy = { old: "x" };
value.old;
`,
    );
    fs.writeFileSync(
      path.join(dir, "ignored.ts"),
      `interface RootLegacy {
  /** @deprecated ignored */
  old: string;
}

const ignored: RootLegacy = { old: "x" };
ignored.old;
`,
    );

    const output = await runSupplementalDiagnosticProviders(dir);

    expect(output).toContain("app/index.ts");
    expect(output).not.toContain("ignored.ts");
  });
});
