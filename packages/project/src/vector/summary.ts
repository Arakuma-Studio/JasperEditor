// Compact descriptions of vector shape contents (wp shapes) for agent queries (`get_timeline`, clip sources) and
// History labels: the item tree with ids, types, names, the static settings and which fields are keyframed.
import type { ShapeItem } from '../schema/shapes.ts';
import { shapeItemSpecsOf } from './properties.ts';

export type ShapeItemSummary = {
	id: string;
	type: ShapeItem['type'];
	name: string;
	enabled?: false;
	/** Current static values of the item's numeric/vector/colour fields (keyframed fields: `"animated"`). */
	values: Record<string, unknown>;
	/** Field keys (relative to the item, dotted) that have keyframes. */
	animated?: string[];
	contents?: ShapeItemSummary[];
};

const round = (v: unknown): unknown =>
	typeof v === 'number' ? Math.round(v * 1000) / 1000 : Array.isArray(v) ? v.map(round) : v;

export function shapeItemsSummary(contents: readonly ShapeItem[]): ShapeItemSummary[] {
	return contents.map((it) => {
		const values: Record<string, unknown> = {};
		const animated: string[] = [];
		for (const spec of shapeItemSpecsOf(it)) {
			let v: unknown = it;
			for (const k of spec.storagePath) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
			const key = spec.storagePath.join('.');
			if (spec.animatable === 'no') {
				if (v !== undefined) values[key] = v;
				continue;
			}
			const a = v as { value: unknown; keyframes: unknown[] } | undefined;
			if (!a) continue;
			if (a.keyframes.length) animated.push(key);
			if (spec.kind === 'json') {
				if (key === 'path') {
					const p = a.value as { vertices: unknown[]; closed: boolean };
					values[key] = `${p.vertices.length} vertices${p.closed ? ', closed' : ''}`;
				} else {
					const g = a.value as { colors: unknown[]; opacities: unknown[] };
					values[key] = `${g.colors.length} colour stops, ${g.opacities.length} opacity stops`;
				}
			} else values[key] = a.keyframes.length ? 'animated' : round(a.value);
		}
		return {
			id: it.id,
			type: it.type,
			name: it.name,
			...(it.enabled === false ? { enabled: false as const } : {}),
			values,
			...(animated.length ? { animated } : {}),
			...(it.type === 'group' ? { contents: shapeItemsSummary(it.contents) } : {}),
		};
	});
}

/** One-line outline of the tree: `Group 1 {Rectangle Path 1, Fill 1}, Trim Paths 1 (animated: end)`. */
export function shapeItemsText(contents: readonly ShapeItem[]): string {
	return shapeItemsSummary(contents)
		.map(function line(s: ShapeItemSummary): string {
			const off = s.enabled === false ? ' (off)' : '';
			const anim = s.animated?.length ? ` (animated: ${s.animated.join(', ')})` : '';
			const kids = s.contents ? ` {${s.contents.map(line).join(', ')}}` : '';
			return `${s.name}${off}${anim}${kids}`;
		})
		.join(', ');
}
