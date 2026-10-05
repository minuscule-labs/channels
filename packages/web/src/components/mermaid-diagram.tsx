import * as Dialog from "@radix-ui/react-dialog";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

export function MermaidDiagram({ code, source, expandTarget }: {
  code: string;
  source: ReactNode;
  expandTarget?: HTMLSpanElement | null;
}) {
  const [result, setResult] = useState<{ code: string; svg?: string; failed?: boolean }>();
  const [expandedResult, setExpandedResult] = useState<{ code: string; svg?: string; failed?: boolean }>();
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const expandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const expandedViewportRef = useRef<HTMLDivElement | null>(null);
  const panPointerRef = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | undefined>(undefined);

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

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setExpandedResult(undefined);
    void import("../lib/mermaid-renderer")
      .then(({ renderMermaid }) => cancelled ? undefined : renderMermaid(code))
      .then((svg) => {
        if (!cancelled) setExpandedResult({ code, svg });
      })
      .catch(() => {
        if (!cancelled) setExpandedResult({ code, failed: true });
      });
    return () => { cancelled = true; };
  }, [code, expanded]);

  const current = result?.code === code ? result : undefined;
  const expandedDiagram = expandedResult?.code === code ? expandedResult : undefined;
  const rendered = Boolean(current?.svg);
  const changeExpanded = (open: boolean) => {
    setExpanded(open);
    if (!open) setZoom(1);
  };
  const resetView = () => {
    setZoom(1);
    expandedViewportRef.current?.scrollTo({ left: 0, top: 0 });
  };
  const onExpandedPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const viewport = event.currentTarget;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    panPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
  };
  const onExpandedPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panPointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    event.currentTarget.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  };
  const onExpandedPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panPointerRef.current?.pointerId !== event.pointerId) return;
    panPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onExpandedKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(3, Number((value * 1.25).toFixed(2))));
    else if (event.key === "-") setZoom((value) => Math.max(0.5, Number((value / 1.25).toFixed(2))));
    else if (event.key === "0") resetView();
    else return;
    event.preventDefault();
  };
  return (
    <Dialog.Root open={expanded && rendered} onOpenChange={changeExpanded}>
      {current?.svg && expandTarget ? createPortal(
        <Dialog.Trigger asChild>
          <button
            ref={expandTriggerRef}
            type="button"
            aria-label="Expand Mermaid diagram"
            title="Expand Mermaid diagram"
            className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            <Maximize2 aria-hidden="true" size={13} />
            Expand
          </button>
        </Dialog.Trigger>,
        expandTarget,
      ) : null}
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
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/75" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandTriggerRef.current?.focus({ preventScroll: true });
          }}
          className="fixed inset-2 z-[81] flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none sm:inset-6 xl:inset-x-16 xl:inset-y-10"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel-elevated)] px-4 py-3">
            <div>
              <Dialog.Title className="text-sm font-semibold">Mermaid diagram</Dialog.Title>
              <Dialog.Description className="sr-only">Expanded Mermaid diagram. Drag to pan and use the zoom controls or plus and minus keys to zoom. Press zero to reset.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="button-secondary" aria-label="Close expanded diagram">
                <X aria-hidden="true" className="h-3.5 w-3.5" /> Close
              </button>
            </Dialog.Close>
          </header>
          <div className="relative min-h-0 flex-1">
            <div
              ref={expandedViewportRef}
              className="mermaid-expanded-viewport minu-scroll absolute inset-0 overflow-auto p-4 sm:p-6"
              role="region"
              aria-label="Expanded interactive Mermaid diagram. Drag to pan."
              tabIndex={0}
              onPointerDown={onExpandedPointerDown}
              onPointerMove={onExpandedPointerMove}
              onPointerUp={onExpandedPointerUp}
              onPointerCancel={onExpandedPointerUp}
              onKeyDown={onExpandedKeyDown}
              onDoubleClick={resetView}
            >
              {expandedDiagram?.svg ? <div
                className="mermaid-expanded-canvas mx-auto"
                style={{ width: `${zoom * 100}%` }}
              >
                <div
                  role="img"
                  aria-label="Expanded Mermaid diagram"
                  className="mermaid-expanded-diagram"
                  dangerouslySetInnerHTML={{ __html: expandedDiagram.svg }}
                />
              </div> : expandedDiagram?.failed ? <div className="rounded border border-[var(--danger)]/30 p-4 text-sm text-[var(--danger)]" role="status">
                Unable to expand this diagram. Close this view to inspect its source.
              </div> : <p className="p-4 text-sm text-[var(--muted)]" role="status">Preparing expanded diagram…</p>}
            </div>
            <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel-elevated)] p-1 shadow-lg" role="group" aria-label="Diagram zoom controls">
              <button
                type="button"
                className="icon-button inline-flex !min-h-8 !min-w-8"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom <= 0.5}
                onClick={() => setZoom((value) => Math.max(0.5, Number((value / 1.25).toFixed(2))))}
              ><Minus aria-hidden="true" className="h-3.5 w-3.5" /></button>
              <span className="min-w-12 text-center font-mono text-[10px] text-[var(--muted)]" aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="icon-button inline-flex !min-h-8 !min-w-8"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom >= 3}
                onClick={() => setZoom((value) => Math.min(3, Number((value * 1.25).toFixed(2))))}
              ><Plus aria-hidden="true" className="h-3.5 w-3.5" /></button>
              <button
                type="button"
                className="icon-button inline-flex !min-h-8 !min-w-8"
                aria-label="Reset diagram zoom"
                title="Reset diagram zoom"
                disabled={zoom === 1}
                onClick={() => setZoom(1)}
              ><RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
