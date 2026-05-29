import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";

type TypeScript = typeof import("typescript");

export type SupplementalDiagnosticProvider = {
  name: string;
  detect: (workingDir: string) => boolean;
  run: (workingDir: string, options?: CancellationOptions) => Promise<string>;
};

const SKIPPED_DIRS = new Set([
  ".git",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);

function hasTypeScriptDependency(workingDir: string): boolean {
  const packageJsonPath = path.join(workingDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return Boolean(
      packageJson.dependencies?.typescript ||
        packageJson.devDependencies?.typescript,
    );
  } catch {
    return false;
  }
}

function discoverTypeScriptFiles(workingDir: string): string[] {
  const files: string[] = [];

  function visit(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          visit(fullPath);
        }
        continue;
      }

      if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(fullPath);
      }
    }
  }

  visit(workingDir);
  files.sort();
  return files;
}

function detectTypeScriptProject(workingDir: string): boolean {
  return (
    fs.existsSync(path.join(workingDir, "tsconfig.json")) ||
    hasTypeScriptDependency(workingDir) ||
    discoverTypeScriptFiles(workingDir).length > 0
  );
}

function resolveTypeScript(workingDir: string): TypeScript {
  try {
    const projectRequire = createRequire(path.join(workingDir, "package.json"));
    return projectRequire("typescript") as TypeScript;
  } catch {
    const frameworkRequire = createRequire(import.meta.url);
    return frameworkRequire("typescript") as TypeScript;
  }
}

function formatTypeScriptDiagnostic(
  ts: TypeScript,
  workingDir: string,
  diagnostic: import("typescript").Diagnostic,
): string | null {
  if (!diagnostic.file || diagnostic.start === undefined) return null;

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const relativePath = path.relative(workingDir, diagnostic.file.fileName);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  return `${relativePath}:${position.line + 1}:${position.character + 1} warning TS${diagnostic.code}: ${message}`;
}

function readTypeScriptProject(
  ts: TypeScript,
  workingDir: string,
): {
  rootFileNames: string[];
  options: import("typescript").CompilerOptions;
} {
  const tsconfigPath = path.join(workingDir, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (readResult.error) {
      throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, " "));
    }

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      workingDir,
    );
    if (parsed.errors.length > 0) {
      const message = parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
        .join("; ");
      throw new Error(message);
    }

    return {
      rootFileNames: parsed.fileNames,
      options: parsed.options,
    };
  }

  return {
    rootFileNames: discoverTypeScriptFiles(workingDir),
    options: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    },
  };
}

async function runTypeScriptLanguageServiceSuggestions(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<string> {
  if (!detectTypeScriptProject(workingDir)) return "";

  try {
    throwIfAborted(options.signal);
    const ts = resolveTypeScript(workingDir);
    const project = readTypeScriptProject(ts, workingDir);
    if (project.rootFileNames.length === 0) return "";

    const host: import("typescript").LanguageServiceHost = {
      getCompilationSettings: () => project.options,
      getCurrentDirectory: () => workingDir,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      getScriptFileNames: () => project.rootFileNames,
      getScriptSnapshot: (fileName) => {
        if (!ts.sys.fileExists(fileName)) return undefined;
        const content = ts.sys.readFile(fileName);
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getScriptVersion: () => "0",
      readFile: ts.sys.readFile,
      fileExists: ts.sys.fileExists,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      readDirectory: ts.sys.readDirectory,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };

    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const lines: string[] = [];
    for (const fileName of project.rootFileNames) {
      throwIfAborted(options.signal);
      const diagnostics = service
        .getSuggestionDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.reportsDeprecated);
      for (const diagnostic of diagnostics) {
        const formatted = formatTypeScriptDiagnostic(ts, workingDir, diagnostic);
        if (formatted) lines.push(formatted);
      }
    }

    if (lines.length === 0) return "";
    return `TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:\n${lines.join("\n")}`;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return `TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:\ninfo: typescript-language-service-suggestions could not run: ${message}`;
  }
}

export const supplementalDiagnosticProviders: SupplementalDiagnosticProvider[] = [
  {
    name: "typescript-language-service-suggestions",
    detect: detectTypeScriptProject,
    run: runTypeScriptLanguageServiceSuggestions,
  },
];

export async function runSupplementalDiagnosticProviders(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<string> {
  const outputs: string[] = [];

  for (const provider of supplementalDiagnosticProviders) {
    throwIfAborted(options.signal);
    if (!provider.detect(workingDir)) continue;
    const output = await provider.run(workingDir, options);
    if (output.trim().length > 0) {
      outputs.push(output);
    }
  }

  return outputs.join("\n\n");
}
