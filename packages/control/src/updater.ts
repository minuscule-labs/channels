import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const DEFAULT_RELEASE_API = "https://api.github.com/repos/minuscule-labs/channels/releases/latest";
const MAX_RELEASE_RESPONSE_BYTES = 1_000_000;
const MAX_CHECKSUM_BYTES = 1_000_000;
const MAX_ARTIFACT_BYTES = 100_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

type CommandResult = { stdout: string; stderr: string };
type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  artifactName: string;
  artifactUrl: string;
  checksumUrl: string;
}

export async function checkForUpdate(options: {
  currentVersion: string;
  fetch?: typeof fetch;
  releaseApiUrl?: string;
}): Promise<UpdateCheck> {
  parseVersion(options.currentVersion);
  const response = await fetchWithTimeout(options.fetch ?? fetch, options.releaseApiUrl ?? DEFAULT_RELEASE_API);
  if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  const body = JSON.parse((await readResponseBytes(response, MAX_RELEASE_RESPONSE_BYTES, "release response")).toString("utf8")) as unknown;
  if (!isObject(body)) throw new Error("GitHub returned an invalid release response");
  const tag = requiredString(body.tag_name, "release tag");
  const latestVersion = tag.startsWith("v") ? tag.slice(1) : tag;
  parseVersion(latestVersion);
  if (!Array.isArray(body.assets)) throw new Error("GitHub release response has no assets");
  const artifactName = `minu-channels-${latestVersion}.tgz`;
  return {
    currentVersion: options.currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, options.currentVersion) > 0,
    releaseUrl: requiredGithubUrl(body.html_url, "release URL"),
    artifactName,
    artifactUrl: releaseAssetUrl(body.assets, artifactName),
    checksumUrl: releaseAssetUrl(body.assets, "SHA256SUMS"),
  };
}

export async function installUpdate(update: UpdateCheck, options: {
  packageRoot?: string;
  npmCommand?: string;
  runCommand?: RunCommand;
  fetch?: typeof fetch;
  temporaryDirectory?: string;
} = {}): Promise<{ previousVersion: string; version: string }> {
  if (!update.updateAvailable) return { previousVersion: update.currentVersion, version: update.currentVersion };
  const packageRoot = resolve(options.packageRoot ?? defaultPackageRoot());
  const npmCommand = options.npmCommand ?? "npm";
  const runCommand = options.runCommand ?? defaultRunCommand;
  await assertGlobalNpmInstall(packageRoot, npmCommand, runCommand, update.latestVersion);
  const temporaryRoot = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "minu-channels-update-"));
  try {
    await chmod(temporaryRoot, 0o700);
    const [artifactResponse, checksumResponse] = await Promise.all([
      fetchWithTimeout(options.fetch ?? fetch, update.artifactUrl),
      fetchWithTimeout(options.fetch ?? fetch, update.checksumUrl),
    ]);
    if (!artifactResponse.ok) throw new Error(`Release artifact download failed with HTTP ${artifactResponse.status}`);
    if (!checksumResponse.ok) throw new Error(`Release checksum download failed with HTTP ${checksumResponse.status}`);
    const [artifact, checksumFile] = await Promise.all([
      readResponseBytes(artifactResponse, MAX_ARTIFACT_BYTES, "release artifact"),
      readResponseBytes(checksumResponse, MAX_CHECKSUM_BYTES, "checksum file"),
    ]);
    const expected = checksumForArtifact(checksumFile.toString("utf8"), update.artifactName);
    const actual = createHash("sha256").update(artifact).digest("hex");
    if (actual !== expected) throw new Error(`Release artifact checksum mismatch: expected ${expected}, received ${actual}`);
    const artifactPath = join(temporaryRoot, basename(update.artifactName));
    await writeFile(artifactPath, artifact, { mode: 0o600 });
    await runCommand(npmCommand, ["install", "-g", "--ignore-scripts", artifactPath]);
    const installed = await runCommand(process.execPath, [join(packageRoot, "dist", "bin", "minu-channels.js"), "--version"]);
    if (installed.stdout.trim() !== update.latestVersion) throw new Error(`Installed CLI reported ${installed.stdout.trim() || "no version"}; expected ${update.latestVersion}`);
    return { previousVersion: update.currentVersion, version: update.latestVersion };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function assertGlobalNpmInstall(packageRoot: string, npm: string, run: RunCommand, version: string): Promise<void> {
  let globalRoot: string;
  try { globalRoot = (await run(npm, ["root", "-g"])).stdout.trim(); }
  catch { throw new Error("Unable to inspect the global npm installation. Update from the installer or source checkout that installed MinuChannels."); }
  if (!globalRoot) throw new Error("npm returned an empty global package root");
  let installed: string; let global: string;
  try { [installed, global] = await Promise.all([realpath(packageRoot), realpath(globalRoot)]); }
  catch { throw new Error("Unable to resolve the installed package and global npm paths"); }
  if (!isWithin(global, installed)) throw new Error("This MinuChannels installation is not managed by global npm. Update it with the installer or source checkout that installed it.");
  try { await Promise.all([access(installed, constants.W_OK), access(dirname(installed), constants.W_OK)]); }
  catch { throw new Error(`The global npm installation is not writable. Install manually from the v${version} GitHub Release.`); }
}

function defaultPackageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "../.."); }
async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> { return executeFile(command, args, { encoding: "utf8" }); }
async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  try { return await fetchImpl(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "minu-channels-update-check", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
  catch (error) { throw new Error(`Unable to reach GitHub releases: ${error instanceof Error ? error.message : String(error)}`); }
}
async function readResponseBytes(response: Response, maximum: number, description: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${description} exceeds the ${maximum}-byte safety limit`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
  while (true) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > maximum) { await reader.cancel(); throw new Error(`${description} exceeds the ${maximum}-byte safety limit`); } chunks.push(Buffer.from(result.value)); }
  return Buffer.concat(chunks, length);
}
function checksumForArtifact(contents: string, artifact: string): string {
  for (const line of contents.split(/\r?\n/)) { const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line.trim()); if (match?.[2] === artifact) return match[1]!.toLowerCase(); }
  throw new Error(`SHA256SUMS does not contain ${artifact}`);
}
function releaseAssetUrl(assets: unknown[], name: string): string { const asset = assets.find((value) => isObject(value) && value.name === name); if (!isObject(asset)) throw new Error(`GitHub release is missing required asset ${name}`); return requiredGithubUrl(asset.browser_download_url, `${name} download URL`); }
function requiredString(value: unknown, description: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`GitHub returned an invalid ${description}`); return value.trim(); }
function requiredHttpsUrl(value: unknown, description: string): string { const url = new URL(requiredString(value, description)); if (url.protocol !== "https:") throw new Error(`${description} must use HTTPS`); return url.href; }
function requiredGithubUrl(value: unknown, description: string): string { const url = new URL(requiredHttpsUrl(value, description)); if (url.hostname !== "github.com") throw new Error(`${description} must use github.com`); return url.href; }
function parseVersion(version: string): [number, number, number] { const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version); if (!match) throw new Error(`Unsupported release version: ${version}`); return match.slice(1).map(Number) as [number, number, number]; }
function isWithin(parent: string, candidate: string): boolean { const path = relative(parent, candidate); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
