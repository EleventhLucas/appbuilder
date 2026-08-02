import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { replaceCodexResources } from "./codex-resource-layout.mjs";

const require = createRequire(import.meta.url);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const codexPackagePath = require.resolve("@openai/codex/package.json");
const codexPackage = JSON.parse(await readFile(codexPackagePath, "utf8"));
const supported = {
  "win32-x64": {
    package: "@openai/codex-win32-x64",
    vendor: "x86_64-pc-windows-msvc",
    executable: "bin/codex.exe",
  },
  "linux-x64": {
    package: "@openai/codex-linux-x64",
    vendor: "x86_64-unknown-linux-musl",
    executable: "bin/codex",
  },
};
const key = `${process.platform}-${process.arch}`;
const platform = supported[key];
if (!platform) throw new Error(`Bundled Codex is unsupported on ${key}.`);

const platformPackagePath = require.resolve(`${platform.package}/package.json`);
const source = join(dirname(platformPackagePath), "vendor", platform.vendor);
const codexRoot = join(repositoryRoot, "resources", "codex");
const target = await replaceCodexResources(codexRoot, key, source);

const executablePath = join(target, platform.executable);
const sha256 = createHash("sha256").update(await readFile(executablePath)).digest("hex");
const manifest = {
  version: codexPackage.version,
  releaseUrl: `https://github.com/openai/codex/releases/tag/rust-v${codexPackage.version}`,
  packageUrl: `https://registry.npmjs.org/@openai/codex/-/codex-${codexPackage.version}.tgz`,
  license: "Apache-2.0",
  platforms: {
    [key]: {
      executable: platform.executable.replaceAll("\\", "/"),
      sha256,
    },
  },
};
await writeFile(join(repositoryRoot, "resources", "codex", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\r\n`, "utf8");
console.log(`Prepared official Codex ${codexPackage.version} for ${key} (${sha256}).`);
