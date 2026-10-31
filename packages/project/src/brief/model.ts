// Spec 18 AF-BRF-001…003 (schema v11): the sequence brief — what the human wants the video to be, stated once on Home
// or in Sequence ▸ Brief… for agents to read — and the project's agent notes (memos agents keep for later sessions).
// Both are read leniently: any stored value loads; INV-BRIEF / INV-AGENT-NOTES check them, `repairDocument` keeps
// their readable parts (reported), and the commands (`sequence.setBrief`, `project.addAgentNote`,
// `project.removeAgentNote`) validate strictly. docs/wp-notes/agent-footage-brief.md.
import { z } from 'zod';
import {
	DELIVERY_ASPECTS,
	DELIVERY_TARGETS,
	type DeliveryAspect,
	type DeliveryTargetId,
	isDeliveryTargetId,
} from '../delivery/targets.ts';
import { ID_PREFIXES, isValidId } from '../ids.ts';

export const BRIEF_LIMITS = {
	/** Brief text, UTF-16 code units (zod `max`). */
	maxText: 8_000,
	/** Target length in seconds (1 s … 10 h). */
	minDurationSec: 1,
	maxDurationSec: 36_000,
} as const;

export const AGENT_NOTE_LIMITS = {
	maxEntries: 500,
	maxAuthor: 64,
	maxText: 4_000,
} as const;

const TARGET_IDS = DELIVERY_TARGETS.map((t) => t.id) as [DeliveryTargetId, ...DeliveryTargetId[]];

/** A delivery target id (`DELIVERY_TARGETS`): youtube, youtube-shorts, instagram-reels, tiktok, x, linkedin. */
export const BriefPlatformSchema = z
	.enum(TARGET_IDS)
	.refine(isDeliveryTargetId, 'a delivery target id')
	.describe(`Platform the video is for: ${TARGET_IDS.join(' | ')}`);
export const BriefAspectSchema = z
	.enum(DELIVERY_ASPECTS)
	.describe(`Frame shape: ${DELIVERY_ASPECTS.join(' | ')}`);
export const BriefDurationSchema = z
	.number()
	.min(BRIEF_LIMITS.minDurationSec)
	.max(BRIEF_LIMITS.maxDurationSec)
	.describe('Target length in seconds (1…36 000)');
export const BriefTextSchema = z
	.string()
	.max(BRIEF_LIMITS.maxText)
	.describe('What the video should be: goal, audience, tone, must-keep moments (≤ 8 000 characters)');

/** `Sequence.brief` as stored (canonical: absent fields = not stated; commands never store nulls). */
export const SequenceBriefSchema = z.strictObject({
	text: BriefTextSchema,
	platform: BriefPlatformSchema.nullable().optional(),
	targetDurationSec: BriefDurationSchema.nullable().optional(),
	aspect: BriefAspectSchema.nullable().optional(),
});
export type SequenceBrief = {
	text: string;
	platform?: DeliveryTargetId | null;
	targetDurationSec?: number | null;
	aspect?: DeliveryAspect | null;
};

export const AGENT_NOTE_ID_PREFIX = ID_PREFIXES.agentNote;

export const AgentNoteAuthorSchema = z
	.string()
	.min(1)
	.max(AGENT_NOTE_LIMITS.maxAuthor)
	.refine((s) => s.trim().length > 0, 'an author name')
	.describe('Who wrote the note (1…64 characters)');
export const AgentNoteTextSchema = z
	.string()
	.min(1)
	.max(AGENT_NOTE_LIMITS.maxText)
	.refine((s) => s.trim().length > 0, 'note text')
	.describe('The note (1…4 000 characters)');

export const AgentNoteSchema = z.strictObject({
	id: z.string().refine((s) => isValidId(s, AGENT_NOTE_ID_PREFIX), 'an agent note id (agn_…)'),
	at: z.iso.datetime(),
	author: AgentNoteAuthorSchema,
	text: AgentNoteTextSchema,
});
export type AgentNote = z.infer<typeof AgentNoteSchema>;

export const ProjectAgentNotesSchema = z.strictObject({
	entries: z
		.array(AgentNoteSchema)
		.max(AGENT_NOTE_LIMITS.maxEntries)
		.refine((list) => new Set(list.map((n) => n.id)).size === list.length, 'note ids are unique'),
});
export type ProjectAgentNotes = { entries: AgentNote[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function issueOf(r: { success: boolean; error?: z.ZodError }, root: string): string | null {
	if (r.success) return null;
	const i = r.error?.issues[0];
	return i ? `${i.path.join('.') || root}: ${i.message}` : 'unreadable';
}

/** INV-BRIEF: why a sequence's `brief` is unreadable, or null (absent is fine). */
export function sequenceBriefIssue(value: unknown): string | null {
	if (value === undefined) return null;
	return issueOf(SequenceBriefSchema.safeParse(value), 'brief');
}

/** INV-AGENT-NOTES: why the project's `agentNotes` is unreadable, or null (absent is fine). */
export function agentNotesIssue(value: unknown): string | null {
	if (value === undefined) return null;
	return issueOf(ProjectAgentNotesSchema.safeParse(value), 'agentNotes');
}

/** The first `max` UTF-16 code units of `s`, never splitting a surrogate pair. */
export function cutText(s: string, max: number): string {
	if (s.length <= max) return s;
	let end = max;
	const c = s.charCodeAt(end - 1);
	if (c >= 0xd800 && c <= 0xdbff) end--;
	return s.slice(0, end);
}

/** The stored form of a brief: null / absent optional fields dropped. Null when nothing is stated. */
export function canonicalBrief(b: SequenceBrief): SequenceBrief | null {
	const out: SequenceBrief = { text: b.text };
	if (b.platform != null) out.platform = b.platform;
	if (b.targetDurationSec != null) out.targetDurationSec = b.targetDurationSec;
	if (b.aspect != null) out.aspect = b.aspect;
	return out.text === '' && Object.keys(out).length === 1 ? null : out;
}

/**
 * Conservative repair of an unreadable `Sequence.brief` (`repairDocument`): the text kept (cut to 8 000 characters on
 * a code point), each readable field kept, unknown keys and bad values dropped. Null when nothing readable is left.
 * Idempotent: its output passes `sequenceBriefIssue`.
 */
export function repairSequenceBrief(value: unknown): SequenceBrief | null {
	if (!isObj(value)) return null;
	const b: SequenceBrief = {
		text: typeof value.text === 'string' ? cutText(value.text, BRIEF_LIMITS.maxText) : '',
	};
	if (BriefPlatformSchema.safeParse(value.platform).success) b.platform = value.platform as DeliveryTargetId;
	if (BriefDurationSchema.safeParse(value.targetDurationSec).success)
		b.targetDurationSec = value.targetDurationSec as number;
	if (BriefAspectSchema.safeParse(value.aspect).success) b.aspect = value.aspect as DeliveryAspect;
	return canonicalBrief(b);
}

/** The readable brief of a sequence (unreadable parts read as absent), or null. Never throws. */
export function readSequenceBrief(seq: { brief?: unknown } | null | undefined): SequenceBrief | null {
	const v = seq?.brief;
	if (v === undefined || v === null) return null;
	const r = SequenceBriefSchema.safeParse(v);
	if (r.success) return canonicalBrief(r.data);
	return repairSequenceBrief(v);
}

/**
 * Conservative repair of an unreadable `ProjectDocument.agentNotes`: readable entries kept (unknown keys dropped,
 * long texts and authors cut, a missing author read as "agent", a malformed or repeated id replaced by a new one that
 * no entry uses); entries without text or a valid time dropped; at most the newest 500 kept (list order). Null when
 * nothing is left. Idempotent: its output passes `agentNotesIssue`.
 */
export function repairAgentNotes(value: unknown, newId: () => string): ProjectAgentNotes | null {
	if (!isObj(value) || !Array.isArray(value.entries)) return null;
	const readable = value.entries
		.filter(
			(v): v is Record<string, unknown> =>
				isObj(v) &&
				typeof v.text === 'string' &&
				v.text.trim().length > 0 &&
				typeof v.at === 'string' &&
				z.iso.datetime().safeParse(v.at).success,
		)
		.slice(-AGENT_NOTE_LIMITS.maxEntries);
	const reserved = new Set(
		readable.map((v) => v.id).filter((id): id is string => isValidId(id, AGENT_NOTE_ID_PREFIX)),
	);
	const used = new Set<string>();
	const entries: AgentNote[] = [];
	for (const v of readable) {
		let id = isValidId(v.id, AGENT_NOTE_ID_PREFIX) && !used.has(v.id) ? v.id : '';
		for (let tries = 0; !id && tries < 64; tries++) {
			const c = newId();
			if (isValidId(c, AGENT_NOTE_ID_PREFIX) && !reserved.has(c) && !used.has(c)) id = c;
		}
		const text = cutText(v.text as string, AGENT_NOTE_LIMITS.maxText);
		if (!id || !text.trim()) continue;
		used.add(id);
		let author = typeof v.author === 'string' ? cutText(v.author, AGENT_NOTE_LIMITS.maxAuthor) : '';
		if (!author.trim()) author = 'agent';
		entries.push({ id, at: v.at as string, author, text });
	}
	return entries.length ? { entries } : null;
}

/** The project's readable agent notes in stored order (oldest first). Never throws. */
export function readAgentNotes(doc: { agentNotes?: unknown } | null | undefined): AgentNote[] {
	const v = doc?.agentNotes;
	if (v === undefined || v === null) return [];
	const r = ProjectAgentNotesSchema.safeParse(v);
	if (r.success) return r.data.entries;
	let n = 0;
	// read-only view: entries whose id is unusable get a placeholder that never collides with a real id
	return repairAgentNotes(v, () => `agn_${String(n++).padStart(16, '0')}`)?.entries ?? [];
}

/** The aspect a brief implies: its own, else its platform's (`DELIVERY_TARGETS`), else null. */
export function briefAspect(brief: SequenceBrief | null): DeliveryAspect | null {
	if (!brief) return null;
	if (brief.aspect) return brief.aspect;
	if (brief.platform) return DELIVERY_TARGETS.find((t) => t.id === brief.platform)?.aspect ?? null;
	return null;
}
