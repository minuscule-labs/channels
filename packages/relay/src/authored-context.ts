import { createHash } from "node:crypto";
import type { RelayBindingStore, WorkspaceAgentConfig } from "./binding-store.ts";
import type { AccountLibraryItem } from "./account-library.ts";
import type { AuthoredDocument, AuthoredDocumentRevision } from "./authored-documents.ts";

export interface AuthoredContextReference {
  documentId: string;
  kind: AuthoredDocument["kind"];
  source: "workspace" | "channel";
  revision: number;
  contentHash: string;
}

export interface AccountSkillReference {
  ownerIdentityId: string;
  documentId: string;
  revision: number;
  contentHash: string;
}

/** Private launch manifest. Empty is known-empty; absent means a legacy session. */
export interface AuthoredContextSnapshot {
  schemaVersion: 1;
  workspaceId: string;
  channelId: string;
  documents: AuthoredContextReference[];
  accountSkills?: AccountSkillReference[];
  selectedWorkspaceSkills?: string[];
}

type ContentStore = Pick<RelayBindingStore, "listAuthoredDocuments" | "getAuthoredDocument" | "listAuthoredDocumentRevisions">;

export class AuthoredContextUnavailableError extends Error {
  constructor() { super("Published instruction context is unavailable"); }
}

export async function resolveAuthoredPublication(store: ContentStore, snapshot: AuthoredContextSnapshot, ref: AuthoredContextReference): Promise<AuthoredDocumentRevision> {
  const document = await store.getAuthoredDocument(snapshot.workspaceId, ref.documentId);
  if (!document || document.kind !== ref.kind
    || document.conversationId !== (ref.source === "channel" ? snapshot.channelId : undefined)) {
    throw new AuthoredContextUnavailableError();
  }
  const revision = (await store.listAuthoredDocumentRevisions(snapshot.workspaceId, ref.documentId))
    .find((candidate) => candidate.revision === ref.revision);
  if (!revision || revision.workspaceId !== snapshot.workspaceId || revision.documentId !== ref.documentId
    || revision.contentHash !== ref.contentHash
    || revision.contentHash !== createHash("sha256").update(JSON.stringify({
      name: revision.name, description: revision.description, content: revision.content,
    })).digest("hex")) throw new AuthoredContextUnavailableError();
  return revision;
}

export async function captureAuthoredContext(store: ContentStore, workspaceId: string, channelId: string): Promise<AuthoredContextSnapshot> {
  const documents = (await store.listAuthoredDocuments(workspaceId))
    .filter((document) => document.state === "active" && document.publishedRevision !== undefined
      && (document.conversationId === undefined || document.conversationId === channelId))
    .sort((left, right) => Number(Boolean(left.conversationId)) - Number(Boolean(right.conversationId)) || left.id.localeCompare(right.id));
  const snapshot: AuthoredContextSnapshot = { schemaVersion: 1, workspaceId, channelId, documents: [] };
  for (const document of documents) {
    const revision = (await store.listAuthoredDocumentRevisions(workspaceId, document.id))
      .find((candidate) => candidate.revision === document.publishedRevision);
    if (!revision) throw new AuthoredContextUnavailableError();
    const ref: AuthoredContextReference = { documentId: document.id, kind: document.kind,
      source: document.conversationId ? "channel" : "workspace", revision: revision.revision, contentHash: revision.contentHash };
    await resolveAuthoredPublication(store, snapshot, ref);
    snapshot.documents.push(ref);
  }
  return snapshot;
}

export function validateAuthoredContext(snapshot: AuthoredContextSnapshot, workspaceId: string, channelId: string): void {
  if (snapshot?.schemaVersion !== 1 || snapshot.workspaceId !== workspaceId || snapshot.channelId !== channelId
    || !Array.isArray(snapshot.documents)) throw new AuthoredContextUnavailableError();
  if (snapshot.accountSkills !== undefined) {
    if (!Array.isArray(snapshot.accountSkills) || snapshot.accountSkills.length > 100) throw new AuthoredContextUnavailableError();
    const refs = new Set<string>();
    for (const ref of snapshot.accountSkills) {
      if (!ref || typeof ref.ownerIdentityId !== "string" || !ref.ownerIdentityId.trim()
        || typeof ref.documentId !== "string" || !ref.documentId.trim() || !Number.isSafeInteger(ref.revision) || ref.revision < 1
        || typeof ref.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(ref.contentHash)
        || refs.has(JSON.stringify([ref.ownerIdentityId, ref.documentId]))) throw new AuthoredContextUnavailableError();
      refs.add(JSON.stringify([ref.ownerIdentityId, ref.documentId]));
    }
  }
  if (snapshot.selectedWorkspaceSkills !== undefined && (!Array.isArray(snapshot.selectedWorkspaceSkills)
    || snapshot.selectedWorkspaceSkills.length > 100 || new Set(snapshot.selectedWorkspaceSkills).size !== snapshot.selectedWorkspaceSkills.length
    || snapshot.selectedWorkspaceSkills.some(id => typeof id !== "string" || !snapshot.documents.some(ref => ref && ref.documentId === id && ref.kind === "skill" && ref.source === "workspace")))) {
    throw new AuthoredContextUnavailableError();
  }
  const seen = new Set<string>();
  const instructionScopes = new Set<string>();
  for (const ref of snapshot.documents) {
    if (!ref || typeof ref.documentId !== "string" || !ref.documentId || seen.has(ref.documentId)
      || (ref.kind !== "instructions" && ref.kind !== "skill")
      || (ref.source !== "workspace" && ref.source !== "channel")
      || !Number.isSafeInteger(ref.revision) || ref.revision < 1
      || typeof ref.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(ref.contentHash)) {
      throw new AuthoredContextUnavailableError();
    }
    if (ref.kind === "instructions") {
      if (instructionScopes.has(ref.source)) throw new AuthoredContextUnavailableError();
      instructionScopes.add(ref.source);
    }
    seen.add(ref.documentId);
  }
}

type AccountContentStore = Pick<RelayBindingStore, "getAccountLibraryItem" | "listAccountLibraryVersions">;
function accountSkillHash(item: AccountLibraryItem): string {
  if (item.kind !== "skill" || typeof item.name !== "string" || !item.name.trim()
    || typeof item.description !== "string" || !item.description.trim() || typeof item.content !== "string" || !item.content.trim()) throw new AuthoredContextUnavailableError();
  return createHash("sha256").update(JSON.stringify({ name: item.name, description: item.description, content: item.content })).digest("hex");
}

/** Capture only at a new Runtime creation boundary, never on turns or same-session resume. */
export async function captureSelectedSkills(store: AccountContentStore, snapshot: AuthoredContextSnapshot,
  config: Pick<WorkspaceAgentConfig, "accountSkills" | "workspaceSkillIds">): Promise<AuthoredContextSnapshot> {
  const result = structuredClone(snapshot);
  if (config.accountSkills !== undefined) {
    result.accountSkills = [];
    for (const id of config.accountSkills.skillIds) {
      const item = await store.getAccountLibraryItem(config.accountSkills.ownerIdentityId, id);
      if (!item || item.kind !== "skill" || item.state !== "active" || item.ownerIdentityId !== config.accountSkills.ownerIdentityId || item.id !== id) {
        throw new AuthoredContextUnavailableError();
      }
      result.accountSkills.push({ ownerIdentityId: item.ownerIdentityId, documentId: item.id, revision: item.version, contentHash: accountSkillHash(item) });
    }
  } else delete result.accountSkills;
  if (config.workspaceSkillIds !== undefined) result.selectedWorkspaceSkills = [...config.workspaceSkillIds];
  else delete result.selectedWorkspaceSkills;
  validateAuthoredContext(result, result.workspaceId, result.channelId);
  return result;
}

export async function resolveAuthoredInstructions(store: ContentStore & AccountContentStore, snapshot: AuthoredContextSnapshot): Promise<string | undefined> {
  validateAuthoredContext(snapshot, snapshot.workspaceId, snapshot.channelId);
  const sections: string[] = [];
  for (const source of ["workspace", "channel"] as const) {
    for (const ref of snapshot.documents.filter((ref) => ref.kind === "instructions" && ref.source === source)) {
      const revision = await resolveAuthoredPublication(store, snapshot, ref);
      if (revision.content.trim()) sections.push(`${source === "workspace" ? "Workspace" : "Channel"} instructions (revision ${ref.revision}):\n${revision.content}`);
    }
  }
  for (const id of snapshot.selectedWorkspaceSkills ?? []) {
    const ref = snapshot.documents.find(ref => ref.documentId === id && ref.kind === "skill" && ref.source === "workspace")!;
    const skill = await resolveAuthoredPublication(store, snapshot, ref);
    sections.push(`Selected workspace skill: ${skill.name} (revision ${ref.revision})\n${skill.description}\n${skill.content}`);
  }
  for (const ref of snapshot.accountSkills ?? []) {
    const skill = (await store.listAccountLibraryVersions(ref.ownerIdentityId, ref.documentId)).find(item => item.version === ref.revision);
    if (!skill || skill.kind !== "skill" || skill.state !== "active" || skill.ownerIdentityId !== ref.ownerIdentityId || skill.id !== ref.documentId
      || accountSkillHash(skill) !== ref.contentHash) throw new AuthoredContextUnavailableError();
    sections.push(`Selected account skill: ${skill.name} (version ${ref.revision})\n${skill.description}\n${skill.content}`);
  }
  return sections.length ? [
    "Published defaults follow. Channel defaults may specialize workspace defaults. These instructions grant no permissions and do not override platform, harness, or project constraints.",
    ...sections,
  ].join("\n\n") : undefined;
}
