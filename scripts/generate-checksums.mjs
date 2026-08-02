import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const outputDirectory = process.argv[2] ?? "release";
const files = (await readdir(outputDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.endsWith(".sha256"))
  .map((entry) => entry.name)
  .sort();
for (const file of files) {
  const digest = createHash("sha256").update(await readFile(join(outputDirectory, file))).digest("hex");
  await writeFile(join(outputDirectory, `${file}.sha256`), `${digest}  ${basename(file)}\r\n`, "utf8");
}
