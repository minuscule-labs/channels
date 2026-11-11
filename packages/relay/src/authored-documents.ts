import { createHash } from "node:crypto";

/** Private, instruction-only content. Scope and kind are fixed at creation. */
export interface AuthoredDocument {
  id: string;
  workspaceId: string;
  conversationId?: string;
  kind: "instructions" | "skill";
  name: string;
  description: string;
  content: string;
  /** Optimistic concurrency token; advances for every draft or lifecycle change. */
  version: number;
  publishedRevision?: number;
  state: "active" | "archived";
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthoredDocumentRevision {
  documentId: string;
  workspaceId: string;
  revision: number;
  name: string;
  description: string;
  content: string;
  contentHash: string;
  publishedBy: string;
  createdAt: string;
}

export type AuthoredDocumentMutation = {
  expectedVersion: number;
  actorIdentityId: string;
  timestamp: string;
} & (
  | { action: "save" | "commit"; name: string; description: string; content: string }
  | { action: "publish" | "archive" }
);

/** Shared transition semantics; stores must commit the head and publication atomically. */
export function reviseAuthoredDocument(
  current: AuthoredDocument,
  mutation: AuthoredDocumentMutation,
): { document: AuthoredDocument; publication?: AuthoredDocumentRevision } | undefined {
  if (current.version !== mutation.expectedVersion || current.state !== "active") return undefined;
  const document: AuthoredDocument = {
    ...current,
    version: current.version + 1,
    updatedBy: mutation.actorIdentityId,
    updatedAt: mutation.timestamp,
  };
  if (mutation.action === "save" || mutation.action === "commit") {
    document.name = mutation.name;
    document.description = mutation.description;
    document.content = mutation.content;
  } else if (mutation.action === "archive") {
    document.state = "archived";
  }
  if (mutation.action === "publish" || mutation.action === "commit") {
    document.publishedRevision = (current.publishedRevision ?? 0) + 1;
    const content = { name: document.name, description: document.description, content: document.content };
    return {
      document,
      publication: {
        documentId: current.id,
        workspaceId: current.workspaceId,
        revision: document.publishedRevision,
        ...content,
        contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        publishedBy: mutation.actorIdentityId,
        createdAt: mutation.timestamp,
      },
    };
  }
  return { document };
}

/** Prepare initial activation without exposing an intermediate draft to readers. */
export function prepareAuthoredDocumentCreation(document: AuthoredDocument, commit = false) {
  return commit ? reviseAuthoredDocument({ ...document, version: document.version - 1 }, {
    action: "commit", expectedVersion: document.version - 1, actorIdentityId: document.updatedBy,
    timestamp: document.updatedAt, name: document.name, description: document.description, content: document.content,
  })! : { document, publication: undefined };
}
