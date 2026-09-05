import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "release/artifacts");
const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort();
if (tarballs.length === 0) throw new Error(`No release tarballs found in ${directory}`);
const lines = [];
for (const name of tarballs) {
  const digest = createHash("sha256").update(await readFile(resolve(directory, name))).digest("hex");
  lines.push(`${digest}  ${name}`);
}
await writeFile(resolve(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
