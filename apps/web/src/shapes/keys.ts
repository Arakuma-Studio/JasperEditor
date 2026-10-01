// Shape property keys a clip currently carries (wp-m2-shapes): a "None" fill or stroke has no rows, ellipses have
// no corner radius. Used by Effect Controls ▸ Shape (stopwatch rows, S11:SHP-005).
import type { Clip } from '@jasper/project';

export function shapePropertyKeys(clip: Clip): string[] {
	if (clip.kind !== 'shape') return [];
	const s = clip.shape;
	return [
		'shape.size',
		...(s.fill ? ['shape.fill'] : []),
		...(s.stroke ? ['shape.stroke.color', 'shape.stroke.width', 'shape.stroke.position'] : []),
		...(s.type === 'rect' ? ['shape.cornerRadius'] : []),
	];
}
