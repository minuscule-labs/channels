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

- `src/router.tsx` shares one dynamic import for the agent-management list, create, and detail routes. The route wrapper exposes TanStack Router's intent-preload hook, starts preloading without blocking navigation, and renders an immediate loading state while keeping the app shell mounted. A failed chunk shows a route-local recovery message; **Reload and retry** starts a fresh module load at the current route.
- `MessageMarkdown` uses a cheap fence-marker check before parsing Markdown code nodes, so ordinary messages avoid the additional discovery parse and never import the highlighting package. Unknown/unlabeled fences stay safe plaintext.
- A supported fenced language dynamically loads the highlighter plus only its needed grammar modules. Language selection uses the same Markdown parsing rules as rendering, including fences nested in blockquotes and lists. Supported aliases normalize to CSS, diff, Dockerfile, HTML, HTTP, JavaScript/TypeScript, JSON, Markdown, Python, shell, SQL, TOML, and YAML grammars.
- Unit and browser coverage verify safe prototype-like labels, alias/fallback behavior, nested fences, intent preload, failed-chunk recovery, no initial highlighter request, and deferred highlighting.

## Follow-up

Re-measure real initial Conversation load and route navigation on supported machines before considering `manualChunks`. `manualChunks` alone may improve cache boundaries but does not reduce total downloaded bytes.

## Guardrails

- Keep Markdown safety behavior unchanged: raw HTML and remote images remain disabled.
- Preserve offline/local-first operation; do not introduce a remote asset or CDN dependency.
- Keep agent-management functionality available after lazy loading, including authenticated local-control errors and retry states.
- Do not treat the Vite warning as a release failure until a measured product performance budget exists.
