// spec 13 SH-003 / AS-032: batch styling and linked text style commands are one History entry each, whatever the
// number of clips; undo restores the exact previous document and redo the exact result.
import {
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const N = 100;

async function open() {
	const ids = createCounterIdSource(1);
	const now = () => '2026-10-25T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Subtitles', preset: 'hd-1080p-30' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	s.apply({
		label: 'Subtitles',
		origin: 'user',
		commands: Array.from({ length: N }, (_, i) => ({
			type: 'clip.addText' as const,
			at: i * 20,
			duration: 20,
			track: 'V2',
			content: { text: `w${i}` },
		})),
	});
	const clipIds = (d: ProjectDocument) =>
		Object.values(Object.values(d.sequences)[0]!.clips)
			.filter((c) => c.kind === 'text')
			.map((c) => c.id);
	return { s, clipIds: clipIds(s.getCommitted()) };
}

describe('text style commands in the session history', () => {
	it('each batch command over 100 clips is one undo step, exact both ways', async () => {
		const { s, clipIds } = await open();
		const steps: CommandInput[][] = [
			[{ type: 'text.setStyle', clipIds, patch: { strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }] } }],
			[{ type: 'text.setStyle', clipIds, patch: { strokes: { set: [{ index: 0, widthPx: 14 }] }, shadow: { blurPx: 6 } } }],
			[
				{ type: 'textStyle.create', name: 'Pixel Pop', fromClipId: clipIds[0]!, ref: '$s' },
				{ type: 'textStyle.apply', styleId: '$s', clipIds },
			],
			[{ type: 'effect.addMany', clipIds, effectId: 'jasper.gaussian-blur', keyframes: { radius: [{ offset: { frames: 0 }, value: 20 }, { offset: { frames: 3 }, value: 0 }] } }],
			[{ type: 'effect.setParamMany', clipIds, effectId: 'jasper.gaussian-blur', param: 'radius', value: 9, at: { frames: 1 } }],
			[{ type: 'effect.removeMany', clipIds, effectId: 'jasper.gaussian-blur' }],
		];
		for (const commands of steps) {
			const before = s.getCommitted();
			const snapshot = structuredClone(before);
			const depth = s.getState().history.index;
			const r = s.apply({ label: 'Step', origin: 'user', commands });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(s.getState().history.index).toBe(depth + 1);
			const after = s.getCommitted();
			const afterSnapshot = structuredClone(after);
			expect(s.undo().ok).toBe(true);
			expect(s.getCommitted()).toEqual(snapshot);
			expect(s.redo().ok).toBe(true);
			expect(s.getCommitted()).toEqual(afterSnapshot);
		}
		const doc = s.getCommitted();
		const styleId = Object.keys(doc.textStyles ?? {})[0]!;
		const before = structuredClone(doc);
		expect(s.apply({ label: 'Edit Style', origin: 'user', commands: [{ type: 'textStyle.update', styleId, patch: { sizePx: 98 } }] }).ok).toBe(true);
		const seq = Object.values(s.getCommitted().sequences)[0]!;
		expect(clipIds.every((id) => (seq.clips[id] as { content: { style: { sizePx: number } } }).content.style.sizePx === 98)).toBe(true);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(before);
	});
});
