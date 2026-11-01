// Media derivation ops (spec 18 AF-OPS-001): the `NativeRecipe` ops the engine runs as one file operation each
// (`POST /api/media/:key/derive`) and registers through `media.derive`. Shared by the engine (refusals, output
// planning), the `media.derive` handler (source kinds, the source range of a `range` file), MCP and the editor's
// Derive Media dialogs (field validation).
import type { MediaAsset, NativeRecipe } from '../schema/media.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';

/** The ops `derive_media` / Derive Media ▸ … run (loudness-normalize, stabilize, transcode and process have their own tools). */
export const DERIVE_OPS = [
	'conform-cfr',
	'reverse',
	'denoise-audio',
	'extract-audio',
	'time-stretch',
	'range',
] as const satisfies readonly NativeRecipe['op'][];
export type DeriveOp = (typeof DERIVE_OPS)[number];
export type DeriveRecipe = Extract<NativeRecipe, { op: DeriveOp }>;

/** Bounds of the derivation ops (wp-note agent-footage-ops). */
export const DERIVE_LIMITS = {
	/** conform-cfr output rate, frames per second. */
	minFps: 1,
	maxFps: 240,
	/** time-stretch speed factor (2 = twice as fast, half the duration). */
	minRate: 0.25,
	maxRate: 4,
} as const;

export function isDeriveOp(op: string): op is DeriveOp {
	return (DERIVE_OPS as readonly string[]).includes(op);
}

/** Ops whose output is an audio file whatever the source (the source must hold an audio stream). */
export function deriveMakesAudio(op: NativeRecipe['op']): boolean {
	return op === 'denoise-audio' || op === 'extract-audio' || op === 'loudness-normalize';
}

/**
 * The media kinds an op reads: audio ops and the timing ops (reverse, time-stretch, range) take video or audio;
 * conform-cfr and the picture ops (process, stabilize, transcode) take video.
 */
export function deriveSourceKinds(op: NativeRecipe['op']): readonly MediaAsset['kind'][] {
	if (deriveMakesAudio(op) || op === 'reverse' || op === 'time-stretch' || op === 'range')
		return ['video', 'audio'];
	return ['video'];
}

/** The kind of the derived media of `op` made from a `source` of kind `sourceKind`. */
export function derivedKind(op: NativeRecipe['op'], sourceKind: MediaAsset['kind']): MediaAsset['kind'] {
	return deriveMakesAudio(op) ? 'audio' : sourceKind;
}

/**
 * The source frames `[startFrame, endFrame)` a `range` op keeps at `rate`: the frames whose start time lies in
 * `[inFlicks, outFlicks)` (frame n starts at n / rate). Exact integer arithmetic (BigInt): no rounding drift at
 * any rate or length.
 */
export function rangeFrames(
	recipe: { inFlicks: number; outFlicks: number },
	rate: Rational,
): { startFrame: number; endFrame: number } {
	const ceilFrame = (flicks: number) => {
		const n = BigInt(Math.max(0, Math.trunc(flicks))) * BigInt(rate.num);
		const d = BigInt(FLICKS_PER_SECOND) * BigInt(rate.den);
		return Number((n + d - 1n) / d);
	};
	return { startFrame: ceilFrame(recipe.inFlicks), endFrame: ceilFrame(recipe.outFlicks) };
}

/** `fps` as a number, or null when the rational is not a finite positive rate. */
export function rationalFps(r: Rational): number | null {
	const v = r.num / r.den;
	return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Field-level problems of a derivation recipe against its source media, as the engine refuses them (same codes):
 * `NO_VIDEO`, `NO_AUDIO`, `UNSUPPORTED_RATE`, `OUT_OF_RANGE`, `EMPTY_RANGE`, `UNSUPPORTED_MEDIA`. Empty = valid.
 * The engine checks the same against its own probe (the authority); the editor and MCP use this before asking.
 */
export function deriveProblems(
	source: Pick<MediaAsset, 'kind' | 'probe'>,
	recipe: DeriveRecipe,
): { code: string; message: string; field?: string }[] {
	const out: { code: string; message: string; field?: string }[] = [];
	const kinds = deriveSourceKinds(recipe.op);
	if (!kinds.includes(source.kind)) {
		out.push({
			code: 'UNSUPPORTED_MEDIA',
			message: `${recipe.op} needs ${kinds.join(' or ')} media; this is ${source.kind}`,
		});
		return out;
	}
	const video = source.probe.streams.find((s) => s.type === 'video');
	const audio = source.probe.streams.filter((s) => s.type === 'audio');
	const durationFlicks = source.probe.durationFlicks;
	switch (recipe.op) {
		case 'conform-cfr': {
			if (!video) out.push({ code: 'NO_VIDEO', message: 'The media has no video stream' });
			const fps = rationalFps(recipe.frameRate);
			if (
				!Number.isInteger(recipe.frameRate.num) ||
				!Number.isInteger(recipe.frameRate.den) ||
				fps === null ||
				fps < DERIVE_LIMITS.minFps ||
				fps > DERIVE_LIMITS.maxFps
			)
				out.push({
					code: 'UNSUPPORTED_RATE',
					field: 'frameRate',
					message: `The frame rate must be ${DERIVE_LIMITS.minFps}…${DERIVE_LIMITS.maxFps} fps`,
				});
			break;
		}
		case 'denoise-audio':
			if (!audio.length) out.push({ code: 'NO_AUDIO', message: 'The media has no audio stream' });
			if (!(recipe.strength >= 0 && recipe.strength <= 1))
				out.push({ code: 'INVALID_PARAM', field: 'strength', message: 'The strength must be 0…1' });
			break;
		case 'extract-audio':
			if (!audio.length) out.push({ code: 'NO_AUDIO', message: 'The media has no audio stream' });
			else if (!audio.some((s) => s.index === recipe.streamIndex))
				out.push({
					code: 'NO_AUDIO',
					field: 'streamIndex',
					message: `Stream ${recipe.streamIndex} is not an audio stream (audio streams: ${audio.map((s) => s.index).join(', ')})`,
				});
			break;
		case 'time-stretch':
			if (
				!Number.isFinite(recipe.rate) ||
				recipe.rate < DERIVE_LIMITS.minRate ||
				recipe.rate > DERIVE_LIMITS.maxRate
			)
				out.push({
					code: 'UNSUPPORTED_RATE',
					field: 'rate',
					message: `The speed must be ${DERIVE_LIMITS.minRate}…${DERIVE_LIMITS.maxRate}× (got ${recipe.rate})`,
				});
			if (durationFlicks === null)
				out.push({ code: 'UNSUPPORTED_MEDIA', message: 'The media has no known duration' });
			break;
		case 'reverse':
			if (durationFlicks === null)
				out.push({ code: 'UNSUPPORTED_MEDIA', message: 'The media has no known duration' });
			break;
		case 'range': {
			if (durationFlicks === null) {
				out.push({ code: 'UNSUPPORTED_MEDIA', message: 'The media has no known duration' });
				break;
			}
			const sec = (f: number) => `${(f / FLICKS_PER_SECOND).toFixed(3)} s`;
			if (recipe.outFlicks > durationFlicks || recipe.inFlicks >= durationFlicks)
				out.push({
					code: 'OUT_OF_RANGE',
					field: recipe.outFlicks > durationFlicks ? 'outFlicks' : 'inFlicks',
					message: `The range ${sec(recipe.inFlicks)}–${sec(recipe.outFlicks)} is outside the media (${sec(durationFlicks)})`,
				});
			else if (recipe.outFlicks <= recipe.inFlicks)
				out.push({
					code: 'EMPTY_RANGE',
					field: 'outFlicks',
					message: 'The Out point must be after the In point',
				});
			else if (video) {
				const f = rangeFrames(recipe, video.frameRate);
				if (f.endFrame <= f.startFrame)
					out.push({
						code: 'EMPTY_RANGE',
						field: 'outFlicks',
						message: 'The range holds no frame start: make it at least one frame long',
					});
			}
			break;
		}
	}
	return out;
}
