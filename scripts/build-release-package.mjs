import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(root, "../runtime");
const output = resolve(root, "release/package");
const binDirectory = join(output, "dist/bin");
const assetsDirectory = join(output, "dist/assets");
const external = ["@libsql/client", "@libsql/client/*", "drizzle-orm", "drizzle-orm/*"];

await rm(output, { recursive: true, force: true });
await mkdir(binDirectory, { recursive: true });

const bundle = (entryPoint, outfile) => build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  external,
});

await Promise.all([
  bundle(
    resolve(root, "packages/control/dist/src/local-cli.js"),
    join(binDirectory, "minu-channels.js"),
  ),
  bundle(
    resolve(runtimeRoot, "packages/pi/dist/src/index.js"),
    join(binDirectory, "runtime-pi.js"),
  ),
  bundle(
    resolve(runtimeRoot, "packages/pi/dist/src/owned-worker.js"),
    join(binDirectory, "owned-worker.js"),
  ),
]);

await Promise.all([
  cp(resolve(root, "packages/web/dist"), join(assetsDirectory, "web"), { recursive: true }),
  cp(resolve(root, "packages/storage-drizzle/drizzle"), join(assetsDirectory, "migrations/channels"), { recursive: true }),
  cp(resolve(root, "packages/relay-storage-drizzle/drizzle"), join(assetsDirectory, "migrations/agent-host"), { recursive: true }),
  cp(resolve(root, "README.md"), join(output, "README.md")),
]);

const workspacePackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const storagePackage = JSON.parse(await readFile(resolve(root, "packages/storage-drizzle/package.json"), "utf8"));
const manifest = {
  name: "@minu/channels",
  version: workspacePackage.version,
  private: true,
  description: "Local collaboration for humans and coding agents",
  type: "module",
  engines: { node: ">=22" },
  bin: { "minu-channels": "./dist/bin/minu-channels.js" },
  files: ["dist", "README.md"],
  dependencies: {
    "@libsql/client": storagePackage.dependencies["@libsql/client"],
    "drizzle-orm": storagePackage.dependencies["drizzle-orm"],
  },
};
await writeFile(join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

async function releaseFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? releaseFiles(path) : [path];
  }));
  return nested.flat();
}

for (const path of await releaseFiles(output)) {
  const relative = path.slice(output.length + 1);
  if (/(^|\/)(\.env(?:\..*)?|local-profile\.json)$|\.(?:db|sqlite|sqlite3)$/i.test(relative)) {
    throw new Error(`Forbidden release file: ${relative}`);
  }
  const content = await readFile(path);
  if (content.includes(Buffer.from("/Users/davidkennedy"))
    || /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(content.toString("utf8"))
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(content.toString("utf8"))) {
    throw new Error(`Potential local path or secret in release file: ${relative}`);
  }
}

console.log(`Built and inspected release package at ${output}`);
