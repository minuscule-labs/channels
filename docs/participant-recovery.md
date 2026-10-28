# Participant recovery

Everyday controls remain in each participant menu. Refresh status reads only that participant; it never starts, resumes, replaces, reconnects or interrupts a session. Individual actions block their own participant, while bulk actions reserve the Conversation. A pending individual action still blocks a conflicting bulk action.

## Lifecycle requests (local-control v23)

- `POST /local/conversations/:conversationId/agent-actions` accepts `{ requestId, action, identityId? }` and returns a `202` lifecycle receipt promptly. Individual actions are `start`, `start-fresh`, `reconnect`, `replace`, `replace-fresh`, `stop`, and `cancel`; bulk actions are `start-all` and `stop-all`, without an identity ID.
- `GET` on that collection lists pending actions; `GET /:requestId` reads one exact receipt. Acceptance and receipt reads require fresh Workspace owner/admin authorization and an authenticated local browser session. Host/origin checks still apply.
- Receipts distinguish pending, succeeded, failed admission, and unconfirmed outcomes. Successful lifecycle handling is independent of a subsequent Runtime status query. Cancel success acknowledges the cancellation request, not physical turn settlement.
- Exact duplicate submissions reuse a retained receipt. A different intent for the same participant is rejected rather than silently queued behind it. Legacy synchronous lifecycle endpoints share this admission guard.
- Confirmed success or failure receipts take precedence over late POST outcomes. Superseded requests cannot resurrect cleared feedback; authorization denials still revoke browser controls.
- The browser never automatically repeats a POST after transport failure. It retains the exact request ID in memory and reconciles using GET only. A healthy/idle Runtime is not evidence that the requested replacement succeeded. Dismissing a transport notice does not unblock a request still being observed as pending.

Receipts are **in-process**, independent of the optional diagnostic journal. They retain at most 512 entries, with terminal records retained for at most one hour; terminal entries can be evicted earlier for capacity. Running entries are never evicted. Restarted, expired or missing receipts mean unconfirmed, not failed or permission to replay the request. Reopening a Conversation discovers currently pending host actions; completed local notices are not browser-persisted or a durable operation history.

## Safe recovery

A completed or rejected action releases its controls. Unconfirmed partial changes remain subject to the existing binding, generation, membership, idle-work and Runtime checks; no blanket force-enable is added. An explicit Stop retry may reuse an existing `stopping` fence, verify/interrupt that same Runtime session, then commit the pause. It never reacquires a delivery lease or automatically resumes/replaces the session. Unreachable work remains unconfirmed and fenced.

A successful per-participant Refresh adds or replaces that participant's cached snapshot without discarding other participants. Multiple participants remain recoverable even if the collection status read stays unavailable.

Fresh-session activation boundaries and context exclusion are unchanged. A Fresh-start request against an already paused participant is rejected rather than accidentally resuming its old transcript; the explicit Fresh replacement action creates the new session.

Action notices can be dismissed from expanded rows, details, or the minimized participant menu. This changes local feedback only, not session state, diagnostic history, message history or image data.

## Diagnostics

The participant menu links to `/app/workspaces/:workspaceId/conversations/:conversationId/participants/:participantId/diagnostics`. Compact participant details can open that page in a separate tab. The page is lazy-loaded and offers no lifecycle mutation controls.

Existing diagnostic authorization and bounded reads remain in force. Private inspection/report state is disposable, fenced against navigation and late responses, and cleared on observed access loss. Authorization denial from any page read clears the whole surface even if public authorization metadata is stale; subsequent successful polls cannot restore the cleared projections. Reports are not shared between tabs or saved in browser storage. Exact selected issue identifiers preserve trigger/failed-time selection; public message links return to the Conversation and focus the referenced message. Returning to the Conversation restores participant focus, including the mobile drawer trigger.

No Runtime repin, authoritative schema migration, installed-app update, or native-addon crash fix is included.
