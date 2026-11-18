import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { EventEmitter } from "node:events";

export interface DiagnosticWorker extends Pick<EventEmitter, "on" | "once"> {
  postMessage(message: unknown): void;
  unref(): void;
  terminate(): Promise<number>;
}
export interface DiagnosticWorkerOptions {
  workerData: { path: string; epoch: string };
}

/** Keep native database failures and forced termination outside the host's V8 isolate. */
class DiagnosticProcess extends EventEmitter implements DiagnosticWorker {
  private readonly child: ChildProcess;
  private readonly exited: Promise<number>;
  private hasExited = false;

  constructor(url: URL, options: DiagnosticWorkerOptions) {
    super();
    this.child = fork(url, [], {
      execArgv: [],
      serialization: "advanced",
      // Native crashes and private error strings must not leak through host output.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.exited = new Promise(resolve => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.hasExited) return;
        this.hasExited = true;
        const status = code ?? -1;
        resolve(status);
        this.emit("exit", status, signal);
      };
      this.child.once("exit", finish);
      // A failed spawn can emit close without exit; there is no process to join.
      this.child.once("close", finish);
    });
    this.child.on("message", message => this.emit("message", message));
    this.child.on("error", error => this.emit("error", error));
    this.child.on("disconnect", () => this.emit("error", new Error("Diagnostic process disconnected")));
    try {
      // Keep the private journal path out of the process argument list.
      this.postMessage({ type: "initialize", ...options.workerData });
    } catch (error) {
      // The factory did not return, so the recorder cannot attach its error listener.
      this.on("error", () => {});
      this.child.kill("SIGKILL");
      throw error;
    }
  }

  postMessage(message: unknown): void {
    if (!this.child.connected) throw new Error("Diagnostic process disconnected");
    this.child.send(message as Serializable, error => { if (error) this.emit("error", error); });
  }

  unref(): void {
    this.child.unref();
    this.child.channel?.unref();
  }

  terminate(): Promise<number> {
    if (!this.hasExited) this.child.kill("SIGKILL");
    return this.exited;
  }
}

export function createDiagnosticProcess(url: URL, options: DiagnosticWorkerOptions): DiagnosticWorker {
  return new DiagnosticProcess(url, options);
}
