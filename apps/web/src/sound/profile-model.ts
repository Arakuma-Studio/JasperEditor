// Reference sound profiles in the editor (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): the pure part of Preferences ▸
// Sound Library ▸ Reference profiles, the New Reference Profile dialog and the Sound Check panel's Reference select
// and rows. Profiles live in the engine's per-user library; a sequence names the one Sound Check compares it with
// (`soundDesign.setSettings {referenceProfile}`, one undo step).
import type { SoundCheckReference, SoundProfileBuildRequest, SoundProfileSummary } from '@jasper/api';
import {
	type Command,
	type ProjectDocument,
	REFERENCE_METRICS,
	REFERENCE_PROFILE_LIMITS,
	type ReferenceMetricKey,
	referenceValueText,
	soundDesignSettingsOf,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';

/** Media and sequences of the project that can be references: audio at least 3 s long (library sounds left out). */
export type ReferenceCandidates = {
	media: { mediaId: string; name: string; seconds: number; hasPicture: boolean }[];
	sequences: { sequenceId: string; name: string }[];
};

const FLICKS = 705_600_000;

export function referenceCandidates(doc: ProjectDocument | null | undefined): ReferenceCandidates {
	const out: ReferenceCandidates = { media: [], sequences: [] };
	if (!doc) return out;
	const items = Object.values(doc.items ?? {});
	const itemName = (key: 'mediaId' | 'sequenceId', id: string) =>
		(items.find((i) => (i as Record<string, unknown>)[key] === id) as { name?: string } | undefined)?.name;
	for (const [id, m] of Object.entries(doc.media ?? {})) {
		const a = m as {
			originalName?: string;
			library?: unknown;
			probe?: { streams?: { type?: string }[]; durationFlicks?: number | null };
		};
		if (a.library) continue;
		const streams = a.probe?.streams ?? [];
		if (!streams.some((s) => s.type === 'audio')) continue;
		const seconds = (a.probe?.durationFlicks ?? 0) / FLICKS;
		if (!(seconds >= REFERENCE_PROFILE_LIMITS.minSec)) continue;
		out.media.push({
			mediaId: id,
			name: itemName('mediaId', id) ?? a.originalName ?? id,
			seconds,
			hasPicture: streams.some((s) => s.type === 'video'),
		});
	}
	for (const id of Object.keys(doc.sequences ?? {}))
		out.sequences.push({ sequenceId: id, name: itemName('sequenceId', id) ?? id });
	out.media.sort((a, b) => a.name.localeCompare(b.name));
	out.sequences.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** Absolute paths, one per line (blank lines and surrounding spaces ignored). */
export function parsePaths(text: string): { paths: string[]; bad: string[] } {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
	return { paths: lines.filter(isAbs), bad: lines.filter((l) => !isAbs(l)) };
}

export type BuildChoice = {
	name: string;
	projectId: string | null;
	mediaIds: readonly string[];
	sequenceIds: readonly string[];
	paths: readonly string[];
};

/** The build request, or why it cannot be sent. */
export function buildRequest(
	c: BuildChoice,
): { ok: true; request: SoundProfileBuildRequest } | { ok: false; why: string } {
	const name = c.name.trim();
	if (!name) return { ok: false, why: t('Give the profile a name') };
	if (name.length > REFERENCE_PROFILE_LIMITS.name)
		return { ok: false, why: t('The name is longer than {0} characters', REFERENCE_PROFILE_LIMITS.name) };
	const n = c.mediaIds.length + c.sequenceIds.length + c.paths.length;
	if (n === 0) return { ok: false, why: t('Choose at least one reference') };
	if (n > REFERENCE_PROFILE_LIMITS.references)
		return { ok: false, why: t('At most {0} references', REFERENCE_PROFILE_LIMITS.references) };
	if ((c.mediaIds.length || c.sequenceIds.length) && !c.projectId)
		return { ok: false, why: t('Open the project first') };
	return {
		ok: true,
		request: {
			name,
			...(c.projectId && (c.mediaIds.length || c.sequenceIds.length) ? { projectId: c.projectId } : {}),
			...(c.mediaIds.length ? { mediaIds: [...c.mediaIds] } : {}),
			...(c.sequenceIds.length ? { sequenceIds: [...c.sequenceIds] } : {}),
			...(c.paths.length ? { paths: [...c.paths] } : {}),
		},
	};
}

/** The sequence's selected profile id (null: none). */
export function selectedProfile(doc: ProjectDocument, sequenceId: string | null | undefined): string | null {
	const seq = sequenceId ? doc.sequences?.[sequenceId] : undefined;
	return seq ? (soundDesignSettingsOf(seq).referenceProfile ?? null) : null;
}

/** The command that selects (or clears) the sequence's profile. */
export function selectProfileCommand(sequenceId: string, profileId: string | null): Command {
	return { type: 'soundDesign.setSettings', sequenceId, referenceProfile: profileId } as Command;
}

export const NO_PROFILE = '__none__';
export const NEW_PROFILE = '__new__';

/** The Sound Check header's Reference select: none, the library's profiles (a missing selected one named), new. */
export function profileOptions(
	profiles: readonly SoundProfileSummary[],
	selected: string | null,
): { value: string; label: string }[] {
	const opts = [{ value: NO_PROFILE, label: t('No reference') }];
	for (const p of profiles) opts.push({ value: p.id, label: t('{0} ({1} references)', p.name, p.n) });
	if (selected && !profiles.some((p) => p.id === selected))
		opts.push({ value: selected, label: t('Missing profile ({0})', selected) });
	opts.push({ value: NEW_PROFILE, label: t('New Reference Profile…') });
	return opts;
}

export const STATUS_LABELS: Record<SoundCheckReference['rows'][number]['status'], string> = {
	ok: 'In range',
	low: 'Low',
	high: 'High',
	'n.a.': 'n.a.',
};
export const WEIGHT_LABELS: Record<SoundCheckReference['rows'][number]['weight'], string> = {
	major: 'Major',
	minor: 'Minor',
	info: 'Shown only',
};

const isKey = (k: string): k is ReferenceMetricKey => Object.hasOwn(REFERENCE_METRICS, k);

/** A row's value as text with its unit. */
export function rowValue(metric: string, v: number | null | undefined): string {
	return isKey(metric) ? referenceValueText(metric, v) : v === null || v === undefined ? 'n.a.' : String(v);
}

/** The judged window of a row as text ("−22.5 dB … −17.5 dB", "≥ 95 %", "≤ 0.30 s"). */
export function rowRange(r: Pick<SoundCheckReference['rows'][number], 'metric' | 'range' | 'basis'>): string {
	const [lo, hi] = r.range;
	if (r.basis === 'no reference data') return t('No reference data');
	if (lo !== null && hi !== null) return `${rowValue(r.metric, lo)} … ${rowValue(r.metric, hi)}`;
	if (lo !== null) return `≥ ${rowValue(r.metric, lo)}`;
	if (hi !== null) return `≤ ${rowValue(r.metric, hi)}`;
	return '—';
}

/** The comparison's heading line. */
export function referenceHeading(ref: SoundCheckReference): string {
	const flagged = ref.counts.low + ref.counts.high;
	return flagged
		? t('{0}: {1} of {2} scored metrics differ', ref.name, flagged, ref.counts.scored)
		: t('{0}: all {1} scored metrics in range', ref.name, ref.counts.scored);
}

/** The profile file name an export saves. */
export function profileFileName(name: string): string {
	return `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'reference'}.sound-profile.json`;
}
