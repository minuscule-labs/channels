# Web bundle performance backlog

**Status:** Deferred follow-up; not a release blocker.

## Baseline

A production Vite build currently emits one eager JavaScript entry bundle:

| Asset | Minified | Gzip |
| --- | ---: | ---: |
| `index-*.js` | ~715 KiB | ~219 KiB |

Vite warns because the minified entry exceeds its default 500 KiB warning threshold. The bundle remains acceptable for the current local-first alpha, and the release smoke path does not fail because of it.

A source-map attribution of the current build identifies the largest approximate contributors:

| Area | Approximate minified contribution |
| --- | ---: |
| `react-dom` | ~177 KiB |
| TanStack Router core | ~52 KiB |
| TanStack Query core | ~35 KiB |
| Markdown/GFM parser stack (`micromark`, mdast/hast utilities, property information) | ~90–110 KiB combined |
| `@tanstack/highlight` and eagerly registered grammars | ~23 KiB direct, plus grammar modules |
| Agent-management route | ~27 KiB |

These numbers are directional source-map attribution rather than a performance budget.

## Why it is one bundle

`src/router.tsx` statically imports the Conversation and agent-management pages, so all routes enter the initial application chunk. `src/components/message-markdown.tsx` statically imports `src/lib/code-highlighter.ts`; that module registers CSS, diff, Dockerfile, HTML, HTTP, JavaScript/TypeScript, JSON, Markdown, Python, shell, SQL, TOML, and YAML grammars eagerly.

## Next implementation slice

1. Establish a repeatable production bundle report and record the before/after gzip sizes.
2. Convert agent-management routes to route-level lazy imports, preserving loading, error, and browser-navigation behavior.
3. Load syntax highlighting only for messages containing fenced code blocks, and register only the grammars required by supported languages.
4. Re-measure initial Conversation load, route navigation, and code-block rendering before considering `manualChunks`.

`manualChunks` alone may improve cache boundaries but does not reduce total downloaded bytes. Prefer demand-driven loading first.

## Guardrails

- Keep Markdown safety behavior unchanged: raw HTML and remote images remain disabled.
- Preserve offline/local-first operation; do not introduce a remote asset or CDN dependency.
- Keep agent-management functionality available after lazy loading, including authenticated local-control errors and retry states.
- Do not treat the Vite warning as a release failure until a measured product performance budget exists.
