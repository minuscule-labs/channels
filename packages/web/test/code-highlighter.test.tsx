import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { loadRehypeHighlight } from "../src/lib/code-highlighter";

describe("highlighting alongside Mermaid", () => {
  it("preserves Mermaid fences and source while highlighting supported code", async () => {
    const plugin = await loadRehypeHighlight(["ts"]);
    const html = renderToStaticMarkup(
      <Markdown rehypePlugins={[plugin]}>{[
        "```mermaid", "graph TD", "  A[Start] --> B[Done]", "```", "",
        "> ~~~MeRmAiD", "> sequenceDiagram", ">   Alice->>Bob: Hello", "> ~~~", "",
        "```typescript", "const answer: number = 42;", "```", "",
        "```unknown", "<script>not executable</script>", "```",
      ].join("\n")}</Markdown>,
    );
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain('class="language-MeRmAiD"');
    expect(html).toContain("  A[Start] --&gt; B[Done]\n");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("th-keyword");
    expect(html).toContain('data-language="plaintext"');
    expect(html).not.toContain("<script>");
  });
});
