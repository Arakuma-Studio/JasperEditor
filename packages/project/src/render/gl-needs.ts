// What of a render document needs WebGL2 in the render browser (spec 19 TL-125, TL-124, TL-123). The Remotion path
// draws colour effects, GPU shader effects, masks, GPU transitions, GL-composited blend modes and 3D layers
// with WebGL2 and cancels a render with WEBGL_UNAVAILABLE (or the effect's float refusal) when it is missing. The
// engine asks this before a render starts, so the plan names the cause (`planner.ts`) and the Remotion service
// refuses before it opens a browser (`assertWebglFor`) instead of failing mid-render.
//
// The document is read structurally: it arrives as untrusted JSON (`inputProps.doc`), a clip, track or nested
// snapshot of another shape is skipped, recursion is bounded and cycle-safe.
import { isCssBlend } from '../blend-modes.ts';
import { defaultEffectRegistry, type EffectRegistry } from '../registry/effects.ts';
import { fxFloatRefusal } from '../registry/fx/shader.ts';
import { advancedNeedsFloat, THREE_D_FLOAT_MESSAGE, THREE_D_NEEDS_FLOAT } from '../three-d/scene-look.ts';
import { transitionSpec } from '../transitions.ts';

/** One thing in a document that needs WebGL2. */
export type GlNeed = {
	kind: 'effect' | 'effect-masks' | 'masks' | 'transition' | 'blend' | '3d';
	/** The effect, transition or blend mode id (`3d` for 3D layers). */
	id: string;
	/** Human name for plan blockers and errors. */
	label: string;
	clipId?: string;
	transitionId?: string;
	/** Set when the effect `requiresFloat` (TL-123): its refusal code and message without float render targets. */
	float?: { code: string; message: string };
};

/** Deepest nest followed (nested snapshots are trees; deeper ones are skipped). */
export const GL_NEEDS_MAX_DEPTH = 16;
/** Most clips and transitions visited in one document. */
export const GL_NEEDS_MAX_NODES = 200_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Some mask draws something (`activeMasks`: a mode other than none and a closed path of 2+ vertices, keys count). */
function hasActiveMask(masks: unknown): boolean {
	if (!Array.isArray(masks)) return false;
	return masks.some((m) => {
		if (!isObj(m) || m.mode === 'none') return false;
		const path = isObj(m.path) ? m.path : null;
		if (!path) return false;
		if (Array.isArray(path.keyframes) && path.keyframes.length > 0) return true;
		const v = isObj(path.value) ? path.value : null;
		return !!v && v.closed === true && Array.isArray(v.vertices) && v.vertices.length >= 2;
	});
}

/**
 * Everything in render document `doc` (a `RenderSnapshot`, its nested snapshots and matte tracks included) that needs
 * WebGL2: enabled colour and GPU shader effects (also on adjustment layers and nested sequences), enabled effects with
 * masks, layers with Opacity masks, GPU transitions, blend modes CSS cannot draw, and 3D layers. Empty for a document that needs none.
 */
export function snapshotGlNeeds(doc: unknown, registry: EffectRegistry = defaultEffectRegistry): GlNeed[] {
	const out: GlNeed[] = [];
	const seen = new WeakSet<object>();
	let nodes = 0;
	// spec 19 TL-076: whether the snapshot being walked draws its 3D through the floating-point scene target.
	let float3d = false;
	const visitClip = (c: unknown, depth: number): void => {
		if (!isObj(c) || nodes++ >= GL_NEEDS_MAX_NODES) return;
		const clipId = typeof c.clipId === 'string' ? c.clipId : undefined;
		const at = clipId ? { clipId } : {};
		if (Array.isArray(c.effects))
			for (const fx of c.effects) {
				if (!isObj(fx) || fx.enabled !== true || typeof fx.effectId !== 'string') continue;
				const spec = registry.get(
					fx.effectId,
					typeof fx.effectVersion === 'number' ? fx.effectVersion : undefined,
				);
				if (!spec) continue;
				const float = fxFloatRefusal(spec);
				if (spec.color || spec.gpu)
					out.push({ kind: 'effect', id: spec.id, label: spec.label, ...at, ...(float ? { float } : {}) });
				else if (hasActiveMask(fx.masks))
					out.push({ kind: 'effect-masks', id: spec.id, label: `${spec.label} (masked)`, ...at });
			}
		if (hasActiveMask(c.masks)) out.push({ kind: 'masks', id: 'masks', label: 'layer mask', ...at });
		if (typeof c.blendMode === 'string' && !isCssBlend(c.blendMode))
			out.push({ kind: 'blend', id: c.blendMode, label: `blend mode ${c.blendMode}`, ...at });
		if (isObj(c.threeD))
			out.push({
				kind: '3d',
				id: '3d',
				label: '3D layer',
				...at,
				...(float3d ? { float: { code: THREE_D_NEEDS_FLOAT, message: THREE_D_FLOAT_MESSAGE } } : {}),
			});
		const nest = isObj(c.source) && isObj(c.source.nest) ? c.source.nest.snapshot : undefined;
		if (nest) visitSnapshot(nest, depth + 1);
	};
	const visitTransitions = (list: unknown): void => {
		if (!Array.isArray(list)) return;
		for (const t of list) {
			if (!isObj(t) || typeof t.effectId !== 'string' || nodes++ >= GL_NEEDS_MAX_NODES) continue;
			const spec = transitionSpec(t.effectId);
			if (spec?.gpu)
				out.push({
					kind: 'transition',
					id: spec.id,
					label: `transition ${spec.label}`,
					...(typeof t.id === 'string' ? { transitionId: t.id } : {}),
				});
		}
	};
	const visitSnapshot = (snap: unknown, depth: number): void => {
		if (!isObj(snap) || depth > GL_NEEDS_MAX_DEPTH || seen.has(snap)) return;
		seen.add(snap);
		const outer = float3d;
		float3d = advancedNeedsFloat(snap as never);
		for (const key of ['videoTracks', 'matteTracks'] as const) {
			const tracks = snap[key];
			if (!Array.isArray(tracks)) continue;
			for (const t of tracks) {
				if (!isObj(t)) continue;
				if (Array.isArray(t.clips)) for (const c of t.clips) visitClip(c, depth);
				visitTransitions(t.transitions);
			}
		}
		float3d = outer;
	};
	visitSnapshot(doc, 0);
	return out;
}
