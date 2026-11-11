import type { ReactNode } from "react";

export function SettingsPageLayout({ title, description, actions, children, containerWidth = "max-w-6xl" }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode; containerWidth?: string;
}) {
  return <main className="minu-scroll min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label={title}>
    <div className={`mx-auto w-full ${containerWidth} px-5 py-7 sm:px-8`}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-sm text-[var(--muted)]">{description}</p> : null}</div>
        {actions}
      </header>
      {children}
    </div>
  </main>;
}
