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

  it("finds fenced code nested in blockquotes and list items", () => {
    const markdown = [
      "> ```typescript",
      "> const answer = 42;",
      "> ```",
      "",
      "- A list item",
      "",
      "    ~~~yml",
      "    key: value",
      "    ~~~",
    ].join("\n");
    assert.deepEqual(fencedCodeLanguages(markdown), ["ts", "yaml"]);
  });

  it("treats prototype-related labels as unknown languages", () => {
    assert.equal(canonicalFenceLanguage("__proto__"), "plaintext");
    assert.equal(canonicalFenceLanguage("constructor"), "plaintext");
    assert.deepEqual(fencedCodeLanguages("```__proto__\nplain\n```\n\n```constructor\nplain\n```"), []);
  });

  it("does not mistake a closing fence for a requested grammar", () => {
    assert.deepEqual(fencedCodeLanguages("```ts\nconst answer = 42;\n```"), ["ts"]);
  });
});
