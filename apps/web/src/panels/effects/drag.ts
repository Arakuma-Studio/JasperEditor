// Effect drag payload and "apply effect" helpers (S03:FX-010, S05:EFX-002).
//
// Contract (additive, owned by WP-2D): dragging an effect from the Effects panel puts
//   DataTransfer[JASPER_EFFECT_MIME] = JSON.stringify({ type: 'jasper/effect', effectId })
// plus a text/plain fallback. Drop targets (Timeline clips — WP-2B, Program monitor layers — WP-2C,
// Effect Controls — WP-2D) read it with `readEffectDragPayload(dt)` and apply it with
// `applyEffectToClips(session, effectId, clipIds, index?)`, which commits ONE transaction for N clips.
import type { Command, EffectRegistry, TransactionResult } from '@jasper/project';
import { effectBadges, isKnownClipKind, kindCapabilities } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

export type EffectDragPayload = { type: 'jasper/effect'; effectId: string };

export const JASPER_EFFECT_MIME = 'application/x-jasper-effect';
/** In-panel reorder of an applied effect instance (Effect Controls, S03:EC-030). */
export const JASPER_EFFECT_INSTANCE_MIME = 'application/x-jasper-effect-instance';

export function writeEffectDragPayload(dt: DataTransfer, effectId: string): void {
	const payload: EffectDragPayload = { type: 'jasper/effect', effectId };
	dt.setData(JASPER_EFFECT_MIME, JSON.stringify(payload));
	dt.setData('text/plain', `jasper-effect:${effectId}`);
	dt.effectAllowed = 'copy';
}

/** True while dragging an effect (types are readable during dragover, data is not). */
export function isEffectDrag(dt: DataTransfer | null): boolean {
	return !!dt && Array.from(dt.types ?? []).includes(JASPER_EFFECT_MIME);
}

export function readEffectDragPayload(dt: DataTransfer | null): EffectDragPayload | null {
	if (!dt) return null;
	const raw = dt.getData(JASPER_EFFECT_MIME);
	if (raw) {
		try {
			const p = JSON.parse(raw) as Partial<EffectDragPayload>;
			if (p.type === 'jasper/effect' && typeof p.effectId === 'string')
				return { type: p.type, effectId: p.effectId };
		} catch {
			return null;
		}
	}
	const text = dt.getData('text/plain');
	return text.startsWith('jasper-effect:') ? { type: 'jasper/effect', effectId: text.slice(14) } : null;
}

/** Clips (of the committed document) that accept the effect: effects-capable kind of the right medium. */
export function clipsAccepting(
	session: EditorSession,
	effectId: string,
	clipIds: readonly string[],
): string[] {
	const spec = session.ctx.registries.effects.get(effectId);
	if (!spec) return [];
	const doc = session.getCommitted();
	const out: string[] = [];
	for (const id of clipIds) {
		for (const seq of Object.values(doc.sequences)) {
			const c = seq.clips[id];
			if (!c || !isKnownClipKind(c.kind)) continue;
			const caps = kindCapabilities(c.kind);
			const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === c.trackId);
			if (!caps?.supportsEffects || track?.locked) continue;
			if ((spec.appliesTo === 'video' && caps.visual) || (spec.appliesTo === 'audio' && caps.audio))
				out.push(id);
		}
	}
	return out;
}

/** Applies an effect to clips as one undo step ("Apply <Effect>"), appended or at `index`. */
export function applyEffectToClips(
	session: EditorSession,
	effectId: string,
	clipIds: readonly string[],
	index?: number,
): TransactionResult | null {
	const targets = clipsAccepting(session, effectId, clipIds);
	if (targets.length === 0) return null;
	const spec = session.ctx.registries.effects.get(effectId)!;
	return session.apply({
		label: targets.length > 1 ? `Apply ${spec.label} (${targets.length} clips)` : `Apply ${spec.label}`,
		origin: 'user',
		commands: targets.map(
			(clipId) =>
				({
					type: 'effect.add',
					target: { clipId },
					effectId,
					...(index !== undefined ? { index } : {}),
				}) as Command,
		),
	});
}

/** Effects grouped for the Effects panel tree (S05:EFX-001): medium → category → effects. */
export function effectTree(
	registry: EffectRegistry,
	filter: { query: string; realtime: boolean; native: boolean },
) {
	const q = filter.query.trim().toLowerCase();
	const groups = new Map<string, Map<string, ReturnType<EffectRegistry['list']>>>();
	for (const e of registry.list()) {
		const hay = [e.label, e.id, e.category, ...(e.keywords ?? [])].join(' ').toLowerCase();
		if (q && !hay.includes(q)) continue;
		if (filter.realtime && e.capabilities.preview === 'none') continue;
		// Colour effects are native through the fused LUT (S06), not a filter string: use the shared badge rule.
		if (filter.native && !effectBadges(e).native) continue;
		const medium = e.appliesTo === 'video' ? 'Video Effects' : 'Audio Effects';
		const byCat = groups.get(medium) ?? new Map();
		byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
		groups.set(medium, byCat);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a === 'Video Effects' ? -1 : b === 'Video Effects' ? 1 : a.localeCompare(b)))
		.map(([medium, cats]) => ({
			medium,
			categories: [...cats.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([category, effects]) => ({
					category,
					effects: [...effects].sort((x, y) => x.label.localeCompare(y.label)),
				})),
		}));
}

// ---------------------------------------------------------------- transitions (S10:TUI-020)

/**
 * Contract (M2, wp-m2-transitions): dragging a transition from the Effects panel puts
 *   DataTransfer[JASPER_TRANSITION_MIME] = JSON.stringify({ type: 'jasper/transition', effectId })
 * plus a `jasper-transition:<effectId>` text/plain fallback. The timeline resolves the drop target while
 * dragging (data is unreadable during dragover, so the id is also kept in `activeTransitionDrag()`).
 */
export type TransitionDragPayload = { type: 'jasper/transition'; effectId: string };

export const JASPER_TRANSITION_MIME = 'application/x-jasper-transition';

let dragging: string | null = null;

export function writeTransitionDragPayload(dt: DataTransfer, effectId: string): void {
	const payload: TransitionDragPayload = { type: 'jasper/transition', effectId };
	dt.setData(JASPER_TRANSITION_MIME, JSON.stringify(payload));
	dt.setData('text/plain', `jasper-transition:${effectId}`);
	dt.effectAllowed = 'copy';
	dragging = effectId;
}

/** The transition being dragged in this window (set on dragstart, cleared on dragend). */
export function activeTransitionDrag(): string | null {
	return dragging;
}
export function endTransitionDrag(): void {
	dragging = null;
}

export function isTransitionDrag(dt: DataTransfer | null): boolean {
	return !!dt && Array.from(dt.types ?? []).includes(JASPER_TRANSITION_MIME);
}

export function readTransitionDragPayload(dt: DataTransfer | null): TransitionDragPayload | null {
	if (!dt) return null;
	const raw = dt.getData(JASPER_TRANSITION_MIME);
	if (raw) {
		try {
			const p = JSON.parse(raw) as Partial<TransitionDragPayload>;
			if (p.type === 'jasper/transition' && typeof p.effectId === 'string')
				return { type: p.type, effectId: p.effectId };
		} catch {
			return null;
		}
	}
	const text = dt.getData('text/plain');
	return text.startsWith('jasper-transition:')
		? { type: 'jasper/transition', effectId: text.slice('jasper-transition:'.length) }
		: null;
}
