import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { MessageMarkdown } from "../src/components/message-markdown";

describe("agent response markdown", () => {
  it("renders common Markdown and GFM structures", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={`## Result\n\n- one\n- two\n\n| File | Status |\n| --- | --- |\n| app.ts | done |\n\n[Details](https://example.com)`} />,
    );
    assert.match(html, /<h2/);
    assert.match(html, /<ul/);
    assert.match(html, /<table/);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noreferrer noopener"/);
  });

  it("renders fenced code safely with a copy control before highlighting is loaded", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={'Inline `value`\n\n```ts\nconst answer: number = 42;\n```'} />,
    );
    assert.doesNotMatch(html, /class="th-token th-keyword"/);
    assert.match(html, /data-language="ts"/);
    assert.match(html, /aria-label="Copy code"/);
    assert.equal(html.match(/aria-label="Copy code"/g)?.length, 1);
  });

  it("recognizes Mermaid fences, including nested tilde fences, without loading the renderer on the server", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={'> ~~~mermaid\n> graph TD\n>   A[Start] --> B[Done]\n> ~~~'} />,
    );
    assert.match(html, /data-language="mermaid"/);
    assert.match(html, /Rendering diagram/);
    assert.match(html, /A\[Start\]/);
    assert.match(html, /aria-label="Copy code"/);
    assert.doesNotMatch(html, /aria-label="Mermaid diagram"/);
  });

  it("safely treats prototype-related fence labels as plaintext", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={'```__proto__\nplain text\n```\n\n```constructor\nmore plain text\n```'} />,
    );
    assert.match(html, /data-language="plaintext"/);
    assert.match(html, /plain text/);
  });

  it("escapes code in unknown languages", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={'```unknown\n<script>alert("unsafe")</script>\n```'} />,
    );
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /data-language="plaintext"/);
  });

  it("does not render raw HTML, unsafe links, or remote images", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown body={`Before <script>alert(1)</script> after\n\n[unsafe](javascript:alert(1))\n\n![tracker](https://example.com/pixel.png)`} />,
    );
    assert.doesNotMatch(html, /<script|javascript:|<img|pixel\.png/);
    assert.match(html, /Image: tracker/);
  });
});
