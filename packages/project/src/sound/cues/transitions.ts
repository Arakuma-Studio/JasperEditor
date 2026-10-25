// Video transitions (spec 12 §2.2): a cue at the visual centre of the span. Moving transitions (push, slide, whip,
// zoom, 3D moves) want a whoosh over the span with a pan sweep along their direction; wipes a swish; distortions a
// glitch; dissolves at most a faint shimmer (ambient, low confidence: the density's minimum confidence usually drops
// it). Classes come from the registry's Effects-panel bin and the id (`TRANSITION_SPECS`).
import { clipEnd } from '../../derive/index.ts';
import type { Clip, Transition } from '../../schema/sequence.ts';
import { transitionSpan, transitionSpec } from '../../transitions.ts';
import type { SoundTypeId, SoundWeight } from '../taxonomy.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clipName, label, secs } from './util.ts';

export type TransitionClass = 'move' | 'zoom' | 'wipe' | 'glitch' | 'light' | 'dissolve';

const MOVE_BINS = new Set(['Slide', 'Animation', '3D Motion', 'Page Peel', 'Transformers']);
const MOVE_IDS =
	/(^|[.-])(push|slide|whip|swish|spin|roll|flip|hyper|strip|parallax|card|travel|pull|fold|block|spring|cube)([.-]|$)/;
const ZOOM_IDS = /zoom/;
const GLITCH_IDS =
	/(glitch|digital-damage|pixel-mosh|pixel-sort|tv-channel|vhs|tv-power|static|flutter|chaos|earthquake)/;
const LIGHT_BINS = new Set(['Lights & Blurs']);

/** The sound class of a transition type (unknown ids are classified by name, else as a dissolve). */
export function transitionClass(effectId: string): TransitionClass {
	const spec = transitionSpec(effectId);
	const id = effectId.toLowerCase();
	const bin = spec?.bin ?? '';
	if (ZOOM_IDS.test(id)) return 'zoom';
	if (GLITCH_IDS.test(id) || bin === 'Grunge & Distort') return 'glitch';
	if (MOVE_BINS.has(bin) || MOVE_IDS.test(id)) return 'move';
	if (bin === 'Wipe' || bin === 'Iris' || spec?.subBin === 'Wipes' || /wipe|iris/.test(id)) return 'wipe';
	if (LIGHT_BINS.has(bin)) return 'light';
	return 'dissolve';
}

/** Direction of a transition → horizontal travel −1 (right to left) … 1 (left to right); null = not horizontal. */
export function transitionTravel(params: Transition['params']): number | null {
	for (const name of ['direction', 'spinDirection', 'wipeDirection']) {
		const v = (params?.[name] as { value?: unknown } | undefined)?.value;
		if (typeof v !== 'string') continue;
		const d = v.toLowerCase();
		if (d.startsWith('westtoeast') || d === 'right') return 1;
		if (d.startsWith('easttowest') || d === 'left') return -1;
		if (d === 'northwesttosoutheast' || d === 'southwesttonortheast') return 1;
		if (d === 'northeasttosouthwest' || d === 'southeasttonorthwest') return -1;
		return null;
	}
	for (const name of ['angle', 'stripAngle']) {
		const v = (params?.[name] as { value?: unknown } | undefined)?.value;
		if (typeof v === 'number' && Number.isFinite(v)) {
			const c = Math.cos((v * Math.PI) / 180);
			return Math.abs(c) < 0.25 ? null : c;
		}
	}
	return null;
}

const TRAVEL_WORD = (t: number) => (t > 0 ? 'left → right' : 'right → left');

/** The frame span of a transition as placed, or null when its clips are missing. */
export function transitionWindow(
	seq: { clips: Record<string, Clip> },
	t: Transition,
): { start: number; end: number } | null {
	const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
	const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
	const d = Math.max(1, Math.round(Number(t.duration) || 1));
	if (inc && out) return transitionSpan(inc.start, d, t.alignment, t.cutPosition);
	if (inc) return { start: inc.start, end: inc.start + Math.min(d, inc.duration) };
	if (out) return { start: clipEnd(out) - Math.min(d, out.duration), end: clipEnd(out) };
	return null;
}

export function deriveTransitionCues(ctx: CueContext): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const shown = new Map(ctx.videoTracks.map((v) => [v.track.id, v]));
	for (const t of Object.values(ctx.seq.transitions ?? {})) {
		if (!t || typeof t.effectId !== 'string' || !shown.has(t.trackId)) continue;
		const spec = transitionSpec(t.effectId);
		if (spec && spec.appliesTo !== 'video') continue;
		const w = transitionWindow(ctx.seq, t);
		if (!w) continue;
		// The visual centre: `start + ⌊duration / 2⌋` (as `resolveCueAnchor` reads a transition anchor).
		const frame = w.start + Math.floor(Math.max(1, Math.round(Number(t.duration) || 1)) / 2);
		if (frame < ctx.range.start || frame >= ctx.range.end) continue;
		cues.push(transitionCue(ctx, t, w, frame, spec?.label ?? t.effectId));
	}
	return cues;
}

function transitionCue(
	ctx: CueContext,
	t: Transition,
	w: { start: number; end: number },
	frame: number,
	name: string,
): CueCandidate {
	const cls = transitionClass(t.effectId);
	const len = w.end - w.start;
	const long = len >= 0.3 * ctx.fps;
	let types: SoundTypeId[];
	let weight: SoundWeight = 'support';
	let confidence: number;
	let travel: number | null = null;
	switch (cls) {
		case 'move':
			types = long ? ['whoosh', 'transition', 'swish'] : ['swish', 'whoosh', 'transition'];
			confidence = 0.85;
			travel = transitionTravel(t.params);
			break;
		case 'zoom':
			types = long ? ['whoosh', 'transition', 'riser'] : ['swish', 'whoosh'];
			confidence = 0.8;
			break;
		case 'wipe':
			types = ['swish', 'transition', 'whoosh'];
			confidence = 0.6;
			travel = transitionTravel(t.params);
			break;
		case 'glitch':
			types = ['glitch', 'zap', 'transition'];
			confidence = 0.7;
			break;
		case 'light':
			types = ['shimmer', 'whoosh', 'transition'];
			confidence = 0.35;
			weight = 'ambient';
			break;
		default:
			types = ['shimmer', 'transition'];
			confidence = 0.2;
			weight = 'ambient';
	}
	const out = t.outgoingClipId ? ctx.seq.clips[t.outgoingClipId] : undefined;
	const inc = t.incomingClipId ? ctx.seq.clips[t.incomingClipId] : undefined;
	const between =
		out && inc
			? ` between ${clipName(out)} and ${clipName(inc)}`
			: inc
				? ` into ${clipName(inc)}`
				: out
					? ` out of ${clipName(out)}`
					: '';
	const dir = travel !== null ? ` (${TRAVEL_WORD(travel)})` : '';
	const sweep =
		travel !== null && (cls === 'move' || cls === 'wipe')
			? { from: Math.round(-60 * travel), to: Math.round(60 * travel) }
			: undefined;
	return candidate('transitions', {
		key: `transition:${t.id}`,
		frame,
		kind: 'transition',
		weight,
		types,
		align: 'peak',
		...(sweep ? { pan: 0, panSweep: sweep } : {}),
		anchor: { type: 'transition', transitionId: t.id },
		confidence,
		reason: `${name}${dir}, ${secs(ctx, len)} on ${label(ctx, t.trackId)}${between}`,
		window: { start: w.start, end: w.end },
		size: 1,
	});
}
