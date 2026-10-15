// Where a motion-graphic template lands and leaves (spec 12 §2.2), in CONTENT frames (sequence-rate frames from the
// template's content start). Shared by the mg cue deriver (`cues/mg.ts`) and `resolveCueAnchor` (`anchor.ts`), so a
// derived `mg` anchor always resolves back to its cue's frame.
//
// Measured (the registry exposes `motionSpeed`, e.g. the fframes templates' rendered SVG twins): the picture speed is
// cut into movements exactly like a keyframed clip's (`speedSegments`, pauses up to 0.25 s bridged). The intro is the
// first movement when it starts within the first 0.1 s; it lands on its last moving frame (`b`: the picture is at
// rest from there, as the keyframes source's abrupt-stop land). The outro is the last movement when it is not the
// intro and starts after the land; it leaves on its first moving frame (`a`). An intro that is still moving on the
// last content frame never comes to rest: no land.
//
// Declared fallback (no `motionSpeed`, it returns null, or the clip is longer than MAX_SAMPLES_PER_CLIP): the
// template's `introFrames` / `outroFrames` (written at 30 fps, scaled and compressed like the renderer, `mgPhases`).
import type { MgTemplateInfo } from '../../registry/mg.ts';
import { MAX_SAMPLES_PER_CLIP, speedSegments } from './motion.ts';

/** Reference rate of motion-graphic `introFrames` / `outroFrames` (the anime layer's `ANIME_REFERENCE_FPS`). */
export const MG_REFERENCE_FPS = 30;

/** Intro / outro lengths in sequence frames of a clip whose content spans `totalFrames` (sourceIn + duration). */
export function mgPhases(
	info: { introFrames: number; outroFrames: number },
	fps: number,
	totalFrames: number,
): { intro: number; outro: number } {
	const at = (f: number) => Math.max(0, Math.round(((Number.isFinite(f) ? f : 0) * fps) / MG_REFERENCE_FPS));
	let intro = at(info.introFrames);
	let outro = at(info.outroFrames);
	const total = Math.max(1, Math.round(totalFrames));
	if (intro + outro > total) {
		const sum = intro + outro;
		intro = Math.floor((total * intro) / sum);
		outro = total - intro;
	}
	return { intro, outro };
}

export type MgCuePhases = {
	/** Content frames before the clip's first frame (its sourceIn at the sequence rate). */
	sourceIn: number;
	/** Content length: sourceIn + duration. */
	total: number;
	/** Content frame the intro settles on (null: none). */
	land: number | null;
	/** Content frame the intro starts moving (the land cue's window start). */
	landFrom: number;
	/** Content frame the outro starts (null: none). */
	exit: number | null;
	/** True when land / exit come from the template's measured motion, false for the declared timing. */
	measured: boolean;
	/** Declared intro / outro lengths in sequence frames (`mgPhases`). */
	intro: number;
	outro: number;
};

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Land / exit of a motion-graphic clip at `fps` (`flicksPerFrame`: one sequence frame in flicks, to read its
 * sourceIn). Pure and total: hostile clips and a throwing or malformed `motionSpeed` give the declared timing.
 */
export function mgCuePhases(
	info: Pick<MgTemplateInfo, 'introFrames' | 'outroFrames' | 'motionSpeed'>,
	clip: { sourceIn?: unknown; duration?: unknown; params?: unknown },
	fps: number,
	flicksPerFrame: number,
): MgCuePhases {
	const sourceIn =
		fin(clip.sourceIn) && flicksPerFrame > 0
			? Math.max(0, Math.round(clip.sourceIn / flicksPerFrame) || 0)
			: 0;
	const duration = fin(clip.duration) ? Math.max(1, Math.round(clip.duration)) : 1;
	const total = Math.max(1, sourceIn + duration);
	const { intro, outro } = mgPhases(info, fps, total);
	const declared: MgCuePhases = {
		sourceIn,
		total,
		land: intro > 0 ? intro : null,
		landFrom: 0,
		exit: outro > 0 ? total - outro : null,
		measured: false,
		intro,
		outro,
	};
	const speed = measuredSpeed(info, clip.params, fps, total);
	if (!speed) return declared;
	const segs = speedSegments(speed, Math.max(1, Math.round(0.25 * fps)));
	const first = segs[0];
	const introSeg = first && first.a <= Math.round(0.1 * fps) + 1 ? first : undefined;
	const land = introSeg && introSeg.b < total - 1 ? introSeg.b : null;
	const last = segs[segs.length - 1];
	const exitSeg = last && last !== introSeg && (land === null || last.a > land) ? last : undefined;
	return {
		sourceIn,
		total,
		land,
		landFrom: introSeg ? introSeg.a : 0,
		exit: exitSeg ? exitSeg.a : null,
		measured: true,
		intro,
		outro,
	};
}

/** The template's picture speed over the content, or null when it cannot be measured (sanitised: never NaN). */
function measuredSpeed(
	info: Pick<MgTemplateInfo, 'motionSpeed'>,
	params: unknown,
	fps: number,
	total: number,
): Float64Array | null {
	if (typeof info.motionSpeed !== 'function' || !(fps > 0) || !Number.isFinite(fps)) return null;
	if (total > MAX_SAMPLES_PER_CLIP) return null;
	let raw: unknown;
	try {
		raw = info.motionSpeed(isRecord(params) ? params : {}, { fps, totalFrames: total });
	} catch {
		return null;
	}
	if (!Array.isArray(raw) || raw.length !== total) return null;
	const out = new Float64Array(total);
	for (let i = 1; i < total; i++) {
		const v = raw[i];
		out[i] = fin(v) && v > 0 ? Math.min(v, 1e6) : 0;
	}
	return out;
}
