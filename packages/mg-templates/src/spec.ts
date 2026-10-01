// Render specs and cache keys for motion-graphic clips (ARCHITECTURE §10.2, S01:KND-009, S04:MG-011).
// Pure functions shared by the engine (render service, export planner) and the web app (render state).
import type { RenderVisualClip } from '@jasper/project';
import type { MgRegistry } from './registry.ts';

/** Same value as @jasper/project's FLICKS_PER_SECOND (kept local: this package imports project types only). */
const FLICKS_PER_SECOND = 705_600_000;

export type MgRational = { num: number; den: number };

/** Mirrors @jasper/api `MgRenderSpec` and the Rust `MgSpec`. */
export type MgSpecInput = {
	template: { id: string; version: number };
	params: Record<string, unknown>;
	width: number;
	height: number;
	fps: MgRational;
	durationFrames: number;
	sourceInFrames?: number;
};

/** JSON with object keys sorted at every level and no whitespace (stable hashing input). */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Applies the template's defaults and validation to `spec.params` when the template is known, so
 * `{}` and the explicit defaults produce the same spec (and the same cache key).
 */
export function resolveSpecParams(spec: MgSpecInput, registry?: MgRegistry): MgSpecInput {
	const def = registry?.getDefinition(spec.template.id, spec.template.version);
	if (!def) return spec;
	const parsed = def.paramsSchema.safeParse(spec.params);
	return parsed.success ? { ...spec, params: parsed.data as Record<string, unknown> } : spec;
}

/**
 * The material hashed into the render key: template id + version, canonical params, canvas, frame
 * rate, duration, sourceIn and renderer version (S01:KND-009, S04:MG-011). Hash it with SHA-256.
 */
export function mgRenderKeyMaterial(spec: MgSpecInput, rendererVersion: string): string {
	return canonicalJson({
		v: 1,
		template: { id: spec.template.id, version: spec.template.version },
		params: spec.params,
		canvas: { width: spec.width, height: spec.height },
		fps: { num: spec.fps.num, den: spec.fps.den },
		durationFrames: spec.durationFrames,
		sourceInFrames: spec.sourceInFrames ?? 0,
		renderer: rendererVersion,
	});
}

/** Builds the render spec of a motion-graphic clip from a render snapshot (null for other kinds). */
export function specFromClip(
	clip: Pick<RenderVisualClip, 'source' | 'duration' | 'sourceIn'>,
	fps: MgRational,
	registry?: MgRegistry,
): MgSpecInput | null {
	if (!('mg' in clip.source)) return null;
	const { template, params, canvas } = clip.source.mg;
	const sourceInFrames = Math.max(0, Math.round((clip.sourceIn * fps.num) / (fps.den * FLICKS_PER_SECOND)));
	return resolveSpecParams(
		{
			template: { id: template.id, version: template.version },
			params: { ...params },
			width: Math.round(canvas.width),
			height: Math.round(canvas.height),
			fps: { num: fps.num, den: fps.den },
			durationFrames: clip.duration,
			sourceInFrames,
		},
		registry,
	);
}
