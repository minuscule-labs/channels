import { Link } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, Bot, Clock, Library, Settings, Users } from "lucide-react";
import { useState } from "react";
import { DrawerCloseButton } from "./ui/drawer";
import { ErrorNotice } from "./ui/error-notice";

export const workspaceSettingsSections = [
  { label: "General", icon: Settings, to: "/app/workspaces/$workspaceId/settings", suffix: "" },
  { label: "Agents", icon: Bot, to: "/app/workspaces/$workspaceId/agents", suffix: "/agents" },
  { label: "People & permissions", icon: Users, to: "/app/workspaces/$workspaceId/settings/people", suffix: "/people", hidden: true },
  { label: "Conversation presets", icon: Bot, to: "/app/workspaces/$workspaceId/settings/presets", suffix: "/presets" },
  { label: "Defaults & timeouts", icon: Clock, to: "/app/workspaces/$workspaceId/settings/defaults", suffix: "/defaults" },
  { label: "Instructions", icon: BookOpen, to: "/app/workspaces/$workspaceId/settings/instructions", suffix: "/instructions" },
  { label: "Skills", icon: Library, to: "/app/workspaces/$workspaceId/settings/skills", suffix: "/skills" },
] as const;

export function WorkspaceSettingsSidebar({ workspaceId, pathname, onBack, mobile = false, onNavigate }: {
  workspaceId: string;
  pathname: string;
  onBack(): Promise<void>;
  mobile?: boolean;
  onNavigate?(): void;
}) {
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string>();
  const path = pathname.replace(/\/$/, "");
  const back = async () => {
    setReturning(true);
    setError(undefined);
    try { await onBack(); onNavigate?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not return to workspace"); }
    finally { setReturning(false); }
  };
  return <aside className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border)] bg-[var(--panel-muted)] md:w-72">
    <div className="border-b border-[var(--border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50" disabled={returning} onClick={() => void back()}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to workspace
        </button>
        {mobile ? <DrawerCloseButton label="Close navigation" /> : null}
      </div>
      {error ? <ErrorNotice className="mt-2" onDismiss={() => setError(undefined)}>{error}</ErrorNotice> : null}
    </div>
    <nav aria-label="Workspace settings" className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
      {workspaceSettingsSections.filter(entry => !("hidden" in entry && entry.hidden)).map(({ label, icon: Icon, to, suffix }) => {
        const target = to.replace("$workspaceId", workspaceId);
        const active = path === target || (suffix !== "" && path.startsWith(`${target}/`));
        return <Link key={to} to={to} params={{ workspaceId }} activeOptions={{ exact: true }} aria-current={active ? "page" : undefined} onClick={onNavigate}
          className={`flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm ${active ? "bg-[var(--selected)] font-semibold text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{label}</span>
        </Link>;
      })}
    </nav>
  </aside>;
}
