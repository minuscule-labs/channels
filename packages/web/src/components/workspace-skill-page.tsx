import { Link, useParams } from "@tanstack/react-router";
import { AuthoredContent } from "./authored-content";
import { AdministrationState, useWorkspacePageData, WorkspaceSettingsLayout } from "./workspace-settings-page";

export function WorkspaceSkillPage() {
  const data = useWorkspacePageData();
  const { skillId = "new" } = useParams({ strict: false });
  return <WorkspaceSettingsLayout>
    <div className="space-y-5">
      <Link to="/app/workspaces/$workspaceId/settings/skills" params={{ workspaceId: data.workspaceId }} className="text-xs text-[var(--muted)] hover:underline">← Skills</Link>
      <AdministrationState pending={data.pending || data.workspace.isPending} error={data.error ?? data.workspace.error} canAdminister={data.canAdminister}>
        <AuthoredContent key={`${data.workspaceId}:${skillId}`} workspaceId={data.workspaceId} actorIdentityId={data.session.data?.identityId} canAdminister={data.canAdminister === true} section="skills" skillId={skillId} />
      </AdministrationState>
      <div className="flex justify-end"><Link className="button-secondary" to="/app/workspaces/$workspaceId/settings/skills" params={{ workspaceId: data.workspaceId }}>Cancel</Link></div>
    </div>
  </WorkspaceSettingsLayout>;
}
