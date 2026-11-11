import { createResourceId, isResourceId, type ConversationClient, type ConversationMessage } from "@minu/channels-core";
import type { RelayBindingStore } from "./binding-store.ts";
import { resolveAuthoredPublication } from "./authored-context.ts";
import { invocationDocumentMatches, invocationTargetMatches, type AuthoredInvocationTarget, type AuthoredSkillInvocation } from "./authored-invocations.ts";

export interface AuthoredInvocationPreparation {
  workspaceId: string;
  conversationId: string;
  actorIdentityId: string;
  requestId: string;
  target: AuthoredInvocationTarget;
  /** Dispatcher-owned expectation/clock, never inferred from the binding being checked. Omit only for non-dispatch preparation. */
  lease?: { owner: string; now: () => Date };
}

/** Server-private request data. Never project this into a public message or receipt. */
export interface PreparedAuthoredInvocationTurn {
  invocationId: string;
  documentId: string;
  source: "workspace" | "channel";
  revision: number;
  contentHash: string;
  input: string;
}

function publicInvocationBody(invocation: AuthoredSkillInvocation): string {
  // Arguments retain their exact accepted bytes, including the 64 KiB boundary.
  // Empty arguments still need a nonempty public message. Procedure text stays private.
  return invocation.arguments.trim() ? invocation.arguments
    : `Use playbook: ${invocation.name} (${invocation.source}, revision ${invocation.revision})`;
}

function messageMatchesInvocation(message: ConversationMessage, invocation: AuthoredSkillInvocation): boolean {
  return message.conversationId === invocation.conversationId && message.authoredInvocationId === invocation.id
    && message.participantId === invocation.actorIdentityId && message.body === publicInvocationBody(invocation)
    && message.replyTo === undefined && !message.attachments?.length
    && JSON.stringify([...message.to].sort()) === JSON.stringify(invocation.targets.map(target => target.identityId).sort());
}

/**
 * Internal publication only. The caller supplies an authenticated private selector,
 * never an operation copied out of a public message. No wake/restart or automatic retry.
 * An uncertain Core acknowledgment retains the link and exact stable ID/key for inspection.
 */
export async function publishAuthoredInvocationMessage(
  store: RelayBindingStore, client: ConversationClient, context: Omit<AuthoredInvocationPreparation, "target">,
  options: { requireNewLink?: boolean; assertSession?: () => void } = {},
): Promise<ConversationMessage> {
  try {
    const invocation = await store.getAuthoredSkillInvocation(context.conversationId, context.actorIdentityId, context.requestId);
    if (!invocation || invocation.workspaceId !== context.workspaceId) throw new AuthoredInvocationDeliveryUnavailableError();
    await Promise.all(invocation.targets.map(target => prepareAuthoredInvocationTurn(store, client, { ...context, target })));
    options.assertSession?.();
    const messageId = createResourceId("message");
    const link = await store.reserveAuthoredInvocationMessageLink({ invocationId: invocation.id, messageId });
    if (!link || link.invocationId !== invocation.id || (options.requireNewLink && link.messageId !== messageId)) {
      throw new AuthoredInvocationDeliveryUnavailableError();
    }
    options.assertSession?.();
    // The private association must commit first: Core may emit SSE before postMessage returns.
    const message = await client.postMessage(invocation.conversationId, {
      id: link.messageId, authoredInvocationId: invocation.id, participantId: invocation.actorIdentityId,
      to: invocation.targets.map(target => target.identityId), body: publicInvocationBody(invocation),
    }, { idempotencyKey: `authored-invocation:${invocation.id}` });
    if (message.id !== link.messageId || !messageMatchesInvocation(message, invocation)) throw new AuthoredInvocationDeliveryUnavailableError();
    return message;
  } catch {
    throw new AuthoredInvocationDeliveryUnavailableError();
  }
}

/** Observation only: absence is not proof of non-publication and no state authorizes a send/retry. */
export type AuthoredInvocationPublicationInspection =
  | { invocationId: string; status: "not_linked" }
  | { invocationId: string; status: "not_observed" | "observed"; messageId: string };

/**
 * Internal, read-only uncertainty inspection using an authenticated private selector.
 * Retirement/recipient availability do not rewrite historical publication. Current
 * human access is required before private reads and again before returning an observation.
 * No body resolution, message publication, lease mutation, wake, dispatch or retry.
 */
export async function inspectAuthoredInvocationPublication(
  store: RelayBindingStore, client: ConversationClient,
  context: Omit<AuthoredInvocationPreparation, "target" | "lease">,
): Promise<AuthoredInvocationPublicationInspection> {
  try {
    const checkActor = async () => {
      const conversation = await client.getConversation(context.conversationId);
      if (conversation.workspaceId !== context.workspaceId) throw new AuthoredInvocationDeliveryUnavailableError();
      const [workspace, members, actor] = await Promise.all([
        client.getWorkspace(context.workspaceId), client.listWorkspaceMembers(context.workspaceId), client.getIdentity(context.actorIdentityId),
      ]);
      if (workspace.status !== "active" || actor.type !== "human" || actor.status !== "active"
        || !members.some(member => member.identityId === actor.id && member.status === "active")
        || !conversation.participants.some(participant => participant.id === actor.id && participant.type === "human" && participant.status === "active")) {
        throw new AuthoredInvocationDeliveryUnavailableError();
      }
      return conversation;
    };

    const conversation = await checkActor();
    const invocation = await store.getAuthoredSkillInvocation(context.conversationId, context.actorIdentityId, context.requestId);
    if (!invocation || invocation.workspaceId !== context.workspaceId || invocation.conversationId !== context.conversationId
      || invocation.actorIdentityId !== context.actorIdentityId || invocation.requestId !== context.requestId
      || invocation.channelId !== (conversation.thread?.parentConversationId ?? conversation.id)) {
      throw new AuthoredInvocationDeliveryUnavailableError();
    }
    const link = await store.getAuthoredInvocationMessageLink(invocation.id);
    if (link && (link.invocationId !== invocation.id || !isResourceId(link.messageId, "message"))) {
      throw new AuthoredInvocationDeliveryUnavailableError();
    }
    // The metadata endpoint does not include messages. Inspect an existing public
    // snapshot only for the original private link; recheck access AFTER all I/O.
    const messages = link ? await client.listMessages(context.conversationId) : [];
    const current = await checkActor();
    if ((current.thread?.parentConversationId ?? current.id) !== invocation.channelId) throw new AuthoredInvocationDeliveryUnavailableError();
    if (!link) return { invocationId: invocation.id, status: "not_linked" };
    const message = messages.find(message => message.id === link.messageId);
    if (message && !messageMatchesInvocation(message, invocation)) throw new AuthoredInvocationDeliveryUnavailableError();
    return { invocationId: invocation.id, status: message ? "observed" : "not_observed", messageId: link.messageId };
  } catch {
    throw new AuthoredInvocationDeliveryUnavailableError();
  }
}

/** Only the durable private message-ID association selects an operation; public metadata is not a selector. */
export async function prepareLinkedAuthoredInvocationTurn(
  store: RelayBindingStore, client: ConversationClient, message: ConversationMessage, target: AuthoredInvocationTarget,
  lease?: AuthoredInvocationPreparation["lease"],
): Promise<PreparedAuthoredInvocationTurn | undefined> {
  try {
    const invocation = await store.getAuthoredSkillInvocationForMessage(message.conversationId, message.id);
    if (!invocation && message.authoredInvocationId === undefined) return undefined;
    if (!invocation || !messageMatchesInvocation(message, invocation)) throw new AuthoredInvocationDeliveryUnavailableError();
    return await prepareAuthoredInvocationTurn(store, client, {
      workspaceId: invocation.workspaceId, conversationId: invocation.conversationId,
      actorIdentityId: invocation.actorIdentityId, requestId: invocation.requestId, target, lease,
    });
  } catch (error) {
    if (error instanceof AuthoredInvocationLeaseLostError) throw error;
    throw new AuthoredInvocationDeliveryUnavailableError();
  }
}

export class AuthoredInvocationDeliveryUnavailableError extends Error {
  constructor() { super("Skill invocation delivery is unavailable"); }
}

/** Distinguish a lost dispatch fence from a policy failure; retain the same sanitized public message. */
export class AuthoredInvocationLeaseLostError extends AuthoredInvocationDeliveryUnavailableError {}

/**
 * Read-only preparation, NOT a dispatch reservation or permission token.
 * Only a trusted dispatcher may call this using a private accepted-operation selector.
 * Public-message linkage, lease/Stop fences and the final send admission are separate;
 * any wait requires fresh preparation. This function never sends, wakes or restarts work.
 */
export async function prepareAuthoredInvocationTurn(
  store: RelayBindingStore,
  client: ConversationClient,
  context: AuthoredInvocationPreparation,
): Promise<PreparedAuthoredInvocationTurn> {
  try {
    const invocation = await store.getAuthoredSkillInvocation(context.conversationId, context.actorIdentityId, context.requestId);
    const target = invocation?.targets.find(target => target.identityId === context.target.identityId);
    if (!invocation || invocation.workspaceId !== context.workspaceId || invocation.conversationId !== context.conversationId
      || invocation.actorIdentityId !== context.actorIdentityId || invocation.requestId !== context.requestId
      || !target || target.bindingId !== context.target.bindingId || target.generation !== context.target.generation) {
      throw new AuthoredInvocationDeliveryUnavailableError();
    }

    const checkCurrent = async () => {
      const conversation = await client.getConversation(invocation.conversationId);
      if (conversation.workspaceId !== invocation.workspaceId
        || (conversation.thread?.parentConversationId ?? conversation.id) !== invocation.channelId) {
        throw new AuthoredInvocationDeliveryUnavailableError();
      }
      const [workspace, lifecycle, members, actor, recipient] = await Promise.all([
        client.getWorkspace(invocation.workspaceId), client.getConversationLifecycle(invocation.conversationId),
        client.listWorkspaceMembers(invocation.workspaceId), client.getIdentity(invocation.actorIdentityId), client.getIdentity(target.identityId),
      ]);
      const participates = (identityId: string) => conversation.participants.some(participant => participant.id === identityId && participant.status === "active");
      const member = (identityId: string) => members.some(member => member.identityId === identityId && member.status === "active");
      if (workspace.status !== "active" || lifecycle.state !== "active" || actor.type !== "human" || actor.status !== "active"
        || recipient.status !== "active" || (recipient.type !== "agent" && recipient.type !== "service")
        || !member(actor.id) || !member(recipient.id) || !participates(actor.id) || !participates(recipient.id)) {
        throw new AuthoredInvocationDeliveryUnavailableError();
      }
      const { bindings, activation } = await store.getSessionInspectionRecords(invocation.workspaceId, invocation.conversationId, target.identityId);
      const binding = bindings[0];
      if (bindings.length !== 1 || !binding || binding.state !== "connected" || binding.wakePolicy === "muted"
        || !activation?.authoredContext || !invocationTargetMatches(invocation, target, binding, activation)) {
        throw new AuthoredInvocationDeliveryUnavailableError();
      }
      const config = await store.getAgentConfig(binding.workspaceAgentConfigId);
      if (!config || config.workspaceId !== invocation.workspaceId || config.agentIdentityId !== target.identityId || config.status !== "active"
        || !invocationDocumentMatches(invocation, await store.getAuthoredDocument(invocation.workspaceId, invocation.documentId))) {
        throw new AuthoredInvocationDeliveryUnavailableError();
      }
      // Validate the dispatcher's EXPECTED owner, not whichever owner now holds
      // the lease. Compare expiry with a fresh clock after this validation's I/O.
      // This read-only fence is part of current-policy validation, not a later renewal.
      if (context.lease && (typeof context.lease.owner !== "string" || !context.lease.owner.trim()
        || binding.leaseOwner !== context.lease.owner
        || !(Date.parse(binding.leaseExpiresAt ?? "") > context.lease.now().getTime()))) {
        throw new AuthoredInvocationLeaseLostError();
      }
      return activation.authoredContext;
    };

    const snapshot = await checkCurrent();
    const reference = snapshot.documents.find(ref => ref.documentId === invocation.documentId && ref.kind === "skill"
      && ref.source === invocation.source && ref.revision === invocation.revision && ref.contentHash === invocation.contentHash)!;
    const publication = await resolveAuthoredPublication(store, snapshot, reference);
    // Catch retirement/access/session changes while the private body was being read.
    // This does not make public membership and private state one atomic transaction.
    await checkCurrent();
    return {
      invocationId: invocation.id, documentId: invocation.documentId, source: invocation.source,
      revision: invocation.revision, contentHash: invocation.contentHash,
      input: [
        "The human explicitly selected this published playbook for this task. It grants no permissions and does not override platform, harness or project constraints.",
        `Playbook: ${publication.name} (${invocation.source}, revision ${invocation.revision})`,
        `Procedure:\n${publication.content}`,
        `User arguments:\n${invocation.arguments}`,
      ].join("\n\n"),
    };
  } catch (error) {
    if (error instanceof AuthoredInvocationLeaseLostError) throw error;
    // No bare-message fallback, procedure text, raw adapter error or host path.
    throw new AuthoredInvocationDeliveryUnavailableError();
  }
}
