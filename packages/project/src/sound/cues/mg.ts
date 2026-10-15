// Motion-graphic templates (spec 12 §2.2): the intro settles (`land`), the outro starts leaving (`exit`). Where, comes
// from `mgCuePhases` (shared with `resolveCueAnchor`): the template's measured picture motion when the registry exposes
// it (`MgTemplateInfo.motionSpeed`, the fframes templates), else the declared `introFrames` / `outroFrames` (written at
// 30 fps, converted / compressed like `animeTemplateTiming` of @jasper/mg-templates) with a lower confidence. The
// registry is injected: the model never imports template code.
import { clipEnd } from '../../derive/index.ts';
import type { MgTemplateRegistry } from '../../registry/mg.ts';
import type { MotionGraphicClip } from '../../schema/sequence.ts';
import { mgCuePhases } from './mg-phases.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clipName, inRange, label, panOfX, secs, sortedClips } from './util.ts';

export { type MgCuePhases, mgCuePhases, mgPhases } from './mg-phases.ts';

/** Confidence of a land / exit found on the template's measured motion, and of the declared-timing fallback. */
export const MG_CONFIDENCE = {
	measured: { land: 0.8, exit: 0.6 },
	declared: { land: 0.5, exit: 0.4 },
} as const;

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
		const ph = mgCuePhases(info, mg, ctx.fps, ctx.F);
		const conf = ph.measured ? MG_CONFIDENCE.measured : MG_CONFIDENCE.declared;
		const where = `on ${label(ctx, c.trackId)} ${clipName(c)}`;
		const name = info.name || mg.template.id;
		const landFrame = ph.land === null ? null : c.start + ph.land - ph.sourceIn;
		if (landFrame !== null && landFrame > c.start && landFrame < clipEnd(c))
			cues.push(
				candidate('mg', {
					key: `mg:${c.id}:intro-end`,
					frame: landFrame,
					kind: 'land',
					weight: 'support',
					types: ['thump', 'hit', 'pop'],
					align: 'peak',
					pan: panOfX(ctx, ctx.width / 2),
					anchor: { type: 'mg', clipId: c.id, event: 'intro-end' },
					confidence: conf.land,
					reason: ph.measured
						? `${name} settles after ${secs(ctx, ph.land!)} ${where}`
						: `${name} intro (declared ${secs(ctx, ph.intro)}) ends ${where}`,
					window: { start: Math.max(c.start, c.start + ph.landFrom - ph.sourceIn), end: landFrame },
					size: 0.5,
				}),
			);
		const exitFrame = ph.exit === null ? null : c.start + ph.exit - ph.sourceIn;
		if (exitFrame !== null && exitFrame > c.start && (landFrame === null || exitFrame > landFrame - 1))
			cues.push(
				candidate('mg', {
					key: `mg:${c.id}:outro-start`,
					frame: exitFrame,
					kind: 'exit',
					weight: 'support',
					types: ['swish', 'whoosh', 'reverse'],
					align: 'peak',
					anchor: { type: 'mg', clipId: c.id, event: 'outro-start' },
					confidence: conf.exit,
					reason: ph.measured
						? `${name} starts leaving ${secs(ctx, ph.total - ph.exit!)} before its end ${where}`
						: `${name} outro (declared ${secs(ctx, ph.outro)}) starts ${where}`,
					window: { start: exitFrame, end: clipEnd(c) },
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
