import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const roots = ["dist", "release", "test-results", "playwright-report"];

await Promise.all(roots.map((root) => rm(resolve(process.cwd(), root), { recursive: true, force: true })));
