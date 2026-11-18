import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBrowserPath, conversationBrowserPath, decodeBrowserId, encodeBrowserId, isBrowserNavigation, toInternalBrowserPath, toPublicBrowserPath } from "../src/browser-urls.ts";

const v4 = "550e8400e29b41d4a716446655440000";
const v7 = "01900000000070008000000000000001";

test("browser IDs compact UUIDv4/v7 without losing legacy or ambiguous IDs", () => {
  for (const kind of ["workspace", "conversation"] as const) {
    for (const payload of [v4, v7]) {
      assert.equal(encodeBrowserId(`${kind}_${payload}`, kind), payload);
      assert.equal(decodeBrowserId(payload, kind), `${kind}_${payload}`);
    }
    for (const id of [v4, `channel_${v4}`, "legacy-id", "~literal", "~~", "conversation_bad", "conversation_" + v7.toUpperCase(), "a/b ?#%", "new"]) {
      assert.equal(decodeBrowserId(encodeBrowserId(id, kind), kind), id);
    }
  }
});

test("browser paths normalize legacy aliases losslessly and leave suffixes and URL state intact", () => {
  for (const suffix of ["", "/settings", "/participants/identity_123/diagnostics"]) {
    const old = `/app/workspaces/workspace_${v4}/channels/channel_${v7}${suffix}`;
    const canonical = `/workspaces/${v4}/conversations/channel_${v7}${suffix}`;
    assert.equal(canonicalBrowserPath(old), canonical);
    assert.equal(canonicalBrowserPath(canonical), canonical);
    assert.equal(toInternalBrowserPath(canonical), old.replace("/channels/", "/conversations/"));
  }
  const oldBare = `/app/workspaces/${v4}/conversations/${v7}`;
  assert.equal(canonicalBrowserPath(oldBare), `/workspaces/~${v4}/conversations/~${v7}`);
  assert.equal(toInternalBrowserPath(canonicalBrowserPath(oldBare)), oldBare);
  const id = "legacy/id ?#%";
  const publicPath = conversationBrowserPath("workspace-legacy", id);
  assert.equal(toInternalBrowserPath(publicPath), `/app/workspaces/workspace-legacy/conversations/${encodeURIComponent(id)}`);
  const url = new URL(`/app/workspaces/workspace_${v4}/conversations/conversation_${v7}?triggerSequence=42&extra=hello%20world#message-42`, "http://localhost");
  const search = url.search;
  url.pathname = canonicalBrowserPath(url.pathname);
  assert.equal(url.search, search);
  assert.equal(url.hash, "#message-42");
  assert.equal(url.pathname, `/workspaces/${v4}/conversations/${v7}`);
  for (const path of ["/", "/local/session/bootstrap", "/workspaces/%ZZ/conversations/id"]) assert.equal(canonicalBrowserPath(path), path);
  assert.equal(toPublicBrowserPath(`/app/workspaces/workspace_${v4}/settings/skills/id`), `/workspaces/${v4}/settings/skills/id`);
});

test("only explicit HTML page navigations bypass overlapping API routes", () => {
  const page = `/workspaces/${v4}/conversations/${v7}`;
  for (const path of [page, `${page}/settings`, `${page}/participants/identity_test/diagnostics`, `/workspaces/${v4}/agents`, `/workspaces/${v4}/settings/presets/new`]) {
    assert.equal(isBrowserNavigation(path, "GET", "text/html,application/xhtml+xml", "document"), true);
    assert.equal(isBrowserNavigation(path, "HEAD", "text/html"), true);
    for (const accept of [undefined, "*/*", "application/json", "text/event-stream", "text/html;q=0"]) assert.equal(isBrowserNavigation(path, "GET", accept), false);
    assert.equal(isBrowserNavigation(path, "POST", "text/html"), false);
    assert.equal(isBrowserNavigation(path, "GET", "text/html", "empty"), false);
  }
  for (const api of ["/workspaces", "/workspaces/workspace_test", "/workspaces/workspace_test/conversations", "/conversations/conversation_test/messages", "/conversations/conversation_test/events", "/conversations/conversation_test/attachments/image", "/local/session/bootstrap"]) {
    assert.equal(isBrowserNavigation(api, "GET", "text/html"), false);
  }
});
