import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export const SUPPORTED_FENCE_LANGUAGES = [
  "css",
  "diff",
  "dockerfile",
  "html",
  "http",
  "js",
  "json",
  "jsx",
  "markdown",
  "python",
  "shell",
  "sql",
  "toml",
  "ts",
  "tsx",
  "yaml",
] as const;

export type SupportedFenceLanguage = typeof SUPPORTED_FENCE_LANGUAGES[number];

const languageAliases = new Map<string, SupportedFenceLanguage>(Object.entries({
  css: "css",
  diff: "diff",
  patch: "diff",
  docker: "dockerfile",
  dockerfile: "dockerfile",
  "angular-html": "html",
  htm: "html",
  html: "html",
  xml: "html",
  http: "http",
  cjs: "js",
  javascript: "js",
  js: "js",
  "js-vue": "js",
  mjs: "js",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  py: "python",
  python: "python",
  bash: "shell",
  cmd: "shell",
  console: "shell",
  sh: "shell",
  shell: "shell",
  zsh: "shell",
  sql: "sql",
  toml: "toml",
  "angular-ts": "ts",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
}));

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** Returns a supported canonical grammar name, or plaintext for unknown/absent labels. */
export function canonicalFenceLanguage(language: string | undefined): SupportedFenceLanguage | "plaintext" {
  if (!language) return "plaintext";
  return languageAliases.get(language.trim().toLowerCase()) ?? "plaintext";
}

interface MarkdownNode {
  type?: unknown;
  lang?: unknown;
  children?: unknown;
}

/**
 * Uses the Markdown parser to select grammars from actual fenced-code nodes,
 * including blocks nested inside blockquotes and lists. Unknown languages stay plaintext.
 */
export function fencedCodeLanguages(markdown: string): SupportedFenceLanguage[] {
  // Avoid a second Markdown parse for the common case: messages with no possible fence.
  if (!markdown.includes("```") && !markdown.includes("~~~")) return [];

  const languages = new Set<SupportedFenceLanguage>();
  const tree = markdownParser.parse(markdown) as MarkdownNode;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const candidate = node as MarkdownNode;
    if (candidate.type === "code" && typeof candidate.lang === "string") {
      const language = canonicalFenceLanguage(candidate.lang);
      if (language !== "plaintext") languages.add(language);
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) visit(child);
    }
  };
  visit(tree);
  return [...languages].sort();
}
