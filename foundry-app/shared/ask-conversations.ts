/**
 * ASK'S CONVERSATIONS — several per book, each kept (Owen, 2026-11-02).
 *
 * A book used to hold ONE live thread (\`ops/ask-thread.json\`), and "New
 * question" deleted it. Now each conversation is kept in
 * \`ops/ask-conversations.json\` with its title, its times, how many questions
 * it holds and its own working note; its runs are the kept sessions
 * (\`ops/ask-sessions.jsonl\`), linked by \`AskSession.conversation\`. "+" starts
 * a new one; an old one can be gone back to and continued.
 *
 * ── CONTINUING ──────────────────────────────────────────────────────────────
 *
 * With a note, the next question opens with it, as a thread always did. With
 * none — the note could not be had, or the conversation predates notes — it
 * opens with the last run's question and answer, so going back to an old
 * question still has something to start from (\`continuationOf\`).
 *
 * ── THE MIGRATION, ONCE, ON THE FIRST READ ──────────────────────────────────
 *
 * Runs kept before conversations had none. The runs the old thread covered —
 * its last \`turns\` runs — become ONE conversation carrying the thread's note,
 * titled by its first question, so what was live stays continuable. Every
 * older run becomes a conversation of its own: they were separate questions
 * ("New question" divided them), and one shared "legacy" bucket would have
 * continued from a note that was never about most of them.
 */
import type { AskSession, AskThread } from './ask';

export interface AskConversation {
  readonly id: string;
  /** The first question, clipped — or what the person renamed it. */
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** How many questions it holds. */
  readonly turns: number;
  /** The model's working note after its latest run, or null (the note failed, or it predates notes). */
  readonly note: string | null;
  /** Runs kept before conversations existed that belong to it, by session id. */
  readonly legacyRuns?: readonly string[];
}

/** The file's shape. */
export interface AskConversationsFile {
  readonly format: 'ask-conversations/v1';
  readonly conversations: readonly AskConversation[];
}

export const CONVERSATION_TITLE_MAX = 60;

/** A question as a conversation's title. */
export function titleOf(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim();
  return flat.length <= CONVERSATION_TITLE_MAX ? flat : `${flat.slice(0, CONVERSATION_TITLE_MAX - 1)}…`;
}

/** A conversation's runs, oldest first. */
export function runsOf(conversation: AskConversation, sessions: readonly AskSession[]): AskSession[] {
  const legacy = new Set(conversation.legacyRuns ?? []);
  return sessions.filter((one) => one.conversation === conversation.id || (one.conversation === undefined && legacy.has(one.id)));
}

/** Newest first, by when each was last asked. */
export function newestFirst(conversations: readonly AskConversation[]): AskConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The conversations a book held before there were any: see the header. */
export function migrateConversations(thread: AskThread | null, sessions: readonly AskSession[]): AskConversation[] {
  const unlinked = sessions.filter((one) => one.conversation === undefined);
  const grouped = thread === null ? [] : unlinked.slice(Math.max(0, unlinked.length - thread.turns));
  const inThread = new Set(grouped.map((one) => one.id));
  const out: AskConversation[] = unlinked.filter((one) => !inThread.has(one.id)).map((one) => ({
    id: `legacy-${one.id}`,
    title: titleOf(one.request),
    createdAt: one.at,
    updatedAt: one.at,
    turns: 1,
    note: null,
    legacyRuns: [one.id],
  }));
  if (thread !== null) {
    out.push({
      id: `legacy-thread-${grouped[0]?.id ?? 'note'}`,
      title: titleOf(thread.first),
      createdAt: grouped[0]?.at ?? thread.at,
      updatedAt: thread.at,
      turns: thread.turns,
      note: thread.note,
      legacyRuns: grouped.map((one) => one.id),
    });
  }
  return out;
}

/**
 * THE FIRST MESSAGE OF A CONTINUED CONVERSATION — its note framed as leads to
 * check, or, with no note, its last question and answer; null when it has
 * neither (nothing to continue from: the question is asked as it stands).
 */
export function continuationOf(conversation: AskConversation, runs: readonly AskSession[], request: string): string | null {
  if (conversation.note !== null) {
    return `This question continues an earlier conversation about this book. Below is the working note you wrote for yourself at the end of it. Treat it as leads to check, not facts: since then the person may have kept or undone your marks, or edited the book, and the book your tools read is the book as it stands now. Blocks they removed are hidden from you, so a block the note names may be gone. Confirm with a read or a search before you act on anything in it; you need not survey again what it already tells you.

Your note, after ${conversation.turns} ${conversation.turns === 1 ? 'question' : 'questions'}:
<note>
${conversation.note}
</note>

The person now says:
${request}`;
  }
  const last = runs.at(-1);
  if (last === undefined) return null;
  return `This question continues an earlier conversation about this book. No working note was kept for it, so here is its last question and your answer to it. Treat your answer as leads to check, not facts: since then the person may have kept or undone your changes, or edited the book, and the book your tools read is the book as it stands now. Confirm with a read or a search before you act on anything in it.

The last question:
<question>
${last.request}
</question>

Your answer:
<answer>
${last.summary.length > 0 ? last.summary : '(You wrote no reply.)'}
</answer>

The person now says:
${request}`;
}

/** Whether a value is a conversation this build can keep. */
export function isConversation(value: unknown): value is AskConversation {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c['id'] === 'string' && c['id'].length > 0 && typeof c['title'] === 'string'
    && typeof c['createdAt'] === 'string' && typeof c['updatedAt'] === 'string'
    && typeof c['turns'] === 'number' && Number.isInteger(c['turns']) && c['turns'] >= 0
    && (c['note'] === null || typeof c['note'] === 'string')
    && (c['legacyRuns'] === undefined || (Array.isArray(c['legacyRuns']) && c['legacyRuns'].every((id) => typeof id === 'string')));
}
