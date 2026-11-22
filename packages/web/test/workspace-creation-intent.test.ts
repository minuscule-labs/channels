import { describe, expect, it } from "vitest";
import { forgetWorkspaceCreationIntent, readWorkspaceCreationIntent, rememberWorkspaceCreationIntent, workspaceCreationIntentKey } from "../src/lib/workspace-creation-intent";
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const id = "request_original_12345";
describe("workspace creation recovery identity", () => {
  it("stores only the opaque request ID and scopes it to the account", () => {
    const s = storage();
    expect(rememberWorkspaceCreationIntent(s, "owner", id)).toBe(id);
    expect([...s.values]).toEqual([[workspaceCreationIntentKey("owner"), id]]);
    expect(readWorkspaceCreationIntent(s, "another-account")).toBeUndefined();
  });
  it("does not overwrite another unresolved intent or clear a different identity", () => {
    const s = storage();
    rememberWorkspaceCreationIntent(s, "owner", id);
    expect(rememberWorkspaceCreationIntent(s, "owner", "request_replacement_12345")).toBe(id);
    forgetWorkspaceCreationIntent(s, "owner", "request_replacement_12345");
    expect(readWorkspaceCreationIntent(s, "owner")).toBe(id);
    forgetWorkspaceCreationIntent(s, "owner", id);
    expect(readWorkspaceCreationIntent(s, "owner")).toBeUndefined();
  });
  it("fails closed when an identity cannot be persisted", () => {
    const s = storage();
    s.setItem = () => { throw new Error("storage unavailable"); };
    expect(() => rememberWorkspaceCreationIntent(s, "owner", id)).toThrow("storage unavailable");
    expect(s.values.size).toBe(0);
  });
  it("does not silently discard a corrupt recovery identity", () => {
    const s = storage();
    s.values.set(workspaceCreationIntentKey("owner"), "invalid");
    expect(() => readWorkspaceCreationIntent(s, "owner")).toThrow("invalid");
    expect(() => rememberWorkspaceCreationIntent(s, "owner", id)).toThrow("invalid");
  });
});
