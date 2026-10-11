import type { LegacyShapeData } from '../schema/sequence.ts';
import type { ShapeItem } from '../schema/shapes.ts';
import { newShapeItem } from './defaults.ts';
import type { IdGen } from './input.ts';

/** Rectangle / ellipse clip → vector contents with the same picture (values and keyframes carried over). */
export function legacyToVectorItems(s: LegacyShapeData, ids: IdGen): ShapeItem[] {
	const items: ShapeItem[] = [];
	const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	if (s.type === 'rect') {
		const r = newShapeItem('rect', { id: ids.item(), name: 'Rectangle Path 1' });
		r.size = json(s.size);
		r.roundness = json(s.cornerRadius);
		items.push(r);
	} else {
		const e = newShapeItem('ellipse', { id: ids.item(), name: 'Ellipse Path 1' });
		e.size = json(s.size);
		items.push(e);
	}
	if (s.stroke) {
		const st = newShapeItem('stroke', { id: ids.item(), name: 'Stroke 1' });
		st.color = json(s.stroke.color);
		st.width = json(s.stroke.width);
		st.position = s.stroke.position;
		items.push(st);
	}
	if (s.fill) {
		const f = newShapeItem('fill', { id: ids.item(), name: 'Fill 1' });
		f.color = json(s.fill);
		items.push(f);
	}
	return items;
}
