import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { assertSafeMermaid, MAX_DIAGRAM_LENGTH } from "./mermaid-safety";

let nextDiagramId = 0;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: MAX_DIAGRAM_LENGTH,
  maxEdges: 500,
  suppressErrorRendering: true,
  // Message-supplied directives/frontmatter must not relax rendering safeguards or inject CSS.
  secure: [
    "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
    "suppressErrorRendering", "dompurifyConfig", "theme", "themeCSS", "themeVariables",
    "fontFamily", "altFontFamily", "htmlLabels", "flowchart",
  ],
});

export async function renderMermaid(source: string): Promise<string> {
  assertSafeMermaid(source);
  // Mermaid measures text in the DOM. Keep that temporary DOM out of the chat and remove it even on errors.
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-100000px";
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`minu-mermaid-${++nextDiagramId}`, source, container);
    // No bindFunctions: diagrams are display-only, never executable message content.
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "image", "a", "script", "animate", "animateMotion", "animateTransform", "set"],
    });
  } finally {
    container.remove();
  }
}
