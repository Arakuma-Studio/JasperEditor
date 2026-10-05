// Responsive time of anime templates (S11:ATP-004, S01:KND-009 "Responsive Design – Time"): the intro is
// anchored at content time 0, the outro at the content end (`sourceIn + duration`), the hold stretches. Seek
// time = content frame → ms (S11:ANM-003). Pure, shared by the composition layer, previews and tests.
import { ANIME_REFERENCE_FPS } from './common.ts';

export type AnimeTemplateTiming = {
	/** Content frame of the clip-local frame (`sourceIn + localFrame`; negative inside a head handle). */
	contentFrame: number;
	/** Content length in frames (`sourceIn + duration`). */
	totalFrames: number;
	/** Whole frames of the sequence rate (compressed when intro + outro exceed the content). */
	introFrames: number;
	outroFrames: number;
	/** Seek time and the window edges in ms (`frame * 1000 / fps`). */
	timeMs: number;
	totalMs: number;
	introMs: number;
	outroMs: number;
};

/** Frames written at `ANIME_REFERENCE_FPS` → whole frames at `fps` (same length in seconds, rounded). */
function animeFramesAt(referenceFrames: number, fps: number): number {
	return Math.max(0, Math.round((referenceFrames * fps) / ANIME_REFERENCE_FPS));
}

/**
 * Timing of one frame of an anime template clip. `introFrames`/`outroFrames` come from the definition (at the
 * reference rate); when both do not fit in the content they are scaled down proportionally (whole frames, the
 * intro rounded down) so the outro still ends on the last frame.
 */
export function animeTemplateTiming(
	def: { introFrames: number; outroFrames: number },
	o: { fps: number; localFrame: number; durationFrames: number; sourceInFrames?: number },
): AnimeTemplateTiming {
	const fps = o.fps > 0 ? o.fps : ANIME_REFERENCE_FPS;
	const sourceIn = Math.max(0, Math.round(o.sourceInFrames ?? 0));
	const totalFrames = Math.max(1, sourceIn + Math.max(1, Math.round(o.durationFrames)));
	let intro = animeFramesAt(def.introFrames, fps);
	let outro = animeFramesAt(def.outroFrames, fps);
	if (intro + outro > totalFrames) {
		const sum = intro + outro;
		intro = Math.floor((totalFrames * intro) / sum);
		outro = totalFrames - intro;
	}
	const contentFrame = sourceIn + Math.round(o.localFrame);
	const ms = (frames: number) => (frames * 1000) / fps;
	return {
		contentFrame,
		totalFrames,
		introFrames: intro,
		outroFrames: outro,
		timeMs: ms(contentFrame),
		totalMs: ms(totalFrames),
		introMs: ms(intro),
		outroMs: ms(outro),
	};
}
