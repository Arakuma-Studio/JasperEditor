// color-grade: the documents the grading analysis renders (Colour Match, Auto tone, `scopes_read` of one clip). The
// engine renders them with its still renderer, so every feature of the clip renders exactly as it exports.
//
// `clipAnalysisDocument` keeps one clip of a sequence alone: no other clips, no transitions, Motion reset to fit the
// frame, opacity 100 %, Normal blend, no masks — the clip's own picture filling the frame. With `before` its
// effect stack stops before that effect instance (the picture a Lumetri instance receives, which is what Colour
// Match and Auto analyse; Premiere matches "the current clip" the same way). An adjustment layer keeps the clips
// below it (its picture is the composite under it) and its own geometry.
import { defaultTransform } from '../factories.ts';
import { LUMETRI_EFFECT_ID } from '../registry/color-effects.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { EffectInstance } from '../schema/sequence.ts';

export class AnalysisError extends Error {
	constructor(
		readonly code: 'SEQUENCE_NOT_FOUND' | 'CLIP_NOT_FOUND' | 'CLIP_NOT_VISUAL' | 'EFFECT_NOT_FOUND',
		message: string,
	) {
		super(message);
		this.name = 'AnalysisError';
	}
}

/** The Lumetri instance a grading action edits: `effectId` when given, else the clip's first. */
export function analysisLumetri(
	effects: readonly EffectInstance[],
	effectId?: string | null,
): EffectInstance | null {
	if (effectId) return effects.find((e) => e.id === effectId && e.effectId === LUMETRI_EFFECT_ID) ?? null;
	return effects.find((e) => e.effectId === LUMETRI_EFFECT_ID) ?? null;
}

export type ClipAnalysisOptions = {
	/** Stop the effect stack before this instance (its input is analysed); null/absent = every effect. */
	before?: string | null;
};

/** A copy of `doc` where `sequenceId` shows only `clipId` (see the module comment). Throws `AnalysisError`. */
export function clipAnalysisDocument(
	doc: ProjectDocument,
	sequenceId: string,
	clipId: string,
	opts: ClipAnalysisOptions = {},
): ProjectDocument {
	const src = doc.sequences[sequenceId];
	if (!src) throw new AnalysisError('SEQUENCE_NOT_FOUND', `Unknown sequence ${sequenceId}`);
	const clip = src.clips[clipId];
	if (!clip) throw new AnalysisError('CLIP_NOT_FOUND', `Unknown clip ${clipId}`);
	const trackIndex = src.videoTracks.findIndex((t) => t.id === clip.trackId);
	if (trackIndex < 0) throw new AnalysisError('CLIP_NOT_VISUAL', `Clip ${clipId} is not on a video track`);
	const out = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
	const seq = out.sequences[sequenceId]!;
	const c = seq.clips[clipId]! as typeof clip & {
		effects?: EffectInstance[];
		transform?: unknown;
		opacity?: { value: number; keyframes: unknown[] };
		blendMode?: string;
		masks?: unknown[];
		enabled?: boolean;
	};
	const adjustment = c.kind === 'adjustment';
	if (opts.before) {
		const effects = c.effects ?? [];
		const i = effects.findIndex((e) => e.id === opts.before);
		if (i < 0) throw new AnalysisError('EFFECT_NOT_FOUND', `Clip ${clipId} has no effect ${opts.before}`);
		c.effects = effects.slice(0, i);
	}
	(c as { enabled?: boolean }).enabled = true;
	if (!adjustment) {
		const frame = { width: seq.settings.width, height: seq.settings.height };
		const box = intrinsicBoxOf({ clip: clip as never, doc, seq: src as never });
		if ('transform' in c && c.transform) c.transform = defaultTransform(box, frame, 'fit') as never;
		if (c.opacity) c.opacity = { value: 100, keyframes: [] };
		if (c.blendMode) c.blendMode = 'normal';
		if (c.masks) c.masks = [];
	}
	// Only the clip (and, for an adjustment layer, the clips on the tracks below it).
	const below = new Set(adjustment ? src.videoTracks.slice(0, trackIndex).map((t) => t.id) : []);
	for (const id of Object.keys(seq.clips)) {
		const other = seq.clips[id]!;
		if (id === clipId) continue;
		if (!below.has(other.trackId)) delete seq.clips[id];
	}
	seq.transitions = {};
	seq.links = {};
	seq.groups = {};
	for (const t of seq.videoTracks) t.output = t.id === clip.trackId || below.has(t.id);
	return out;
}
