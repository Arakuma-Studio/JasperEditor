// Acknowledged Sound Check findings (spec 12 §4 P6-E4; wp-note "Phase 6 → WP-E2"; the idea is earshot's `qa_ok`): a
// finding the user (or an agent, for warnings and infos only) marked as a deliberate exception, with a reason, stops
// counting against the verdict until what it is about changes. Pure; never throws.
//
// - The **key** of a finding is its report id, `<CODE>:<subject>`: the code with the clip / cue ids it names (and which
//   edge, `clp_…:start`), else its frame (`SILENCE:53`), else what it is about (`LOUDNESS:mix`). The check derives it
//   from the document, so the same finding has the same key on every run.
// - The **target** is what the finding names: its clips, its cue, else its frame (`soundAckTargetOf`).
// - `inputsHash` (`soundAckInputsHash`) hashes the target: the clips' and the cue's records; with neither, what plays
//   around the frame (`soundCheckMomentHash`); with no frame either, the whole mix and the delivery settings. When it
//   changes the finding is reported again, "acknowledged before the change".
// - Severity: an acknowledgement covers a finding up to the severity it acknowledged (a warning that became an error
//   comes back), and one written by an agent never covers an error (an agent may only acknowledge warnings and infos:
//   the command refuses errors with E_APPROVAL_REQUIRED, and the check does not trust an agent's word for it either).
import { mixFingerprint } from '../audio/fingerprint.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import {
	readSoundAcknowledgements,
	SOUND_DESIGN_LIMITS,
	type SoundAcknowledgement,
	soundDesignSettingsOf,
} from '../schema/sound.ts';
import { fnv1a64 } from '../structure/nest.ts';
import {
	type SoundCheckSeverity,
	type SoundCheckVerdict,
	soundCheckCounts,
	soundCheckMomentHash,
	soundCheckVerdict,
	SOUND_CHECK_CODES,
	type SoundCheckCode,
} from './check.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ranks severities: an error is the worst (0). */
export const SOUND_ACK_SEVERITY_RANK: Readonly<Record<SoundCheckSeverity, number>> = {
	error: 0,
	warning: 1,
	info: 2,
};

/** What an acknowledgement is about (`SoundAcknowledgement.target`). */
export type SoundAckTarget = { clipIds?: string[]; cueId?: string; frame?: number };

/** The parts of a finding acknowledgements read (a Sound Check report issue). */
export type SoundAckFinding = {
	id: string;
	code: string;
	severity: SoundCheckSeverity;
	clipIds?: readonly string[] | undefined;
	cueId?: string | undefined;
	frame?: number | undefined;
	range?: { start: number; end: number } | undefined;
	message?: { text?: string } | undefined;
};

/** How a finding stands against its acknowledgement (`issue.acknowledged` in a report). */
export type SoundAckMark = {
	reason: string;
	by: 'user' | 'agent';
	agent?: string;
	at: string;
	/** Left out of the verdict (true), or reported again (false, with `why`). */
	active: boolean;
	/**
	 * Why it is reported again: `changed` (what it is about changed since: "acknowledged before the change"), `worse`
	 * (its severity is now worse than what was acknowledged), `needs-user` (an agent acknowledged an error).
	 */
	why?: 'changed' | 'worse' | 'needs-user';
};

/** The key of a finding: its report id (`<CODE>:<subject>`, see the module docs). */
export function soundFindingKey(f: Pick<SoundAckFinding, 'id'>): string {
	return f.id;
}

/** What a finding names: its clips (≤ 16) and cue, else its frame (or the start of its range). */
export function soundAckTargetOf(f: Pick<SoundAckFinding, 'clipIds' | 'cueId' | 'frame' | 'range'>): SoundAckTarget {
	if (!isRecord(f)) return {};
	const clipIds = (Array.isArray(f.clipIds) ? f.clipIds : [])
		.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= SOUND_DESIGN_LIMITS.id)
		.slice(0, SOUND_DESIGN_LIMITS.placedClips);
	const cueId =
		typeof f.cueId === 'string' && f.cueId.length > 0 && f.cueId.length <= SOUND_DESIGN_LIMITS.id
			? f.cueId
			: undefined;
	if (clipIds.length || cueId) return { ...(clipIds.length ? { clipIds } : {}), ...(cueId ? { cueId } : {}) };
	const frame = f.frame ?? (isRecord(f.range) ? f.range.start : undefined);
	return typeof frame === 'number' && Number.isSafeInteger(frame) && frame >= 0 && frame <= SOUND_DESIGN_LIMITS.maxFrame
		? { frame }
		: {};
}

/**
 * Serialises with sorted keys. Names are left out (a renamed clip sounds the same) and so are keys holding undefined,
 * as JSON drops them: the engine checks a JSON copy of the edit, the editor its in-memory document — both hash alike.
 */
function stable(v: unknown, depth = 0): string {
	if (depth > 64) return 'null';
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map((x) => stable(x, depth + 1)).join(',')}]`;
	const keys = Object.keys(v as object)
		.filter((k) => k !== 'name' && (v as Record<string, unknown>)[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
}

/**
 * The hash of what an acknowledgement is about (see the module docs). '' for an unknown sequence. Never throws.
 */
export function soundAckInputsHash(doc: ProjectDocument, sequenceId: string, target: SoundAckTarget): string {
	try {
		const seq = doc?.sequences?.[sequenceId] as Sequence | undefined;
		if (!seq) return '';
		const clipIds = Array.isArray(target?.clipIds) ? target.clipIds : [];
		const cueId = typeof target?.cueId === 'string' ? target.cueId : undefined;
		if (clipIds.length || cueId) {
			const clips = clipIds.map((id) =>
				typeof id === 'string' && Object.hasOwn(seq.clips, id) ? seq.clips[id] : `gone:${String(id)}`,
			);
			const cues = (seq as { soundDesign?: { cues?: Record<string, unknown> } }).soundDesign?.cues;
			const cue = cueId ? (cues && Object.hasOwn(cues, cueId) ? cues[cueId] : `gone:${cueId}`) : null;
			return fnv1a64(`ack:clips|${stable({ clips, cue })}`);
		}
		if (typeof target?.frame === 'number' && Number.isFinite(target.frame))
			return fnv1a64(`ack:moment|${soundCheckMomentHash(doc, sequenceId, target.frame)}`);
		const s = soundDesignSettingsOf(seq);
		return fnv1a64(
			`ack:mix|${mixFingerprint(doc, sequenceId)}|${s.delivery}|${s.credits ?? ''}|${stable((seq as { master?: { loudness?: unknown } }).master?.loudness ?? null)}`,
		);
	} catch {
		return '';
	}
}

/** The acknowledgements of a sequence (readable entries only; empty when none). Never throws. */
export function soundAcknowledgementsOf(seq: unknown): Record<string, SoundAcknowledgement> {
	try {
		const sd = isRecord(seq) ? (seq as { soundDesign?: unknown }).soundDesign : undefined;
		return readSoundAcknowledgements(isRecord(sd) ? sd.acknowledged : undefined) ?? {};
	} catch {
		return {};
	}
}

/** How a finding stands against an acknowledgement, given the target's hash now. */
export function soundAckMark(entry: SoundAcknowledgement, f: SoundAckFinding, hashNow: string): SoundAckMark {
	const base = {
		reason: entry.reason,
		by: entry.by,
		...(entry.agent ? { agent: entry.agent } : {}),
		at: entry.at,
	};
	if (entry.by === 'agent' && f.severity === 'error') return { ...base, active: false, why: 'needs-user' };
	const was = SOUND_ACK_SEVERITY_RANK[entry.severity as SoundCheckSeverity] ?? 0;
	if ((SOUND_ACK_SEVERITY_RANK[f.severity] ?? 0) < was) return { ...base, active: false, why: 'worse' };
	if (!hashNow || hashNow !== entry.inputsHash) return { ...base, active: false, why: 'changed' };
	return { ...base, active: true };
}

/** An acknowledgement no finding of the report matches (fixed since, or outside the checked range). */
export type SoundAckUnmatched = SoundAcknowledgement & { key: string };

export type AppliedAcknowledgements<T extends SoundAckFinding> = {
	/** Every finding, those with an acknowledgement marked (`acknowledged`). */
	issues: (T & { acknowledged?: SoundAckMark })[];
	/** The findings the verdict counts (not acknowledged, or acknowledged before a change). */
	open: (T & { acknowledged?: SoundAckMark })[];
	/** How many findings are left out as acknowledged. */
	acknowledged: number;
	/** Counts per code and severity of the open findings, plus `acknowledged` when any are left out. */
	counts: Record<string, number>;
	verdict: SoundCheckVerdict;
	/** Acknowledgements no finding matched. */
	unmatched: SoundAckUnmatched[];
};

/**
 * Marks the findings of a Sound Check (of `sequenceId` in `doc`) that the sequence's acknowledgements cover, and
 * recomputes the verdict and counts without the acknowledged ones (spec 12 §4 P6-E4). A mark already on a finding
 * (a report read back) is replaced by what the document says now. Never throws.
 */
export function applySoundAcknowledgements<T extends SoundAckFinding>(
	doc: ProjectDocument,
	sequenceId: string,
	issues: readonly T[],
): AppliedAcknowledgements<T> {
	const list = Array.isArray(issues) ? issues : [];
	let acks: Record<string, SoundAcknowledgement> = {};
	try {
		acks = soundAcknowledgementsOf(doc?.sequences?.[sequenceId]);
	} catch {
		acks = {};
	}
	const hashes = new Map<string, string>();
	const seen = new Set<string>();
	const out: (T & { acknowledged?: SoundAckMark })[] = [];
	const open: (T & { acknowledged?: SoundAckMark })[] = [];
	let n = 0;
	for (const raw of list) {
		if (!isRecord(raw)) continue;
		const { acknowledged: _old, ...rest } = raw as T & { acknowledged?: unknown };
		const f = rest as unknown as T;
		const key = typeof f.id === 'string' ? soundFindingKey(f) : '';
		const entry = key && Object.hasOwn(acks, key) ? acks[key] : undefined;
		if (!entry || entry.code !== f.code) {
			out.push(f);
			open.push(f);
			continue;
		}
		seen.add(key);
		let h = hashes.get(key);
		if (h === undefined) {
			h = soundAckInputsHash(doc, sequenceId, entry.target as SoundAckTarget);
			hashes.set(key, h);
		}
		const mark = soundAckMark(entry, f, h);
		const marked = { ...f, acknowledged: mark };
		out.push(marked);
		if (mark.active) n++;
		else open.push(marked);
	}
	const known = new Set<string>(SOUND_CHECK_CODES);
	const counts = soundCheckCounts(
		open.filter((i) => known.has(i.code)) as unknown as { code: SoundCheckCode; severity: SoundCheckSeverity }[],
	);
	if (n) counts.acknowledged = n;
	const unmatched = Object.entries(acks)
		.filter(([k]) => !seen.has(k))
		.map(([key, a]) => ({ ...a, key }));
	return { issues: out, open, acknowledged: n, counts, verdict: soundCheckVerdict(open), unmatched };
}
