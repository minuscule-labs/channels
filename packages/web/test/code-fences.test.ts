import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { canonicalFenceLanguage, fencedCodeLanguages } from "../src/lib/code-fences";

describe("fenced code language selection", () => {
  it("normalizes supported aliases and ignores unknown or unlabeled fences", () => {
    assert.deepEqual(
      fencedCodeLanguages("```typescript\nconst answer = 42;\n```\n\n~~~yml\nname: Minu\n~~~\n\n```unknown\nplain\n```\n\n```\nplain\n```"),
      ["ts", "yaml"],
    );
    assert.equal(canonicalFenceLanguage("docker"), "dockerfile");
    assert.equal(canonicalFenceLanguage("unknown"), "plaintext");
  });

  it("does not mistake a closing fence for a requested grammar", () => {
    assert.deepEqual(fencedCodeLanguages("```ts\nconst answer = 42;\n```"), ["ts"]);
  });
});
