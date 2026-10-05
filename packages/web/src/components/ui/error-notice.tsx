import { X } from "lucide-react";
import type { ReactNode } from "react";

/** Dismiss transient feedback without clearing drafts or persisted diagnostics. */
export function ErrorNotice({
  children,
  onDismiss,
  dismissLabel = "Dismiss error",
  className = "",
}: {
  children: ReactNode;
  onDismiss(): void;
  dismissLabel?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={`flex items-start gap-2 text-xs text-[var(--danger)] ${className}`}>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      <button
        type="button"
        className="icon-button inline-flex shrink-0"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
