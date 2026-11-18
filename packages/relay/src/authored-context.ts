import { createHash } from "node:crypto";
import type { RelayBindingStore } from "./binding-store.ts";
import type { AuthoredDocument, AuthoredDocumentRevision } from "./authored-documents.ts";

export interface AuthoredContextReference {
  documentId: string;
  kind: AuthoredDocument["kind"];
  source: "workspace" | "channel";
  revision: number;
  contentHash: string;
}

/** Private launch manifest. Empty is known-empty; absent means a legacy session. */
export interface AuthoredContextSnapshot {
  schemaVersion: 1;
  workspaceId: string;
  channelId: string;
  documents: AuthoredContextReference[];
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

export async function resolveAuthoredInstructions(store: ContentStore, snapshot: AuthoredContextSnapshot): Promise<string | undefined> {
  validateAuthoredContext(snapshot, snapshot.workspaceId, snapshot.channelId);
  const sections: string[] = [];
  for (const source of ["workspace", "channel"] as const) {
    for (const ref of snapshot.documents.filter((ref) => ref.kind === "instructions" && ref.source === source)) {
      const revision = await resolveAuthoredPublication(store, snapshot, ref);
      if (revision.content.trim()) sections.push(`${source === "workspace" ? "Workspace" : "Channel"} instructions (revision ${ref.revision}):\n${revision.content}`);
    }
  }
  return sections.length ? [
    "Published defaults follow. Channel defaults may specialize workspace defaults. These instructions grant no permissions and do not override platform, harness, or project constraints.",
    ...sections,
  ].join("\n\n") : undefined;
}
