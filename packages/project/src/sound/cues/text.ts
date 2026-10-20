// Text animation (spec 12 §2.2): In/Out presets (`resolveTextAnimationWindows`) give an `appear` / `exit` cue at the
// start of their window; typewriter presets give one key per typed unit, and Range Selectors with animated
// Start/End/Offset (AE-style animators) one per revealed unit. Those patterns are thinned to ≤ 12 per second and
// ≤ 40 per clip (evenly) and share a group id, so a budget counts them as one cue.
// Typing (spec 12 P6-E10, `typingChoice`): a character pattern typed faster than 25 units per second gets one key per
// word start instead (thinning a fast run to 12/s reads as random keys); `CueContext.typing` forces keys, words or
// silence (no typing cues).
import { clipEnd } from '../../derive/index.ts';
import { isAnimated } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { clipContentTime, resolveLayerProps } from '../../render/scene.ts';
import type { Animatable } from '../../schema/common.ts';
import type { Clip, TextClip } from '../../schema/sequence.ts';
import type { TextAnimatorGroup, TextRangeSelector } from '../../schema/text-animators.ts';
import { getTextAnimationSpec, resolveTextAnimationWindows } from '../../text-animations.ts';
import { rangeParams } from '../../text-animators/evaluate.ts';
import { rangeValue, unitCount } from '../../text-animators/selectors.ts';
import { typingChoice } from '../grammar.ts';
import type { SoundTypeId } from '../taxonomy.ts';
import { textUnitCount, typewriterOffsets, typewriterScheduleMs, wordStartUnits } from '../text-events.ts';
import type { CueCandidate, DerivedCueKind } from './types.ts';
import {
	type CueContext,
	candidate,
	clamp01,
	clipName,
	inRange,
	label,
	panOfX,
	secs,
	sortedClips,
	textUnitCounts,
} from './util.ts';

/** Pattern caps (spec 12 §2.2): at most 12 units per second and 40 per clip. */
export const PATTERN_MAX_PER_SEC = 12;
export const PATTERN_MAX_PER_CLIP = 40;
/** Most unit × frame evaluations of one Range Selector (beyond: frames are sampled with a stride). */
const MAX_SELECTOR_WORK = 2_000_000;

const PRESET_TYPES: Record<string, { in: SoundTypeId[]; out: SoundTypeId[]; conf: number }> = {
	Fade: { in: ['ui', 'shimmer', 'swish'], out: ['swish', 'ui'], conf: 0.4 },
	Slide: { in: ['swish', 'whoosh', 'ui'], out: ['swish', 'whoosh'], conf: 0.65 },
	Pop: { in: ['pop', 'ui', 'swish'], out: ['pop', 'swish'], conf: 0.7 },
	Blur: { in: ['whoosh', 'shimmer', 'swish'], out: ['whoosh', 'swish'], conf: 0.5 },
	Tracking: { in: ['whoosh', 'shimmer', 'swish'], out: ['whoosh', 'swish'], conf: 0.5 },
	Reveal: { in: ['swish', 'ui', 'whoosh'], out: ['swish', 'whoosh'], conf: 0.6 },
	Rotate: { in: ['swish', 'whoosh'], out: ['swish', 'whoosh'], conf: 0.6 },
	Drop: { in: ['swish', 'tap', 'thump'], out: ['swish', 'whoosh'], conf: 0.6 },
};
const UNKNOWN_PRESET = {
	in: ['ui', 'swish'] as SoundTypeId[],
	out: ['swish', 'ui'] as SoundTypeId[],
	conf: 0.4,
};

/**
 * Thins sorted pattern frames: drops repeats and frames closer than `fps / 12` to the last kept one (≤ 12 per
 * second; `minSpacingFrames` instead when given: one key per word start keeps every word on its own frame), then
 * keeps at most 40 evenly spread. Returns indices into `frames`.
 */
export function thinPattern(frames: readonly number[], fps: number, minSpacingFrames?: number): number[] {
	const spacing =
		minSpacingFrames !== undefined && Number.isFinite(minSpacingFrames)
			? Math.max(1, minSpacingFrames)
			: fps / PATTERN_MAX_PER_SEC;
	const kept: number[] = [];
	let last = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		if (!Number.isFinite(f) || f - last < spacing - 1e-9) continue;
		kept.push(i);
		last = f;
	}
	if (kept.length <= PATTERN_MAX_PER_CLIP) return kept;
	const out: number[] = [];
	for (let j = 0; j < PATTERN_MAX_PER_CLIP; j++)
		out.push(kept[Math.round((j * (kept.length - 1)) / (PATTERN_MAX_PER_CLIP - 1))]!);
	return out;
}

export { typewriterOffsets };

export function deriveTextCues(ctx: CueContext): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const shown = new Set(ctx.videoTracks.map((v) => v.track.id));
	for (const c of sortedClips(ctx)) {
		if (c.kind !== 'text' || c.enabled === false || !shown.has(c.trackId) || !inRange(ctx, c)) continue;
		textClipCues(ctx, c as TextClip, cues);
	}
	return cues;
}

/**
 * The text source's cue candidates of one text clip (no track, enabled or range filter): what `deriveTextCues` gives for
 * it. `resolveCueAnchor` re-derives a clip with it so a Range Selector unit anchor resolves to the same frame.
 */
export function textClipCueCandidates(ctx: CueContext, c: Clip): CueCandidate[] {
	if (c.kind !== 'text') return [];
	const cues: CueCandidate[] = [];
	textClipCues(ctx, c as TextClip, cues);
	return cues;
}

function textClipCues(ctx: CueContext, c: TextClip, cues: CueCandidate[]): void {
	const where = `on ${label(ctx, c.trackId)} ${clipName(c)}`;
	const geo = layerGeometry(ctx, c);
	const text = typeof c.content?.text === 'string' ? c.content.text : '';
	const counts = textUnitCounts(text);
	const w = resolveTextAnimationWindows(c);
	for (const side of ['in', 'out'] as const) {
		const a = w[side];
		if (!a || a.frames <= 0) continue;
		const start = side === 'in' ? c.start : clipEnd(c) - a.frames;
		const window = { start, end: start + a.frames };
		const spec = getTextAnimationSpec(a.preset, a.version);
		const kind: DerivedCueKind = side === 'in' ? 'appear' : 'exit';
		if (a.preset === 'typewriter') {
			const unit = a.params.unit === 'word' ? 'word' : 'char';
			const n = textUnitCount(text, unit);
			const offsets = typewriterOffsets(n, a.frames, ctx.fps, a.params, side);
			const frames = offsets.map((o) => start + o);
			// typed units per second (the schedule's slot); words are a word per unit already
			const slotMs = n > 0 ? typewriterScheduleMs(n, (a.frames * 1000) / ctx.fps, a.params).slot : 0;
			const perSec = slotMs > 0 ? 1000 / slotMs : 0;
			const choice = typingChoice(ctx.typing, perSec);
			if (choice === 'silent') continue;
			const byWord = choice === 'words' && unit === 'char';
			const starts = byWord ? new Set(wordStartUnits(text, 'char')) : null;
			const units = frames.map((_, i) => i).filter((i) => !starts || starts.has(i));
			// one key per word replaces the 12/s thinning (no two words on one frame)
			const keep = thinPattern(
				units.map((i) => frames[i]!),
				ctx.fps,
				byWord ? 1 : undefined,
			).map((k) => units[k]!);
			const group = `text:${c.id}:${side}:typewriter`;
			const how = byWord
				? `one key per word: ${Math.round(perSec)} typed/s`
				: `${keep.length} keys over ${secs(ctx, a.frames)}`;
			for (const i of keep)
				cues.push(
					candidate('text', {
						key: `${group}:${i}`,
						frame: frames[i]!,
						kind,
						weight: 'support',
						types: unit === 'char' ? ['key', 'tick', 'click'] : ['key', 'tick'],
						align: 'peak',
						pan: geo.pan,
						anchor: { type: 'text', clipId: c.id, side, unit: i },
						confidence: 0.75,
						reason: `Typewriter ${side === 'in' ? 'types' : 'deletes'} ${unit} ${i + 1}/${n} ${where} (${how})`,
						window,
						group,
						size: geo.area,
					}),
				);
			continue;
		}
		const t = (spec && PRESET_TYPES[spec.category]) || UNKNOWN_PRESET;
		const name = spec?.label ?? a.preset;
		cues.push(
			candidate('text', {
				key: `text:${c.id}:${side}`,
				frame: start,
				kind,
				weight: 'support',
				types: side === 'in' ? t.in : t.out,
				align: 'peak',
				pan: geo.pan,
				anchor: { type: 'text', clipId: c.id, side },
				confidence: side === 'in' ? t.conf : t.conf * 0.75,
				reason: `Text ${side === 'in' ? 'animates in' : 'animates out'} (${name}, ${secs(ctx, a.frames)}) ${where}`,
				window,
				size: geo.area,
			}),
		);
	}
	const groups = Array.isArray(c.animators) ? (c.animators as TextAnimatorGroup[]) : [];
	for (const g of groups) {
		if (!g || g.enabled === false || !Array.isArray(g.selectors)) continue;
		for (const sel of g.selectors)
			if (sel?.kind === 'range' && sel.enabled !== false)
				selectorCues(ctx, c, g, sel, counts, geo, where, cues);
	}
}

/** Size and pan of a text layer at its first frame. */
function layerGeometry(ctx: CueContext, c: Clip): { area: number; pan: number } {
	try {
		const box = intrinsicBoxOf({ clip: c, doc: ctx.doc, seq: ctx.seq });
		const vc = c as TextClip;
		const p = resolveLayerProps(
			{ transform: vc.transform, opacity: vc.opacity, intrinsicBox: box, effects: [] },
			clipContentTime(c as never, c.start, ctx.rate),
		);
		const area = clamp01((p.bounds.width * p.bounds.height) / (ctx.width * ctx.height));
		return { area: Math.max(area, 0.02), pan: panOfX(ctx, p.bounds.x + p.bounds.width / 2) };
	} catch {
		return { area: 0.05, pan: 0 };
	}
}

function selectorCues(
	ctx: CueContext,
	c: TextClip,
	g: TextAnimatorGroup,
	sel: TextRangeSelector,
	counts: ReturnType<typeof textUnitCounts>,
	geo: { area: number; pan: number },
	where: string,
	cues: CueCandidate[],
): void {
	const anims = [sel.start, sel.end, sel.offset].filter(
		(a): a is Animatable<number> => !!a && Array.isArray(a.keyframes) && isAnimated(a),
	);
	if (!anims.length) return;
	const n = Math.min(1000, unitCount(sel.basedOn, counts));
	if (n < 1) return;
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const a of anims)
		for (const k of a.keyframes)
			if (Number.isFinite(k?.time)) {
				lo = Math.min(lo, k.time);
				hi = Math.max(hi, k.time);
			}
	const step = ctx.F * (c.speed?.rate > 0 ? c.speed.rate : 1);
	let i0 = 0;
	let i1 = c.duration;
	if (lo <= hi && !anims.some((a) => a.expression?.enabled)) {
		i0 = Math.floor((lo - c.sourceIn) / step) - 1;
		i1 = Math.ceil((hi - c.sourceIn) / step) + 2;
		if (c.speed?.reverse) [i0, i1] = [c.duration - i1, c.duration - i0];
	}
	i0 = Math.max(0, i0);
	i1 = Math.min(c.duration, i1, i0 + 20_000);
	if (i1 - i0 < 2) return;
	const stride = Math.max(1, Math.ceil(((i1 - i0) * n) / MAX_SELECTOR_WORK));
	const hides = selectionHides(g);
	let prev: Uint8Array | null = null;
	const flips: { frame: number; unit: number; reveal: boolean }[] = [];
	for (let i = i0; i < i1; i += stride) {
		const t = clipContentTime(c as never, c.start + i, ctx.rate);
		const rp = rangeParams(sel, t, n);
		const cur = new Uint8Array(n);
		for (let u = 0; u < n; u++) cur[u] = Math.abs(rangeValue(rp, u, n)) >= 0.5 ? 1 : 0;
		if (prev) {
			for (let u = 0; u < n; u++)
				if (cur[u] !== prev[u]) {
					flips.push({ frame: c.start + i, unit: u, reveal: hides ? cur[u] === 0 : cur[u] === 1 });
					break;
				}
		}
		prev = cur;
	}
	if (!flips.length) return;
	const reveals = flips.filter((f) => f.reveal).length;
	const appear = reveals * 2 >= flips.length;
	const kind: DerivedCueKind = appear ? 'appear' : 'exit';
	const side = appear ? 'in' : 'out';
	const based = sel.basedOn === 'words' ? 'word' : sel.basedOn === 'lines' ? 'line' : 'character';
	const types: SoundTypeId[] =
		based === 'character'
			? ['key', 'tick', 'click']
			: based === 'word'
				? ['tick', 'pop', 'key']
				: ['swish', 'pop', 'ui'];
	// Typing (P6-E10): a character reveal faster than 25 units per second keeps the word starts.
	let steps = flips;
	let how = '';
	if (based === 'character') {
		const span = (flips[flips.length - 1]!.frame - flips[0]!.frame + 1) / ctx.fps;
		const choice = typingChoice(ctx.typing, span > 0 ? flips.length / span : 0);
		if (choice === 'silent') return;
		if (choice === 'words') {
			const text = typeof c.content?.text === 'string' ? c.content.text : '';
			const starts = new Set(
				wordStartUnits(text, sel.basedOn === 'charactersExcludingSpaces' ? 'char' : 'charWithSpaces'),
			);
			const atStarts = flips.filter((f) => starts.has(f.unit));
			if (atStarts.length) {
				steps = atStarts;
				how = `, one key per word: ${Math.round(flips.length / span)} typed/s`;
			}
		}
	}
	const frames = steps.map((f) => f.frame);
	const keep = thinPattern(frames, ctx.fps, how ? 1 : undefined);
	const group = `text:${c.id}:animator:${g.id}:${sel.id}`;
	const name = typeof g.name === 'string' && g.name ? `'${g.name}'` : 'animator';
	for (const i of keep) {
		const f = steps[i]!;
		cues.push(
			candidate('text', {
				key: `${group}:${f.frame}`,
				frame: f.frame,
				kind,
				weight: 'support',
				types,
				align: 'peak',
				pan: geo.pan,
				anchor: { type: 'text', clipId: c.id, side, unit: f.unit },
				confidence: 0.65,
				reason: `Range selector of ${name} ${appear ? 'reveals' : 'hides'} ${based} ${f.unit + 1}/${n} ${where} (${keep.length} of ${flips.length} steps${how})`,
				window: { start: frames[0]!, end: frames[frames.length - 1]! + 1 },
				group,
				size: geo.area,
			}),
		);
	}
}

/** Whether the animator hides what it selects (Opacity < 50 %, or Scale < 20 %): then leaving the selection reveals. */
function selectionHides(g: TextAnimatorGroup): boolean {
	const op = g.properties?.opacity?.value;
	if (typeof op === 'number' && op < 50) return true;
	const sc = g.properties?.scale?.value;
	return (
		Array.isArray(sc) && typeof sc[0] === 'number' && typeof sc[1] === 'number' && sc[0] < 20 && sc[1] < 20
	);
}
