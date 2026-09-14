import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireChannelsDataDirectoryLock, prepareChannelsDataDirectory } from "./local-paths.ts";

const executeFile = promisify(execFile);
const SERVICE_LABEL_PREFIX = "com.minusculelabs.minuchannels";

type CommandResult = { stdout: string; stderr: string };
export type ServiceCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface LocalServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  ready: boolean;
  loginEnabled: boolean;
}

export interface LocalServiceLifecycleOptions {
  dataDirectory: string;
  nodeExecutable: string;
  cliEntryPoint: string;
  homeDirectory?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  runCommand?: ServiceCommandRunner;
  environmentPath?: string;
  lifecycleTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class LocalServiceLifecycle {
  readonly dataDirectory: string;
  readonly label: string;
  readonly plistPath: string;
  readonly target: string;
  private readonly nodeExecutable: string;
  private readonly cliEntryPoint: string;
  private readonly runCommand: ServiceCommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly environmentPath: string;
  private readonly lifecycleTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: LocalServiceLifecycleOptions) {
    this.platform = options.platform ?? process.platform;
    if (this.platform !== "darwin") {
      throw new Error("Background service lifecycle is currently available on macOS only");
    }
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
      throw new Error("Unable to determine the current macOS user id");
    }
    this.dataDirectory = resolve(options.dataDirectory);
    this.nodeExecutable = resolve(options.nodeExecutable);
    this.cliEntryPoint = resolve(options.cliEntryPoint);
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.environmentPath = options.environmentPath?.trim() || process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    this.lifecycleTimeoutMs = positiveInteger(options.lifecycleTimeoutMs ?? 30_000, "lifecycleTimeoutMs");
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 100, "pollIntervalMs");
    const suffix = createHash("sha256").update(this.dataDirectory).digest("hex").slice(0, 12);
    this.label = `${SERVICE_LABEL_PREFIX}.${suffix}`;
    this.plistPath = join(resolve(options.homeDirectory ?? homedir()), "Library", "LaunchAgents", `${this.label}.plist`);
    this.target = `gui/${uid}/${this.label}`;
  }

  async status(): Promise<LocalServiceStatus> {
    const installed = await pathExists(this.plistPath);
    const loginEnabled = installed && (await readFile(this.plistPath, "utf8")).includes("<key>RunAtLoad</key>\n  <true/>");
    const inspection = await this.tryLaunchctl(["print", this.target]);
    const running = inspection.ok && /\bstate\s*=\s*running\b/.test(inspection.stdout);
    const pidMatch = /\bpid\s*=\s*(\d+)\b/.exec(inspection.stdout);
    const ready = running && pidMatch !== null && await this.readyFor(Number(pidMatch[1]));
    return {
      installed,
      loaded: inspection.ok,
      running,
      ready,
      loginEnabled,
    };
  }

  async start(): Promise<LocalServiceStatus> {
    const before = await this.status();
    const changed = await this.ensureDefinition(before.loginEnabled);
    if (before.running && !changed) {
      return before.ready
        ? before
        : this.waitFor((status) => status.ready, "MinuChannels did not become ready in time");
    }
    if (before.loaded && changed) await this.launchctl(["bootout", this.target]);
    await this.assertDataDirectoryAvailable();
    await this.ensureLoaded();
    await this.launchctl(["kickstart", this.target]);
    return this.waitFor((status) => status.ready, "MinuChannels did not start in time");
  }

  async stop(): Promise<LocalServiceStatus> {
    const current = await this.status();
    if (current.loaded && current.running) {
      const stopped = await this.tryLaunchctl(["kill", "SIGTERM", this.target]);
      if (!stopped.ok) throw new Error("MinuChannels could not be stopped");
      return this.waitFor((status) => !status.running, "MinuChannels did not stop in time");
    }
    return current;
  }

  async restart(): Promise<LocalServiceStatus> {
    const before = await this.status();
    const changed = await this.ensureDefinition(before.loginEnabled);
    if (before.loaded && changed) await this.launchctl(["bootout", this.target]);
    else if (before.running) {
      const stopped = await this.tryLaunchctl(["kill", "SIGTERM", this.target]);
      if (!stopped.ok) throw new Error("MinuChannels could not be stopped for restart");
      await this.waitFor((status) => !status.running, "MinuChannels did not stop in time");
    }
    await this.assertDataDirectoryAvailable();
    await this.ensureLoaded();
    await this.launchctl(["kickstart", this.target]);
    return this.waitFor((status) => status.ready, "MinuChannels did not restart in time");
  }

  async setLoginEnabled(enabled: boolean): Promise<LocalServiceStatus> {
    const before = await this.status();
    const changed = await this.ensureDefinition(enabled);
    if (!changed) return before;
    if (before.loaded) {
      await this.launchctl(["bootout", this.target]);
      await this.launchctl(["bootstrap", dirnameTarget(this.target), this.plistPath]);
      if (before.running || enabled) await this.launchctl(["kickstart", "-k", this.target]);
    }
    return this.status();
  }

  async remove(): Promise<LocalServiceStatus> {
    const current = await this.status();
    if (current.loaded) await this.launchctl(["bootout", this.target]);
    await rm(this.plistPath, { force: true });
    return this.status();
  }

  private async ensureDefinition(loginEnabled: boolean): Promise<boolean> {
    await Promise.all([
      assertExecutable(this.nodeExecutable, "Node.js executable"),
      assertReadable(this.cliEntryPoint, "MinuChannels executable"),
      mkdir(dirname(this.plistPath), { recursive: true, mode: 0o700 }),
      mkdir(join(this.dataDirectory, "logs"), { recursive: true, mode: 0o700 }),
    ]);
    const logDirectory = join(this.dataDirectory, "logs");
    const logMetadata = await lstat(logDirectory);
    if (!logMetadata.isDirectory() || logMetadata.isSymbolicLink()) {
      throw new Error("Service log directory must be a private local directory");
    }
    await chmod(logDirectory, 0o700);
    const contents = launchAgentPlist({
      label: this.label,
      nodeExecutable: this.nodeExecutable,
      cliEntryPoint: this.cliEntryPoint,
      dataDirectory: this.dataDirectory,
      loginEnabled,
      environmentPath: this.environmentPath,
    });
    if (await readFile(this.plistPath, "utf8").catch(() => undefined) === contents) return false;
    const temporary = `${this.plistPath}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.plistPath);
    return true;
  }

  private async readyFor(pid: number): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(join(this.dataDirectory, "run", "open", "ready.json"), "utf8")) as { pid?: unknown };
      return record.pid === pid;
    } catch {
      return false;
    }
  }

  private async assertDataDirectoryAvailable(): Promise<void> {
    await prepareChannelsDataDirectory(this.dataDirectory);
    let lock;
    try {
      lock = await acquireChannelsDataDirectoryLock(this.dataDirectory);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MinuChannels is already using data directory:")) {
        throw new Error("MinuChannels is already running for this data directory");
      }
      throw error;
    }
    await lock.release();
  }

  private async waitFor(
    predicate: (status: LocalServiceStatus) => boolean,
    failure: string,
  ): Promise<LocalServiceStatus> {
    const deadline = Date.now() + this.lifecycleTimeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (predicate(status)) return status;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.pollIntervalMs));
    }
    throw new Error(failure);
  }

  private async ensureLoaded(): Promise<void> {
    if ((await this.tryLaunchctl(["print", this.target])).ok) return;
    await this.launchctl(["bootstrap", dirnameTarget(this.target), this.plistPath]);
  }

  private async launchctl(args: string[]): Promise<CommandResult> {
    try {
      return await this.runCommand("/bin/launchctl", args);
    } catch {
      throw new Error("The MinuChannels background service command failed");
    }
  }

  private async tryLaunchctl(args: string[]): Promise<{ ok: boolean; stdout: string }> {
    try {
      const result = await this.runCommand("/bin/launchctl", args);
      return { ok: true, stdout: result.stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function dirnameTarget(target: string): string {
  return target.slice(0, target.lastIndexOf("/"));
}

function launchAgentPlist(input: {
  label: string;
  nodeExecutable: string;
  cliEntryPoint: string;
  dataDirectory: string;
  loginEnabled: boolean;
  environmentPath: string;
}): string {
  const values = [input.nodeExecutable, input.cliEntryPoint, "run", "--data-dir", input.dataDirectory, "--service-mode"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${values.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(input.environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <${input.loginEnabled ? "true" : "false"}/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function assertExecutable(path: string, description: string): Promise<void> {
  try { await access(path, 1); }
  catch { throw new Error(`${description} is unavailable`); }
}

async function assertReadable(path: string, description: string): Promise<void> {
  try { await access(path, 4); }
  catch { throw new Error(`${description} is unavailable`); }
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  return executeFile(command, args, { encoding: "utf8" });
}
