import type { ReactNode } from "react";

export function SettingsPageLayout({ title, description, actions, children }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode;
}) {
  return <main className="minu-scroll min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label={title}>
    <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-sm text-[var(--muted)]">{description}</p> : null}</div>
        {actions}
      </header>
      {children}
    </div>
  </main>;
}
