import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const assetsDirectory = resolve("packages/web/dist/assets");
const assets = (await readdir(assetsDirectory))
  .filter((name) => name.endsWith(".js"))
  .sort();

console.log("Web production JavaScript bundle report");
for (const asset of assets) {
  const content = await readFile(resolve(assetsDirectory, asset));
  console.log(`${asset}\t${content.length}\t${gzipSync(content).length}`);
}
console.log("Columns: asset, minified bytes, gzip bytes");
