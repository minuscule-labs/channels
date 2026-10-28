import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LocalAgentActionInput } from "@minu/channels-control/contracts";
import { localControl } from "./api";
import { ParticipantActionRequests, type BrowserAgentAction } from "./agent-actions";

export function useAgentActions(conversationId: string, humanIdentityId: string | undefined, enabled: boolean, completed: () => void, revoked: () => void) {
  const [actions, setActions] = useState<readonly BrowserAgentAction[]>([]);
  const owner = useRef<ParticipantActionRequests | undefined>(undefined);
  const onComplete = useRef(completed);
  const onRevoked = useRef(revoked);
  onComplete.current = completed;
  onRevoked.current = revoked;
  useLayoutEffect(() => {
    setActions([]);
    if (!enabled || !humanIdentityId) return;
    const requests = new ParticipantActionRequests(conversationId, localControl, setActions, () => onComplete.current(), () => onRevoked.current());
    owner.current = requests;
    void requests.refresh();
    const timer = window.setInterval(() => { void requests.refresh(); }, 1_000);
    return () => { window.clearInterval(timer); requests.dispose(); owner.current = undefined; };
  }, [conversationId, humanIdentityId, enabled]);
  const submit = useCallback((action: LocalAgentActionInput["action"], identityId?: string) => {
    if (!owner.current) return Promise.reject(new Error("Participant controls unavailable"));
    return owner.current.submit(action, identityId);
  }, []);
  const refresh = useCallback(() => owner.current?.refresh(), []);
  const dismiss = useCallback((requestId: string) => owner.current?.dismiss(requestId), []);
  return { actions, submit, refresh, dismiss };
}
