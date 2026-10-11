// INV-GRAPHIC (§GR-4/5): graphic settings are readable; a layer's pins name the frame or another
// layer of the same sequence. Repair resets unreadable settings and drops dangling pins.
import type { ProjectDocument } from '../schema/document.ts';
import { GraphicSettingsSchema, LayerPinsSchema } from './graphics-schema.ts';
import { registerGapsCheck } from './settings.ts';

function pinProblem(seq: { clips: Record<string, unknown> }, clipId: string, pins: unknown): string | null {
	if (pins === undefined) return null;
	const p = LayerPinsSchema.safeParse(pins);
	if (!p.success) return 'unreadable pins';
	if (p.data.target === clipId) return 'pinned to itself';
	if (p.data.target !== 'frame' && !seq.clips[p.data.target])
		return `pinned to a missing layer ${p.data.target}`;
	return null;
}

function clipIssues(doc: Pick<ProjectDocument, 'media' | 'sequences'>) {
	const out: { invariant: string; message: string; path: string[] }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const why = pinProblem(seq, c.id, (c as { pins?: unknown }).pins);
			if (why)
				out.push({
					invariant: 'INV-GRAPHIC',
					message: `clip ${c.id}: ${why}`,
					path: ['sequences', seq.id, 'clips', c.id, 'pins'],
				});
		}
	return out;
}

registerGapsCheck({
	clipIssues,
	issues(doc) {
		const out = clipIssues(doc);
		for (const seq of Object.values(doc.sequences)) {
			const g = (seq as { graphic?: unknown }).graphic;
			if (g !== undefined && !GraphicSettingsSchema.safeParse(g).success)
				out.push({
					invariant: 'INV-GRAPHIC',
					message: `sequence ${seq.id}: unreadable graphic settings`,
					path: ['sequences', seq.id, 'graphic'],
				});
		}
		return out;
	},
	repair(doc, note) {
		for (const seq of Object.values(doc.sequences)) {
			const s = seq as { graphic?: unknown };
			if (s.graphic !== undefined && !GraphicSettingsSchema.safeParse(s.graphic).success) {
				s.graphic = { intro: 0, outro: 0, roll: null };
				note('reset-graphic', seq.id, 'unreadable graphic settings reset');
			}
			for (const c of Object.values(seq.clips)) {
				const r = c as { pins?: unknown };
				if (pinProblem(seq, c.id, r.pins)) {
					delete r.pins;
					note('drop-pins', c.id, 'dangling Responsive Design pins removed');
				}
			}
		}
	},
});
