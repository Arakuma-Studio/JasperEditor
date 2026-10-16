// Proposal ghosts on the timeline (spec 12 §2.7 "Review", P3-R6 ghost part): what the proposal under review would
// create, change or delete in the active sequence, built from the session's preview (`preview.result`: one
// transaction per item, so every ghost belongs to an item) and placed with the timeline's layout. Pure: the model
// (`buildGhostModel`), its geometry (`ghostTrackRows`, `layoutGhosts`), the keyboard order, the why-line and the
// accessible names; `GhostLayer.tsx` draws it.
//
// - Created clips → ghost clips (fill `--pr-ghost-fill`, 1 px dashed `--pr-ghost-stroke`; an agent's proposal adds a
//   3 px `--pr-agent` bar on the left).
// - Created tracks → ghost track rows and headers ("A4 · SFX 1 (new)"), below the audio tracks / above the video ones.
// - Changed clips → the ghost at the new place over a `--pr-ghost-remove` wash on the clip as it is; deleted clips →
//   the wash only.
// - Created / changed sound cues → ghost cues on the Cue Seam.
// - Item states: pending dashed; accepted solid + ✓ (`--pr-success`); rejected 35 % opacity, hatched, ✕;
//   stale / invalid `--pr-warning` outline + "!". High contrast: 2 px solid strokes, the state by its glyph only.
import {
	type Clip,
	findTrack,
	formatTimecode,
	type ProjectDocument,
	type Rational,
	type Sequence,
	type SoundCue,
} from '@jasper/project';
import type { ProposalPreviewState, ReviewItem, ReviewItemState } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import {
	DEFAULT_AUDIO_PX,
	DEFAULT_VIDEO_PX,
	rowOf,
	type TrackAreaLayout,
} from '../panels/timeline/model/layout.ts';
import { frameToX, type Viewport } from '../panels/timeline/model/viewport.ts';
import { cuesOf } from '../sound/cues/model.ts';

/** States a ghost can show (applied items are in the document: no ghost). */
export type GhostState = Exclude<ReviewItemState, 'applied'>;

export type GhostClip = {
	key: string;
	itemId: string;
	clipId: string;
	trackId: string;
	region: 'video' | 'audio';
	start: number;
	duration: number;
	name: string;
	change: 'created' | 'changed';
	/** On a track the proposal creates. */
	newTrack: boolean;
	gainDb: number | null;
};

export type GhostRemoval = {
	key: string;
	itemId: string;
	clipId: string;
	trackId: string;
	start: number;
	duration: number;
	change: 'changed' | 'deleted';
};

export type GhostTrack = {
	itemId: string;
	trackId: string;
	region: 'video' | 'audio';
	/** Position among the tracks of its kind in the preview (0 = V1 / A1). */
	index: number;
	/** "A4". */
	label: string;
	name: string;
};

export type GhostCue = { itemId: string; cue: SoundCue; change: 'created' | 'changed' };

export type GhostItem = {
	id: string;
	label: string;
	state: GhostState;
	/** Frame span of everything the item shows (for Play and the keyboard order). */
	start: number;
	end: number;
	clips: number;
	tracks: number;
	cues: number;
	removals: number;
};

export type GhostModel = {
	proposalId: string;
	sequenceId: string;
	/** An agent wrote the proposal (the ghosts get the 3 px agent bar). */
	agent: boolean;
	clips: GhostClip[];
	removals: GhostRemoval[];
	tracks: GhostTrack[];
	cues: GhostCue[];
	/** Items with something to show in this sequence, in time order. */
	items: GhostItem[];
	byItem: Record<string, GhostItem>;
};

const GHOST_CUE_SUFFIX = '~ghost';
/** The id a changed cue's ghost is drawn under (the cue itself keeps its id on the seam). */
export const ghostCueId = (cueId: string) => `${cueId}${GHOST_CUE_SUFFIX}`;

function region(seq: Sequence, trackId: string): 'video' | 'audio' | null {
	const f = findTrack(seq, trackId);
	if (!f) return null;
	return f.track.kind === 'video' ? 'video' : f.track.kind === 'audio' ? 'audio' : null;
}

function clipGain(c: Clip): number | null {
	const g = (c as { gainDb?: unknown }).gainDb;
	return typeof g === 'number' && Number.isFinite(g) ? g : null;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The ghosts of the proposal under review in one sequence. `committed` is the session's document (what is there now),
 * `preview.result.document` what the proposal would make of it. Never throws: unreadable entities are skipped.
 */
export function buildGhostModel(input: {
	preview: ProposalPreviewState;
	committed: ProjectDocument;
	sequenceId: string;
	items: readonly ReviewItem[];
	agent: boolean;
}): GhostModel {
	const { preview, committed, sequenceId } = input;
	const out: GhostModel = {
		proposalId: preview.proposalId,
		sequenceId,
		agent: input.agent,
		clips: [],
		removals: [],
		tracks: [],
		cues: [],
		items: [],
		byItem: {},
	};
	const after = preview.result.document.sequences[sequenceId];
	const before = committed.sequences[sequenceId];
	if (!after || !before) return out;
	const stateOf = new Map(input.items.map((it) => [it.id, it]));
	const cuesAfter = new Map(cuesOf(after).map((c) => [c.id, c]));
	const cuesBefore = new Map(cuesOf(before).map((c) => [c.id, c]));
	const span = new Map<string, { start: number; end: number; c: number; t: number; q: number; r: number }>();
	const touch = (itemId: string, start: number, end: number, what: 'c' | 't' | 'q' | 'r') => {
		const s = span.get(itemId) ?? {
			start: Number.POSITIVE_INFINITY,
			end: Number.NEGATIVE_INFINITY,
			c: 0,
			t: 0,
			q: 0,
			r: 0,
		};
		if (finite(start)) s.start = Math.min(s.start, start);
		if (finite(end)) s.end = Math.max(s.end, end);
		s[what]++;
		span.set(itemId, s);
	};
	const ghostClip = (itemId: string, c: Clip, change: 'created' | 'changed') => {
		const r = region(after, c.trackId);
		if (!r || !finite(c.start) || !finite(c.duration) || c.duration <= 0) return;
		out.clips.push({
			key: `${itemId}:${c.id}`,
			itemId,
			clipId: c.id,
			trackId: c.trackId,
			region: r,
			start: c.start,
			duration: c.duration,
			name: typeof c.name === 'string' ? c.name : '',
			change,
			newTrack: !findTrack(before, c.trackId),
			gainDb: clipGain(c),
		});
		touch(itemId, c.start, c.start + c.duration, 'c');
	};
	const removal = (itemId: string, c: Clip, change: 'changed' | 'deleted') => {
		if (!finite(c.start) || !finite(c.duration)) return;
		out.removals.push({
			key: `${itemId}:${c.id}:rm`,
			itemId,
			clipId: c.id,
			trackId: c.trackId,
			start: c.start,
			duration: c.duration,
			change,
		});
		touch(itemId, c.start, c.start + c.duration, 'r');
	};
	for (const [itemId, g] of Object.entries(preview.result.items)) {
		for (const id of g.created) {
			const c = after.clips[id] as Clip | undefined;
			if (c && !before.clips[id]) {
				ghostClip(itemId, c, 'created');
				continue;
			}
			const tr = findTrack(after, id);
			if (tr && !findTrack(before, id) && (tr.track.kind === 'audio' || tr.track.kind === 'video')) {
				const label = `${tr.track.kind === 'video' ? 'V' : 'A'}${tr.index + 1}`;
				out.tracks.push({
					itemId,
					trackId: id,
					region: tr.track.kind,
					index: tr.index,
					label,
					name: typeof tr.track.name === 'string' ? tr.track.name : label,
				});
				touch(itemId, Number.NaN, Number.NaN, 't');
				continue;
			}
			const cue = cuesAfter.get(id);
			if (cue && !cuesBefore.has(id)) {
				out.cues.push({ itemId, cue, change: 'created' });
				touch(itemId, cue.frame, cue.frame, 'q');
			}
		}
		for (const id of g.changed) {
			const a = before.clips[id] as Clip | undefined;
			const b = after.clips[id] as Clip | undefined;
			if (a && b) {
				removal(itemId, a, 'changed');
				ghostClip(itemId, b, 'changed');
				continue;
			}
			const ca = cuesBefore.get(id);
			const cb = cuesAfter.get(id);
			if (ca && cb) {
				out.cues.push({ itemId, cue: { ...cb, id: ghostCueId(id) }, change: 'changed' });
				touch(itemId, cb.frame, cb.frame, 'q');
			}
		}
		for (const id of g.deleted) {
			const a = before.clips[id] as Clip | undefined;
			if (a) removal(itemId, a, 'deleted');
		}
	}
	out.tracks.sort((x, y) => (x.region === y.region ? x.index - y.index : x.region === 'video' ? -1 : 1));
	for (const [itemId, s] of span) {
		const it = stateOf.get(itemId);
		if (!it || it.state === 'applied') continue;
		const start = finite(s.start) ? s.start : 0;
		const end = finite(s.end) ? s.end : start;
		const item: GhostItem = {
			id: itemId,
			label: it.label,
			state: it.state,
			start,
			end,
			clips: s.c,
			tracks: s.t,
			cues: s.q,
			removals: s.r,
		};
		out.byItem[itemId] = item;
		out.items.push(item);
	}
	const order = new Map(input.items.map((it, i) => [it.id, i]));
	out.items.sort((a, b) => a.start - b.start || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const keep = (x: { itemId: string }) => !!out.byItem[x.itemId];
	out.clips = out.clips.filter(keep);
	out.removals = out.removals.filter(keep);
	out.tracks = out.tracks.filter(keep);
	out.cues = out.cues.filter(keep);
	return out;
}

export type GhostRow = { trackId: string; region: 'video' | 'audio'; y: number; height: number; track: GhostTrack };

/**
 * Rows of the tracks the proposal creates: below the last audio track (where the master row would start) and
 * above the top video track, in track order, at the default heights.
 */
export function ghostTrackRows(model: GhostModel, layout: TrackAreaLayout): GhostRow[] {
	const rows: GhostRow[] = [];
	const audio = model.tracks.filter((x) => x.region === 'audio');
	const lastA = layout.audio.rows.at(-1);
	let y = lastA ? lastA.y + lastA.height : layout.audio.top;
	for (const tr of audio) {
		rows.push({ trackId: tr.trackId, region: 'audio', y, height: DEFAULT_AUDIO_PX, track: tr });
		y += DEFAULT_AUDIO_PX;
	}
	const video = model.tracks.filter((x) => x.region === 'video');
	const topV = layout.video.rows[0];
	let vy = topV ? topV.y : layout.video.top + layout.video.height;
	for (const tr of video) {
		vy -= DEFAULT_VIDEO_PX;
		rows.push({ trackId: tr.trackId, region: 'video', y: vy, height: DEFAULT_VIDEO_PX, track: tr });
	}
	return rows;
}

export type GhostRect = { x: number; y: number; w: number; h: number; region: 'video' | 'audio' };

/** Where every ghost clip and wash is drawn (track-area coordinates), culled to the view; unplaceable ones are left out. */
export function layoutGhosts(
	model: GhostModel,
	layout: TrackAreaLayout,
	v: Viewport,
): {
	clips: (GhostClip & GhostRect)[];
	removals: (GhostRemoval & GhostRect)[];
	rows: GhostRow[];
} {
	const rows = ghostTrackRows(model, layout);
	const ghostRow = new Map(rows.map((r) => [r.trackId, r]));
	const place = (trackId: string, start: number, duration: number): GhostRect | null => {
		const row = rowOf(layout, trackId) ?? ghostRow.get(trackId) ?? null;
		if (!row) return null;
		const x = frameToX(v, start);
		const w = Math.max(2, duration * v.pxPerFrame);
		if (x + w < -8 || x > v.width + 8) return null;
		const r = 'kind' in row ? row.kind : row.region;
		return { x, y: row.y, w, h: row.height, region: r };
	};
	const clips: (GhostClip & GhostRect)[] = [];
	for (const c of model.clips) {
		const r = place(c.trackId, c.start, c.duration);
		if (r) clips.push({ ...c, ...r });
	}
	const removals: (GhostRemoval & GhostRect)[] = [];
	for (const c of model.removals) {
		const r = place(c.trackId, c.start, c.duration);
		if (r) removals.push({ ...c, ...r });
	}
	return { clips, removals, rows };
}

/** The next item in time order (keyboard), wrapping at neither end. */
export function neighbourItem(
	model: Pick<GhostModel, 'items'>,
	from: string | null,
	dir: 1 | -1 | 'first' | 'last',
	frame = 0,
): string | null {
	const items = model.items;
	if (!items.length) return null;
	if (dir === 'first') return items[0]!.id;
	if (dir === 'last') return items[items.length - 1]!.id;
	const i = from ? items.findIndex((x) => x.id === from) : -1;
	if (i < 0) {
		if (dir > 0) return (items.find((x) => x.start >= frame) ?? items[items.length - 1]!).id;
		return ([...items].reverse().find((x) => x.start <= frame) ?? items[0]!).id;
	}
	return items[Math.min(items.length - 1, Math.max(0, i + dir))]!.id;
}

/** "Accepted", "Stale", … */
export const GHOST_STATE_LABELS: Record<GhostState, string> = {
	pending: 'Pending',
	accepted: 'Accepted',
	rejected: 'Rejected',
	stale: 'Stale',
	invalid: 'Invalid',
};

/** The glyph each state is told by (never by colour alone); pending shows none outside high contrast. */
export function stateGlyph(state: GhostState, highContrast: boolean): string | null {
	if (state === 'accepted') return '✓';
	if (state === 'rejected') return '✕';
	if (state === 'stale' || state === 'invalid') return '!';
	return highContrast ? '○' : null;
}

/** How a ghost of an item in `state` is painted (CSS values; tokens only). */
export function ghostPaint(
	state: GhostState,
	opts: { highContrast: boolean; selected: boolean },
): {
	borderStyle: 'dashed' | 'solid';
	borderWidth: number;
	borderColor: string;
	opacity: number;
	hatch: boolean;
	glyphColor: string;
} {
	const warn = state === 'stale' || state === 'invalid';
	return {
		borderStyle: opts.highContrast || state !== 'pending' ? 'solid' : 'dashed',
		borderWidth: opts.highContrast || opts.selected ? 2 : 1,
		borderColor: warn ? 'var(--pr-warning)' : opts.selected ? 'var(--pr-focus-ring)' : 'var(--pr-ghost-stroke)',
		opacity: state === 'rejected' ? 0.35 : 1,
		hatch: state === 'rejected',
		glyphColor:
			state === 'accepted'
				? 'var(--pr-success)'
				: warn
					? 'var(--pr-warning)'
					: state === 'rejected'
						? 'var(--pr-text-strong)'
						: 'var(--pr-ghost-stroke)',
	};
}

const tcOf = (seq: Pick<Sequence, 'settings'>) => (f: number) =>
	formatTimecode(Math.max(0, Math.floor(f)), seq.settings.frameRate as Rational, {
		dropFrame: seq.settings.dropFrame,
		startFrames: seq.settings.startTimecodeFrames,
	});

function metaText(meta: unknown, key: 'why' | 'reason'): string | null {
	if (!meta || typeof meta !== 'object') return null;
	const v = (meta as Record<string, unknown>)[key];
	return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
}
function metaFacts(meta: unknown): string[] {
	if (!meta || typeof meta !== 'object') return [];
	const v = (meta as Record<string, unknown>).facts;
	return Array.isArray(v)
		? v
				.filter((x): x is string => typeof x === 'string' && !!x.trim())
				.slice(0, 4)
				.map((x) => x.trim().slice(0, 160))
		: [];
}

/**
 * The why-line of an item: the creator's reason (`meta.why`, else `meta.reason`), then facts computed from the
 * preview (what lands where: track, timecode, length, gain) and the creator's own `meta.facts`, then why it is stale.
 */
export function whyLines(
	item: Pick<ReviewItem, 'id' | 'meta' | 'state' | 'reason' | 'note'>,
	model: GhostModel,
	seq: Sequence,
	previewSeq: Sequence | undefined,
): { why: string | null; facts: string[]; problem: string | null } {
	const tc = tcOf(seq);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const facts: string[] = [];
	const lookup = previewSeq ?? seq;
	for (const c of model.clips) {
		if (c.itemId !== item.id || facts.length >= 3) continue;
		const where = trackDisplay(lookup, c.trackId, c.newTrack);
		const secs = fps > 0 ? (c.duration / fps).toFixed(2) : String(c.duration);
		const gain = c.gainDb !== null ? `, ${c.gainDb >= 0 ? '+' : ''}${c.gainDb.toFixed(1)} dB` : '';
		facts.push(
			c.change === 'created'
				? t('{0} on {1} at {2} ({3} s{4})', c.name || t('Clip'), where, tc(c.start), secs, gain)
				: t('{0} changes on {1} at {2}', c.name || t('Clip'), where, tc(c.start)),
		);
	}
	for (const r of model.removals)
		if (r.itemId === item.id && r.change === 'deleted' && facts.length < 4) {
			const name = (seq.clips[r.clipId] as Clip | undefined)?.name ?? t('Clip');
			facts.push(t('Removes {0} at {1}', name, tc(r.start)));
		}
	for (const tr of model.tracks)
		if (tr.itemId === item.id) facts.push(t('New track {0} · {1}', tr.label, tr.name));
	for (const q of model.cues)
		if (q.itemId === item.id && facts.length < 5) facts.push(t('Cue at {0}', tc(q.cue.frame)));
	facts.push(...metaFacts(item.meta));
	const problem =
		item.state === 'stale' || item.state === 'invalid'
			? (item.reason ?? (item.state === 'stale' ? t('Changed since it was proposed') : t('Does not apply')))
			: null;
	return { why: metaText(item.meta, 'why') ?? metaText(item.meta, 'reason'), facts, problem };
}

/** "A4", or "A4 · SFX 1 (new)" for a track the proposal creates. */
export function trackDisplay(seq: Sequence, trackId: string, isNew: boolean): string {
	const f = findTrack(seq, trackId);
	if (!f) return '?';
	const label = `${f.track.kind === 'video' ? 'V' : f.track.kind === 'audio' ? 'A' : 'C'}${f.index + 1}`;
	return isNew ? t('{0} · {1} (new)', label, f.track.name ?? label) : label;
}

/** The accessible name of an item's ghosts: "Proposed: <label>, accepted, A4 at 00:00:02:15. <why>". */
export function ghostAriaLabel(item: GhostItem, why: string | null, seq: Sequence): string {
	const tc = tcOf(seq);
	const state = GHOST_STATE_LABELS[item.state].toLowerCase();
	const base = t('Proposed: {0}, {1}, at {2}', item.label, state, tc(item.start));
	return why ? `${base}. ${why}` : base;
}
