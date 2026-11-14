// A ripple that keeps a generated overlay whole (packages/project overlay-ripple.ts) is one History step: undo brings
// back the card's length and keyframe times, redo refits it again.
import {
	checkInvariants,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	flicksPerFrame,
	type ProjectDocument,
	RATES,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const F = flicksPerFrame(RATES.r30);
const seqOf = (d: ProjectDocument) => Object.values(d.sequences)[0]!;

describe('overlay refit across a ripple: undo / redo', () => {
	it('undoes and redoes a range.extract that shortened a keyframed title as one step', async () => {
		const ids = createCounterIdSource(1);
		const now = () => '2026-11-14T10:00:00.000Z';
		const store = new MemoryProjectStore({ ids, now });
		const doc = createEmptyProject({ ids, name: 'Cards', preset: 'hd-1080p-30' });
		store.put(doc);
		const s = await EditorSession.open({
			store,
			projectId: doc.projectId,
			ctx: { ids, now, registries: defaultRegistries() },
			sessionId: 's1',
		});
		const scale = (id: string) => ['clip', id, 'transform', 'scale'];
		const setup = s.apply({
			label: 'Card',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 900, track: 'V1', color: [0, 0, 0, 1] },
				{ type: 'clip.addText', at: 100, duration: 363, track: 'V2', content: { text: 'Día 1' }, ref: '$t' },
				{ type: 'param.setAnimated', target: scale('$t'), animated: true, at: { flicks: 0 } },
				{ type: 'param.set', target: scale('$t'), value: 100, at: { flicks: 66 * F } },
				{ type: 'param.set', target: scale('$t'), value: 100, at: { flicks: 354 * F } },
				{ type: 'param.set', target: scale('$t'), value: 0, at: { flicks: 362 * F } },
			],
		});
		if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
		const card = setup.refs.$t!;
		const before = s.getCommitted();
		const r = s.apply({
			label: 'Extract',
			origin: 'user',
			commands: [{ type: 'range.extract', from: 300, to: 330 }],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const after = s.getCommitted();
		const keyFrames = (d: ProjectDocument) =>
			(
				seqOf(d).clips[card] as unknown as { transform: { scale: { keyframes: { time: number }[] } } }
			).transform.scale.keyframes.map((k) => k.time / F);
		expect(seqOf(after).clips[card]!.duration).toBe(333);
		expect(keyFrames(after)).toEqual([0, 66, 324, 332]);
		expect(checkInvariants(after)).toEqual([]);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toBe(before);
		expect(seqOf(s.getCommitted()).clips[card]!.duration).toBe(363);
		expect(keyFrames(s.getCommitted())).toEqual([0, 66, 354, 362]);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted()).toBe(after);
	});
});
