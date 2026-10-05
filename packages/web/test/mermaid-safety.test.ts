import { describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { renderMermaid } from "../src/lib/mermaid-renderer";
import { assertSafeMermaid, MAX_DIAGRAM_LENGTH } from "../src/lib/mermaid-safety";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const unsafeSources = [
  'flowchart TD\nA@{ img: "https://review.invalid/image.png", label: "Image" }',
  'flowchart TD\nA@{ "\\x69mg": "/private-endpoint", label: "Image" }',
  'kanban\n  column[Tasks]\n    task[Remote]@{ img: "//review.invalid/image.png" }',
  '%%{init: {"themeCSS": "@import url(https://review.invalid/style.css)"}}%%\ngraph TD\nA-->B',
  '---\nconfig:\n  fontFamily: RemoteFont\n---\ngraph TD\nA-->B',
  'graph TD\nA-->B\nstyle A fill:url(https://review.invalid/image.png)',
  'graph TD\nA-->B;classDef default fill:u\\72l(https://review.invalid/image.png)',
  'graph TD\nA-->B\nlinkStyle 0 stroke:red',
  'C4Context\nUpdateElementStyle(a, $bgColor="url(https://review.invalid/image.png)")',
  'graph TD\nA["<img src=/private-endpoint>"]',
  'graph TD\nA["&lt;img src=/private-endpoint&gt;"]',
  'graph TD\nA["#60;#105;mg src=/private-endpoint#62;"]',
  'graph TD\nA["&#x3c;img src=/private-endpoint&#x3e;"]',
  'graph TD\nA["<br style=background-image:url(/private-endpoint)>"]',
  'gantt\n  dateFormat YYYY-MM-DD\n  todayMarker stroke:red,stroke-width:5px,mask-image:url(https://review.invalid/marker-mask.svg),filter:url(/mermaid-resource-probe)\n  section Review\n  Task : 2026-10-02, 2d',
  '%% graph TD is only a comment\r\ngantt\r\n  todayMarker filter:url(/mermaid-resource-probe)',
  'gantt\n  dateFormat YYYY-MM-DD\n  section Review\n  Task : 2026-10-02, 2d',
  'pie title Other grammar\n  "One" : 1',
  'architecture-beta\n  service db(database)[Database]',
  'flowchart-elk TD\n  A-->B',
  'sequenceDiagram\n  participant Alice\n  properties Alice: {"icon":"https://review.invalid/image.png"}',
  'sequenceDiagram;participant Alice;properties Alice: {"icon":"/mermaid-resource-probe"}',
  'sequenceDiagram\n  Alice->>Bob: Hello;properties Alice: {"icon":"https://review.invalid/image.png"}',
  'sequenceDiagram\n  rect url(https://review.invalid/fill.svg)\n  Alice->>Bob: Hello\n  end',
  'sequenceDiagram\n  details Alice: {"icon":"https://review.invalid/image.png"}',
];

describe("Mermaid pre-render safety", () => {
  it.each([
    "graph TD\n  A[Start] --> B[Done]",
    "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
    "graph TD\n  A[First<br/>Second] --> B[Done]",
    'graph TD\n  A["A #38; B"] --> B[Done]',
    "graph TD\n  %% an ordinary comment\n  A --> B",
    "%% header comment\nflowchart LR\n  subgraph Group\n    A[Start] --> B{Ready?}\n  end",
    "graph TB;A-->B",
    "sequenceDiagram\n  participant Alice as Customer\n  actor Bob\n  autonumber 1 2\n  activate Bob\n  loop Retry\n    Alice->>+Bob: Hello\n    Note over Alice,Bob: Request\n    Bob-->>-Alice: Done\n  end\n  deactivate Bob",
    "%% sequence comment\nsequenceDiagram; Alice->>Bob: Hello; Bob-->>Alice: Done",
    "sequenceDiagram\n  Élodie->>用户: Hello",
    "sequenceDiagram\n  Alice->>Bob: A #59; B #38; C",
  ])("allows ordinary display-only diagrams: %s", (source) => {
    expect(() => assertSafeMermaid(source)).not.toThrow();
  });

  it.each(unsafeSources)("rejects resource-capable syntax before Mermaid or DOM work: %s", async (source) => {
    await expect(renderMermaid(source)).rejects.toThrow("unsupported");
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("enforces the length limit before rendering", async () => {
    await expect(renderMermaid("x".repeat(MAX_DIAGRAM_LENGTH + 1))).rejects.toThrow("too large");
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
