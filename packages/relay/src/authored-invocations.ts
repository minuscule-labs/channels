import type { ConversationAgentBindingRecord, RuntimeSessionHistoryRecord } from "./binding-store.ts";
import type { AuthoredDocument } from "./authored-documents.ts";
import { validateAuthoredContext } from "./authored-context.ts";

/** Private, immutable association reserved BEFORE publishing a public trigger. */
export interface AuthoredInvocationMessageLink {
  invocationId: string;
  messageId: string;
}

export interface AuthoredInvocationTarget {
  identityId: string;
  bindingId: string;
  generation: number;
}

/** Immutable private acceptance, not a message, delivery receipt, or execution grant. */
export interface AuthoredSkillInvocation {
  id: string;
  workspaceId: string;
  conversationId: string;
  channelId: string;
  actorIdentityId: string;
  requestId: string;
  requestHash: string;
  documentId: string;
  source: "workspace" | "channel";
  revision: number;
  contentHash: string;
  name: string;
  arguments: string;
  targets: AuthoredInvocationTarget[];
  acceptedAt: string;
}

export function invocationDocumentMatches(invocation: AuthoredSkillInvocation, document: AuthoredDocument | undefined): boolean {
  return Boolean(document && document.workspaceId === invocation.workspaceId && document.id === invocation.documentId
    && document.kind === "skill" && document.state === "active"
    && document.conversationId === (invocation.source === "channel" ? invocation.channelId : undefined)
    && document.publishedRevision !== undefined && document.publishedRevision >= invocation.revision);
}

/** Rechecked by each store inside its acceptance transaction/CAS boundary. */
export function invocationTargetMatches(
  invocation: Pick<AuthoredSkillInvocation, "workspaceId" | "conversationId" | "channelId" | "documentId" | "source" | "revision" | "contentHash">,
  target: AuthoredInvocationTarget,
  binding: ConversationAgentBindingRecord | undefined,
  activation: RuntimeSessionHistoryRecord | undefined,
): boolean {
  if (!binding || !activation || binding.workspaceId !== invocation.workspaceId
    || binding.conversationId !== invocation.conversationId || binding.agentIdentityId !== target.identityId
    || binding.id !== target.bindingId || binding.generation !== target.generation
    || !["connected", "sleeping", "paused"].includes(binding.state)
    || activation.state !== "active" || activation.workspaceId !== invocation.workspaceId
    || activation.conversationId !== invocation.conversationId || activation.agentIdentityId !== target.identityId
    || activation.bindingId !== target.bindingId || activation.bindingGeneration !== target.generation
    || activation.runtimeAdapter !== binding.runtimeAdapter
    || (activation.mapping === "managed"
      ? activation.managedSessionId !== binding.runtimeSessionId || activation.runtimeOwnerId !== binding.runtimeOwnerId
      : activation.legacyRuntimeSessionRef !== binding.runtimeSessionId)
    || !activation.authoredContext) return false;
  try { validateAuthoredContext(activation.authoredContext, invocation.workspaceId, invocation.channelId); }
  catch { return false; }
  return activation.authoredContext.documents.some(ref => ref.documentId === invocation.documentId
    && ref.kind === "skill" && ref.source === invocation.source && ref.revision === invocation.revision
    && ref.contentHash === invocation.contentHash);
}
