import { createHighlighter, type Highlighter, type LanguageDefinition } from "@tanstack/highlight/core";
import type { HastElement } from "@tanstack/highlight/markdown";
import { rehypePreCodeToHast, type rehypeHighlightCodeBlocks } from "@tanstack/highlight/rehype";
import type { SupportedFenceLanguage } from "./code-fences";

type LanguageLoader = () => Promise<LanguageDefinition>;

const languageLoaders: Readonly<Record<SupportedFenceLanguage, LanguageLoader>> = {
  css: () => import("@tanstack/highlight/languages/css").then(({ css }) => css),
  diff: () => import("@tanstack/highlight/languages/diff").then(({ diff }) => diff),
  dockerfile: () => import("@tanstack/highlight/languages/dockerfile").then(({ dockerfile }) => dockerfile),
  html: () => import("@tanstack/highlight/languages/html").then(({ html }) => html),
  http: () => import("@tanstack/highlight/languages/http").then(({ http }) => http),
  js: () => import("@tanstack/highlight/languages/js").then(({ js }) => js),
  json: () => import("@tanstack/highlight/languages/json").then(({ json }) => json),
  jsx: () => import("@tanstack/highlight/languages/jsx").then(({ jsx }) => jsx),
  markdown: () => import("@tanstack/highlight/languages/markdown").then(({ markdown }) => markdown),
  python: () => import("@tanstack/highlight/languages/python").then(({ python }) => python),
  shell: () => import("@tanstack/highlight/languages/shell").then(({ shell }) => shell),
  sql: () => import("@tanstack/highlight/languages/sql").then(({ sql }) => sql),
  toml: () => import("@tanstack/highlight/languages/toml").then(({ toml }) => toml),
  ts: () => import("@tanstack/highlight/languages/ts").then(({ ts }) => ts),
  tsx: () => import("@tanstack/highlight/languages/tsx").then(({ tsx }) => tsx),
  yaml: () => import("@tanstack/highlight/languages/yaml").then(({ yaml }) => yaml),
};

export type RehypeHighlightPlugin = () => ReturnType<typeof rehypeHighlightCodeBlocks>;

const plugins = new Map<string, Promise<RehypeHighlightPlugin>>();
type HighlightTree = Parameters<ReturnType<typeof rehypeHighlightCodeBlocks>>[0];

function isElement(node: HighlightTree): node is HastElement {
  return node.type === "element" && typeof node.tagName === "string";
}

function highlightCodeBlocks(tree: HighlightTree, highlighter: Highlighter): void {
  tree.children?.forEach((child, index, children) => {
    if (isElement(child) && child.tagName === "pre") {
      const code = child.children.find((node) => isElement(node) && node.tagName === "code");
      const className = code && isElement(code) ? code.properties?.className : undefined;
      const classes = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/) : [];
      // The default transform rewrites unknown languages to plaintext and destroys Mermaid's fence identity.
      if (classes.some((value) => typeof value === "string" && value.toLowerCase() === "language-mermaid")) return;
      children[index] = rehypePreCodeToHast(child, { highlighter }) ?? child;
      return;
    }
    highlightCodeBlocks(child, highlighter);
  });
}

/** Builds and caches a code-block plugin for exactly the requested grammar set. */
export function loadRehypeHighlight(
  requestedLanguages: readonly SupportedFenceLanguage[],
): Promise<RehypeHighlightPlugin> {
  const languages = [...new Set(requestedLanguages)].sort();
  const key = languages.join(",");
  const existing = plugins.get(key);
  if (existing) return existing;

  const plugin = Promise.all(languages.map((language) => languageLoaders[language]())).then((loadedLanguages) => {
    const highlighter = createHighlighter({ languages: loadedLanguages });
    return () => (tree: HighlightTree) => highlightCodeBlocks(tree, highlighter);
  });
  plugins.set(key, plugin);
  return plugin;
}
