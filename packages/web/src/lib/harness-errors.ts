/** Harness discovery errors are generic by design. The one exception is a harness that needs its own sign-in: its fixed,
 * non-secret instruction is shown so the user knows what to do (nothing else from the error is ever displayed). */
export function harnessDiscoveryMessage(error: unknown, fallback: string): string {
  return error instanceof Error && /^Claude Code is not logged in; run `claude` to sign in$/.test(error.message) ? error.message : fallback;
}
