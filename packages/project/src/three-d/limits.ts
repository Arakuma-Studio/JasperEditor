// Advanced 3D's fixed limits, said out loud (AGENTS §4: nothing is dropped in silence). The renderer
// (`packages/compositions/src/three-d/advanced.ts`) draws at most `ADVANCED_MAX_LIGHTS` lights and `ADVANCED_MAX_SHADOW_TILES`
// shadow maps a frame, and supersamples by what the GPU's largest render buffer holds. Preview and export draw with the
// same renderer, so both show the same picture: the preview says so in its chip, the export plan in a warning. Pure.
import type { RenderScene3D } from '../render/snapshot.ts';
import type { Rational } from '../time.ts';
import { type LightState, lightsAt } from './scene.ts';

/** Most lights (other than environment lights) one frame of Advanced 3D draws; the rest are left out. */
export const ADVANCED_MAX_LIGHTS = 32;
/** Most shadow maps one frame draws: a spot or parallel light needs one, a point light six. */
export const ADVANCED_MAX_SHADOW_TILES = 48;
/** Largest supersampling factor. */
export const ADVANCED_MAX_SUPERSAMPLING = 4;

/** Shadow maps a light needs (`shadowTiles` of the renderer). */
export const shadowTileCount = (l: Pick<LightState, 'type' | 'castsShadows'>): number =>
	!l.castsShadows || l.type === 'ambient' || l.type === 'environment' ? 0 : l.type === 'point' ? 6 : 1;

export type Advanced3dLimits = {
	/** Lights of the frame left out (past the first `ADVANCED_MAX_LIGHTS`, in drawing order). */
	droppedLights: string[];
	/** Lights drawn whose shadows are left out (their maps would pass `ADVANCED_MAX_SHADOW_TILES`). */
	shadowless: string[];
};

/** What one frame leaves out, from its lights in drawing order (`lightsAt`, environment lights excluded). */
export function advanced3dLimitsOf(
	lights: readonly Pick<LightState, 'clipId' | 'type' | 'castsShadows'>[],
): Advanced3dLimits {
	const own = lights.filter((l) => l.type !== 'environment');
	const kept = own.slice(0, ADVANCED_MAX_LIGHTS);
	const shadowless: string[] = [];
	let tiles = 0;
	for (const l of kept) {
		const n = shadowTileCount(l);
		if (n === 0) continue;
		// The renderer skips a light whose maps would not fit and goes on with the next one.
		if (tiles + n > ADVANCED_MAX_SHADOW_TILES) shadowless.push(l.clipId);
		else tiles += n;
	}
	return { droppedLights: own.slice(ADVANCED_MAX_LIGHTS).map((l) => l.clipId), shadowless };
}

/** The supersampling a frame of `width × height` gets on a GPU whose largest render buffer side is `maxRenderbuffer`. */
export function advancedSupersampling(
	requested: number,
	width: number,
	height: number,
	maxRenderbuffer: number,
): number {
	const side = Math.max(1, Math.round(width), Math.round(height));
	const fits = Number.isFinite(maxRenderbuffer)
		? Math.floor(maxRenderbuffer / side)
		: ADVANCED_MAX_SUPERSAMPLING;
	return Math.max(
		1,
		Math.min(ADVANCED_MAX_SUPERSAMPLING, fits, Math.round(Number.isFinite(requested) ? requested : 1)),
	);
}

/** Most frames `advanced3dLimitWarnings` evaluates (lights only change where a light clip starts or ends). */
const MAX_FRAMES = 4096;

/**
 * The export plan's warnings for the Advanced 3D limits over `range` (sequence frames, half-open): lights left out, shadows
 * left out, and supersampling the render browser's GPU cannot hold (`maxRenderbuffer`, absent when not probed).
 */
export function advanced3dLimitWarnings(
	doc: {
		scene3d?: RenderScene3D;
		settings: { width: number; height: number; fps: Rational };
		videoTracks: readonly {
			clips: readonly { clipId: string; start: number; duration: number; threeD?: unknown }[];
		}[];
	},
	range: { start: number; end: number },
	maxRenderbuffer?: number,
): { code: string; message: string; itemIds: string[] }[] {
	const scene = doc.scene3d;
	if (scene?.renderer !== 'advanced' || scene.draft) return [];
	const layers = doc.videoTracks.flatMap((t) => t.clips.filter((c) => !!c.threeD));
	if (layers.length === 0) return [];
	// The set of lights and 3D layers changes only where one starts or ends.
	const frames = new Set<number>([range.start]);
	for (const c of [...scene.lights, ...layers])
		for (const f of [c.start, c.start + c.duration])
			if (f >= range.start && f < range.end && frames.size < MAX_FRAMES) frames.add(f);
	const dropped = new Set<string>();
	const shadowless = new Set<string>();
	let drawn = false;
	for (const f of frames) {
		if (!layers.some((c) => f >= c.start && f < c.start + c.duration)) continue;
		drawn = true;
		const r = advanced3dLimitsOf(lightsAt(scene, f, doc.settings.fps));
		for (const id of r.droppedLights) dropped.add(id);
		for (const id of r.shadowless) shadowless.add(id);
	}
	const out: { code: string; message: string; itemIds: string[] }[] = [];
	if (dropped.size)
		out.push({
			code: 'THREE_D_LIGHTS_LIMIT',
			message: `${dropped.size} light(s) are not drawn: Advanced 3D draws at most ${ADVANCED_MAX_LIGHTS} lights at a time (as the preview shows)`,
			itemIds: [...dropped],
		});
	if (shadowless.size)
		out.push({
			code: 'THREE_D_SHADOWS_LIMIT',
			message: `${shadowless.size} light(s) cast no shadows: Advanced 3D draws at most ${ADVANCED_MAX_SHADOW_TILES} shadow maps at a time (a point light takes six; as the preview shows)`,
			itemIds: [...shadowless],
		});
	const requested = scene.supersampling ?? 1;
	if (drawn && requested > 1 && maxRenderbuffer !== undefined) {
		const want = Math.min(ADVANCED_MAX_SUPERSAMPLING, Math.round(requested));
		const got = advancedSupersampling(requested, doc.settings.width, doc.settings.height, maxRenderbuffer);
		if (got < want)
			out.push({
				code: 'THREE_D_SUPERSAMPLING_LIMIT',
				message: `3D supersampling renders at ${got}× instead of ${want}×: the render browser's GPU holds render buffers of ${maxRenderbuffer} px per side`,
				itemIds: layers.map((c) => c.clipId),
			});
	}
	return out;
}
