# Network connection lifecycle fixes

Status: owner-approved lifecycle fixes passed targeted code review and verifier V&V, including the complete-but-unread response correction. A scoped integration branch is prepared on current main; required CI, full agent workflows, individual crashed-tab lease expiry, and soak remain outstanding. No release or installation has been performed.

## Objective and evidence

Release every proxy-owned active connection and SSE subscription when its consumer disappears, without interrupting valid HTTP responses or changing message-delivery semantics. At steady workload, connections must remain bounded by current consumers rather than historical connections.

Confirmed in the investigation:

- Production proxy disconnect leak: 12 proxied SSE disconnects retained 12 backend subscriptions and 12 established loopback TCP connections. Twelve direct disconnects retained neither. Web-server closure alone did not release the orphans; backend closure did.
- SSE setup race: disconnecting while subscription creation was pending retained subscriptions on both event routes, with no surviving TCP connections.
- Astra independently reproduced both defects and additionally observed a downstream stream remaining open after premature upstream response termination.

These findings explain a connection-growth mechanism, not the original ENOBUFS incident. PID 8952, its exact build, and kernel-buffer causality remain unverified. Neither an open-file count nor two endpoint rows represents two distinct loopback TCP connections.

### Source baseline (before implementation)

Repository: `channels/`, HEAD `00c289f4fd6856fc2fdb231001fdd0bade33db8a`, including pre-existing working-tree changes. Preserve those changes; do not reset or sweep them into this work.

SHA-256 of inspected source:

| File | SHA-256 |
| --- | --- |
| `packages/control/src/local-web-server.ts` | `24ec442528ee9466d9d15bcbd74bbfdc3e4df0074b5dfa99b0953b6411ecc8b8` |
| `packages/core/src/http-server.ts` | `47bd3afaf1ff8d2a01ae581af59ffb9d8ce5a2ad16fff10ba1409a120c115fe3` |

Line references below apply to this snapshot. Re-read both files before implementation; review intervening changes rather than overwriting them.

## Scope and file map

| File | Proposed update |
| --- | --- |
| `packages/control/src/local-web-server.ts:46–80` | Complete bidirectional ownership/termination of each proxied exchange. |
| `packages/core/src/http-server.ts:257–290,428–450,485–498` | Make both SSE subscription setups cancellation-safe and cleanup idempotent, including shutdown. |
| `packages/control/test/local-web-server-lifecycle.test.ts` (new) | Real HTTP proxy lifecycle regressions and repeated-cycle integration coverage. |
| `packages/core/test/http-server-lifecycle.test.ts` (new) | Deterministic setup-race, cleanup, and heartbeat ownership regressions for both routes. |

Use local handlers and existing Node HTTP APIs. A small file-local cleanup helper is acceptable only where it avoids divergent lifecycle handling; do not introduce a networking framework or public abstraction.

Non-goals: Runtime/Relay redesign, SharedWorker/reconnection-policy changes, Vite proxy changes, connection caps, new custom HTTP agents, global-agent destruction, new dependencies, telemetry endpoints, schema changes, UI changes, kernel tuning, installation, deployment, or release publication. Expand scope only if a concrete remaining failure requires it and the owner agrees.

## A. Production HTTP proxy

Each proxied exchange owns its upstream request and, once received, its upstream response. Connect cancellation/error handlers before piping. Use idempotent terminal handling and guards against already-closed responses.

| Event | Required behavior |
| --- | --- |
| Browser aborts during request upload | Stop forwarding the body and destroy this exchange's upstream resources. |
| Browser disconnects while awaiting headers or streaming a response | Destroy upstream request/response; release the backend SSE subscription through its normal disconnect path. |
| Incoming request completes normally | Continue waiting for/streaming the response. **Do not treat normal IncomingMessage `close` as cancellation.** |
| Upstream request fails before downstream headers | Send the existing generic JSON 502 if the browser response is still writable. Never expose the upstream error or credentials. |
| Upstream response errors, aborts, or closes before its HTTP message is complete | Terminate the downstream response promptly. After headers, destroy it rather than pretending a truncated stream completed successfully or attempting a second status response. |
| Upstream response ends normally | Preserve normal piping and response completion, including an intentional SSE end; do not destroy a healthy reusable socket. Parser completion (`complete`) alone is insufficient: cancellation must dispose responses whose readable side has not ended (`readableEnded`). |
| Upstream response arrives after browser cancellation | Dispose it immediately; do not write downstream headers or start piping. |
| `web.close()` destroys inbound sockets | The same cancellation path releases active upstream exchanges without requiring backend shutdown. |

Handle request and response errors without unhandled events, repeated writes, or recursive teardown. Retain needed error handlers until destruction settles; do not leave callbacks attached to reusable sockets. Do not add application-level retries.

Preserve routing, authentication/actor headers, origin stripping, cookies and renewal cookies, response headers/status, binary bytes, streamed request bodies, and quiescing behavior. A disconnected browser does not roll back an already-admitted mutation. The proxy must not replay it or claim otherwise.

## B. SSE setup and cleanup

Apply the same ownership rules to `/conversations/:id/events` and `/conversations/events`:

1. Track response closure before awaiting `subscribe`/`subscribeMany`.
2. When subscription setup resolves, check the tracked terminal state and response destruction. If disconnected, call the returned unsubscribe immediately and return without registering a stream, writing readiness, or creating a heartbeat.
3. Otherwise register the active stream and heartbeat under one idempotent cleanup path.
4. Cleanup removes the stream, clears its heartbeat, releases the subscription exactly once, and releases local pending events. Do not enqueue or write events after closure.
5. Setup rejection, response failure, client disconnect, and server shutdown must all release any acquired resources. Do not attempt an error response on an already-destroyed response.
6. Keep the existing multiplexed pending-before-ready ordering, event/frame formats, heartbeat interval, authorization, and subscription validation unchanged.

Retain the existing server shutdown mechanism (`stream.end()`, `server.close()`, `closeAllConnections()`) unless the regression tests demonstrate it cannot trigger the corrected cleanup. A subscription resolving after shutdown must dispose itself; do not make shutdown wait indefinitely for stalled setup. Do not solve per-response leaks by clearing all service listeners globally.

## Regression tests and acceptance criteria

Use `node:test`, actual loopback HTTP servers on ephemeral ports, temporary assets, and in-memory conversation storage. The proxy tests must instantiate `createLocalWebServer`, not substitute Vite or mock away the HTTP boundary.

Use readiness/entry barriers and socket/response close events instead of arbitrary sleeps. Proposed automated cleanup deadline: two seconds after disconnect, or after releasing a deliberately paused setup. Use bounded test timeouts and ensure failure cleanup closes fixture resources.

### Proxy integration file

- Exercise both SSE routes through the real conversation backend. After readiness and browser cancellation, subscriptions return to baseline and fixture-owned active stream sockets close within the deadline, without closing the backend.
- Repeat 100 connect/disconnect cycles per route. No residual active subscription/socket increase after settled cycles. Use non-pooling clients for this resource oracle; pooled idle sockets are a separate category.
- Disconnect before upstream headers arrive; release delayed headers and assert no orphan or late downstream write.
- Abort an incomplete upload; assert upstream request/socket closure. Separately complete an ordinary request body and delay its response: the full response must still arrive.
- Send SSE readiness, then abruptly destroy the upstream response. The browser stream must terminate within the deadline so the existing client can reconnect. Also verify intentional upstream end completes normally.
- Refuse the upstream connection before headers: preserve the generic 502. Check the already-disconnected browser race produces no secondary write or unhandled error.
- Close only the web server with an active stream; backend active subscriptions/stream sockets must return to baseline.
- Exercise ordinary JSON GET and POST, delayed/chunked output, and binary response integrity. Add a proxied HEAD case that completes normally without a response body.
- For sequential finite responses through a keep-alive client, assert actual upstream socket reuse, not just successful responses or browser-facing socket reuse. Do not disable pooling globally to obtain a zero count.
- Cancel under downstream backpressure after the upstream parser is complete but before the readable side ends. The unread response must be destroyed and its backend socket must close within two seconds; ordinary completed-response reuse must still pass.

Retain the existing production-web routing/authentication/cookie/quiescing test in `packages/control/test/control.test.ts:1485` as compatibility coverage; no need to duplicate its whole matrix.

### Core SSE lifecycle file

Parameterize both routes where their contracts match:

- Normal ready/disconnect and server shutdown: zero residual subscriptions, stream registrations, and fixture-owned heartbeat timers.
- Pause subscription completion after acquisition, disconnect, then release it: unsubscribe exactly once; no stream registration or heartbeat creation after closure.
- Repeat the paused-setup case with server shutdown before releasing setup, and with subscription rejection after disconnect. No retained resource or attempted write to the dead response.
- Connected setup rejection/invalid subscription retains existing error behavior without leaking partial subscriptions.
- Overlapping terminal notifications do not double-unsubscribe. Scoped heartbeat instrumentation verifies creation/clear balance, not merely that an unref'd timer cannot keep the process alive.
- Preserve readiness, live event delivery, multiplexed pending-event ordering, and quiet-connection heartbeats through existing tests plus a focused race assertion if needed.

Test instrumentation must remain fixture-local. Do not introduce public production counters, configuration flags, or a testing framework solely to inspect cleanup.

## Verification sequence

### Focused development checks

From `channels/` (executed; results below):

```bash
pnpm exec tsc -b packages/control
node --test packages/core/dist/test/http-server-lifecycle.test.js
node --test packages/control/dist/test/local-web-server-lifecycle.test.js
node --test --test-name-pattern="SSE|multiplex" packages/core/dist/test/channels.test.js
node --test --test-name-pattern="local production web server serves" packages/control/dist/test/control.test.js
```

Compilation includes the control package's referenced dependencies. Run affected tests while implementing; do not run workspace-wide suites after each edit. Existing browser hub code is unchanged; its passing unit tests are contextual evidence, not a substitute for these real-proxy regressions.

At integration, satisfy the existing CI checks in `.github/workflows/ci.yml`, including macOS/Ubuntu verification, browser checks, and package checks. Follow [release requirements](releasing.md) separately; do not run release/tag/install commands as routine development checks or publish from the dirty investigation tree.

### macOS operational validation

Use an isolated production-server fixture/build; do not restart the user's live installation or kill real agents without permission. Record revision/build, Node version, PID, fixture configuration, and timestamped baseline/peak/post-cleanup measurements.

```bash
lsof -nP -a -p "$PID" -iTCP -sTCP:ESTABLISHED
```

Group endpoints by role/port. Deduplicate a same-process loopback connection's two endpoint rows; do not divide all rows by two because connections to other processes may have only one local row. Separate active streams, idle pooled HTTP sockets, and transient TCP cleanup states. Fixture socket counters are cleanup oracles, not a substitute for OS-established-state measurements.

Validate repeated navigation/topic replacement, six browser tabs and multiple agents, abrupt termination of fixture-only clients/workers, and transport interruptions/backend restarts. Active connection counts must converge to the baseline appropriate to the remaining consumers; web-only closure must not leave active proxy streams behind. Allow the existing crashed-tab SharedWorker lease window (three minutes plus up to one sweep interval) and legitimate bounded idle pooling.

After focused acceptance, run a 24–48-hour bounded workload soak before claiming continuous-operation stability. Sample counts at a fixed workload and after cleanup; require no sustained upward trend or residual per-cycle growth. This soak is distinct from implementation-ready review, required CI, release acceptance, and proof of the historical ENOBUFS cause. Record any deferred soak explicitly.

## Implementation handoff

- Owner accepted implementation in Conversation message 11. Source changes are limited to the two mapped files, with two new regression files; unrelated working-tree changes were preserved.
- Suggested order: add failing proxy/setup-race regressions; implement proxy termination; implement SSE setup cleanup; run focused checks; review the integrated diff and operational count results.
- Required handoff: changed files/diff, tested source revision, exact commands/results, before/after count evidence, remaining gaps, and confirmation that unrelated working-tree edits were preserved.
- Specification review: sol-med returned PASS with no blocking findings against the recorded source baseline. The optional upstream-socket-reuse and HEAD-response checks are incorporated above. This was a specification review, not implementation validation or renewed defect reproduction.

## Implementation evidence (initial implementation)

Target: HEAD `00c289f4fd6856fc2fdb231001fdd0bade33db8a` plus the existing working tree and the lifecycle changes below. No commit, installation, deployment, or release was performed.

| Changed file | Tested SHA-256 |
| --- | --- |
| `packages/control/src/local-web-server.ts` | `5040654123bee2fe82616e48c16ae8624b7a621fe322605cfbd543fa86e3bca3` |
| `packages/core/src/http-server.ts` | `2b47c040914807c2eaf47d0e9cbe86d4743f4ddda79f602589ee1413a4d4085c` |
| `packages/control/test/local-web-server-lifecycle.test.ts` | `a5b704154165c08d2ad9e584097d87930988b17247784c26ef39577fc37f6178` |
| `packages/core/test/http-server-lifecycle.test.ts` | `e4a3e85d7a453ca8570cae8c2d4dc59e7ed46ee76d7896e4b249da08476935a6` |

- Before source changes: compilation passed; the new single-route proxy-disconnect and early-subscription-disconnect regressions both failed their two-second resource cleanup deadlines.
- `pnpm exec tsc -b packages/control` — passed after implementation.
- `node --test packages/core/dist/test/http-server-lifecycle.test.js packages/control/dist/test/local-web-server-lifecycle.test.js` — 17 passed, including 100 disconnect cycles per route, web-only shutdown, setup/shutdown/rejection races, response errors, event ordering, JSON/binary/HEAD compatibility, and actual upstream keep-alive reuse.
- `node --test --test-name-pattern="SSE|multiplex" packages/core/dist/test/channels.test.js` — 5 passed.
- `node --test --test-name-pattern="local production web server serves" packages/control/dist/test/control.test.js` — 1 passed.
- `git diff --check` — passed.
- Test synchronization was corrected to wait for the backend response's close event, not merely the client's socket closure. Underlying HTTP socket observation uses fixture-port-filtered Node diagnostics channels; no production counters or socket-level listeners were added.
- During test development, an asynchronous HEAD fixture followed immediately by another request used two sockets even against a direct Node server. The regression checks reuse across GET/POST/GET and normal HEAD completion, without asserting unsupported reuse across that direct-Node behavior.

### Isolated macOS established-TCP measurement

Executed `node /tmp/sol-med-channels-network-counts.mjs` against compiled current source on Darwin 23.1.0, Node v22.23.0, PID 94646, at 2026-11-09T15:29:17–19Z. Fixture: in-memory storage, 25 ms SSE heartbeat, backend `127.0.0.1:58034`, production web proxy `127.0.0.1:58035`, non-pooling loopback HTTP clients, ephemeral assets. The temporary script uses the `lsof` command above and deduplicates endpoint pairs, rather than dividing all rows by two.

| Checkpoint | Subscriptions | Upstream established connections | All fixture established connections |
| --- | ---: | ---: | ---: |
| Baseline | 0 | 0 | 0 |
| Single active SSE | 1 | 1 | 2 |
| After 100 single-route cycles | 0 | 0 | 0 |
| Multiplexed active SSE | 1 | 1 | 2 |
| After 100 multiplexed-route cycles | 0 | 0 | 0 |
| Six concurrent fixture consumers | 6 | 6 | 12 |
| Web-only closure; backend still running | 0 | 0 | 0 |
| Full fixture shutdown | 0 | 0 | 0 |

Every upstream loopback connection produced two endpoint rows owned by the fixture PID. The additional established connections while active were browser-side fixture clients connecting to the web proxy, not additional backend streams. Cleanup checks used a two-second deadline.

These are short-lived HTTP/SSE fixture results, not six real browser tabs or attached agents. Required CI, browser topic replacement/lease behavior, abrupt real fixture-worker termination, transport interruption/backend restart scenarios, and the 24–48-hour soak were not executed. No live installation or agent was restarted. Do not claim release readiness, continuous-operation stability, or historical ENOBUFS causality from these results. This initial target subsequently received verifier REQUEST_CHANGES for the unread-response case below.

### Verifier-requested correction: complete-but-unread responses

Verifier's Conversation message 15 confirmed that `IncomingMessage.complete` can be true with unread buffered bytes. The initial cleanup guard skipped destruction in that state, retaining one active upstream connection beyond the two-second deadline. The observed connection eventually closed at the backend timeout; indefinite retention was not demonstrated. Original reviewer evidence: `/tmp/verifier-channels-network.aZA3o5/complete-unread-characterized.log`.

Correction is limited to `stopUpstream` in `packages/control/src/local-web-server.ts`: preserve sockets only after `readableEnded`, rather than parser completion. Existing request-completion and idempotent termination guards are unchanged. Both core files remain unchanged from the initial tested target.

The new real-HTTP regression uses fixture-only downstream socket corking to cause writable backpressure, waits for the upstream readable to pause, and then ends the backend with a small tail. It asserts `complete === true`, `readableEnded === false`, and unread buffered bytes before cancelling. Cancellation must destroy the upstream response and close the backend socket within two seconds. This avoids payload-size searching or dependence on TCP receive-window capacity. The initial guard failed the cleanup deadline; the corrected guard passed. Existing upstream socket-reuse assertions remain intact.

Current target: same HEAD and preserved unrelated working tree as above, with these replacement hashes:

| Changed file | Current tested SHA-256 |
| --- | --- |
| `packages/control/src/local-web-server.ts` | `8b0b688bb106042aa77a31007e02aa65e535d0bdf401fed7656ab6ca854a94dc` |
| `packages/control/test/local-web-server-lifecycle.test.ts` | `c92dba78e5fbc03cccaee131494da26d2354fadb913e48db6cd2cc89eeec908c` |

Correction checks:

- `pnpm exec tsc -b packages/control` — passed.
- `node --test --test-name-pattern='fully parsed but unread|upstream keep-alive reuse' packages/control/dist/test/local-web-server-lifecycle.test.js` — 2 passed.
- `node --test packages/control/dist/test/local-web-server-lifecycle.test.js` — 7 passed, including both 100-cycle SSE regressions.
- `node --test --test-name-pattern='local production web server serves' packages/control/dist/test/control.test.js` — 1 passed.
- `git diff --check` — passed.

Core verification evidence is reused because the core source and regression hashes are unchanged. The earlier OS measurements apply to the initial target; they were not repeated by the author for this correction. Verifier separately reported passing browser, cancellation/failure ordering, abrupt-client, and backend-restart scenarios against that initial target; these are independent reviewer results, not author reruns. Verifier subsequently approved the correction in Conversation message 17 after independently repeating the original real-TCP backpressure scenario: upstream established connections dropped from one to zero within 27 ms. Evidence: `/tmp/verifier-channels-network.aZA3o5/correction-focused.log` and `correction-os.log`. Prior core/browser evidence was reused, not fully rerun. Required CI, full agent workflows, individual crashed-tab lease expiry, and the soak remain outstanding; no installation or release occurred.

## Scoped integration target

Branch: `fix/network-connection-lifecycle`, based on main `f01075c4340cf0f912c523d5590683a2f4301a20` (46 commits after the investigation checkout). Prepared in a clean, separate clone; the original shared branch, index, and working-tree files are preserved. Only the two lifecycle source changes, two new regression files, and this specification/evidence document belong to the PR. Unrelated thread/cursor/folder changes from the shared working tree were not copied; current main's existing behavior is retained.

The proxy and both regression files are byte-identical to the verifier-approved correction. The SSE lifecycle helper and associated route/cleanup changes were applied unchanged to current main's HTTP server; its whole-file hash differs because current main contains additional pre-existing routes and validation.

| Integration source/test | SHA-256 |
| --- | --- |
| `packages/control/src/local-web-server.ts` | `8b0b688bb106042aa77a31007e02aa65e535d0bdf401fed7656ab6ca854a94dc` |
| `packages/core/src/http-server.ts` | `ccebf9bf806005becf75840f81f6fba3e7ac7812948f69f34e94e312687f7e30` |
| `packages/control/test/local-web-server-lifecycle.test.ts` | `c92dba78e5fbc03cccaee131494da26d2354fadb913e48db6cd2cc89eeec908c` |
| `packages/core/test/http-server-lifecycle.test.ts` | `e4a3e85d7a453ca8570cae8c2d4dc59e7ed46ee76d7896e4b249da08476935a6` |

Local integration checks on Node v22.23.0:

- `pnpm install --frozen-lockfile` — passed without changing the lockfile.
- `pnpm exec tsc -b packages/control` — passed.
- `node --test packages/core/dist/test/http-server-lifecycle.test.js packages/control/dist/test/local-web-server-lifecycle.test.js` — 18 passed, including the backpressure correction and 100 cycles per SSE route.
- `node --test --test-name-pattern='SSE|multiplex' packages/core/dist/test/channels.test.js` — 5 passed.
- `node --test --test-name-pattern='local production web server serves' packages/control/dist/test/control.test.js` — 1 passed.
- `git diff --check` — passed.

These 24 focused test results cover the isolated integration target; historical browser/OS results above retain their recorded target and limitations. A ready-for-review PR triggers the repository's existing macOS/Ubuntu, web/browser, and package CI gates. Their results are separate from local evidence; do not claim they passed until observed. No merge, tag, publication, product installation, or live restart is part of this integration handoff.
