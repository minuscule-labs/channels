/** Harness discovery errors are generic by design. The exceptions are a harness that is not installed, needs its own sign-in or is
 * too old: its fixed, non-secret instruction is shown so the user knows what to do (exact match only; nothing else from the error is
 * ever displayed). Keep in step with HARNESS_SETUP_MESSAGES in the control package's configuration.ts. */
const SETUP_MESSAGES: ReadonlySet<string> = new Set([
  "Claude Code is not logged in; run `claude` to sign in",
  "Claude Code is not installed; install `claude` and restart Channels",
  "This Claude Code version is not supported; update `claude`",
  "Codex is not installed; install `codex` and restart Channels",
  "Codex is not logged in; run `codex login`",
]);

export function harnessDiscoveryMessage(error: unknown, fallback: string): string {
  return error instanceof Error && SETUP_MESSAGES.has(error.message) ? error.message : fallback;
}
