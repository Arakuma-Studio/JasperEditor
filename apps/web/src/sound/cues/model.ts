// Cue Seam model (spec 12 §2.7 "Cue Seam", "Peak handle"; P2-R7): pure geometry, states, hit testing, keyboard order,
// accessible names, clip peaks and the conversions between cues, derived cues and markers. DOM-free and React-free so
// it is tested exactly; `CueSeam.tsx` draws what this computes, `PeakHandle.tsx` uses the peak math.
import {
	type ClipSfx,
	CUE_KINDS,
	type CueKind,
	type CueMix,
	type CueWeight,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isRemapped,
	type LibraryProvenance,
	type Marker,
	parseSfxRequest,
	type Rational,
	type Sequence,
	SOUND_DESIGN_LIMITS,
	SOUND_TYPES,
	type SoundCue,
	type SoundTypeId,
	type TimedClip,
} from '@jasper/project';
import { t, withoutContext } from '../../i18n/runtime.ts';
import { frameToX, type Viewport } from '../../panels/timeline/model/viewport.ts';
import { typeLabel } from '../model.ts';

/** Height of the Cue Seam lane (the widened video/audio divider). */
export const SEAM_PX = 18;
/** Glyph sizes by weight: hero 12 px, support 8 px, ambient small. */
export const GLYPH_PX: Readonly<Record<CueWeight, number>> = { hero: 12, support: 8, ambient: 6 };
/** Two heroes closer than this are a conflict (spec 12 §2.2 budgets never keep them; a user can). */
export const HERO_CONFLICT_SEC = 0.5;
/** Most glyphs drawn at once (heroes first): beyond it they overlap anyway at that zoom. */
export const MAX_RENDERED_CUES = 1500;
/** Pointer tolerance around a glyph (px). */
const HIT_SLOP_PX = 3;
/** Hidden below this clip size (spec: 24 px wide, 32 px high). */
export const PEAK_MIN_W = 24;
export const PEAK_MIN_H = 32;
/** Peak diamond size (px). */
export const PEAK_DIAMOND_PX = 7;

// ---------------------------------------------------------------------------------------------------------------
// Labels (the `*_LABELS` maps are translated by the i18n transform)

export const CUE_KIND_LABELS: Record<CueKind, string> = {
	cut: 'Cut [cue kind]',
	transition: 'Transition',
	move: 'Move',
	land: 'Land',
	appear: 'Appear',
	exit: 'Exit [cue kind]',
	emphasis: 'Emphasis',
	reveal: 'Reveal',
	beat: 'Beat',
	manual: 'Manual',
	silence: 'Silence',
};

/** A cue kind's label (homonyms carry a "[cue kind]" context in the catalogue). */
export const kindLabel = (k: string): string =>
	k in CUE_KIND_LABELS ? withoutContext(CUE_KIND_LABELS[k as CueKind]) : k;

export const CUE_WEIGHT_LABELS: Record<CueWeight, string> = {
	hero: 'Hero',
	support: 'Support',
	ambient: 'Ambient',
};

export const CUE_ALIGN_LABELS: Record<'peak' | 'start' | 'end', string> = {
	peak: 'Peak',
	start: 'Start',
	end: 'End',
};

// ---------------------------------------------------------------------------------------------------------------
// Reading cues

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The cues of a sequence sorted by frame, then id. Defensive: a value that is not a cue (a damaged document the
 * invariants have not repaired yet) is skipped, never thrown on.
 */
export function cuesOf(seq: Pick<Sequence, 'soundDesign'> | null | undefined): SoundCue[] {
	const raw = (seq as { soundDesign?: unknown } | null | undefined)?.soundDesign;
	if (!isRecord(raw) || !isRecord(raw.cues)) return [];
	const out: SoundCue[] = [];
	for (const [key, c] of Object.entries(raw.cues)) {
		if (!isRecord(c) || !fin(c.frame) || typeof c.id !== 'string' || c.id !== key) continue;
		out.push(c as unknown as SoundCue);
	}
	return out.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a cue has clips (with the sequence's clips: only clips that still exist count; dangling ids are ignored). */
export const isFilled = (c: SoundCue, clips?: Readonly<Record<string, unknown>>): boolean =>
	(c.placedClipIds ?? []).some((id) => !clips || Object.hasOwn(clips, id));

/** Placed clips of a cue that still exist in the sequence. */
export function placedClips(seq: Pick<Sequence, 'clips'>, c: SoundCue): string[] {
	return (c.placedClipIds ?? []).filter((id) => Object.hasOwn(seq.clips, id));
}

/** Ids of hero cues with another hero closer than 0.5 s (spec 12 §2.7 conflict state). */
export function heroConflicts(cues: readonly SoundCue[], rate: Rational): Set<string> {
	const fps = rate.den > 0 ? rate.num / rate.den : 0;
	const out = new Set<string>();
	if (!(fps > 0)) return out;
	const limit = HERO_CONFLICT_SEC * fps;
	const heroes = cues.filter((c) => c.weight === 'hero' && !c.muted);
	for (let i = 1; i < heroes.length; i++) {
		const a = heroes[i - 1]!;
		const b = heroes[i]!;
		if (b.frame - a.frame < limit) {
			out.add(a.id);
			out.add(b.id);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Glyphs

export type GlyphShape =
	| 'bar'
	| 'diamond'
	| 'triangle-right'
	| 'triangle-down'
	| 'circle'
	| 'triangle-up'
	| 'star'
	| 'square'
	| 'plus'
	| 'pentagon'
	| 'dash';

/** One glyph per kind (spec: cut ▮, move ▸, land ▼, appear ○; the others chosen so no two kinds share a shape). */
export const KIND_GLYPH: Readonly<Record<CueKind, GlyphShape>> = {
	cut: 'bar',
	transition: 'diamond',
	move: 'triangle-right',
	land: 'triangle-down',
	appear: 'circle',
	exit: 'triangle-up',
	emphasis: 'star',
	reveal: 'square',
	beat: 'plus',
	manual: 'pentagon',
	silence: 'dash',
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG path of a glyph of `size` px centred on (0, 0). Closed shapes for every kind but `plus` and `dash`. */
export function glyphPath(shape: GlyphShape, size: number): string {
	const h = size / 2;
	const p = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' L')} Z`;
	switch (shape) {
		case 'bar':
			return p([
				[-h * 0.45, -h],
				[h * 0.45, -h],
				[h * 0.45, h],
				[-h * 0.45, h],
			]);
		case 'diamond':
			return p([
				[0, -h],
				[h, 0],
				[0, h],
				[-h, 0],
			]);
		case 'triangle-right':
			return p([
				[-h * 0.8, -h],
				[h, 0],
				[-h * 0.8, h],
			]);
		case 'triangle-down':
			return p([
				[-h, -h * 0.8],
				[h, -h * 0.8],
				[0, h],
			]);
		case 'triangle-up':
			return p([
				[0, -h],
				[h, h * 0.8],
				[-h, h * 0.8],
			]);
		case 'circle':
			return `M${r2(-h)},0 A${r2(h)},${r2(h)} 0 1,0 ${r2(h)},0 A${r2(h)},${r2(h)} 0 1,0 ${r2(-h)},0 Z`;
		case 'square':
			return p([
				[-h * 0.8, -h * 0.8],
				[h * 0.8, -h * 0.8],
				[h * 0.8, h * 0.8],
				[-h * 0.8, h * 0.8],
			]);
		case 'star': {
			const pts: [number, number][] = [];
			for (let i = 0; i < 8; i++) {
				const a = (Math.PI / 4) * i - Math.PI / 2;
				const r = i % 2 === 0 ? h : h * 0.42;
				pts.push([Math.cos(a) * r, Math.sin(a) * r]);
			}
			return p(pts);
		}
		case 'pentagon':
			return p([
				[-h * 0.8, -h],
				[h * 0.8, -h],
				[h * 0.8, h * 0.25],
				[0, h],
				[-h * 0.8, h * 0.25],
			]);
		case 'plus':
			return `M${r2(-h)},0 L${r2(h)},0 M0,${r2(-h)} L0,${r2(h)}`;
		case 'dash':
			return `M${r2(-h)},0 L${r2(h)},0`;
	}
}

/** Open glyphs are strokes only (they have no inside to fill). */
export const openGlyph = (shape: GlyphShape): boolean => shape === 'plus' || shape === 'dash';

export type CueVisualState = {
	filled: boolean;
	/** Authored by an agent (`source: 'agent'`). */
	agent: boolean;
	/** A proposal's cue (P3), drawn but not stored. */
	ghost: boolean;
	/** Hero closer than 0.5 s to another hero. */
	conflict: boolean;
	muted: boolean;
	selected: boolean;
};

/** How a glyph is painted. State is never colour alone: dash patterns, fill, underline and connector differ too. */
export type GlyphPaint = {
	stroke: string;
	fill: string;
	strokeWidth: number;
	/** SVG dash array, or null for solid. */
	dash: string | null;
	opacity: number;
	/** `--pr-warning` underline (conflict). */
	underline: boolean;
	/** Agent mark: a small tick above the glyph. */
	agentTick: boolean;
	/** Diagonal strike through a muted cue. */
	strike: boolean;
};

export function glyphPaint(weight: CueWeight, shape: GlyphShape, s: CueVisualState): GlyphPaint {
	const heavy = weight === 'hero';
	const open = openGlyph(shape);
	const base: GlyphPaint = {
		stroke: 'var(--pr-cue)',
		fill: 'none',
		strokeWidth: heavy ? 2 : weight === 'support' ? 1.5 : 1.25,
		dash: null,
		opacity: s.muted ? 0.45 : 1,
		underline: s.conflict,
		agentTick: s.agent,
		strike: s.muted,
	};
	if (s.ghost)
		return {
			...base,
			stroke: 'var(--pr-ghost-stroke)',
			fill: open ? 'none' : 'var(--pr-ghost-fill)',
			dash: '2 1.5',
		};
	if (!s.filled)
		return {
			...base,
			stroke: s.agent ? 'var(--pr-agent)' : 'var(--pr-cue-unfilled)',
			// unfilled: dashed; agent: dotted (shape, not colour alone)
			dash: s.agent ? '1 1.5' : '3 1.5',
		};
	// filled: solid; a hero is a filled shape, support and ambient outlines
	return {
		...base,
		stroke: s.agent ? 'var(--pr-agent)' : heavy ? 'var(--pr-cue-hero)' : 'var(--pr-cue)',
		fill: heavy && !open ? 'var(--pr-cue-hero)' : 'none',
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Layout and hit testing

export type SpanPx = { x0: number; x1: number };

export type CueGeom = {
	id: string;
	frame: number;
	x: number;
	size: number;
	shape: GlyphShape;
	weight: CueWeight;
	state: CueVisualState;
	/** The picture event's span (`window`), for windowed moves/transitions: a tail through the glyph. */
	window: SpanPx | null;
	/** High-pass build before the cue (P4 data): a rising wedge. */
	build: SpanPx | null;
	/** Music dip before the cue: a bar along the top. */
	stopBefore: SpanPx | null;
	/**
	 * Written into the mix (`soundDesign.mix.cues`, Phase 4: the span is where it was written) vs only stored on the cue
	 * (drawn dashed: an unfilled cue, no music under it, a muted cue).
	 */
	buildWritten: boolean;
	stopBeforeWritten: boolean;
};

const fpsOf = (rate: Rational) => (rate.den > 0 && rate.num > 0 ? rate.num / rate.den : 0);

/** Glyph geometry of the cues in view (± one glyph), heroes kept first when there are more than the cap. */
export function layoutCues(
	cues: readonly SoundCue[],
	v: Viewport,
	opts: {
		rate: Rational;
		selected: ReadonlySet<string>;
		conflicts?: ReadonlySet<string>;
		ghosts?: ReadonlySet<string>;
		/** The sequence's clips (dangling `placedClipIds` do not make a cue filled). */
		clips?: Readonly<Record<string, unknown>>;
		/** What stop-before / build wrote per cue (`soundDesign.mix.cues`, Phase 4). */
		mix?: Readonly<Record<string, CueMix>>;
		max?: number;
	},
): CueGeom[] {
	const fps = fpsOf(opts.rate);
	const margin = 16;
	const out: CueGeom[] = [];
	for (const c of cues) {
		const x = frameToX(v, c.frame);
		const span = (start: number, end: number): SpanPx => ({ x0: frameToX(v, start), x1: frameToX(v, end) });
		const window = c.window && c.window.end > c.window.start ? span(c.window.start, c.window.end) : null;
		const secSpan = (sec: number | undefined, at = c.frame) =>
			fps > 0 && fin(sec) && sec > 0 && fin(at) ? span(at - sec * fps, at) : null;
		const rec = opts.mix && Object.hasOwn(opts.mix, c.id) ? opts.mix[c.id] : undefined;
		const buildW = rec?.build ? secSpan(rec.build.seconds, rec.build.frame) : null;
		const stopW = rec?.stopBefore ? secSpan(rec.stopBefore.seconds, rec.stopBefore.frame) : null;
		const build = buildW ?? secSpan(c.build?.seconds);
		const stopBefore = stopW ?? secSpan(c.stopBefore?.seconds);
		const left = Math.min(x, window?.x0 ?? x, build?.x0 ?? x, stopBefore?.x0 ?? x);
		const right = Math.max(x, window?.x1 ?? x);
		if (right < -margin || left > v.width + margin) continue;
		const weight: CueWeight = c.weight in GLYPH_PX ? c.weight : 'support';
		const shape = KIND_GLYPH[c.kind as CueKind] ?? 'pentagon';
		out.push({
			id: c.id,
			frame: c.frame,
			x,
			size: GLYPH_PX[weight],
			shape,
			weight,
			state: {
				filled: isFilled(c, opts.clips),
				agent: c.source === 'agent',
				ghost: !!opts.ghosts?.has(c.id),
				conflict: !!opts.conflicts?.has(c.id),
				muted: !!c.muted,
				selected: opts.selected.has(c.id),
			},
			window,
			build,
			stopBefore,
			buildWritten: !!buildW,
			stopBeforeWritten: !!stopW,
		});
	}
	const max = opts.max ?? MAX_RENDERED_CUES;
	if (out.length <= max) return out;
	// Selected cues first, then heroes, support, ambient. The tier that does not fit whole is thinned evenly over the
	// view (every k-th cue in frame order), so the end of a zoomed-out sequence keeps its share instead of losing
	// every cue of that tier past the first `max`.
	const tiers: CueGeom[][] = [[], [], [], []];
	const rank: Record<CueWeight, number> = { hero: 1, support: 2, ambient: 3 };
	for (const g of out) tiers[g.state.selected ? 0 : rank[g.weight]]!.push(g);
	const kept = new Set<string>();
	for (const tier of tiers) {
		const room = max - kept.size;
		if (room <= 0) break;
		if (tier.length <= room) for (const g of tier) kept.add(g.id);
		else for (let i = 0; i < room; i++) kept.add(tier[Math.floor((i * tier.length) / room)]!.id);
	}
	return out.filter((g) => kept.has(g.id));
}

/**
 * The cue under the pointer (lane-local x): the nearest glyph whose box plus a slop contains x; on a tie the heavier
 * (hero over support over ambient), then the selected one. Null when none.
 */
export function hitCue(geoms: readonly CueGeom[], x: number): string | null {
	if (!Number.isFinite(x)) return null;
	const rank: Record<CueWeight, number> = { hero: 0, support: 1, ambient: 2 };
	let best: CueGeom | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const g of geoms) {
		const d = Math.abs(g.x - x);
		if (d > g.size / 2 + HIT_SLOP_PX) continue;
		const better =
			!best ||
			d < bestD - 0.5 ||
			(Math.abs(d - bestD) <= 0.5 &&
				(rank[g.weight] < rank[best.weight] ||
					(rank[g.weight] === rank[best.weight] && g.state.selected && !best.state.selected)));
		if (better) {
			best = g;
			bestD = d;
		}
	}
	return best?.id ?? null;
}

/** Keyboard order (Left/Right, Home/End): by frame then id; from nothing, Right/Home is the first cue at or after `frame`. */
export function neighbourCue(
	cues: readonly SoundCue[],
	fromId: string | null,
	dir: 1 | -1 | 'first' | 'last',
	frame = 0,
): string | null {
	if (cues.length === 0) return null;
	if (dir === 'first') return cues[0]!.id;
	if (dir === 'last') return cues[cues.length - 1]!.id;
	const i = fromId ? cues.findIndex((c) => c.id === fromId) : -1;
	if (i < 0) {
		if (dir > 0) return (cues.find((c) => c.frame >= frame) ?? cues[cues.length - 1]!).id;
		return ([...cues].reverse().find((c) => c.frame <= frame) ?? cues[0]!).id;
	}
	const j = Math.min(cues.length - 1, Math.max(0, i + dir));
	return cues[j]!.id;
}

/** Playhead navigation (Next/Previous Cue): the first cue strictly after / before `frame`. */
export function cueAfter(cues: readonly SoundCue[], frame: number, dir: 1 | -1): SoundCue | null {
	if (dir > 0) return cues.find((c) => c.frame > frame) ?? null;
	for (let i = cues.length - 1; i >= 0; i--) if (cues[i]!.frame < frame) return cues[i]!;
	return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Accessible names

/** "Hero Land cue at 00:00:04:02, unfilled, Scale ease-out on V2 'Logo'" (the reason or label last). */
export function cueAriaLabel(
	c: SoundCue,
	opts: {
		timecode: string;
		placedNames?: readonly string[];
		conflict?: boolean;
		clips?: Readonly<Record<string, unknown>>;
	},
): string {
	const weight = CUE_WEIGHT_LABELS[c.weight] ?? c.weight;
	const kind = kindLabel(c.kind);
	const parts = [t('{0} {1} cue at {2}', weight, kind, opts.timecode)];
	const names = opts.placedNames?.filter(Boolean) ?? [];
	parts.push(
		isFilled(c, opts.clips)
			? names.length
				? t('filled with {0}', names.join(' + '))
				: t('filled')
			: t('unfilled'),
	);
	if (c.source === 'agent') parts.push(t('agent-authored'));
	if (c.muted) parts.push(t('muted'));
	if (opts.conflict) parts.push(t('conflicts with another hero cue'));
	const why = (c.label || c.reason || '').trim();
	if (why) parts.push(why.length > 160 ? `${why.slice(0, 157)}…` : why);
	return parts.join(', ');
}

/** Tooltip lines of a cue (name, types, reason, how to fill). */
export function cueTooltip(
	c: SoundCue,
	timecode: string,
	clips?: Readonly<Record<string, unknown>>,
): string[] {
	const lines = [
		t('{0} {1} cue at {2}', CUE_WEIGHT_LABELS[c.weight] ?? c.weight, kindLabel(c.kind), timecode),
	];
	if (c.label) lines.push(c.label);
	if (c.reason && c.reason !== c.label)
		lines.push(c.reason.length > 300 ? `${c.reason.slice(0, 297)}…` : c.reason);
	if (c.types?.length) lines.push(t('Sounds: {0}', c.types.slice(0, 6).map(typeLabel).join(', ')));
	lines.push(
		isFilled(c, clips) ? t('Filled') : t('Unfilled: double-click or Enter to fill from the Sound Library'),
	);
	return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Clip peaks (peak handle, peak snapping, connectors)

type PeakClip = Pick<TimedClip, 'start' | 'duration' | 'sourceIn' | 'speed'> & {
	kind: string;
	mediaId?: string;
	sfx?: ClipSfx;
};
type PeakMedia = { library?: LibraryProvenance | null } | undefined;

/** Library provenance of a media (lenient: only what the peak needs). */
function libraryOf(media: PeakMedia): LibraryProvenance | null {
	const lib = (media as { library?: unknown } | undefined)?.library;
	return isRecord(lib) ? (lib as unknown as LibraryProvenance) : null;
}

/**
 * The peak of an audio clip's sound as content flicks from the media start: the clip's own placement when it aligned
 * the peak (or a Shift-drag override), else the media's library descriptors. Null when neither is known.
 */
export function clipPeakFlicks(
	clip: PeakClip,
	media: PeakMedia,
): { flicks: number; override: boolean } | null {
	if (clip.kind !== 'audio') return null;
	const pl = clip.sfx?.placement;
	if (pl && pl.align === 'peak' && fin(pl.peakFlicks) && pl.peakFlicks >= 0)
		return { flicks: pl.peakFlicks, override: true };
	const peakSec = libraryOf(media)?.descriptors?.peakSec;
	if (fin(peakSec) && peakSec >= 0)
		return { flicks: Math.round(peakSec * FLICKS_PER_SECOND), override: false };
	return null;
}

/**
 * The sequence frame (fractional) the clip's peak plays at, or null (no peak, a reversed or time-remapped clip, or a
 * peak outside the part of the media the clip uses).
 */
export function clipPeakFrame(clip: PeakClip, media: PeakMedia, rate: Rational): number | null {
	const pk = clipPeakFlicks(clip, media);
	if (!pk) return null;
	return peakFrameOf(clip, pk.flicks, rate);
}

/** The sequence frame content time `flicks` of the clip plays at (fractional), or null outside the clip. */
export function peakFrameOf(clip: PeakClip, flicks: number, rate: Rational): number | null {
	if (clip.speed?.reverse || isRemapped(clip as TimedClip)) return null;
	const F = flicksPerFrame(rate);
	const sp = clip.speed?.rate ?? 1;
	if (!(F > 0) || !(sp > 0) || !fin(clip.sourceIn)) return null;
	const rel = (flicks - clip.sourceIn) / (F * sp);
	if (!Number.isFinite(rel) || rel < 0 || rel > clip.duration) return null;
	return clip.start + rel;
}

/** Content flicks at a sequence frame (inverse of `peakFrameOf`), clamped to the clip, whole flicks. */
export function contentFlicksAt(clip: PeakClip, frame: number, rate: Rational): number {
	const F = flicksPerFrame(rate);
	const sp = clip.speed?.rate ?? 1;
	const rel = Math.min(clip.duration, Math.max(0, frame - clip.start));
	return Math.max(0, Math.round(clip.sourceIn + rel * F * sp));
}

/** Seconds of the peak into the sound itself (the lead silence the engine padded is not part of the sound). */
export function peakSecondsIntoSound(flicks: number, media: PeakMedia): number {
	const lead = libraryOf(media)?.leadSilenceSec;
	return Math.max(0, flicks / FLICKS_PER_SECOND - (fin(lead) ? lead : 0));
}

export type PeakHandleGeom = { x: number; visible: boolean };

/** Body-local x of the peak line, hidden when the clip is too small to hold a handle. */
export function peakHandleGeom(
	clip: PeakClip,
	peakFrame: number | null,
	box: { w: number; height: number; pxPerFrame: number },
): PeakHandleGeom | null {
	if (peakFrame === null) return null;
	const x = (peakFrame - clip.start) * box.pxPerFrame;
	return { x, visible: box.w >= PEAK_MIN_W && box.height >= PEAK_MIN_H && x >= 0 && x <= box.w };
}

// ---------------------------------------------------------------------------------------------------------------
// Conversions

/** What `soundCue.add` takes for one cue (the command's `SoundCueInput`). */
export type CueInput = Omit<SoundCue, 'id' | 'placedClipIds'>;

const clampText = (s: string | undefined, max: number) =>
	s === undefined ? undefined : s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** A marker as a cue: `sfx: <type>[+<type>]` markers give their types and the first type's weight and align. */
export function markerToCueInput(
	m: Pick<Marker, 'frame' | 'duration' | 'name' | 'comment' | 'type'>,
): CueInput {
	const req =
		parseSfxRequest(m.name) ?? (m.type === 'agent-note' ? parseSfxRequest(m.comment) : null) ?? null;
	const types = (req?.types ?? []).slice(0, SOUND_DESIGN_LIMITS.types) as SoundTypeId[];
	const first = types[0] ? SOUND_TYPES[types[0]] : undefined;
	const label = req ? undefined : (m.name || m.comment || '').trim() || undefined;
	const dur = Number.isInteger(m.duration) && m.duration > 0 ? m.duration : 0;
	return {
		frame: Math.max(0, Math.round(m.frame)),
		kind: 'manual',
		weight: first?.defaultWeight ?? 'support',
		...(types.length ? { types } : {}),
		...(first ? { align: first.defaultAlign } : {}),
		...(label ? { label: clampText(label, SOUND_DESIGN_LIMITS.label) } : {}),
		source: 'marker',
		anchor: null,
		reason: clampText(
			req ? t('Marker “{0}”', m.name) : t('Converted from a marker'),
			SOUND_DESIGN_LIMITS.reason,
		),
		...(dur ? { window: { start: m.frame, end: m.frame + dur } } : {}),
	};
}

/** The marker a cue converts to: `sfx: whoosh+swish` (parsed back by `parseSfxRequest`), the reason as comment. */
export function cueToMarker(c: SoundCue): { frame: number; name: string; comment: string; duration: number } {
	const types = (c.types ?? []).filter((x) => typeof x === 'string' && /^[a-z][a-z0-9-]*$/.test(x));
	const name = types.length ? `sfx: ${types.slice(0, 8).join('+')}` : c.label?.trim() || `sfx: ${c.kind}`;
	const comment = [c.label && types.length ? c.label : '', c.reason ?? ''].filter(Boolean).join('\n');
	return { frame: c.frame, name: name.slice(0, 200), comment: comment.slice(0, 2000), duration: 0 };
}

/** Markers that convert to cues: names starting `sfx:` plus the selected ones (deduplicated, in frame order). */
export function markersToConvert(markers: readonly Marker[], selected: readonly string[]): Marker[] {
	const sel = new Set(selected);
	return markers
		.filter((m) => sel.has(m.id) || parseSfxRequest(m.name) !== null)
		.sort((a, b) => a.frame - b.frame);
}

/** Whether a derived cue duplicates a stored one (same kind within 2 frames). */
export function duplicatesStored(d: { frame: number; kind: string }, stored: readonly SoundCue[]): boolean {
	return stored.some((c) => c.kind === d.kind && Math.abs(c.frame - d.frame) <= 2);
}

/** The kinds a user can tag a cue with (Visual Tag ▸). */
export const VISUAL_TAGS: readonly CueKind[] = CUE_KINDS;
