// Export checks of object mattes (parity workstream `roto`): every path renders object mattes from the computed matte
// sets, so a frame that an exported clip shows inside a roto's span without a computed matte would silently come out
// unmatted — the planner refuses such exports with a named reason instead (AGENTS.md §4). Stale mattes (strokes or
// settings changed since the propagation) render as computed and are reported as warnings.
import { contentTimeAt } from '../derive/index.ts';
import type { RenderSnapshot, RenderVisualClip } from '../render/snapshot.ts';
import type { Rational } from '../time.ts';
import { mediaFrameAt, ROTO_OBJECT_PARAMS, rotoFrameState } from './index.ts';

export type RotoExportIssue = {
	clipId: string;
	rotoId: string;
	kind: 'not-computed' | 'stale';
	message: string;
	/** Media frames without a matte (not-computed). */
	frames?: [number, number];
};

function clipsOf(snap: RenderSnapshot): RenderVisualClip[] {
	const out: RenderVisualClip[] = [];
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			out.push(c);
			if ('nest' in c.source) out.push(...clipsOf(c.source.nest.snapshot));
		}
	return out;
}

/** Problems of the object mattes an export of `snap` (its range) would draw. */
export function rotoExportIssues(snap: RenderSnapshot): RotoExportIssue[] {
	const out: RotoExportIssue[] = [];
	const fps = snap.settings.fps as Rational;
	for (const c of clipsOf(snap)) {
		if (!c.rotos) continue;
		const used = new Set<string>();
		for (const fx of c.effects) {
			if (!fx.enabled) continue;
			for (const name of ROTO_OBJECT_PARAMS[fx.effectId] ?? []) {
				const a = fx.params[name];
				for (const v of a ? [a.value, ...a.keyframes.map((k) => k.value)] : [])
					if (typeof v === 'string' && v && c.rotos[v]) used.add(v);
			}
		}
		for (const id of used) {
			const m = c.rotos[id]!;
			const head = c.headHandle ?? 0;
			const tail = c.tailHandle ?? 0;
			const f0 = Math.max(c.start - head, snap.range.start);
			const f1 = Math.min(c.start + c.duration + tail, snap.range.end);
			let lo = Number.POSITIVE_INFINITY;
			let hi = Number.NEGATIVE_INFINITY;
			for (let f = f0; f < f1; f++) {
				const mf = c.kind === 'still' ? 0 : mediaFrameAt(contentTimeAt(c, f, fps), m.rate);
				if (rotoFrameState(m, mf) === 'missing') {
					lo = Math.min(lo, mf);
					hi = Math.max(hi, mf);
				}
			}
			if (hi >= lo)
				out.push({
					clipId: c.clipId,
					rotoId: id,
					kind: 'not-computed',
					frames: [lo, hi],
					message: `roto "${m.name}" of clip "${c.name}" has no computed matte for media frames ${lo}–${hi}: propagate it over its span first`,
				});
			else if (m.stale && m.key)
				out.push({
					clipId: c.clipId,
					rotoId: id,
					kind: 'stale',
					message: `roto "${m.name}" of clip "${c.name}" changed since it was propagated: the export uses the last computed mattes`,
				});
		}
	}
	return out;
}
