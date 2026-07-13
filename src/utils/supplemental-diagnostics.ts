import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { type ProcessResult } from "./command.js";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";
import { listGitVisiblePathsCancellable } from "./git-utils.js";
import { parseCompleteGitNulRecords } from "./git-status.js";

type TypeScript = typeof import("typescript");

type TypeScriptProject = {
  rootDir: string;
  label: string;
  rootFileNames: string[];
  options: import("typescript").CompilerOptions;
};

type TypeScriptProjectReadResult = {
  projects: TypeScriptProject[];
  notes: string[];
};

type RecursiveFileDiscoveryOptions = {
  limit: number;
  includeFile: (fileName: string, fullPath: string) => boolean;
  skipDirectory?: (dirName: string) => boolean;
};

export type SupplementalDiagnosticProvider = {
  name: string;
  detect: (workingDir: string) => boolean;
  run: (workingDir: string, options?: CancellationOptions) => Promise<string>;
};

const SKIPPED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "public",
  "target",
  "vendor",
]);

const MAX_TYPESCRIPT_PROJECTS = 20;
const MAX_TYPESCRIPT_ROOT_FILES = 1_000;
const GIT_FILE_LIST_MAX_BYTES = 4 * 1024 * 1024;
const SUPPLEMENTAL_PROVIDER_MAX_MS = 30_000;

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

function shouldSkipDirectory(name: string): boolean {
  return SKIPPED_DIRS.has(name);
}

function isTypeScriptSourceFile(fileName: string): boolean {
  return (
    (fileName.endsWith(".ts") || fileName.endsWith(".tsx")) &&
    !fileName.endsWith(".d.ts")
  );
}

function discoverFilesRecursive(
  workingDir: string,
  {
    limit,
    includeFile,
    skipDirectory = shouldSkipDirectory,
  }: RecursiveFileDiscoveryOptions,
): string[] {
  const files: string[] = [];

  function visit(dir: string): void {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory(entry.name)) visit(fullPath);
        if (files.length >= limit) return;
        continue;
      }

      if (entry.isFile() && includeFile(entry.name, fullPath)) {
        files.push(fullPath);
        if (files.length >= limit) return;
      }
    }
  }

  visit(workingDir);
  files.sort();
  return files;
}

function discoverTypeScriptConfigPaths(workingDir: string): string[] {
  const rootTsconfig = path.join(workingDir, "tsconfig.json");
  if (fs.existsSync(rootTsconfig)) return [rootTsconfig];

  return discoverFilesRecursive(workingDir, {
    limit: MAX_TYPESCRIPT_PROJECTS,
    includeFile: (fileName) => fileName === "tsconfig.json",
  });
}

function discoverTypeScriptFiles(
  workingDir: string,
  limit = MAX_TYPESCRIPT_ROOT_FILES + 1,
): string[] {
  return discoverFilesRecursive(workingDir, {
    limit,
    includeFile: isTypeScriptSourceFile,
  });
}

function detectTypeScriptProject(workingDir: string): boolean {
  return (
    discoverTypeScriptConfigPaths(workingDir).length > 0 ||
    hasTypeScriptDependency(workingDir) ||
    discoverTypeScriptFiles(workingDir, 1).length > 0
  );
}

function resolveTypeScript(projectDir: string): TypeScript {
  try {
    const projectRequire = createRequire(path.join(projectDir, "package.json"));
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

function readTypeScriptConfigProject(
  ts: TypeScript,
  workingDir: string,
  tsconfigPath: string,
): TypeScriptProject {
  const rootDir = path.dirname(tsconfigPath);
  const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, " "));
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    rootDir,
  );
  if (parsed.errors.length > 0) {
    const message = parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
      .join("; ");
    throw new Error(message);
  }

  return {
    rootDir,
    label: path.relative(workingDir, tsconfigPath) || "tsconfig.json",
    rootFileNames: parsed.fileNames.filter(isTypeScriptSourceFile),
    options: parsed.options,
  };
}

function defaultCompilerOptions(ts: TypeScript): import("typescript").CompilerOptions {
  return {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
}

export function parseGitVisibleTypeScriptFiles(
  result: ProcessResult,
  workingDir: string,
): string[] | null {
  let records: string[];
  try {
    records = parseCompleteGitNulRecords(result, "supplemental TypeScript file inventory");
  } catch {
    return null;
  }

  return typeScriptPathsFromRecords(records, workingDir);
}

function typeScriptPathsFromRecords(records: string[], workingDir: string): string[] {
  return records
    .filter(isTypeScriptSourceFile)
    .map((fileName) => path.join(workingDir, fileName))
    .sort();
}

async function discoverGitVisibleTypeScriptFiles(
  workingDir: string,
  options: CancellationOptions,
): Promise<string[] | null> {
  try {
    const paths = await listGitVisiblePathsCancellable(workingDir, {
      ...options,
      maxStdoutBytes: GIT_FILE_LIST_MAX_BYTES,
      maxStderrBytes: 64 * 1024,
    });
    return typeScriptPathsFromRecords(paths, workingDir);
  } catch {
    throwIfAborted(options.signal);
    return null;
  }
}

async function readTypeScriptProjects(
  ts: TypeScript,
  workingDir: string,
  options: CancellationOptions,
): Promise<TypeScriptProjectReadResult> {
  const notes: string[] = [];
  const tsconfigPaths = discoverTypeScriptConfigPaths(workingDir);
  if (tsconfigPaths.length > 0) {
    if (tsconfigPaths.length >= MAX_TYPESCRIPT_PROJECTS) {
      notes.push(`info: typescript-language-service-suggestions limited tsconfig discovery to ${MAX_TYPESCRIPT_PROJECTS} projects.`);
    }

    const projects: TypeScriptProject[] = [];
    for (const tsconfigPath of tsconfigPaths.slice(0, MAX_TYPESCRIPT_PROJECTS)) {
      throwIfAborted(options.signal);
      try {
        const project = readTypeScriptConfigProject(ts, workingDir, tsconfigPath);
        if (project.rootFileNames.length > MAX_TYPESCRIPT_ROOT_FILES) {
          notes.push(
            `info: skipped ${project.label}: ${project.rootFileNames.length} TypeScript root files exceeds supplemental limit ${MAX_TYPESCRIPT_ROOT_FILES}.`,
          );
          continue;
        }
        if (project.rootFileNames.length > 0) projects.push(project);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`info: could not read ${path.relative(workingDir, tsconfigPath)}: ${message}`);
      }
    }
    return { projects, notes };
  }

  const gitVisibleFiles = await discoverGitVisibleTypeScriptFiles(workingDir, options);
  const rootFileNames = gitVisibleFiles ?? discoverTypeScriptFiles(workingDir);
  if (rootFileNames.length > MAX_TYPESCRIPT_ROOT_FILES) {
    return {
      projects: [],
      notes: [
        `info: skipped fallback TypeScript diagnostics: ${rootFileNames.length} TypeScript files without a tsconfig exceeds supplemental limit ${MAX_TYPESCRIPT_ROOT_FILES}.`,
      ],
    };
  }

  return {
    projects: rootFileNames.length > 0
      ? [{
          rootDir: workingDir,
          label: gitVisibleFiles ? "git-visible TypeScript files" : "discovered TypeScript files",
          rootFileNames,
          options: defaultCompilerOptions(ts),
        }]
      : [],
    notes,
  };
}

function createLanguageServiceHost(
  ts: TypeScript,
  project: TypeScriptProject,
): import("typescript").LanguageServiceHost {
  return {
    getCompilationSettings: () => project.options,
    getCurrentDirectory: () => project.rootDir,
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
}

async function runTypeScriptLanguageServiceSuggestions(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<string> {
  if (!detectTypeScriptProject(workingDir)) return "";

  try {
    throwIfAborted(options.signal);
    const ts = resolveTypeScript(workingDir);
    const { projects, notes } = await readTypeScriptProjects(ts, workingDir, options);
    if (projects.length === 0 && notes.length === 0) return "";

    const deadline = Date.now() + SUPPLEMENTAL_PROVIDER_MAX_MS;
    const lines: string[] = [];
    let stoppedForBudget = false;
    for (const project of projects) {
      throwIfAborted(options.signal);
      if (Date.now() > deadline) {
        stoppedForBudget = true;
        break;
      }

      const service = ts.createLanguageService(
        createLanguageServiceHost(ts, project),
        ts.createDocumentRegistry(),
      );
      try {
        for (const fileName of project.rootFileNames) {
          throwIfAborted(options.signal);
          if (Date.now() > deadline) {
            stoppedForBudget = true;
            break;
          }
          const diagnostics = service
            .getSuggestionDiagnostics(fileName)
            .filter((diagnostic) => diagnostic.reportsDeprecated);
          for (const diagnostic of diagnostics) {
            const formatted = formatTypeScriptDiagnostic(ts, workingDir, diagnostic);
            if (formatted) lines.push(formatted);
          }
        }
      } finally {
        service.dispose();
      }
      if (stoppedForBudget) break;
    }

    if (stoppedForBudget) {
      notes.push(`info: stopped TypeScript supplemental diagnostics after ${SUPPLEMENTAL_PROVIDER_MAX_MS}ms internal budget.`);
    }

    const outputLines = [...notes, ...lines];
    if (outputLines.length === 0) return "";
    return `TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:\n${outputLines.join("\n")}`;
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
