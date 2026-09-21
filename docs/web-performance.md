# Web bundle performance backlog

**Status:** Initial demand-loading slice implemented; not a release blocker.

## Baseline

The pre-change production Vite build emitted one eager JavaScript entry bundle:

| Asset | Minified | Gzip |
| --- | ---: | ---: |
| `index-*.js` (before demand loading) | ~715 KiB | ~219 KiB |

The initial demand-loading slice changes the entry bundle to **~667 KiB minified / ~206 KiB gzip**. It defers the agent-management page (~28 KiB / ~7 KiB gzip), highlighting runtime (~10 KiB / ~4 KiB gzip), and individual grammar modules until needed. Run `pnpm web:report` for a repeatable per-asset minified/gzip report.

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

## Implemented demand loading

- `src/router.tsx` uses one shared TanStack Router lazy import for the agent-management list, create, and detail routes. Its loader preserves Router-friendly pending/error and stale-module recovery behavior.
- `MessageMarkdown` detects fenced code blocks without importing the highlighting package. Plain Markdown and unknown/unlabeled fences stay safe plaintext and do not request syntax highlighting.
- A supported fenced language dynamically loads the highlighter plus only its needed grammar modules. Supported aliases normalize to CSS, diff, Dockerfile, HTML, HTTP, JavaScript/TypeScript, JSON, Markdown, Python, shell, SQL, TOML, and YAML grammars.
- Unit and browser coverage verify aliases/fallbacks, no initial highlighter request, and deferred highlighting of a TypeScript message.

## Follow-up

Re-measure real initial Conversation load and route navigation on supported machines before considering `manualChunks`. `manualChunks` alone may improve cache boundaries but does not reduce total downloaded bytes.

## Guardrails

- Keep Markdown safety behavior unchanged: raw HTML and remote images remain disabled.
- Preserve offline/local-first operation; do not introduce a remote asset or CDN dependency.
- Keep agent-management functionality available after lazy loading, including authenticated local-control errors and retry states.
- Do not treat the Vite warning as a release failure until a measured product performance budget exists.
