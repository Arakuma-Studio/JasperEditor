// Sound Check panel model (spec 12 §2.6 / §2.7 "Sound Check panel", P5-R3; wp-note "Phase 5 → WP5.2"): pure helpers
// the panel, the Export dialog's check and the tests share — translated finding texts (the report's message templates
// are model strings; cue kinds and densities inside them are ids, translated here), issues grouped by category, the
// summary chips, the fix plan of "Fix" / "Fix all safe" (command fixes in ONE transaction, sound swaps registered first,
// engine jobs after it, duplicates once), the listen-here rows with the user's verdict markers, the delivery target
// choice (a preset or a custom LUFS / dBTP target) and what "Use as sequence target" writes, and the staleness line.
import type {
	SoundCheckEvent,
	SoundCheckIssue,
	SoundCheckListen,
	SoundCheckMessageJson,
	SoundCheckReport,
} from '@jasper/api';
import {
	applySoundAcknowledgements,
	type Command,
	DELIVERY_PRESETS,
	mixFingerprint,
	type ProjectDocument,
	REFERENCE_MESSAGES,
	readSoundCheckTarget,
	type Sequence,
	SOUND_CHECK_MESSAGES,
	SOUND_CHECK_TARGET_LIMITS,
	type SOUND_CHECK_VERDICT_MARKER,
	type SoundAckUnmatched,
	type SoundCheckAudio,
	type SoundCheckHumanVerdict,
	type SoundCheckStatus,
	type SoundCheckTarget,
	type SoundDelivery,
	sequenceTimecode,
	soundAckTargetOf,
	soundCheckAudioKey,
	soundCheckHumanVerdicts,
	soundCheckInputsHash,
	soundCheckVerdictFor,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { IconId } from '@jasper/ui';
import { t, withoutContext } from '../i18n/runtime.ts';
import { CUE_KIND_LABELS } from './cues/model.ts';
import { deliveryOptionLabel, fmtDb, solverReason } from './mix-model.ts';

export type CheckCategory = SoundCheckIssue['category'];
export type CheckSeverity = SoundCheckIssue['severity'];
export type CheckVerdict = SoundCheckReport['verdict'];

/**
 * Category order of the results list (what a user fixes first: timing, then clicks and cut edges, delivery, the mix,
 * its tone…). `edges` and `tonal` are the Phase 6 review lenses (spec 12 §4 P6-E1…E3); `reference` (P6-E8) holds
 * the comparison with a reference profile, a style rather than a defect: last.
 */
export const CATEGORY_ORDER: readonly CheckCategory[] = [
	'sync',
	'edges',
	'loudness',
	'mix',
	'tonal',
	'cues',
	'licence',
	'reference',
];
export const CATEGORY_LABELS: Record<CheckCategory, string> = {
	sync: 'Sync',
	edges: 'Edges',
	loudness: 'Loudness',
	mix: 'Mix',
	tonal: 'Tone',
	cues: 'Cues',
	licence: 'Licence',
	reference: 'Reference',
};
export const SEVERITY_LABELS: Record<CheckSeverity, string> = {
	error: 'Error',
	warning: 'Warning',
	info: 'Info',
};
/** Severity is told by shape (and word), not by colour alone: ⊗ circle-x, △ triangle, ⓘ. */
export const SEVERITY_ICON: Record<CheckSeverity, IconId> = {
	error: 'status.error',
	warning: 'status.warning',
	info: 'status.info',
};
export const SEVERITY_TONE: Record<CheckSeverity, string> = {
	error: 'text-pr-danger',
	warning: 'text-pr-warning',
	info: 'text-pr-muted',
};
const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };

export const VERDICT_LABELS: Record<CheckVerdict, string> = {
	pass: 'Pass',
	warn: 'Warnings',
	fail: 'Fail',
};
export const VERDICT_ICON: Record<CheckVerdict, IconId> = {
	pass: 'status.success',
	warn: 'status.warning',
	fail: 'status.error',
};
export const VERDICT_TONE: Record<CheckVerdict, string> = {
	pass: 'text-pr-success',
	warn: 'text-pr-warning',
	fail: 'text-pr-danger',
};

export const SLOT_LABELS: Record<SoundCheckListen['slot'], string> = {
	worst: 'Worst finding',
	hero: 'Biggest hero',
	loudest: 'Loudest moment',
	densest: 'Busiest moment',
	passing: 'A cue that passes',
};

/** Density names inside density messages (translated, then lower-cased: "at balanced density"). */
const DENSITY_LABELS: Record<string, string> = { sparse: 'Sparse', balanced: 'Balanced', rich: 'Rich' };
/** Templates whose parameter at this index is a cue kind id / a density id. */
const KIND_PARAM = new Map<string, number>([
	[SOUND_CHECK_MESSAGES.syncEarly, 2],
	[SOUND_CHECK_MESSAGES.syncLate, 2],
	[SOUND_CHECK_MESSAGES.syncEndEarly, 2],
	[SOUND_CHECK_MESSAGES.syncEndLate, 2],
	[SOUND_CHECK_MESSAGES.coverage, 2],
]);
const DENSITY_PARAM = new Map<string, number>([
	[SOUND_CHECK_MESSAGES.densityHeroes, 4],
	[SOUND_CHECK_MESSAGES.densityRate, 3],
]);
/** Templates whose parameter at this index is a fixed English fragment the editor translates (a model string). */
const FRAGMENT_PARAM = new Map<string, number>([
	[SOUND_CHECK_MESSAGES.syncUnmeasurable, 1],
	// P6-E8: a Reference row's finding names its metric's label (a model string)
	[REFERENCE_MESSAGES.low, 0],
	[REFERENCE_MESSAGES.high, 0],
	[REFERENCE_MESSAGES.lowOpen, 0],
	[REFERENCE_MESSAGES.highOpen, 0],
]);

/**
 * A report message in the UI language: the template (`key`, a model string) translated and filled with `params`;
 * cue kinds and densities (ids inside the English text) become their labels. Falls back to the English `text` when
 * the message is malformed. Never throws.
 */
export function messageText(m: SoundCheckMessageJson | null | undefined): string {
	if (!m || typeof m.key !== 'string' || !Array.isArray(m.params)) return m?.text ?? '';
	try {
		const kindAt = KIND_PARAM.get(m.key);
		const densityAt = DENSITY_PARAM.get(m.key);
		const fragmentAt = FRAGMENT_PARAM.get(m.key);
		const params = m.params.map((p, i) => {
			if (typeof p !== 'string') return p;
			if (i === fragmentAt) return t(p);
			if (i === kindAt) {
				const label = (CUE_KIND_LABELS as Record<string, string>)[p];
				return label ? withoutContext(t(label)).toLocaleLowerCase() : p;
			}
			if (i === densityAt && DENSITY_LABELS[p]) return t(DENSITY_LABELS[p]!).toLocaleLowerCase();
			return p;
		});
		return t(m.key, ...params);
	} catch {
		return m.text;
	}
}

/** The frame a finding points at: its frame, else the start of its range (null: the whole mix). */
export function issueFrame(i: Pick<SoundCheckIssue, 'frame' | 'range'>): number | null {
	return i.frame ?? i.range?.start ?? null;
}

export type IssueGroup = {
	category: CheckCategory;
	label: string;
	issues: SoundCheckIssue[];
	counts: Record<CheckSeverity, number>;
};

/** Issues grouped by category (CATEGORY_ORDER), errors first, then by time; empty categories left out. */
export function groupIssues(issues: readonly SoundCheckIssue[]): IssueGroup[] {
	const out: IssueGroup[] = [];
	for (const category of CATEGORY_ORDER) {
		const list = issues
			.filter((i) => i.category === category)
			.sort(
				(a, b) =>
					SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
					(issueFrame(a) ?? -1) - (issueFrame(b) ?? -1) ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
		if (!list.length) continue;
		const counts = { error: 0, warning: 0, info: 0 };
		for (const i of list) counts[i.severity]++;
		out.push({ category, label: CATEGORY_LABELS[category], issues: list, counts });
	}
	return out;
}

/** The issues in the order the list shows them (keyboard navigation follows it). */
export function orderedIssues(issues: readonly SoundCheckIssue[]): SoundCheckIssue[] {
	return groupIssues(issues).flatMap((g) => g.issues);
}

/** The per-event row of a sync finding's clip (offset, correlation), when the report has one. */
export function eventOf(report: SoundCheckReport, issue: SoundCheckIssue): SoundCheckEvent | null {
	const clipId = issue.clipIds?.[0];
	if (!clipId) return null;
	return report.events.find((e) => e.clipId === clipId) ?? null;
}

/** Whether a finding's row expands into a sync strip (a sync finding about a placed clip). */
export function hasSyncStrip(issue: SoundCheckIssue): boolean {
	return issue.category === 'sync' && !!issue.clipIds?.length && issueFrame(issue) !== null;
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SummaryChip = { id: string; label: string; value: string; title?: string };

const num = (v: number | null | undefined, unit: string) =>
	v === null || v === undefined || !Number.isFinite(v) ? '–' : `${fmtDb(v)} ${unit}`;

const CODEC_NAMES = { aac: 'AAC', opus: 'Opus', pcm: 'PCM' } as const;

/**
 * The summary chips: integrated, true peak, LRA, findings per severity. Checked as an export encodes it
 * (`loudness.delivered`): the decoded codec audio's numbers, with the codec and the limiter ceiling in the titles.
 */
export function summaryChips(report: SoundCheckReport): SummaryChip[] {
	const l = report.loudness;
	const c = report.counts;
	const d = l.delivered;
	const as = d
		? d.bitrateKbps
			? t('as {0} {1} kb/s decodes', CODEC_NAMES[d.codec], d.bitrateKbps)
			: t('as {0} decodes', CODEC_NAMES[d.codec])
		: null;
	const ceiling = l.normalization.limiterCeilingDb;
	const limiter =
		typeof ceiling === 'number' && ceiling !== report.preset.truePeakDb
			? t('limiter {0} dBTP in front of the encoder', fmtDb(ceiling))
			: null;
	const titled = (base: string) => [base, as, limiter].filter(Boolean).join(' · ');
	return [
		{
			id: 'integrated',
			label: t('Integrated'),
			value: l.measurable ? num(d ? d.integratedLufs : l.integratedLufs, 'LUFS') : t('not measurable'),
			title: titled(t('Target {0} LUFS', report.preset.integratedLufs)),
		},
		{
			id: 'truePeak',
			label: t('True peak'),
			value: num(d ? d.truePeakDb : l.truePeakDb, 'dBTP'),
			title: titled(t('Ceiling {0} dBTP', report.preset.truePeakDb)),
		},
		{
			id: 'lra',
			label: t('LRA'),
			value: l.lra === null || !Number.isFinite(l.lra) ? '–' : `${l.lra.toFixed(1)} LU`,
		},
		{ id: 'errors', label: t('Errors'), value: String(c.error ?? 0) },
		{ id: 'warnings', label: t('Warnings'), value: String(c.warning ?? 0) },
		{ id: 'infos', label: t('Info'), value: String(c.info ?? 0) },
	];
}

/** "2 errors, 3 warnings". */
export function countsText(counts: Record<string, number>): string {
	const e = counts.error ?? 0;
	const w = counts.warning ?? 0;
	return [e === 1 ? t('1 error') : t('{0} errors', e), w === 1 ? t('1 warning') : t('{0} warnings', w)].join(
		', ',
	);
}

/** "Sound Check Fail: 2 errors, 3 warnings" — what the live region says after a run. */
export function verdictSentence(verdict: CheckVerdict, counts: Record<string, number>): string {
	return t('Sound Check {0}: {1}', t(VERDICT_LABELS[verdict]), countsText(counts));
}

/** Why a stored summary is stale, in words (null when it is current or there is none). */
export function staleText(status: Pick<SoundCheckStatus, 'state' | 'reasons'>): string | null {
	if (status.state !== 'stale') return null;
	const words = status.reasons.map((r) =>
		r === 'mix'
			? t('the mix changed')
			: r === 'inputs'
				? t('cues, loudness or credits settings changed')
				: r === 'codec'
					? t('the export encoding to check for changed')
					: t('the delivery target changed'),
	);
	return t('Stale: {0} since this check', words.join(', '));
}

/**
 * Whether a report still describes the document (as `soundCheckStatus` does for the stored summary): the mix, the other
 * inputs (cues, loudness settings, credits, a custom target) and the sequence's delivery preset. A report kept by the
 * engine across a restart is judged by this, whatever summary the sequence stores.
 */
export function reportStatus(
	doc: ProjectDocument,
	report: Pick<SoundCheckReport, 'sequenceId' | 'mixHash' | 'inputsHash' | 'preset' | 'exportAudio'>,
	/** The panel's "Check for": a report checked for another encoding is stale (`codec`). */
	checkFor?: SoundCheckAudio | null,
): Pick<SoundCheckStatus, 'state' | 'reasons'> {
	const seq = doc.sequences?.[report.sequenceId] as Sequence | undefined;
	if (!seq) return { state: 'none', reasons: [] };
	const reasons: SoundCheckStatus['reasons'] = [];
	if (report.mixHash !== mixFingerprint(doc, report.sequenceId)) reasons.push('mix');
	const target = report.preset.custom
		? { integratedLufs: report.preset.integratedLufs, truePeakDb: report.preset.truePeakDb }
		: null;
	if (
		report.inputsHash !==
		soundCheckInputsHash(doc, report.sequenceId, report.preset.id, target, undefined, report.exportAudio)
	)
		reasons.push('inputs');
	if (report.preset.id !== soundDesignSettingsOf(seq).delivery) reasons.push('preset');
	if (checkFor !== undefined && soundCheckAudioKey(checkFor) !== soundCheckAudioKey(report.exportAudio))
		reasons.push('codec');
	return { state: reasons.length ? 'stale' : 'current', reasons };
}

// ── fixes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FixJob = { route: 'rebalance' | 'delivery'; body: Record<string, unknown> };
export type FixPlan = {
	/** Command fixes in issue order (each fix's commands kept together), duplicates once. */
	commands: Command[];
	/** Clips to swap to a library sound (registered first, then `soundDesign.swap` in the same transaction). */
	swaps: { clipId: string; soundId: string }[];
	/** Engine jobs, run one after another after the transaction. */
	jobs: FixJob[];
	/** Issues each part resolves. */
	issueIds: string[];
	/** Fix units in order, for applying one by one when the joined transaction is refused. */
	units: FixUnit[];
};
export type FixUnit =
	| { kind: 'commands'; issueIds: string[]; commands: Command[] }
	| { kind: 'swap'; issueIds: string[]; clipId: string; soundId: string }
	| { kind: 'job'; issueIds: string[]; job: FixJob };

function stable(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
	const keys = Object.keys(v as object).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Whether a finding has a fix the panel can apply (a typed command / swap / job fix). */
export function canApply(issue: SoundCheckIssue): boolean {
	const f = issue.fix;
	if (!f) return false;
	if (f.kind === 'commands') return !!f.commands?.length;
	if (f.kind === 'swap') return !!f.swap?.clipId && !!f.swap.soundId;
	return !!f.job && (f.job.route === 'rebalance' || f.job.route === 'delivery');
}

/**
 * The plan of applying these findings' fixes (`safeOnly`: only fixes marked safe — "Fix all safe"). The same fix
 * offered by two findings (LOUDNESS and TRUE_PEAK both normalise the Mix) is applied once; a clip is swapped once.
 */
export function planFixes(issues: readonly SoundCheckIssue[], opts: { safeOnly: boolean }): FixPlan {
	const plan: FixPlan = { commands: [], swaps: [], jobs: [], issueIds: [], units: [] };
	const seen = new Map<string, FixUnit>();
	for (const i of issues) {
		const f = i.fix;
		if (!f || !canApply(i) || (opts.safeOnly && !f.safe)) continue;
		const key =
			f.kind === 'commands'
				? `c:${stable(f.commands)}`
				: f.kind === 'swap'
					? `s:${f.swap!.clipId}`
					: `j:${f.job!.route}:${stable(f.job!.body)}`;
		const had = seen.get(key);
		if (had) {
			had.issueIds.push(i.id);
			plan.issueIds.push(i.id);
			continue;
		}
		let unit: FixUnit;
		if (f.kind === 'commands') {
			unit = { kind: 'commands', issueIds: [i.id], commands: f.commands as unknown as Command[] };
			plan.commands.push(...unit.commands);
		} else if (f.kind === 'swap') {
			unit = { kind: 'swap', issueIds: [i.id], clipId: f.swap!.clipId, soundId: f.swap!.soundId };
			plan.swaps.push({ clipId: unit.clipId, soundId: unit.soundId });
		} else {
			unit = { kind: 'job', issueIds: [i.id], job: { route: f.job!.route, body: { ...f.job!.body } } };
			plan.jobs.push(unit.job);
		}
		seen.set(key, unit);
		plan.units.push(unit);
		plan.issueIds.push(i.id);
	}
	return plan;
}

type AnyCmd = Record<string, unknown> & { type: string };

/** A clip's name for the confirmation ("Crunchy impact"), else its id. */
function clipName(seq: Sequence | undefined, id: unknown): string {
	if (typeof id !== 'string') return '?';
	const c =
		seq && Object.hasOwn(seq.clips, id) ? (seq.clips[id] as { name?: unknown } | undefined) : undefined;
	return typeof c?.name === 'string' && c.name ? c.name : id;
}

const tcOf = (seq: Sequence | undefined, f: unknown, fallback: string): string =>
	typeof f === 'number' && Number.isFinite(f) && f >= 0 && seq
		? sequenceTimecode(seq, Math.round(f))
		: fallback;

/**
 * What applying a finding's fix will change, one sentence per change (the confirmation of a fix that needs the user's
 * judgement names them before anything is applied; Phase 5 verification follow-up (a)). Never throws.
 */
export function fixChangeSummary(issue: SoundCheckIssue, seq: Sequence | undefined): string[] {
	const f = issue.fix;
	if (!f) return [];
	const at = issue.timecode ?? '';
	try {
		if (f.kind === 'swap' && f.swap)
			return [
				t('Replaces the sound of “{0}” at {1}: {2}', clipName(seq, f.swap.clipId), at, messageText(f.label)),
			];
		if (f.kind === 'job' && f.job) {
			const b = f.job.body;
			if (f.job.route === 'rebalance')
				return [
					t(
						'Re-levels the sound effects of the sequence against the bed and the true-peak ceiling: the gain of any of them may change',
					),
				];
			const lines: string[] = [];
			if (b.loudness !== false) lines.push(t('Normalises the Mix to the delivery target'));
			if (b.autoMatch !== false)
				lines.push(
					t('Auto-Match sets the gains of the dialogue and music clips by their Essential Sound type'),
				);
			lines.push(t('Turns on ducking of the music under the voice'));
			if (b.rebalance !== false) lines.push(t('Re-levels the sound effects against the bed'));
			return lines;
		}
		const out: string[] = [];
		for (const c of (f.commands ?? []) as AnyCmd[]) {
			switch (c.type) {
				case 'soundCue.add': {
					for (const q of (Array.isArray(c.cues) ? c.cues : []) as Record<string, unknown>[]) {
						const w = q.window as { start?: unknown; end?: unknown } | undefined;
						out.push(
							q.kind === 'silence' && w
								? t(
										'Adds a silence cue from {0} to {1}: Sound Check no longer reports silence there',
										tcOf(seq, w.start, at),
										tcOf(seq, w.end, at),
									)
								: q.kind === 'silence'
									? t(
											'Adds a silence cue at {0}: Sound Check no longer reports silence there',
											tcOf(seq, q.frame, at),
										)
									: t('Adds a sound cue at {0}', tcOf(seq, q.frame, at)),
						);
					}
					break;
				}
				case 'soundCue.remove': {
					const ids = Array.isArray(c.cueIds) ? (c.cueIds as string[]) : [];
					const cues = (
						seq as { soundDesign?: { cues?: Record<string, { placedClipIds?: string[]; frame?: number }> } }
					)?.soundDesign?.cues;
					for (const id of ids) {
						const cue = cues && Object.hasOwn(cues, id) ? cues[id] : undefined;
						const n = c.withClips ? (cue?.placedClipIds?.length ?? 0) : 0;
						const where = tcOf(seq, cue?.frame, at);
						out.push(
							n === 0
								? t('Deletes the sound cue at {0}', where)
								: n === 1
									? t('Deletes the sound cue at {0} and the sound placed on it', where)
									: t('Deletes the sound cue at {0} and the {1} sounds placed on it', where, n),
						);
					}
					break;
				}
				case 'soundDesign.applyGains': {
					const gains = (c.gains ?? {}) as Record<string, unknown>;
					for (const [id, g] of Object.entries(gains)) {
						const was =
							seq && Object.hasOwn(seq.clips, id) ? (seq.clips[id] as { gainDb?: unknown }).gainDb : null;
						out.push(
							typeof was === 'number' && typeof g === 'number'
								? t('Sets the gain of “{0}” from {1} dB to {2} dB', clipName(seq, id), fmtDb(was), fmtDb(g))
								: t(
										'Sets the gain of “{0}” to {1} dB',
										clipName(seq, id),
										typeof g === 'number' ? fmtDb(g) : '?',
									),
						);
					}
					break;
				}
				case 'mixer.setLoudness':
					out.push(
						t(
							'Normalises the Mix to {0} LUFS with a {1} dBTP ceiling',
							typeof c.targetLufs === 'number' ? fmtDb(c.targetLufs) : '?',
							typeof c.truePeakDb === 'number' ? fmtDb(c.truePeakDb) : '?',
						),
					);
					break;
				case 'soundCue.resync':
					out.push(t('Moves the cue at {0} and its sounds to what it follows', at));
					break;
				case 'clip.trim':
					out.push(t('Lengthens “{0}” so the whole sound plays', clipName(seq, c.clipId)));
					break;
				case 'soundDesign.swap':
					out.push(t('Replaces the sound of “{0}” at {1}', clipName(seq, c.clipId), at));
					break;
				case 'soundCue.update':
				case 'soundDesign.setRole':
					out.push(t('Makes the sound at {0} a support sound', at));
					break;
				case 'soundDesign.setSettings':
					out.push(t('Exports a credits file with this sequence'));
					break;
				case 'media.register':
					out.push(
						t(
							'Imports “{0}” into the project',
							String((c.asset as { originalName?: unknown })?.originalName ?? ''),
						),
					);
					break;
				case 'soundDesign.layBed': {
					// P6-E12: room tone (or an ambience) laid as looped clips on its own track, from … to …
					const shots = (Array.isArray(c.shots) ? c.shots : c.range ? [c.range] : []) as {
						start?: unknown;
						end?: unknown;
					}[];
					const from = shots[0]?.start;
					const to = shots[shots.length - 1]?.end;
					out.push(
						c.purpose === 'roomtone'
							? t(
									'Lays room tone on the “Room Tone” track from {0} to {1}, looped, with short fades under the dialogue',
									tcOf(seq, from, at),
									tcOf(seq, to, at),
								)
							: t(
									'Lays an ambience bed on the “Ambience” track from {0} to {1}',
									tcOf(seq, from, at),
									tcOf(seq, to, at),
								),
					);
					break;
				}
				default:
					out.push(t('Applies “{0}”', c.type));
			}
		}
		return [...new Set(out)];
	} catch {
		return [messageText(f.label)];
	}
}

/**
 * Why a fix needs the user's judgement, in the UI language (the engine's message; else its English text). "The solver's
 * gain does not resolve it: {0}" carries the solver's English reason: the fix's own gain report (its `limitedBy` codes,
 * the lifts) says it in the UI language instead (WP6.5a), as Essential Sound's Auto gain line does.
 */
export function fixWhyText(fix: SoundCheckIssue['fix']): string | null {
	if (!fix) return null;
	if (fix.whyMessage) {
		if (fix.whyMessage.key === SOUND_CHECK_MESSAGES.whySolverGain) {
			const why = solverGainWhy(fix);
			if (why) return t(SOUND_CHECK_MESSAGES.whySolverGain, why);
		}
		return messageText(fix.whyMessage);
	}
	return fix.why ?? null;
}

/** The solver's why of a gain fix, from the report its `soundDesign.applyGains` command carries (null: none). */
function solverGainWhy(fix: NonNullable<SoundCheckIssue['fix']>): string | null {
	const commands = (fix as { commands?: unknown }).commands;
	if (!Array.isArray(commands)) return null;
	for (const c of commands as { type?: unknown; report?: unknown }[]) {
		if (c?.type !== 'soundDesign.applyGains' || !c.report || typeof c.report !== 'object') continue;
		for (const r of Object.values(c.report as Record<string, unknown>)) {
			if (!r || typeof r !== 'object') continue;
			const lv = r as {
				limitedBy?: unknown;
				targetLiftDb?: unknown;
				achievedLiftDb?: unknown;
				reason?: unknown;
			};
			const why = solverReason({
				limitedBy: Array.isArray(lv.limitedBy)
					? lv.limitedBy.filter((x): x is string => typeof x === 'string')
					: [],
				targetLiftDb: typeof lv.targetLiftDb === 'number' ? lv.targetLiftDb : null,
				achievedLiftDb: typeof lv.achievedLiftDb === 'number' ? lv.achievedLiftDb : null,
				...(typeof lv.reason === 'string' ? { reason: lv.reason } : {}),
			});
			if (why) return why;
		}
	}
	return null;
}

/** Findings with a safe fix the panel can apply. */
export function safeFixable(issues: readonly SoundCheckIssue[]): SoundCheckIssue[] {
	return issues.filter((i) => i.fix?.safe && canApply(i));
}

// ── acknowledged findings (spec 12 §4 P6-E4) ───────────────────────────────────────────────────────────────────────

export type AckView = {
	/** The report as the document's acknowledgements say now (marks, verdict and counts recomputed). */
	report: SoundCheckReport;
	/** The findings that count (the list shows them). */
	open: SoundCheckIssue[];
	/** The findings left out as acknowledged ("Acknowledged (n)"). */
	acknowledged: SoundCheckIssue[];
	/** Acknowledgements no finding of the report matches (fixed since, or outside the range). */
	unmatched: SoundAckUnmatched[];
};

/**
 * A report seen through the sequence's acknowledgements now (`applySoundAcknowledgements`): acknowledging or taking
 * one back shows at once, without running the check again. Never throws.
 */
export function acknowledgedView(doc: ProjectDocument, report: SoundCheckReport): AckView {
	const a = applySoundAcknowledgements(doc, report.sequenceId, report.issues);
	const issues = a.issues as SoundCheckIssue[];
	return {
		report: { ...report, issues, verdict: a.verdict, counts: a.counts },
		open: issues.filter((i) => !i.acknowledged?.active),
		acknowledged: issues.filter((i) => i.acknowledged?.active),
		unmatched: a.unmatched,
	};
}

/** The command that acknowledges a finding with a reason (the user's own edit in the panel). */
export function ackCommand(issue: SoundCheckIssue, sequenceId: string, reason: string): Command {
	const target = soundAckTargetOf(issue);
	return {
		type: 'soundDesign.acknowledgeIssue',
		sequenceId,
		key: issue.id,
		code: issue.code,
		severity: issue.severity,
		reason: reason.trim().slice(0, 300),
		target,
		message: issue.message.text.slice(0, 500),
	} as Command;
}

/** The command that takes an acknowledgement back. */
export function unackCommand(key: string, sequenceId: string): Command {
	return { type: 'soundDesign.unacknowledgeIssue', sequenceId, key } as Command;
}

/** Who acknowledged it: "you" for the user, else the agent's name. */
export function ackByText(a: { by: 'user' | 'agent'; agent?: string | undefined }): string {
	return a.by === 'user' ? t('you') : (a.agent ?? t('an agent'));
}

/** Why an acknowledged finding counts again, in words (null when it is left out). */
export function ackAgainText(issue: Pick<SoundCheckIssue, 'acknowledged'>): string | null {
	const a = issue.acknowledged;
	if (!a || a.active) return null;
	if (a.why === 'worse') return t('Acknowledged as a lesser finding ({0}): it is worse now', a.reason);
	if (a.why === 'needs-user')
		return t('{0} acknowledged it ({1}): only you can acknowledge an error', ackByText(a), a.reason);
	return t('Acknowledged before the change ({0}): what it is about changed since', a.reason);
}

// ── listen here ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ListenRow = SoundCheckListen & {
	slotLabel: string;
	text: string;
	/** The listener's verdict on this moment (same frame and clip / cue; an unbound older one at the frame). */
	verdict: SoundCheckHumanVerdict | null;
};

/**
 * The listen-here rows (≤ 5) with the user's verdict on each moment — the last one at its frame about the same clip or
 * cue (`soundCheckVerdictFor`); with `doc` each verdict says whether it is stale (what plays there changed since).
 */
export function listenRows(
	report: SoundCheckReport,
	seq: Sequence | undefined,
	doc?: ProjectDocument,
): ListenRow[] {
	const verdicts = seq ? soundCheckHumanVerdicts(seq, doc ? { doc } : {}) : [];
	return report.listen.slice(0, 5).map((l) => {
		// the worst moment's reason quotes its finding's English text: say the finding in the UI language instead
		const issue = l.issueId ? report.issues.find((i) => i.id === l.issueId) : undefined;
		const text =
			issue && l.why?.key === SOUND_CHECK_MESSAGES.listenWorst
				? t(SOUND_CHECK_MESSAGES.listenWorst, messageText(issue.message))
				: messageText(l.why);
		return {
			...l,
			slotLabel: SLOT_LABELS[l.slot] ?? l.slot,
			text,
			verdict: soundCheckVerdictFor(verdicts, { frame: l.frame, clipId: l.clipId, cueId: l.cueId }),
		};
	});
}

/** Why a verdict no longer describes its moment, in words (null when it does or cannot be told). */
export function verdictStaleText(v: SoundCheckHumanVerdict | null): string | null {
	if (!v?.stale) return null;
	const r = v.staleReasons ?? [];
	const what = r.includes('gone')
		? v.cueId
			? t('its cue is gone')
			: t('its sound is gone')
		: r.includes('moved')
			? v.cueId
				? t('its cue moved')
				: t('its sound moved')
			: t('the sound here changed');
	return t('Out of date: {0} since you listened', what);
}

/**
 * The command that records a verdict on a listen-here moment (`soundDesign.setVerdict`): a user `comment` marker named
 * as `SOUND_CHECK_VERDICT_MARKER` with the note as its comment, bound to the moment — its slot, the clip (else cue) it
 * is about when that still exists, and the report's mix hash; the verdict on the same moment is updated instead of
 * adding another.
 */
export function verdictCommands(
	seq: Sequence,
	row: Pick<SoundCheckListen, 'frame'> & Partial<Pick<SoundCheckListen, 'slot' | 'clipId' | 'cueId'>>,
	verdict: keyof typeof SOUND_CHECK_VERDICT_MARKER,
	note: string,
	reportMixHash?: string | null,
): Command[] {
	const clipId = row.clipId && Object.hasOwn(seq.clips, row.clipId) ? row.clipId : undefined;
	const cues = (seq as { soundDesign?: { cues?: Record<string, unknown> } }).soundDesign?.cues;
	const cueId = !clipId && row.cueId && cues && Object.hasOwn(cues, row.cueId) ? row.cueId : undefined;
	return [
		{
			type: 'soundDesign.setVerdict',
			sequenceId: seq.id,
			frame: row.frame,
			verdict,
			note: note.trim().slice(0, 2000),
			...(row.slot ? { slot: row.slot } : {}),
			...(clipId ? { clipId } : {}),
			...(cueId ? { cueId } : {}),
			...(reportMixHash ? { reportMixHash: reportMixHash.slice(0, 256) } : {}),
		} as Command,
	];
}

// ── delivery target ─────────────────────────────────────────────────────────────────────────────────────────────────

// ── Check for: the export encoding the check delivers through ─────────────────────────────────────────────────────

/** The "Check for" value of the PCM master (the mix as it is, no codec). */
export const CHECK_FOR_MASTER = 'master';

/** The encodings "Check for" offers (`aac:256`, `opus:160`, `master`) in menu order. */
export const CHECK_FOR_ENCODINGS: readonly SoundCheckAudio[] = [
	{ codec: 'aac', bitrateKbps: 128 },
	{ codec: 'aac', bitrateKbps: 192 },
	{ codec: 'aac', bitrateKbps: 256 },
	{ codec: 'aac', bitrateKbps: 320 },
	{ codec: 'opus', bitrateKbps: 96 },
	{ codec: 'opus', bitrateKbps: 128 },
	{ codec: 'opus', bitrateKbps: 160 },
];

/** The select value of an encoding (null / PCM at the mix rate: the master). */
export function checkForValue(a: SoundCheckAudio | null | undefined): string {
	if (!a || a.codec === 'pcm') return a?.sampleRate ? `pcm@${a.sampleRate}` : CHECK_FOR_MASTER;
	return `${a.codec}:${a.bitrateKbps ?? (a.codec === 'aac' ? 192 : 160)}`;
}

/** The encoding of a select value (null: the PCM master; unknown values too). */
export function checkForAudio(value: string): SoundCheckAudio | null {
	const pcm = /^pcm@(44100|48000|96000)$/.exec(value);
	if (pcm) return { codec: 'pcm', sampleRate: Number(pcm[1]) as 44100 | 48000 | 96000 };
	const m = /^(aac|opus):(\d{2,4})$/.exec(value);
	if (!m) return null;
	const kbps = Number(m[2]);
	return kbps >= 16 && kbps <= 1536 ? { codec: m[1] as 'aac' | 'opus', bitrateKbps: kbps } : null;
}

/** The translated label of an encoding: "AAC 256 kb/s", "Opus 160 kb/s", "PCM / master", "PCM 44.1 kHz". */
export function checkForLabel(a: SoundCheckAudio | null | undefined): string {
	if (!a) return t('PCM / master');
	if (a.codec === 'pcm')
		return a.sampleRate ? t('PCM {0} kHz', String(a.sampleRate / 1000)) : t('PCM / master');
	const kbps = String(a.bitrateKbps ?? (a.codec === 'aac' ? 192 : 160));
	return a.codec === 'aac' ? t('AAC {0} kb/s', kbps) : t('Opus {0} kb/s', kbps);
}

/**
 * The "Check for" select's options: the PCM master, the AAC and Opus rates, and `extra` (the default when it is none
 * of these, e.g. the last export's PCM at another rate) — each value once.
 */
export function checkForOptions(extra?: SoundCheckAudio | null): { value: string; label: string }[] {
	const out = [
		{ value: CHECK_FOR_MASTER, label: checkForLabel(null) },
		...CHECK_FOR_ENCODINGS.map((a) => ({ value: checkForValue(a), label: checkForLabel(a) })),
	];
	if (extra && !out.some((o) => o.value === checkForValue(extra)))
		out.push({ value: checkForValue(extra), label: checkForLabel(extra) });
	return out;
}

/**
 * What "Check for" starts at: the sequence's last export settings (`lastExport`: the encoding the Export dialog will
 * write again), else the delivery preset's typical encoding (`DELIVERY_PRESETS[…].typicalAudio`: Web AAC 256 kb/s,
 * Podcast AAC 128 kb/s, broadcast PCM). `source` says which, for the select's hint.
 */
export function defaultCheckFor(
	seq: Sequence | undefined,
	choice: DeliveryChoice,
	lastExport: { audio: SoundCheckAudio | null } | null,
): { audio: SoundCheckAudio | null; source: 'export' | 'preset' } {
	if (lastExport) return { audio: lastExport.audio, source: 'export' };
	const id =
		choice.kind === 'preset'
			? choice.preset
			: seq
				? (soundDesignSettingsOf(seq).delivery as SoundDelivery)
				: 'web';
	const a = DELIVERY_PRESETS[id]?.typicalAudio ?? DELIVERY_PRESETS.web.typicalAudio;
	return {
		audio:
			a.codec === 'pcm' ? null : { codec: a.codec, ...(a.bitrateKbps ? { bitrateKbps: a.bitrateKbps } : {}) },
		source: 'preset',
	};
}

export type DeliveryChoice =
	| { kind: 'preset'; preset: SoundDelivery }
	| { kind: 'custom'; target: SoundCheckTarget };

export const CUSTOM_VALUE = 'custom';

/** The select's options: the four presets, then "Custom…". */
export function deliveryOptions(): { value: string; label: string }[] {
	return [
		...Object.values(DELIVERY_PRESETS).map((p) => ({ value: p.id, label: deliveryOptionLabel(p) })),
		{ value: CUSTOM_VALUE, label: t('Custom…') },
	];
}

type LoudnessLike = { enabled?: unknown; targetLufs?: unknown; truePeakDb?: unknown };
const loudnessOf = (seq: Sequence): LoudnessLike =>
	((seq.master as { loudness?: unknown } | undefined)?.loudness as LoudnessLike | undefined) ?? {};

/**
 * The target a check uses when the user has not chosen one: the stored summary's (its custom target, else its preset),
 * else a Mix normalisation that matches no preset (custom), else the sequence's delivery preset.
 */
export function defaultChoice(seq: Sequence | undefined): DeliveryChoice {
	if (!seq) return { kind: 'preset', preset: 'web' };
	const sd = (seq as { soundDesign?: { lastCheck?: { preset?: unknown; target?: unknown } } }).soundDesign;
	const last = sd?.lastCheck;
	const lastTarget = readSoundCheckTarget(last?.target);
	if (lastTarget) return { kind: 'custom', target: lastTarget };
	const delivery = soundDesignSettingsOf(seq).delivery as SoundDelivery;
	const l = loudnessOf(seq);
	if (l.enabled === true && typeof l.targetLufs === 'number' && typeof l.truePeakDb === 'number') {
		const preset = Object.values(DELIVERY_PRESETS).find(
			(p) => p.integratedLufs === l.targetLufs && p.truePeakDb === l.truePeakDb,
		);
		if (!preset) {
			const target = readSoundCheckTarget({ integratedLufs: l.targetLufs, truePeakDb: l.truePeakDb });
			if (target) return { kind: 'custom', target };
		}
	}
	if (typeof last?.preset === 'string' && Object.hasOwn(DELIVERY_PRESETS, last.preset))
		return { kind: 'preset', preset: last.preset as SoundDelivery };
	return { kind: 'preset', preset: Object.hasOwn(DELIVERY_PRESETS, delivery) ? delivery : 'web' };
}

/** The check request fields of a choice (the preset behind a custom target is the sequence's). */
export function choiceRequest(
	choice: DeliveryChoice,
	seq: Sequence | undefined,
): { preset: SoundDelivery; target?: SoundCheckTarget } {
	if (choice.kind === 'preset') return { preset: choice.preset };
	const d = seq ? (soundDesignSettingsOf(seq).delivery as SoundDelivery) : 'web';
	return { preset: Object.hasOwn(DELIVERY_PRESETS, d) ? d : 'web', target: choice.target };
}

/** The numbers of a choice. */
export function choiceNumbers(choice: DeliveryChoice): { integratedLufs: number; truePeakDb: number } {
	return choice.kind === 'preset' ? DELIVERY_PRESETS[choice.preset] : choice.target;
}

/** Whether the sequence already delivers to this target (its preset is it and the Mix normalises there). */
export function isSequenceTarget(choice: DeliveryChoice, seq: Sequence | undefined): boolean {
	if (!seq) return false;
	const l = loudnessOf(seq);
	const n = choiceNumbers(choice);
	const normalises = l.enabled === true && l.targetLufs === n.integratedLufs && l.truePeakDb === n.truePeakDb;
	if (choice.kind === 'preset') return normalises && soundDesignSettingsOf(seq).delivery === choice.preset;
	return normalises;
}

/**
 * "Use as sequence target" as ONE undoable edit: a preset → `soundDesign.applyDelivery {delivery}` (the sequence's
 * delivery setting, the Mix normalised at the preset, default sound-effect levels moved to it); a custom target →
 * `mixer.setLoudness` at its numbers (the delivery preset, which only presets can be, stays).
 */
export function sequenceTargetCommands(choice: DeliveryChoice, sequenceId: string): Command[] {
	if (choice.kind === 'preset')
		return [{ type: 'soundDesign.applyDelivery', sequenceId, delivery: choice.preset } as Command];
	return [
		{
			type: 'mixer.setLoudness',
			sequenceId,
			enabled: true,
			targetLufs: choice.target.integratedLufs,
			truePeakDb: choice.target.truePeakDb,
		} as Command,
	];
}

/** Parses the Custom… fields ("−18", "-18,5", "−1"), or says what is wrong. */
export function parseCustomTarget(
	lufs: string,
	tp: string,
): { ok: true; target: SoundCheckTarget } | { ok: false; field: 'lufs' | 'tp'; message: string } {
	const read = (s: string) => {
		const v = Number(s.trim().replace(/[−–]/g, '-').replace(',', '.'));
		return s.trim() && Number.isFinite(v) ? v : Number.NaN;
	};
	const L = SOUND_CHECK_TARGET_LIMITS;
	const l = read(lufs);
	if (!(l >= L.integratedLufs.min && l <= L.integratedLufs.max))
		return {
			ok: false,
			field: 'lufs',
			message: t('Integrated loudness from {0} to {1} LUFS', L.integratedLufs.min, L.integratedLufs.max),
		};
	const p = read(tp);
	if (!(p >= L.truePeakDb.min && p <= L.truePeakDb.max))
		return {
			ok: false,
			field: 'tp',
			message: t('True peak from {0} to {1} dBTP', L.truePeakDb.min, L.truePeakDb.max),
		};
	return { ok: true, target: readSoundCheckTarget({ integratedLufs: l, truePeakDb: p })! };
}

/** "Custom · −18 LUFS · −1.5 dBTP". */
export function customLabel(target: SoundCheckTarget): string {
	return t('Custom · {0} LUFS · {1} dBTP', fmtDb(target.integratedLufs), fmtDb(target.truePeakDb));
}
