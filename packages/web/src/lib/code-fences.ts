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

const languageAliases: Readonly<Record<string, SupportedFenceLanguage>> = {
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
};

/** Returns a supported canonical grammar name, or plaintext for unknown/absent labels. */
export function canonicalFenceLanguage(language: string | undefined): SupportedFenceLanguage | "plaintext" {
  if (!language) return "plaintext";
  return languageAliases[language.trim().toLowerCase()] ?? "plaintext";
}

/**
 * Returns the distinct supported grammars referenced by Markdown fenced blocks.
 * It deliberately ignores unknown and unlabeled blocks: those render as safe plaintext
 * without downloading the highlighting runtime.
 */
export function fencedCodeLanguages(markdown: string): SupportedFenceLanguage[] {
  const languages = new Set<SupportedFenceLanguage>();
  const fence = /^(?: {0,3})(?:`{3,}|~{3,})[ \t]*([^\s`~]+)?[^\n]*$/gm;
  for (const match of markdown.matchAll(fence)) {
    const language = canonicalFenceLanguage(match[1]);
    if (language !== "plaintext") languages.add(language);
  }
  return [...languages].sort();
}
