import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsRoot = join(projectRoot, "resources", "icons");
const sourcePath = join(iconsRoot, "app-icon-source.png");
const runtimePath = join(iconsRoot, "app-icon.png");
const windowsPath = join(iconsRoot, "app-icon.ico");
const linuxRoot = join(iconsRoot, "linux");
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512];
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];

const source = await readFile(sourcePath);
const metadata = await sharp(source).metadata();
if (metadata.format !== "png" || metadata.width !== metadata.height || !metadata.hasAlpha) {
  throw new Error("The AppBuilder icon source must be a square PNG with transparency.");
}

await mkdir(linuxRoot, { recursive: true });
await writeFile(runtimePath, await renderPng(source, 512));

for (const size of linuxSizes) {
  await writeFile(join(linuxRoot, `${size}x${size}.png`), await renderPng(source, size));
}

const windowsImages = await Promise.all(
  windowsSizes.map(async (size) => ({ size, data: await renderPng(source, size) })),
);
await writeFile(windowsPath, createIco(windowsImages));

console.log(`Generated AppBuilder icons from ${metadata.width}x${metadata.height} source artwork.`);

async function renderPng(input, size) {
  return sharp(input)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ adaptiveFiltering: true, compressionLevel: 9, effort: 10, palette: false })
    .toBuffer();
}

function createIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  let imageOffset = directory.length;
  images.forEach(({ size, data }, index) => {
    const entryOffset = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset);
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(data.length, entryOffset + 8);
    directory.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += data.length;
  });

  return Buffer.concat([directory, ...images.map(({ data }) => data)]);
}
