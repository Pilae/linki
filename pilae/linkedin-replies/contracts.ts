export type Participant = { id: string; profileUrl?: string };
export type Conversation = { id: string; participants: Participant[]; group: boolean };
export type Message = { id: string; sender: string; at: number; kind: 'message' | 'system'; body: string };
export type Page<T> = { items: T[]; next: string | null };
/** Implementations must reject incomplete/unknown envelopes, never turn them into []. */
export interface Reader {
  identity(): Promise<string>;
  conversations(cursor: string | null): Promise<Page<Conversation>>;
  messages(conversation: string, cursor: string | null): Promise<Page<Message>>;
}
export class SyncError extends Error {
  constructor(public code: 'authentication' | 'incomplete' | 'rate_limited' | 'identity_changed' | 'transport') { super(code); }
}
export interface ReplyEvent {
  version: 1; id: string; accountId: string; conversationId: string; messageId: string;
  targetId: string; workflowId: string; runId: string; channel: 'linkedin';
  kind: 'reply_received'; occurredAt: string; body: string;
}
