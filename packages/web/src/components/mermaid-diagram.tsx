import { useEffect, useState, type ReactNode } from "react";

export function MermaidDiagram({ code, source }: { code: string; source: ReactNode }) {
  const [result, setResult] = useState<{ code: string; svg?: string; failed?: boolean }>();

  useEffect(() => {
    let cancelled = false;
    void import("../lib/mermaid-renderer")
      .then(({ renderMermaid }) => cancelled ? undefined : renderMermaid(code))
      .then((svg) => {
        if (!cancelled) setResult({ code, svg });
      })
      .catch(() => {
        if (!cancelled) setResult({ code, failed: true });
      });
    return () => { cancelled = true; };
  }, [code]);

  const current = result?.code === code ? result : undefined;
  return (
    <div>
      {current?.svg ? (
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="mermaid-diagram overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
      ) : (
        <>
          <p role="status" className="px-3 pt-2 text-xs text-[var(--muted)]">
            {current?.failed ? "Unable to render this diagram. Mermaid source is shown below." : "Rendering diagram…"}
          </p>
          {source}
        </>
      )}
      {current?.svg ? (
        <details className="border-t border-[var(--border-subtle)]">
          <summary className="cursor-pointer px-3 py-2 text-xs text-[var(--muted)]">Mermaid source</summary>
          {source}
        </details>
      ) : null}
    </div>
  );
}
