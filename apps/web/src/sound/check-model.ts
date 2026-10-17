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
	type Command,
	DELIVERY_PRESETS,
	readSoundCheckTarget,
	SOUND_CHECK_MESSAGES,
	SOUND_CHECK_TARGET_LIMITS,
	SOUND_CHECK_VERDICT_MARKER,
	type Sequence,
	type SoundCheckHumanVerdict,
	type SoundCheckStatus,
	type SoundCheckTarget,
	type SoundDelivery,
	soundCheckHumanVerdicts,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { IconId } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';
import { kindLabel } from './cues/model.ts';
import { deliveryOptionLabel, fmtDb } from './mix-model.ts';

export type CheckCategory = SoundCheckIssue['category'];
export type CheckSeverity = SoundCheckIssue['severity'];
export type CheckVerdict = SoundCheckReport['verdict'];

/** Category order of the results list (what a user fixes first: timing, then delivery, then the mix…). */
export const CATEGORY_ORDER: readonly CheckCategory[] = ['sync', 'loudness', 'mix', 'cues', 'licence'];
export const CATEGORY_LABELS: Record<CheckCategory, string> = {
	sync: 'Sync',
	loudness: 'Loudness',
	mix: 'Mix',
	cues: 'Cues',
	licence: 'Licence',
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

const DENSITY_LABELS: Record<string, string> = { sparse: 'sparse', balanced: 'balanced', rich: 'rich' };
/** Templates whose parameter at this index is a cue kind id / a density id. */
const KIND_PARAM = new Map<string, number>([
	[SOUND_CHECK_MESSAGES.syncEarly, 2],
	[SOUND_CHECK_MESSAGES.syncLate, 2],
]);
const DENSITY_PARAM = new Map<string, number>([
	[SOUND_CHECK_MESSAGES.densityHeroes, 4],
	[SOUND_CHECK_MESSAGES.densityRate, 3],
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
		const params = m.params.map((p, i) => {
			if (typeof p !== 'string') return p;
			if (i === kindAt) return kindLabel(p).toLocaleLowerCase();
			if (i === densityAt && DENSITY_LABELS[p]) return t(DENSITY_LABELS[p]!);
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

/** The summary chips: integrated, true peak, LRA, findings per severity. */
export function summaryChips(report: SoundCheckReport): SummaryChip[] {
	const l = report.loudness;
	const c = report.counts;
	return [
		{
			id: 'integrated',
			label: t('Integrated'),
			value: l.measurable ? num(l.integratedLufs, 'LUFS') : t('not measurable'),
			title: t('Target {0} LUFS', report.preset.integratedLufs),
		},
		{
			id: 'truePeak',
			label: t('True peak'),
			value: num(l.truePeakDb, 'dBTP'),
			title: t('Ceiling {0} dBTP', report.preset.truePeakDb),
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

/** "Fail: 2 errors, 3 warnings" — what the live region says after a run. */
export function verdictSentence(verdict: CheckVerdict, counts: Record<string, number>): string {
	const e = counts.error ?? 0;
	const w = counts.warning ?? 0;
	const parts = [
		e === 1 ? t('1 error') : t('{0} errors', e),
		w === 1 ? t('1 warning') : t('{0} warnings', w),
	];
	return t('Sound Check {0}: {1}', t(VERDICT_LABELS[verdict]), parts.join(', '));
}

/** Why a stored summary is stale, in words (null when it is current or there is none). */
export function staleText(status: Pick<SoundCheckStatus, 'state' | 'reasons'>): string | null {
	if (status.state !== 'stale') return null;
	const words = status.reasons.map((r) =>
		r === 'mix'
			? t('the mix changed')
			: r === 'inputs'
				? t('cues, loudness or credits settings changed')
				: t('the delivery target changed'),
	);
	return t('Stale: {0} since this check', words.join(', '));
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

/** Findings with a safe fix the panel can apply. */
export function safeFixable(issues: readonly SoundCheckIssue[]): SoundCheckIssue[] {
	return issues.filter((i) => i.fix?.safe && canApply(i));
}

// ── listen here ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ListenRow = SoundCheckListen & {
	slotLabel: string;
	text: string;
	verdict: SoundCheckHumanVerdict | null;
};

/** The listen-here rows (≤ 5) with the user's verdict at each frame (the last one written there). */
export function listenRows(report: SoundCheckReport, seq: Sequence | undefined): ListenRow[] {
	const verdicts = seq ? soundCheckHumanVerdicts(seq) : [];
	return report.listen.slice(0, 5).map((l) => ({
		...l,
		slotLabel: SLOT_LABELS[l.slot] ?? l.slot,
		text: messageText(l.why),
		verdict: verdicts.filter((v) => v.frame === l.frame).at(-1) ?? null,
	}));
}

/**
 * The commands that record a verdict at a listen-here frame: a user `comment` marker named as
 * `SOUND_CHECK_VERDICT_MARKER` with the note as its comment; an existing verdict marker at that frame is updated
 * instead of adding another.
 */
export function verdictCommands(
	seq: Sequence,
	frame: number,
	verdict: keyof typeof SOUND_CHECK_VERDICT_MARKER,
	note: string,
): Command[] {
	const name = SOUND_CHECK_VERDICT_MARKER[verdict];
	const comment = note.trim().slice(0, 2000);
	const color = verdict === 'ok' ? 'green' : 'rose';
	const existing = soundCheckHumanVerdicts(seq).filter((v) => v.frame === frame);
	const keep = existing.at(-1);
	if (keep)
		return [
			{ type: 'marker.update', markerId: keep.markerId, name, comment, color } as Command,
			...(existing.length > 1
				? [
						{
							type: 'marker.remove',
							markerIds: existing.slice(0, -1).map((v) => v.markerId),
						} as Command,
					]
				: []),
		];
	return [
		{
			type: 'marker.add',
			sequenceId: seq.id,
			frame,
			name,
			markerType: 'comment',
			comment,
			color,
		} as Command,
	];
}

// ── delivery target ─────────────────────────────────────────────────────────────────────────────────────────────────

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
export function useAsTargetCommands(choice: DeliveryChoice, sequenceId: string): Command[] {
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
