import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RunProfileSuggestion } from "../../shared/types";

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const profileId = (prefix: string, name: string): string => `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const parseToml = async (source: string): Promise<unknown> => (await import("smol-toml")).parse(source);

export async function detectRunProfiles(projectPath: string): Promise<RunProfileSuggestion[]> {
  const entries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const suggestions = [
    ...await detectNode(projectPath, files),
    ...await detectDotNet(projectPath, files),
    ...await detectPython(projectPath, files),
    ...await detectRust(projectPath, files),
  ];
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.id)) return false;
    seen.add(suggestion.id);
    return true;
  });
}

async function detectNode(projectPath: string, files: Set<string>): Promise<RunProfileSuggestion[]> {
  if (!files.has("package.json")) return [];
  try {
    const pkg = object(JSON.parse(await readFile(join(projectPath, "package.json"), "utf8")));
    const scripts = object(pkg.scripts);
    const manager = files.has("bun.lock") || files.has("bun.lockb")
      ? { command: "bun", prefix: ["run"] }
      : files.has("pnpm-lock.yaml")
        ? { command: "pnpm", prefix: ["run"] }
        : files.has("yarn.lock")
          ? { command: "yarn", prefix: [] }
          : { command: "npm", prefix: ["run"] };
    return Object.entries(scripts).flatMap(([name, value]) => typeof value === "string" ? [{
      id: profileId("node", name),
      name: title(name),
      command: manager.command,
      args: [...manager.prefix, name],
      detector: "node" as const,
      description: `Package script: ${value}`,
      recommended: name === "dev" || name === "start",
    }] : []);
  } catch {
    return [];
  }
}

async function detectDotNet(projectPath: string, files: Set<string>): Promise<RunProfileSuggestion[]> {
  const projects = [...files].filter((name) => extname(name).toLowerCase() === ".csproj").sort();
  const suggestions: RunProfileSuggestion[] = [];
  for (const project of projects) {
    suggestions.push({
      id: profileId("dotnet", basename(project, ".csproj")),
      name: `Run ${basename(project, ".csproj")}`,
      command: "dotnet",
      args: ["run", "--project", project],
      detector: "dotnet",
      description: `Run ${project} from the project root.`,
      recommended: projects.length === 1,
    });
    const launchSettings = join(projectPath, "Properties", "launchSettings.json");
    try {
      const parsed = object(JSON.parse(await readFile(launchSettings, "utf8")));
      for (const name of Object.keys(object(parsed.profiles))) {
        suggestions.push({
          id: profileId("dotnet-profile", name),
          name,
          command: "dotnet",
          args: ["run", "--project", project, "--launch-profile", name],
          detector: "dotnet",
          description: `Launch profile from Properties/launchSettings.json.`,
          recommended: false,
        });
      }
    } catch {
      // Launch settings are optional.
    }
  }
  return suggestions;
}

async function detectPython(projectPath: string, files: Set<string>): Promise<RunProfileSuggestion[]> {
  const python = process.platform === "win32" ? "python" : "python3";
  const suggestions: RunProfileSuggestion[] = [];
  if (files.has("pyproject.toml")) {
    try {
      const parsed = object(await parseToml(await readFile(join(projectPath, "pyproject.toml"), "utf8")));
      const scripts = object(object(parsed.project).scripts);
      for (const [name, value] of Object.entries(scripts)) {
        if (typeof value !== "string") continue;
        const moduleName = value.split(":", 1)[0];
        suggestions.push({
          id: profileId("python", name),
          name: title(name),
          command: files.has("uv.lock") ? "uv" : python,
          args: files.has("uv.lock") ? ["run", name] : ["-m", moduleName],
          detector: "python",
          description: `Python project script: ${value}`,
          recommended: suggestions.length === 0,
        });
      }
    } catch {
      // An invalid pyproject is reported by the user's Python tooling, not rewritten here.
    }
  }
  for (const entry of ["main.py", "app.py", "manage.py"]) {
    if (!files.has(entry)) continue;
    suggestions.push({
      id: profileId("python-file", entry),
      name: `Run ${entry}`,
      command: python,
      args: [entry],
      detector: "python",
      description: `Conventional Python entry file.`,
      recommended: suggestions.length === 0,
    });
  }
  return suggestions;
}

async function detectRust(projectPath: string, files: Set<string>): Promise<RunProfileSuggestion[]> {
  if (!files.has("Cargo.toml")) return [];
  let name = "Rust project";
  try {
    const parsed = object(await parseToml(await readFile(join(projectPath, "Cargo.toml"), "utf8")));
    const packageName = object(parsed.package).name;
    if (typeof packageName === "string") name = packageName;
  } catch {
    // Cargo will provide the authoritative parse error when launched.
  }
  return [{
    id: profileId("rust", name),
    name: `Run ${name}`,
    command: "cargo",
    args: ["run"],
    detector: "rust",
    description: "Cargo package at the project root.",
    recommended: true,
  }];
}

function title(value: string): string {
  return value.replace(/[-_:]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
