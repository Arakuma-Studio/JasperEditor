// Motion-graphic templates (spec 12 §2.2): the intro's end lands (`land`), the outro's start leaves (`exit`). The
// lengths come from the template registry (`MgTemplateRegistry`, injected: the model never imports template code);
// they are written at 30 fps and converted / compressed exactly like `animeTemplateTiming` of @jasper/mg-templates
// (intro anchored at content frame 0, outro at the content end, both scaled down when they do not fit).
import { clipEnd } from '../../derive/index.ts';
import type { MgTemplateRegistry } from '../../registry/mg.ts';
import type { MotionGraphicClip } from '../../schema/sequence.ts';
import { MG_REFERENCE_FPS } from '../anchor.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clipName, inRange, label, panOfX, secs, sortedClips } from './util.ts';

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

export function deriveMgCues(ctx: CueContext, registry: MgTemplateRegistry | undefined): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const shown = new Set(ctx.videoTracks.map((v) => v.track.id));
	let missing = false;
	for (const c of sortedClips(ctx)) {
		if (c.kind !== 'motion-graphic' || c.enabled === false || !shown.has(c.trackId) || !inRange(ctx, c))
			continue;
		const mg = c as MotionGraphicClip;
		const info = registry?.get(String(mg.template?.id), Number(mg.template?.version));
		if (!info) {
			missing = true;
			continue;
		}
		// As the composition layer (MotionGraphicLayer): content frames at the sequence rate.
		const sourceInFrames = Math.max(0, Math.round(mg.sourceIn / ctx.F) || 0);
		const { intro, outro } = mgPhases(info, ctx.fps, sourceInFrames + mg.duration);
		const where = `on ${label(ctx, c.trackId)} ${clipName(c)}`;
		const name = info.name || mg.template.id;
		const introEnd = c.start + intro - sourceInFrames;
		if (intro > 0 && introEnd > c.start && introEnd < clipEnd(c))
			cues.push(
				candidate('mg', {
					key: `mg:${c.id}:intro-end`,
					frame: introEnd,
					kind: 'land',
					weight: 'support',
					types: ['thump', 'hit', 'pop'],
					align: 'peak',
					pan: panOfX(ctx, ctx.width / 2),
					anchor: { type: 'mg', clipId: c.id, event: 'intro-end' },
					confidence: 0.7,
					reason: `${name} intro (${secs(ctx, intro)}) lands ${where}`,
					window: { start: Math.max(c.start, introEnd - intro), end: introEnd },
					size: 0.5,
				}),
			);
		const outroStart = clipEnd(c) - outro;
		if (outro > 0 && outroStart > c.start && outroStart > introEnd - 1)
			cues.push(
				candidate('mg', {
					key: `mg:${c.id}:outro-start`,
					frame: outroStart,
					kind: 'exit',
					weight: 'support',
					types: ['swish', 'whoosh', 'reverse'],
					align: 'peak',
					anchor: { type: 'mg', clipId: c.id, event: 'outro-start' },
					confidence: 0.55,
					reason: `${name} outro (${secs(ctx, outro)}) starts ${where}`,
					window: { start: outroStart, end: clipEnd(c) },
					size: 0.5,
				}),
			);
	}
	if (missing)
		ctx.warn({
			code: 'W_MG_REGISTRY_MISSING',
			message: 'Some motion-graphic templates are not known here; their intro and outro were not used',
			source: 'mg',
		});
	return cues;
}
