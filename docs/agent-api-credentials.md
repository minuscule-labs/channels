# Agent API credentials — status-only backend

The first adapter is loopback HTTP. These credentials authorize only the separately wired status-inspection API, not legacy collaboration/service-token or human local-control endpoints. MCP, hosted access, message retrieval, management and lifecycle operations are not included.

B2 provides credential administration/persistence; B3/B4 provide shared authorization/bounded projection; B5 wires the loopback HTTP route below. Independent integrated acceptance remains a separate Q2 gate.

## OpenAPI

The [OpenAPI 3.1 specification (`openapi.json`)](openapi.json) describes the inspection endpoint and the six separate human-session credential-administration operations, including authentication, schemas, errors and limits. Import it into an OpenAPI-compatible viewer or client generator. It documents existing routes only; no hosted Swagger UI or documentation endpoint is added.

## Authority and storage

An active human Workspace owner/admin may create and manage their own delegated keys. Administration uses the existing authenticated human browser-session boundary, including Host/Origin validation. There is no bearer-key administration or API-key-to-browser-session exchange. A principal cannot transfer a key to another identity or Workspace; other administrators cannot read/rotate that principal's keys. Disabling/demoting the principal removes their inspection entitlement, even if the credential remains recorded.

Grants must name known conversations/threads in the selected Workspace. A PM client and the authorizing owner/admin need not participate in those targets. `includeThreads` must be explicitly selected for a parent Conversation to include its existing/future threads. A direct thread grant is exact and requires `includeThreads: false`. No wildcard scope exists. Current principal and target authorization still apply on inspection; a key's grant is a ceiling.

Keys contain a public credential ID and a 256-bit random secret. Only a SHA-256 verification digest is stored in the private Relay SQLite database; high-entropy secrets are not passwords. Raw secrets are returned once on creation/rotation, never in lists/reads or errors. Keep the local data directory private. No credential is stored in collaboration metadata or supplied as a model-visible tool argument.

Default expiry is 30 days, maximum 90 days from an explicit create/expiry update. Earlier expiry is supported. Rotation preserves expiry, increments the secret generation and immediately invalidates the previous secret. There is no overlap, grace period, silent renewal, or plaintext recovery. Expired/revoked credentials cannot be rotated/reactivated; issue a new credential after human review. Revocation remains possible after expiry.

## Non-UI provisioning

Use the loopback control origin from the product's human launch URL. Redeem a fresh human launch URL once to obtain an HttpOnly session cookie, or use the existing authenticated human session. This administration boundary intentionally requires human authentication; later API use does not require a browser session or active agent turn.

For command-line provisioning, use a private cookie jar and private output files (`umask 077`). Do not put cookies, launch codes or keys in shell history, source control, screenshots, chat or logs. Do not automatically retry mutating requests.

```sh
umask 077
# Supply CONTROL_ORIGIN and LAUNCH_URL from your local product, not a remote server.
# LAUNCH_URL is sensitive. Redeem without following its redirect.
curl --silent --show-error --cookie-jar ./channels.cookies \
  --output /dev/null "$LAUNCH_URL"

# Populate create-key.json with reviewed non-secret configuration below.
# Response includes the one-time secret: keep this file private.
curl --silent --show-error --cookie ./channels.cookies \
  --header 'Content-Type: application/json' \
  --data-binary @create-key.json \
  --output ./created-key.private.json \
  "$CONTROL_ORIGIN/local/workspaces/$WORKSPACE_ID/agent-credentials"
```

Example configuration (substitute actual public IDs and a fresh client-generated request ID):

```json
{
  "requestId": "client_generated_unique_request_id",
  "name": "Conversation foreman",
  "capabilities": ["conversation.inspect"],
  "scope": {
    "mode": "locked",
    "conversationId": "conversation_public_id",
    "includeThreads": true
  }
}
```

Generic scope instead uses `{ "mode": "generic", "grants": [{ "conversationId": "...", "includeThreads": false }] }`. Supply an explicit UTC ISO `expiresAt` to choose earlier expiry. An empty capabilities array disables operations without changing scope.

## Headless HTTP inspection (B5)

Run the local product without opening a browser, for example `minu-channels run /path/to/workspace --no-open --control-port 47411`. Existing product startup/recovery policy is unchanged; inspection itself never starts agents. Provision the human-authorized key once using the non-UI instructions above. The product still includes its normal local web server; a new UI-free deployment package is not part of this slice.

The supported API origin is the **loopback control origin**, normally `http://127.0.0.1:47411`, or the control origin in the human launch URL. It is not the web SPA port or the internal collaboration service. There is exactly one agent operation:

`POST /api/agent/v1/conversation/inspect`

Supply `Authorization: Bearer <API key>` via the HTTP transport. No browser cookie, selected conversation, active model turn, agent participation or Runtime caller binding is required. Cookies and legacy service tokens do not authorize this endpoint. No key appears in the JSON request, query string or model-visible tool arguments.

Create `inspect.json` with `{ "conversationId": "known_permitted_public_id" }`. Keep a curl configuration file containing the authorization header private (`umask 077`, mode 0600), rather than placing the secret on the command line or in shell history:

```text
# agent-api.private.curl — substitute the one-time secret locally, never commit/share this file
header = "Authorization: Bearer <one-time-secret>"
header = "Content-Type: application/json"
```

```sh
curl --silent --show-error --config ./agent-api.private.curl \
  --data-binary @inspect.json --output ./inspection.private.json \
  "$CONTROL_ORIGIN/api/agent/v1/conversation/inspect"
```

The entire raw JSON body, including whitespace, is limited to 1 KiB; extra properties, query parameters, unsafe target selectors and duplicate authorization headers are rejected. Request body parsing shares the operation's eight-request admission limit and five-second deadline. Slow/incomplete bodies receive a bounded unavailable response and the connection is closed. The client disconnect signal prevents later result release; actual Runtime slots remain occupied until real settlement.

A success is a complete B4 snapshot, never a lifecycle/diagnostic response. Errors are fixed-code JSON: 400 invalid_request; 401 unauthenticated; indistinguishable 404 target_unavailable for absent/inaccessible/out-of-scope resources; 503 inspection_unavailable for overload/deadline/inspection failure. Other methods return 405, unsupported `/api/agent/...` operations return 404 unavailable. All responses are no-store. There is no MCP/tool-discovery endpoint: this documented route is the sole supported operation, and knowing lifecycle/admin names grants nothing.

Production resource policy is the approved **current active Workspace human owner/admin inspection entitlement**, including nonparticipants. It is checked for the selected target and any parent in addition to B3 scope/capability checks. Current Channels has no separate private/restricted-thread ACL; if one is introduced, this resource-policy port must narrow access rather than let thread inclusion bypass it.

For reproducible Runtime-boundary author evidence, build Channels control, then run `MINU_RUNTIME_ROOT=/absolute/path/to/an/existing/built/runtime node scripts/smoke-agent-api.mjs`. This uses disposable credentials/SQLite, a real Runtime-owned worker and real status HTTP, with a controlled final Pi RPC harness (no installed Pi/model invoked). Output identifies the actual Runtime HEAD/dirty state and compiled Pi/core JavaScript digest, and compares the Channels Runtime pin. A pin mismatch is reported, never silently presented as pinned-source evidence. Genuine installed-harness/workflow acceptance and required CI/release gates remain Q2/integration work.

## Explicit Runtime root for source development (I1)

For source startup and integration checks, set `MINU_RUNTIME_ROOT` to one clean built checkout of the commit in `runtime-source.json`. Build that Runtime with its frozen dependencies before running Channels. Do not repoint shared Runtime links or downgrade access policy to make an older copy load.

```sh
# RUNTIME_ROOT is an absolute path to the separately built, clean pinned Runtime.
export MINU_RUNTIME_ROOT="$RUNTIME_ROOT"
pnpm exec tsc -b packages/control --pretty false
node --test packages/control/dist/test/local-runtimes.test.js
node scripts/smoke-agent-api.mjs
pnpm test
```

The app's loader honors this root too, not just the smoke script. Selection order is: explicit per-adapter module override, explicit `MINU_RUNTIME_ROOT`, packaged adapter, then the existing development sibling fallback. With an explicit root, a missing module or empty root fails clearly; it never silently borrows another checkout. Without an explicit root, existing packaged behavior is unchanged. The loader does not build/fetch Runtime or rewrite the pin automatically; the smoke reports the actual source/artifact identity for comparison.

## Administrative contract

All paths begin `/local/workspaces/:workspaceId/agent-credentials`. JSON requests reject extra fields; bodies are capped at 64 KiB. These are administrative bounds, not the inspection request's 1 KiB bound. Responses use `Cache-Control: no-store`.

| Method/path suffix | Input | Result |
| --- | --- | --- |
| GET `/` | none | `{ credentials: [...] }`, own keys only |
| POST `/` | `requestId`, `name`, `capabilities`, `scope`, optional `expiresAt` | 201 `{ credential, secret }` |
| GET `/:id` | none | `{ credential }` |
| PATCH `/:id` | `expectedRevision`, one or more of `name`, `capabilities`, `scope`, `expiresAt` | `{ credential }` |
| POST `/:id/rotate` | `expectedRevision` | `{ credential, secret }` |
| POST `/:id/revoke` | `expectedRevision` | `{ credential }` |

Collection paths have no trailing slash. Summaries include public ID, issuing principal/Workspace, creation request ID, name, grants, revision, secret generation, timestamps and optional revocation timestamp. Neither the verifier digest nor the raw secret appears in a summary. Errors contain only a fixed code: invalid request (400), authentication required (401), forbidden (403), unavailable target/credential (404), request/revision/inactive conflict (409), or administrative failure (503).

## Conflicts and uncertain outcomes

Every successful update/rotation/revocation increments the credential revision. Rotate/revoke are explicit actions, not DELETE. After a 409, re-read and review the current configuration; do not silently rebase. Rotation preserves the reviewed grants and expiry. Inspection's final authorization must reject a captured old secret generation/revision after any relevant change (B3).

Creation request IDs are unique per Workspace/principal. A repeated create returns 409 `request_already_recorded`, never a second secret or replay. If creation's response is lost, list keys and find that request ID; explicitly revoke the recorded key and issue a new reviewed request if the secret was lost. A different payload with the same request ID also conflicts.

If rotation's response is lost, read metadata and compare revision/generation with the attempted operation. A changed revision alone does not prove which competing change won: review current metadata. The old secret may already be invalid. Explicitly rotate again using the reviewed current revision, or revoke; never automatically replay rotation. Likewise resolve an uncertain update/revoke by reading metadata. Generic errors do not guarantee the mutation failed before persistence.

## Shared inspection authorization boundary (B3)

`AgentInspectionAuthorization` is the inspection-only operation boundary for adapters. It is not an HTTP route or tool registry. Adapters supply the transport secret, a strict `{ conversationId }` request, the read-only status projector, and a synchronous response-release callback. Model-selected principal IDs, role names, caller bindings and extra request fields are rejected. Legacy/custom public IDs remain opaque but must be safe single path selectors.

Each invocation authenticates the key, checks `conversation.inspect`, resolves current Workspace/human owner-admin entitlement, checks generic/locked grants against the current target and parent metadata, and evaluates a **required** `canInspectTarget` resource-policy port. Thread inclusion never overrides denial on either the parent or selected thread; direct thread grants do not authorize parents or siblings. There is no policy/discovery bypass flag or cross-request authorization cache. The port is not a new stored thread ACL; B5 production composition applies the owner/admin resource entitlement described above.

After the asynchronous read, the boundary repeats target/policy/principal checks, rejects changed parent linkage or roster revision, then authenticates again and compares credential revision and secret generation. Expiry is checked again immediately before synchronous release. Revocation/rotation invalidate admitted reads; scope/capability edits also invalidate an admitted revision. Principal authority is checked again after potentially slow resource-policy reads. These are current boundary checks, not an atomic transaction across separate services.

The release callback must serialize immediately; it must not await further work or expose the read result before authorization finishes. B4 owns the response allowlist and status projection. B5 passes the whole-request deadline/disconnect signal; B3 abort stops waiting and prevents late release, but does not claim that an underlying port's I/O was cancelled. B4 must retain real Runtime probe slots until those calls settle. B3 adds no production route, Runtime probes or lifecycle effects.

## Bounded status snapshot (B4)

`AgentStatusInspection` composes B3 authorization with the existing local-control state interpreter. B5 registers its production route. Its public snapshot is `{ version: 1, conversationId, sampledAt, participants }`; participant fields are only public identity ID, handle, optional display name, type, normalized membership status and applicable `{ state, lastVerifiedAt? }` runtime. Humans omit runtime; agents/services always have an explicit state. Current disabled members remain present, removed members do not reappear through orphan bindings. Diagnostics, capability flags, activity payloads, messages, configuration and private Runtime identifiers are never serialized.

Inspection calls the same state interpreter as the UI while omitting capability queries entirely. Its only Runtime I/O is read-only status; activity/start/work observations are existing process-local read methods. No start, resume, recovery, reconnect or other mutation is invoked. Individual failures, missing verification and malformed Runtime responses yield uncertain; an unavailable binding directory leaves the full roster uncertain rather than falsely unbound. Invalid/incomplete/duplicate-ID/over-128 rosters and over-128-KiB UTF-8 results fail unavailable, never truncate. `sampledAt` is assembly time; valid source `lastVerifiedAt` is retained unchanged, never replaced by that clock. No status response cache is introduced.

The five-second whole-operation deadline starts before authorization and includes roster/status work and final authorization. New/waiting status work stops at an absolute monotonic four-second cutoff, checked before every Runtime call even if timer callbacks are delayed, reserving up to one second for final authorization; authorization can still fail unavailable if it cannot finish by five seconds. Every actual status call has a two-second monotonic result deadline, including synchronous call time; overdue results remain uncertain even if promise completion beats delayed timeout delivery. Four worker loops process the bounded roster, but only four actual inspection Runtime calls may remain outstanding across all inspector instances in the process. Timed-out calls retain those slots until actual settlement; saturated probes return uncertain without queueing more Runtime work. This inspection cap does not retrofit unrelated legacy UI calls. Eight inspections may be active process-wide; further requests fail immediately without an unbounded queue.

The same disconnect/deadline signal reaches B3; no late result is released after abort. A complete roster can legitimately contain many uncertain states, including unattempted probes. B5 supplies the loopback HTTP route, 1-KiB raw request-body limit, concrete resource policy and disconnect wiring. The smoke script supplies controlled-harness real Runtime-boundary evidence; independent installed-harness/workflow acceptance remains Q2.

## Verification boundary

Use disposable databases and HTTP fixtures. B2 checks migration from 0028, persistence/reopen, human/admin authority, strict grants, digest-only storage, one-time delivery, conflicts and atomic rotation/revocation. Full inspection authorization, bounded Runtime status and independent integrated API/Runtime acceptance are separate B3–B5/Q2 evidence, not implied by credential tests.
