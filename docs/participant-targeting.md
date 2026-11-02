# Participant targeting

Main conversations and threads use the same flow: select a recipient, keep talking, select or mention someone else to switch. Adding participants, creating a conversation, opening/restoring a thread and drafting do not launch agents.

## Selection and composer

- Each human has a separate selection per workspace and conversation/thread, stored in this browser. It survives reloads, not device changes. Parent/thread selections and other people's selections are independent.
- The composer recipient control shows the effective recipients for the next Send. Choose a participant there, type a valid mention or use a message's **Reply** action. Reply selects the author; it does not create a thread. Start/Open thread remains separate.
- An intentional single mention on Send changes the sticky recipient. Ordinary followups keep it. A recipient-control or Reply choice takes precedence over older mention text in that draft; typing a new mention changes the target again. Draft overrides and exact retry targets survive reloads.
- Code, quoted text, escaped mentions and generated agent replies are not implicit recipient commands. Incoming messages never change a person's selection.
- Broadcast and multiple-recipient overrides apply only to that message and preserve the previous sticky selection. Unknown/disabled recipients do not silently fall back to somebody else. An explicit no-recipient choice also persists.

Threads initially default to the active agent author of the root, or the sole active agent recipient of a human-authored root. Broadcast/multiple/unclear roots infer nobody. Explicit choices override that default.

## Send and activation

The authenticated local message endpoint handles main and thread sends. It saves the normal validated/idempotent message before attempting startup:

- Eligible explicitly addressed never-bound agents start on Send, including multiple explicit agents. Existing running sessions receive through the normal Relay.
- Any existing binding, including stopped, uncertain, offline or disabled bindings, prevents implicit resume/replacement. Explicit Start/Stop controls remain available.
- Broadcast never starts idle agents or resumes stopped ones. Eligible already-running agents retain their configured broadcast/wake policy. A message combining broadcast and direct targets does not initiate automatic startup.
- Workspace Start permissions and conversation/parent archive restrictions remain authoritative. Ordinary members may post without gaining Start privileges. Retired work cannot execute.
- Startup includes the triggering question and earlier pending directly addressed work above the retirement floor. A partial multi-agent startup failure leaves the saved message intact; same-key retry cannot duplicate messages or existing sessions.
- Generated replies cannot wake other agents, including under `all_messages`. Intentional proactive collaboration-tool sends can still use explicit recipients on existing sessions.

Thread agents retain separate sessions, frozen inherited public context and thread-only responses. Visibility, parent administration, working folders and permissions are unchanged; this is not filesystem isolation.

## Message API contract

`CreateMessageInput.to`, when supplied, is authoritative, including `[]`. Callers wanting human body-mention resolution must omit `to`; callers selecting recipients should send the exact displayed IDs. This replaces the former union of structured recipients and arbitrary body matches. Generated agent text is never parsed into recipients; explicit proactive tool recipients remain explicit.

The browser always supplies its effective targets. Omitted-target local API compatibility uses the reply author, or a stable seed from that sender's first saved message; when no such message exists it uses the thread-root default. An initial no-recipient/broadcast/multiple seed does not become an arbitrary recipient later. This compatibility default is not an evolving server-side sticky selection: later sends cannot reinterpret an older same-key retry. API callers implementing sticky targeting must submit their effective `to` on each Send, as the browser does. These defaults never borrow another person's history or synchronize browser preferences across devices. Direct public message API writes do not launch workers.

Copy-message, message links, cross-device preference synchronization and automatic history transfer remain out of scope.
