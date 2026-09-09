import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?(): void;
}

interface ToastContextValue {
  showToast(options: ToastOptions): void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useAppToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useAppToast must be used within ToastProvider");
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastOptions>();
  const [paused, setPaused] = useState(false);
  const shownAt = useRef(0);
  const remaining = useRef(5_000);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setToast(undefined);
  }, []);
  const scheduleDismissal = useCallback((milliseconds: number) => {
    if (timer.current) clearTimeout(timer.current);
    shownAt.current = Date.now();
    timer.current = setTimeout(dismiss, milliseconds);
  }, [dismiss]);
  const showToast = useCallback((options: ToastOptions) => {
    remaining.current = 5_000;
    setPaused(false);
    setToast(options);
    scheduleDismissal(remaining.current);
  }, [scheduleDismissal]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const pause = () => {
    if (!toast || paused) return;
    remaining.current = Math.max(0, remaining.current - (Date.now() - shownAt.current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setPaused(true);
  };
  const resume = () => {
    if (!toast || !paused) return;
    setPaused(false);
    scheduleDismissal(remaining.current || 1);
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <div className="fixed right-4 bottom-4 z-[100] max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel-elevated)] p-3 shadow-xl" role="status" aria-live="polite" onMouseEnter={pause} onMouseLeave={resume} onFocusCapture={pause} onBlurCapture={resume}>
          <div className="flex items-center gap-3 text-sm">
            <p className="min-w-0 flex-1">{toast.message}</p>
            {toast.actionLabel && toast.onAction ? <button className="button-secondary shrink-0" type="button" onClick={() => { toast.onAction?.(); dismiss(); }}>{toast.actionLabel}</button> : null}
            <button className="icon-button inline-flex shrink-0" type="button" onClick={dismiss} aria-label="Dismiss notification"><X className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}
