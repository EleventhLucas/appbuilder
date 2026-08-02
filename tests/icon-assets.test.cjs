const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const iconsRoot = join(projectRoot, "resources", "icons");

test("generated icon assets cover renderer, Windows, and Linux targets", () => {
  const source = readPng(join(iconsRoot, "app-icon-source.png"));
  assert.deepEqual(source, { width: 500, height: 500, bitDepth: 8, colorType: 6 });

  const runtime = readPng(join(iconsRoot, "app-icon.png"));
  assert.deepEqual(runtime, { width: 512, height: 512, bitDepth: 8, colorType: 6 });

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    assert.deepEqual(
      readPng(join(iconsRoot, "linux", `${size}x${size}.png`)),
      { width: size, height: size, bitDepth: 8, colorType: 6 },
    );
  }

  const ico = readFileSync(join(iconsRoot, "app-icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 7);
  const sizes = Array.from({ length: count }, (_, index) => ico[6 + index * 16] || 256);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);

  const rendererHtml = readFileSync(join(projectRoot, "dist", "renderer", "index.html"), "utf8");
  assert.match(rendererHtml, /app-icon-[^"']+\.png/);

  const builder = readFileSync(join(projectRoot, "electron-builder.yml"), "utf8");
  assert.match(builder, /icon: app-icon\.ico/);
  assert.match(builder, /icon: linux/);

  const main = readFileSync(join(projectRoot, "src", "main", "main.ts"), "utf8");
  assert.match(main, /titleBarStyle: "hidden"/);
  assert.match(main, /titleBarOverlay:/);
});

function readPng(path) {
  assert.equal(existsSync(path), true, `${path} should exist`);
  const buffer = readFileSync(path);
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}
