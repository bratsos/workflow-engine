#!/usr/bin/env node

import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";

type TypeScriptApi = typeof import("typescript");

const MISSING_TYPESCRIPT_MESSAGE =
  'workflow-engine-codemod requires the optional peer dependency "typescript" (>=5.0.0).';

function loadTypeScript(): TypeScriptApi {
  try {
    return createRequire(import.meta.url)("typescript") as TypeScriptApi;
  } catch {
    console.error(MISSING_TYPESCRIPT_MESSAGE);
    process.exit(1);
  }
}

const ts: TypeScriptApi = loadTypeScript();

export type CodemodVersion = "0.11" | "0.12";

export interface CodemodOptions {
  from?: CodemodVersion;
  fileName?: string;
}

export interface CodemodEdit {
  rule: number;
  start: number;
  end: number;
  line: number;
  column: number;
  from: string;
  to: string;
}

export interface CodemodFinding {
  rule: number;
  start: number;
  line: number;
  column: number;
  message: string;
  suggestion: string;
}

export interface ParseError {
  line: number;
  column: number;
  message: string;
}

export interface SourceCodemodResult {
  source: string;
  transformedSource: string;
  edits: CodemodEdit[];
  findings: CodemodFinding[];
  parseErrors: ParseError[];
  generated: boolean;
  skipped: boolean;
}

export interface PackageSourceInput {
  fileName: string;
  source: string;
}

export interface PackageJsonCodemodResult {
  findings: CodemodFinding[];
  parseErrors: ParseError[];
}

const REMOVED_BATCH_IMPORTS = new Set([
  "AnthropicBatchProvider",
  "GoogleBatchProvider",
  "OpenAIBatchProvider",
  "AnthropicBatchProviderConfig",
  "GoogleBatchProviderConfig",
  "OpenAIBatchProviderConfig",
  "AnthropicBatchRequest",
  "GoogleBatchRequest",
  "OpenAIBatchRequest",
  "BatchRequestText",
  "BatchRequestWithSchema",
  "BatchStatus",
]);

const VENDOR_DEPENDENCIES = new Set([
  "@anthropic-ai/sdk",
  "@google/genai",
  "openai",
]);

const DEPENDENCY_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next"]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const PACKAGE_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const MESSAGE_REMOVED_IMPORT =
  "removed in 0.13; drive batches through ai.batch()";
const MESSAGE_STATUS =
  "pass the suspended-state metadata as the second argument: getStatus(id, state.metadata)";
const MESSAGE_RESULTS =
  "pass metadata (batchRefs, requestIds, schemas) as the second argument; results are not schema-validated unless schemas are re-supplied";
const MESSAGE_DISCOUNT =
  "prefer batchInputCostPerMillion/batchOutputCostPerMillion; re-run workflow-engine-sync";
const MESSAGE_API_KEY =
  "SuspendedStateSchema.apiKey is deprecated; use BatchOptions.apiKey";
const MESSAGE_VENDOR_DEPENDENCY =
  "no longer required by @bratsos/workflow-engine; remove if your own code does not import it";

function scriptKindForFile(fileName: string): TypeScript.ScriptKind {
  return extname(fileName).toLowerCase() === ".tsx"
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function packageScriptKindForFile(fileName: string): TypeScript.ScriptKind {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".tsx" || extension === ".jsx") return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function createSourceFile(
  source: string,
  fileName: string,
): TypeScript.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName),
  );
}

function createPackageSourceFile(
  source: string,
  fileName: string,
): TypeScript.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    packageScriptKindForFile(fileName),
  );
}

function isGeneratedSource(source: string): boolean {
  return source
    .split(/\r\n|\r|\n/)
    .slice(0, 3)
    .some((line) => line.includes("AUTO-GENERATED"));
}

function unwrapExpression(
  expression: TypeScript.Expression,
): TypeScript.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyAccessName(
  expression: TypeScript.Expression,
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  return ts.isPropertyAccessExpression(unwrapped)
    ? unwrapped.name.text
    : undefined;
}

function objectLiteralArgument(
  argument: TypeScript.Expression,
): TypeScript.ObjectLiteralExpression | undefined {
  const unwrapped = unwrapExpression(argument);
  return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
}

function identifierPropertyAssignment(
  member: TypeScript.ObjectLiteralElementLike,
): TypeScript.Identifier | undefined {
  if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) {
    return undefined;
  }
  return member.name;
}

function addEdit(
  edits: CodemodEdit[],
  sourceFile: TypeScript.SourceFile,
  name: TypeScript.Identifier,
  rule: number,
  to: string,
): void {
  edits.push({
    rule,
    start: name.getStart(sourceFile),
    end: name.end,
    line:
      sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile)).line +
      1,
    column:
      sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile))
        .character + 1,
    from: name.text,
    to,
  });
}

function addFinding(
  findings: CodemodFinding[],
  sourceFile: TypeScript.SourceFile,
  node: TypeScript.Node,
  rule: number,
  message: string,
  suggestion: string,
): void {
  const start = node.getStart(sourceFile);
  const location = sourceFile.getLineAndCharacterOfPosition(start);
  findings.push({
    rule,
    start,
    line: location.line + 1,
    column: location.character + 1,
    message,
    suggestion,
  });
}

function parseErrorsForSource(sourceFile: TypeScript.SourceFile): ParseError[] {
  const parseDiagnostics = (
    sourceFile as TypeScript.SourceFile & {
      parseDiagnostics?: readonly TypeScript.Diagnostic[];
    }
  ).parseDiagnostics;

  return (parseDiagnostics ?? []).map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const location = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      line: location.line + 1,
      column: location.character + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    };
  });
}

function collectBatchVariableNames(
  sourceFile: TypeScript.SourceFile,
): Set<string> {
  const names = new Set<string>();

  const visit = (node: TypeScript.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer && isBatchCall(node.initializer)) {
        names.add(node.name.text);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isBatchCall(node.right)
    ) {
      names.add(node.left.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

function isBatchCall(expression: TypeScript.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    ts.isCallExpression(unwrapped) &&
    propertyAccessName(unwrapped.expression) === "batch"
  );
}

function addSafeRenames(
  sourceFile: TypeScript.SourceFile,
  edits: CodemodEdit[],
): void {
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = propertyAccessName(node.expression);
      if (method === "generateText") {
        for (const argument of node.arguments) {
          const object = objectLiteralArgument(argument);
          if (!object) continue;
          for (const member of object.properties) {
            const name = identifierPropertyAssignment(member);
            if (name?.text === "experimental_output") {
              addEdit(edits, sourceFile, name, 1, "output");
            }
          }
        }
      }

      if (
        method === "generateText" ||
        method === "generateObject" ||
        method === "streamText"
      ) {
        for (const argument of node.arguments) {
          const object = objectLiteralArgument(argument);
          if (!object) continue;
          for (const member of object.properties) {
            const name = identifierPropertyAssignment(member);
            if (name?.text === "onStepFinish") {
              addEdit(edits, sourceFile, name, 2, "onStepEnd");
            }
          }
        }
      }

      if (method === "streamText") {
        const object = node.arguments[1]
          ? objectLiteralArgument(node.arguments[1])
          : undefined;
        if (object) {
          for (const member of object.properties) {
            const name = identifierPropertyAssignment(member);
            if (name?.text === "system") {
              addEdit(edits, sourceFile, name, 3, "instructions");
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function addManualFindings(
  sourceFile: TypeScript.SourceFile,
  findings: CodemodFinding[],
): void {
  const batchVariableNames = collectBatchVariableNames(sourceFile);

  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (
        (moduleName === "@bratsos/workflow-engine" ||
          moduleName === "@bratsos/workflow-engine/client") &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          const imported = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(imported) &&
            REMOVED_BATCH_IMPORTS.has(imported.text)
          ) {
            addFinding(
              findings,
              sourceFile,
              imported,
              4,
              MESSAGE_REMOVED_IMPORT,
              "Replace direct provider usage with ai.batch().",
            );
          }
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = unwrapExpression(node.expression.expression);
      if (
        node.arguments.length === 1 &&
        ts.isIdentifier(receiver) &&
        (receiver.text === "batch" ||
          receiver.text === "provider" ||
          batchVariableNames.has(receiver.text))
      ) {
        if (method === "getStatus") {
          addFinding(
            findings,
            sourceFile,
            node.expression.name,
            5,
            MESSAGE_STATUS,
            "Pass state.metadata as the second argument.",
          );
        }
        if (method === "getResults") {
          addFinding(
            findings,
            sourceFile,
            node.expression.name,
            6,
            MESSAGE_RESULTS,
            "Pass state.metadata, including batchRefs, requestIds, and schemas, as the second argument.",
          );
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const hasBatchId = node.properties.some(
        (member) => identifierPropertyAssignment(member)?.text === "batchId",
      );
      for (const member of node.properties) {
        const name = identifierPropertyAssignment(member);
        if (!name) continue;
        if (name.text === "batchDiscountPercent") {
          addFinding(
            findings,
            sourceFile,
            name,
            7,
            MESSAGE_DISCOUNT,
            "Replace the discount field with absolute batch prices and re-run workflow-engine-sync.",
          );
        }
        if (name.text === "apiKey" && hasBatchId) {
          addFinding(
            findings,
            sourceFile,
            name,
            8,
            MESSAGE_API_KEY,
            "Move the key to BatchOptions.apiKey.",
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function applyEdits(source: string, edits: readonly CodemodEdit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) =>
        `${result.slice(0, edit.start)}${edit.to}${result.slice(edit.end)}`,
      source,
    );
}

/** Analyze and safely transform one TypeScript source string without touching unrelated text. */
export function transformSource(
  source: string,
  options: CodemodOptions = {},
): SourceCodemodResult {
  const generated = isGeneratedSource(source);
  if (generated) {
    return {
      source,
      transformedSource: source,
      edits: [],
      findings: [],
      parseErrors: [],
      generated: true,
      skipped: true,
    };
  }

  const fileName = options.fileName ?? "file.ts";
  const sourceFile = createSourceFile(source, fileName);
  const parseErrors = parseErrorsForSource(sourceFile);
  const edits: CodemodEdit[] = [];
  const findings: CodemodFinding[] = [];

  if (options.from !== "0.12") addSafeRenames(sourceFile, edits);
  addManualFindings(sourceFile, findings);

  edits.sort((left, right) => left.start - right.start);
  findings.sort((left, right) => left.start - right.start);

  return {
    source,
    transformedSource:
      parseErrors.length > 0 ? source : applyEdits(source, edits),
    edits,
    findings,
    parseErrors,
    generated: false,
    skipped: false,
  };
}

function importedModulesFromSource(
  source: string,
  fileName: string,
): Set<string> {
  const sourceFile = createPackageSourceFile(source, fileName);
  const modules = new Set<string>();

  const addModule = (expression: TypeScript.Expression | undefined): void => {
    if (expression && ts.isStringLiteralLike(expression))
      modules.add(expression.text);
  };

  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node)) addModule(node.moduleSpecifier);
    if (ts.isExportDeclaration(node)) addModule(node.moduleSpecifier);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addModule(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const firstArgument = node.arguments[0];
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        addModule(firstArgument);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return modules;
}

function importsDependency(
  importedModules: ReadonlySet<string>,
  dependency: string,
): boolean {
  return [...importedModules].some(
    (moduleName) =>
      moduleName === dependency || moduleName.startsWith(`${dependency}/`),
  );
}

function packageJsonPropertyName(
  member: TypeScript.ObjectLiteralElementLike,
): string | undefined {
  if (!ts.isPropertyAssignment(member)) return undefined;
  return ts.isStringLiteralLike(member.name) || ts.isIdentifier(member.name)
    ? member.name.text
    : undefined;
}

/** Find deprecated vendor dependencies and state whether this package's source imports each one. */
export function inspectPackageJson(
  packageJson: string,
  sourceFiles: readonly PackageSourceInput[] = [],
  fileName = "package.json",
): PackageJsonCodemodResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const positionMatch = message.match(/position (\d+)/i);
    const position = positionMatch?.[1] ? Number(positionMatch[1]) : 0;
    const lineAndCharacter = getLineAndCharacter(packageJson, position);
    return {
      findings: [],
      parseErrors: [
        {
          line: lineAndCharacter.line,
          column: lineAndCharacter.column,
          message,
        },
      ],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      findings: [],
      parseErrors: [
        {
          line: 1,
          column: 1,
          message: "package.json must contain a JSON object",
        },
      ],
    };
  }

  const sourceFile = ts.parseJsonText(fileName, packageJson);
  const parseErrors = parseErrorsForSource(sourceFile);
  if (parseErrors.length > 0) return { findings: [], parseErrors };

  const root = sourceFile.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) {
    return { findings: [], parseErrors: [] };
  }

  const importedModules = new Set<string>();
  for (const sourceInput of sourceFiles) {
    if (isGeneratedSource(sourceInput.source)) continue;
    for (const moduleName of importedModulesFromSource(
      sourceInput.source,
      sourceInput.fileName,
    )) {
      importedModules.add(moduleName);
    }
  }

  const findings: CodemodFinding[] = [];
  for (const section of root.properties) {
    const sectionName = packageJsonPropertyName(section);
    if (!sectionName || !DEPENDENCY_SECTIONS.has(sectionName)) continue;
    if (
      !ts.isPropertyAssignment(section) ||
      !ts.isObjectLiteralExpression(section.initializer)
    ) {
      continue;
    }

    for (const dependency of section.initializer.properties) {
      const dependencyName = packageJsonPropertyName(dependency);
      if (
        !dependencyName ||
        !VENDOR_DEPENDENCIES.has(dependencyName) ||
        !dependency.name
      ) {
        continue;
      }
      const imported = importsDependency(importedModules, dependencyName);
      addFinding(
        findings,
        sourceFile,
        dependency.name,
        9,
        MESSAGE_VENDOR_DEPENDENCY,
        imported
          ? "declared and imported by this package's source; keep it unless that import is removed"
          : "declared but never imported by this package's source; remove it",
      );
    }
  }

  findings.sort((left, right) => left.start - right.start);
  return { findings, parseErrors: [] };
}

function getLineAndCharacter(
  source: string,
  position: number,
): { line: number; column: number } {
  const before = source.slice(
    0,
    Math.max(0, Math.min(position, source.length)),
  );
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

interface CliOptions {
  from: CodemodVersion;
  dryRun: boolean;
  json: boolean;
  paths: string[];
}

interface DiscoveredFiles {
  sources: string[];
  packageJsons: string[];
  errors: string[];
}

interface FileReport {
  file: string;
  changes: CodemodEdit[];
  findings: CodemodFinding[];
  skipped?: boolean;
}

interface CliReport {
  from: CodemodVersion;
  dryRun: boolean;
  files: FileReport[];
  parseErrors: Array<{ file: string; error: ParseError }>;
  summary: {
    changedFiles: number;
    changes: number;
    findings: number;
    parseErrors: number;
  };
}

const USAGE =
  "Usage: npx workflow-engine-codemod [--from 0.11|0.12] [--dry-run] [--json] [paths...]";

function parseArguments(argv: readonly string[], cwd: string): CliOptions {
  let from: CodemodVersion = "0.11";
  let dryRun = false;
  let json = false;
  const paths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      return { from, dryRun, json, paths: [cwd] };
    }
    if (argument === "--from" || argument?.startsWith("--from=")) {
      const value =
        argument === "--from"
          ? argv[++index]
          : argument.slice("--from=".length);
      if (value !== "0.11" && value !== "0.12") {
        throw new Error(
          `${USAGE}\nInvalid --from value: ${value ?? "(missing)"}`,
        );
      }
      from = value;
      continue;
    }
    if (argument?.startsWith("-"))
      throw new Error(`${USAGE}\nUnknown option: ${argument}`);
    if (argument) paths.push(argument);
  }

  return { from, dryRun, json, paths };
}

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name);
}

function discoverFiles(inputPath: string, result: DiscoveredFiles): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(inputPath);
  } catch {
    result.errors.push(`Path does not exist or cannot be read: ${inputPath}`);
    return;
  }

  if (stats.isFile()) {
    const extension = extname(inputPath).toLowerCase();
    if (SOURCE_EXTENSIONS.has(extension)) result.sources.push(inputPath);
    if (basename(inputPath) === "package.json")
      result.packageJsons.push(inputPath);
    return;
  }
  if (!stats.isDirectory()) return;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(inputPath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    result.errors.push(`Directory cannot be read: ${inputPath}`);
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && isSkippedDirectory(entry.name)) continue;
    discoverFiles(resolve(inputPath, entry.name), result);
  }
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function defaultPaths(cwd: string): string[] {
  return ["src", "app", "apps", "packages"]
    .map((name) => resolve(cwd, name))
    .filter((path) => existsSync(path));
}

function collectPackageSourceFiles(
  packageDirectory: string,
): PackageSourceInput[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && isSkippedDirectory(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        PACKAGE_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())
      ) {
        paths.push(path);
      }
    }
  };

  visit(packageDirectory);
  return uniqueSorted(paths).flatMap((path) => {
    try {
      return [{ fileName: path, source: readFileSync(path, "utf8") }];
    } catch {
      return [];
    }
  });
}

function toDisplayPath(fileName: string, cwd: string): string {
  const display = relative(cwd, fileName);
  return display && !display.startsWith("..") ? display : fileName;
}

function addReportFile(
  files: FileReport[],
  file: string,
  changes: CodemodEdit[],
  findings: CodemodFinding[],
  skipped = false,
): void {
  if (changes.length === 0 && findings.length === 0 && !skipped) return;
  files.push({
    file,
    changes,
    findings,
    ...(skipped ? { skipped: true } : {}),
  });
}

/** Run the command against paths. Returns 1 only when discovery or parsing failed. */
export async function runCodemod(
  argv: readonly string[] = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  let options: CliOptions;
  try {
    options = parseArguments(argv, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const inputPaths =
    options.paths.length > 0
      ? options.paths.map((path) => resolve(cwd, path))
      : defaultPaths(cwd);
  const discovered: DiscoveredFiles = {
    sources: [],
    packageJsons: [],
    errors: [],
  };
  for (const inputPath of inputPaths) discoverFiles(inputPath, discovered);

  const files: FileReport[] = [];
  const parseErrors: Array<{ file: string; error: ParseError }> = [];
  const sourcePaths = uniqueSorted(discovered.sources);
  const packageJsonPaths = uniqueSorted(discovered.packageJsons);

  for (const sourcePath of sourcePaths) {
    let source: string;
    try {
      source = readFileSync(sourcePath, "utf8");
    } catch (error) {
      discovered.errors.push(`Could not read ${sourcePath}: ${String(error)}`);
      continue;
    }
    const result = transformSource(source, {
      from: options.from,
      fileName: sourcePath,
    });
    if (result.skipped) continue;
    for (const error of result.parseErrors) {
      parseErrors.push({ file: toDisplayPath(sourcePath, cwd), error });
    }
    if (
      result.parseErrors.length === 0 &&
      result.edits.length > 0 &&
      !options.dryRun
    ) {
      writeFileSync(sourcePath, result.transformedSource, "utf8");
    }
    addReportFile(
      files,
      toDisplayPath(sourcePath, cwd),
      result.edits,
      result.findings,
    );
  }

  for (const packageJsonPath of packageJsonPaths) {
    let packageJson: string;
    try {
      packageJson = readFileSync(packageJsonPath, "utf8");
    } catch (error) {
      discovered.errors.push(
        `Could not read ${packageJsonPath}: ${String(error)}`,
      );
      continue;
    }
    const result = inspectPackageJson(
      packageJson,
      collectPackageSourceFiles(dirname(packageJsonPath)),
      packageJsonPath,
    );
    for (const error of result.parseErrors) {
      parseErrors.push({ file: toDisplayPath(packageJsonPath, cwd), error });
    }
    addReportFile(
      files,
      toDisplayPath(packageJsonPath, cwd),
      [],
      result.findings,
    );
  }

  files.sort((left, right) => left.file.localeCompare(right.file));
  const report: CliReport = {
    from: options.from,
    dryRun: options.dryRun,
    files,
    parseErrors,
    summary: {
      changedFiles: files.filter((file) => file.changes.length > 0).length,
      changes: files.reduce((count, file) => count + file.changes.length, 0),
      findings: files.reduce((count, file) => count + file.findings.length, 0),
      parseErrors: parseErrors.length,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, options.dryRun);
    for (const error of discovered.errors) console.error(error);
  }

  return parseErrors.length > 0 || discovered.errors.length > 0 ? 1 : 0;
}

function printHumanReport(report: CliReport, dryRun: boolean): void {
  console.log(`workflow-engine-codemod (from ${report.from})`);
  if (report.files.length === 0) {
    console.log("No changes or manual findings.");
  } else {
    for (const file of report.files) {
      console.log(`\n${file.file}`);
      if (file.skipped) console.log("  skipped (AUTO-GENERATED)");
      for (const change of file.changes) {
        console.log(
          `  ${dryRun ? "WOULD CHANGE" : "CHANGED"} ${file.file}:${change.line}:${change.column} ${change.from} -> ${change.to}`,
        );
      }
      for (const finding of file.findings) {
        console.log(
          `  MANUAL ${file.file}:${finding.line}:${finding.column} [rule ${finding.rule}] ${finding.message}`,
        );
        console.log(`    Suggested fix: ${finding.suggestion}`);
      }
    }
  }
  if (report.parseErrors.length > 0) {
    console.log("\nParse errors");
    for (const parseError of report.parseErrors) {
      console.log(
        `  ${parseError.file}:${parseError.error.line}:${parseError.error.column} ${parseError.error.message}`,
      );
    }
  }
  const action = dryRun ? "would change" : "changed";
  console.log(
    `\nSummary: ${report.summary.changes} safe rewrite(s) ${action} in ${report.summary.changedFiles} file(s); ${report.summary.findings} manual finding(s); ${report.summary.parseErrors} parse error(s).`,
  );
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  void runCodemod().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
