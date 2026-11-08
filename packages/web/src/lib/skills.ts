import type { LocalAuthoredSkillInvocationInput, LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationPublicationReceipt, LocalConversationAuthoredSkillCatalog } from "@minu/channels-control/contracts";
import type { LocalControlClient } from "@minu/channels-control/client";
import type { Participant } from "@minu/channels-core/types";

export type SkillChoice = LocalConversationAuthoredSkillCatalog["skills"][number];
export interface SkillRequest {
  requestId: string;
  actorIdentityId: string;
  input: LocalAuthoredSkillInvocationInput;
  accepted?: LocalAuthoredSkillInvocationReceipt;
  publicationAttempted: boolean;
  publication?: LocalAuthoredSkillInvocationPublicationReceipt;
}
export type SkillApi = Pick<LocalControlClient, "acceptAuthoredSkillInvocation" | "publishAuthoredSkillInvocation" | "getAuthoredSkillInvocation" | "getAuthoredSkillInvocationPublication">;
export function skillsCommand(body: string): { query: string; arguments: string } | undefined {
  const match = /^\/([^\n]*)(?:\n([\s\S]*))?$/.exec(body);
  if (!match) return undefined;
  // Retain /skills as an alias; / and /query open the same skill-only popup.
  const query = match[1]!.replace(/^skills(?:[ \t]+|$)/, "").trim();
  return { query, arguments: match[2] ?? "" };
}
export type SkillPickerEntry = { skill: SkillChoice } | { identityId: string; commandId: string };
export function skillPickerEntries(catalog: LocalConversationAuthoredSkillCatalog | undefined, query: string): SkillPickerEntry[] {
  const search = query.trim().toLowerCase();
  return [
    ...(catalog?.skills.filter(skill => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(search))
      .map(skill => ({ skill })) ?? []),
    ...(catalog?.agents?.flatMap(agent => agent.harness.map(commandId => ({ identityId: agent.identityId, commandId })))
      .filter(skill => `harness ${skill.commandId}`.toLowerCase().includes(search)) ?? []),
  ];
}
export function readSkillChoice(value: string | null): SkillChoice | undefined {
  try {
    const v = JSON.parse(value ?? "null");
    return v && typeof v.documentId === "string" && (v.source === "workspace" || v.source === "channel")
      && Number.isSafeInteger(v.revision) && v.revision > 0 && /^[a-f0-9]{64}$/.test(v.contentHash)
      && typeof v.name === "string" && typeof v.description === "string" ? v : undefined;
  } catch { return undefined; }
}
export function readSkillRequest(value: string | null, actor: string): SkillRequest | undefined {
  try {
    const v = JSON.parse(value ?? "null"), input = v?.input;
    return v?.actorIdentityId === actor && typeof v.requestId === "string" && v.requestId.length > 0
      && typeof v.publicationAttempted === "boolean" && input && typeof input.documentId === "string"
      && (input.source === "channel" || input.source === "workspace") && Number.isSafeInteger(input.revision) && input.revision > 0
      && typeof input.arguments === "string" && Array.isArray(input.to) && input.to.every((id: unknown) => typeof id === "string") ? v : undefined;
  } catch { return undefined; }
}
export function skillAvailability(skill: SkillChoice, targets: string[], participants: Participant[], catalog?: LocalConversationAuthoredSkillCatalog, live?: ReadonlyArray<{ identityId: string; state: string }>): "Ready" | "Pending" | "Unavailable" {
  if (!catalog || !live || targets.some(id => !live.some(agent => agent.identityId === id && (agent.state === "idle" || agent.state === "running")))) return "Unavailable";
  if (!targets.length || new Set(targets).size !== targets.length
    || targets.some(id => !participants.some(p => p.id === id && p.status === "active" && (p.type === "agent" || p.type === "service")))) return "Unavailable";
  const current = catalog.skills.find(value => value.documentId === skill.documentId && value.source === skill.source);
  if (!current || current.revision < skill.revision || (current.revision === skill.revision && current.contentHash !== skill.contentHash)) return "Unavailable";
  let pending = false;
  for (const target of targets) {
    const agent = catalog.agents?.find(value => value.identityId === target);
    if (!agent?.supported || agent.state !== "ready") return "Unavailable";
    if (!agent.skills.some(ref => ref.documentId === skill.documentId && ref.source === skill.source && ref.revision === skill.revision && ref.contentHash === skill.contentHash)) pending = true;
  }
  return pending ? "Pending" : "Ready";
}
export function createSkillRequest(actorIdentityId: string, choice: SkillChoice, argumentsText: string, to: string[], createId: () => string = () => crypto.randomUUID()): SkillRequest {
  return { actorIdentityId, requestId: createId(), input: { documentId: choice.documentId, source: choice.source,
    revision: choice.revision, arguments: argumentsText, to: [...to].sort() }, publicationAttempted: false };
}
function checkAcceptance(request: SkillRequest, receipt: LocalAuthoredSkillInvocationReceipt, conversationId: string) {
  if (receipt.conversationId !== conversationId || receipt.acceptance !== "accepted" || receipt.requestId !== request.requestId || receipt.actorIdentityId !== request.actorIdentityId
    || receipt.documentId !== request.input.documentId || receipt.source !== request.input.source || receipt.revision !== request.input.revision
    || receipt.arguments !== request.input.arguments || JSON.stringify([...receipt.to].sort()) !== JSON.stringify([...request.input.to].sort())) throw new Error("Receipt mismatch");
}
function checkPublication(request: SkillRequest, publication: LocalAuthoredSkillInvocationPublicationReceipt) {
  if (publication.requestId !== request.requestId || publication.invocationId !== request.accepted?.id) throw new Error("Receipt mismatch");
}
/** Exactly one explicit attempt per phase; inspection never calls this function. */
export async function publishSkillRequest(api: SkillApi, conversationId: string, request: SkillRequest, persist: (request: SkillRequest) => void): Promise<SkillRequest> {
  if (!request.accepted || request.publicationAttempted) throw new Error("Inspect the original receipt");
  checkAcceptance(request, request.accepted, conversationId);
  const attempted = { ...request, publicationAttempted: true };
  persist(attempted);
  const publication = await api.publishAuthoredSkillInvocation(conversationId, request.accepted);
  checkPublication(attempted, publication);
  const result = { ...attempted, publication }; persist(result); return result;
}
export async function submitSkillRequest(api: SkillApi, conversationId: string, request: SkillRequest, persist: (request: SkillRequest) => void): Promise<SkillRequest> {
  persist(request);
  const accepted = await api.acceptAuthoredSkillInvocation(conversationId, request.input, { idempotencyKey: request.requestId });
  checkAcceptance(request, accepted, conversationId);
  const result = { ...request, accepted }; persist(result);
  return publishSkillRequest(api, conversationId, result, persist);
}
/** Missing/unobserved receipts do not authorize acceptance, publication or resend. */
export async function inspectSkillRequest(api: SkillApi, conversationId: string, request: SkillRequest): Promise<SkillRequest> {
  const accepted = await api.getAuthoredSkillInvocation(conversationId, request.requestId);
  checkAcceptance(request, accepted, conversationId);
  const result = { ...request, accepted };
  const publication = await api.getAuthoredSkillInvocationPublication(conversationId, request.requestId);
  checkPublication(result, publication);
  return { ...result, publication };
}
