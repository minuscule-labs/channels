# Participant recovery

Everyday controls remain in each participant menu. Refresh status reads only that participant; it never starts, resumes, replaces, reconnects or interrupts a session. Individual actions block their own participant, while bulk actions reserve the Conversation. A pending individual action still blocks a conflicting bulk action.

## Lifecycle requests (local-control v24)

- `POST /local/conversations/:conversationId/agent-actions` accepts `{ requestId, action, identityId? }` and returns a `202` lifecycle receipt promptly. Individual actions are `start`, `start-fresh`, `reconnect`, `replace`, `replace-fresh`, `stop`, `cancel`, `stop-runtime`, and `restart-runtime`; bulk actions are `start-all` and `stop-all`, without an identity ID.
- `GET` on that collection lists pending actions; `GET /:requestId` reads one exact receipt. Acceptance and receipt reads require fresh Workspace owner/admin authorization and an authenticated local browser session. Host/origin checks still apply.
- Receipts distinguish pending, succeeded, failed admission, and unconfirmed outcomes. Successful lifecycle handling is independent of a subsequent Runtime status query. Cancel success acknowledges the cancellation request, not physical turn settlement.
- Exact duplicate submissions reuse a retained receipt. A different intent for the same participant is rejected rather than silently queued behind it. Legacy synchronous lifecycle endpoints share this admission guard.
- Confirmed success or failure receipts take precedence over late POST outcomes. Superseded requests cannot resurrect cleared feedback; authorization denials still revoke browser controls.
- The browser never automatically repeats a POST after transport failure. It retains the exact request ID in memory and reconciles using GET only. A healthy/idle Runtime is not evidence that the requested replacement succeeded. Dismissing a transport notice does not unblock a request still being observed as pending.

Receipts are **in-process**, independent of the optional diagnostic journal. They retain at most 512 entries, with terminal records retained for at most one hour; terminal entries can be evicted earlier for capacity. Running entries are never evicted. Restarted, expired or missing receipts mean unconfirmed, not failed or permission to replay the request. Reopening a Conversation discovers currently pending host actions; completed local notices are not browser-persisted or a durable operation history.

## Safe recovery

A completed or rejected action releases its controls. Unconfirmed partial changes remain subject to the existing binding, generation, membership, idle-work and Runtime checks; no blanket force-enable is added. An explicit legacy pause (`stop`) retry may reuse an existing `stopping` fence, verify/interrupt that same Runtime session, then commit the pause. It never reacquires a delivery lease or automatically resumes/replaces the session. Unreachable work remains unconfirmed and fenced.

A successful per-participant Refresh adds or replaces that participant's cached snapshot without discarding other participants. Multiple participants remain recoverable even if the collection status read stays unavailable.

Fresh-session activation boundaries and context exclusion are unchanged. A Fresh-start request against an already paused participant is rejected rather than accidentally resuming its old transcript; the explicit Fresh replacement action creates the new session.

Action notices can be dismissed from expanded rows, details, or the minimized participant menu. This changes local feedback only, not session state, diagnostic history, message history or image data.

## Manual Runtime recovery

Participant menus have three compact groups: **Agent**, **New session**, and **Inspect**. Under Agent, **Stop agent** shuts down the worker and **Restart agent** prefers reopening the same saved transcript, then recovers the Conversation in a replacement session when that resume fails. Their internal receipt actions remain `stop-runtime` and `restart-runtime`; the implementation detail is not part of the menu labels. When managed shutdown is unavailable, the legacy delivery-only `stop` action is labelled **Pause agent**, never displayed alongside the supported full Stop action.

Stop and Restart remain available for an exact owner-scoped managed binding even when status is uncertain, including sleeping/unattached and previously fenced sessions. They use the same authenticated owner/admin receipt, participant admission and pending-operation guards as ordinary lifecycle actions; archived Conversations remain read-only. Inspect remains accessible while lifecycle actions are pending, and new-session replacement stays separate.

Recovery first reserves the binding's existing stopping fence with a unique, renewed recovery lease and detaches the old route. The reservation remains in force through shutdown, resume or replacement launch, and the final state/generation commit. Start, competing recovery and ordinary lifecycle mutations cannot take over a live reservation; only explicit recovery can reclaim an expired reservation and must confirm shutdown again. Old route teardown cannot release the separate recovery lease. Runtime stops the exact worker without requiring healthy status or native RPC, confirms process exit, and preserves the managed identity and transcript. New POSIX workers use dedicated process groups; a verified unresponsive worker can be escalated from TERM to KILL without signalling a shared controller/terminal group. Legacy workers receive only verified worker-targeted TERM, with observed descendant exit required. A dead legacy bridge without process-group or previously confirmed suspension evidence cannot authorize a new writer; unverifiable shutdown remains unconfirmed.

A persisted Runtime recovery fence also rejects delayed automatic resumes. Only an explicit Start/Restart can clear it. Stop leaves the binding paused. Restart first attempts the same saved transcript, binding generation, context policy and activation boundary, after rechecking authority. Successful same-session resume does not reapply saved future launch settings.

If explicit Restart cannot resume the saved session, it confirms shutdown again before launching a replacement: an earlier timed-out resume may still be settling. The replacement remains in the same Conversation, uses current configured launch settings and a bounded public-context snapshot, and increments the binding generation. It retains the old transcript and session-history record, records the failed resume and replacement in diagnostics, preserves Fresh-session context exclusions and thread snapshot boundaries, and atomically commits the replacement generation and captured cursor boundary so old/possibly completed work is not replayed. Cleanup bookkeeping runs afterward; its failure cannot expose a replacement without its no-replay boundary. Recovery does not run a separate model turn to summarize history. Private working memory may be lost; tool/filesystem side effects are not rolled back.

Known limitation: consecutive fallback replacements of a Fresh session can progressively narrow the public context supplied to the agent. The Conversation and retained transcripts remain intact; improving this context reconstruction is deferred.

Failure to confirm either shutdown leaves delivery fenced and never launches a second worker. Ordinary Start and background startup/lease recovery still only resume the same owner-scoped saved session; they never automatically replace it. Replacement is limited to explicit Restart with confirmed shutdown, fresh owner/admin authority and an unchanged binding.

Recovery, wake, idle sleep and retirement cleanup use exact-session metadata lookup when supported. Transcript contents are validated on actual resume, not routine polling. Legacy adapters share one unfinished inventory read per owner. The shared read carries a cancellation deadline matching the configured status-read budget; supported Runtime reads remove queued work and stop active validation between chunks when it expires. Adapters that ignore cancellation still occupy their in-flight guard until physical settlement. Resume guards also remain held until settlement, preventing retries from multiplying the underlying work.

## Durable sessions and retirement

The worker is disposable; its owner-scoped resume manifest and Pi transcript are not. Runtime validates the private journal envelope while Pi interprets native entry payloads, including context edits, usage records and branched history. A CLI upgrade must not make valid new entry types fail an outdated Runtime allowlist.

Explicit New session still creates a different session, but retires and suspends the previous one without destroying its resume manifest. History remains owner-scoped and retained; cleanup failures remain visible and retryable. Older queued automatic-destroy intents are converted to suspend attempts, not replayed as deletion. A missing or invalid session is not falsely recorded as successfully cleaned up. Disposal of a newly launched, never-bound session remains separate.

These changes do not reconstruct manifests already removed by older versions or rewrite historical records labelled destroyed. Older orphaned transcript files may still exist and require explicit recovery; no automatic scan, reassignment or modification of them is performed.

## Diagnostics

The participant menu links to `/app/workspaces/:workspaceId/conversations/:conversationId/participants/:participantId/diagnostics`. Compact participant details can open that page in a separate tab. The page is lazy-loaded and offers no lifecycle mutation controls.

Existing diagnostic authorization and bounded reads remain in force. Private inspection/report state is disposable, fenced against navigation and late responses, and cleared on observed access loss. Authorization denial from any page read clears the whole surface even if public authorization metadata is stale; subsequent successful polls cannot restore the cleared projections. Reports are not shared between tabs or saved in browser storage. Exact selected issue identifiers preserve trigger/failed-time selection; public message links return to the Conversation and focus the referenced message. Returning to the Conversation restores participant focus, including the mobile drawer trigger.

Resume failures retain bounded reason codes (`session_metadata_unavailable`, `session_transcript_invalid`, or `session_resume_failed`) in lifecycle evidence and safe existing action errors. Raw errors, native IDs, paths and transcript content remain private. Failure guidance no longer suggests replacing a session as the ordinary recovery step.

No authoritative schema migration, installed-app update, or native-addon crash fix is included.
