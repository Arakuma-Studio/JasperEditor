// spec 13 SH-004: the session measures text the measurer could not size yet (clips made headless, fonts loading)
// as soon as it can — system transactions, no History entries — and undo / redo keep working around them.
import {
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type TextMeasurer,
	applyTransaction,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/index.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
const NOW = () => '2026-10-25T10:00:00.000Z';

/** A measurer that cannot measure until `ready()` (fonts loading), then 0.5 em per character. */
function loadingMeasurer() {
	let ready = false;
	const listeners = new Set<() => void>();
	const m: TextMeasurer & { onSettled(cb: () => void): () => void } = {
		measure(content, box) {
			if (!ready) return null;
			return {
				width: box.autoSize === 'width' ? content.text.length * content.style.sizePx * 0.5 : box.width,
				height: Math.ceil(content.style.sizePx * content.style.lineHeight),
			};
		},
		onSettled(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
	return {
		m,
		ready() {
			ready = true;
			for (const l of listeners) l();
		},
	};
}

/** A document with one text clip made headless (estimated box, layoutPending). */
function headlessDoc(): { doc: ProjectDocument; clipId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const seqId = Object.keys(base.sequences)[0]!;
	const { document, result } = applyTransaction(
		base,
		{
			label: 'agent',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hello', style: { sizePx: 100 } }, ref: '$t' }],
		},
		{ ids, now: NOW, revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error('setup');
	return { doc: document, clipId: result.refs.$t! };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const clipOf = (s: EditorSession, id: string) =>
	Object.values(s.getCommitted().sequences)[0]!.clips[id] as TextClip;

describe('pending text relayout (spec 13 SH-004)', () => {
	it('measures pending clips when the measurer becomes able to, without a History entry', async () => {
		const { doc, clipId } = headlessDoc();
		const { m, ready } = loadingMeasurer();
		const s = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids: createCounterIdSource(100), now: NOW, registries: defaultRegistries(), textMeasurer: m },
		});
		await tick();
		expect(clipOf(s, clipId).layoutPending).toBe(true);
		ready();
		await tick();
		expect(clipOf(s, clipId).layoutPending).toBeUndefined();
		expect(clipOf(s, clipId).box).toMatchObject({ width: 250, height: 120 });
		expect(s.getState().history.entries).toEqual([]);
		expect(s.getState().dirty).toBe(true);
		await s.close();
	});

	it('redo back to an estimated box measures it again; edits keep the measured box; one History entry each', async () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
		const { m, ready } = loadingMeasurer();
		const s = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids: createCounterIdSource(100), now: NOW, registries: defaultRegistries(), textMeasurer: m },
		});
		const r = s.apply({
			label: 'Add Text',
			origin: 'user',
			commands: [{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hello', style: { sizePx: 100 } }, ref: '$t' }],
		});
		if (!r.ok) throw new Error('add text');
		const clipId = r.refs.$t!;
		expect(clipOf(s, clipId).layoutPending).toBe(true);
		ready();
		await tick();
		expect(clipOf(s, clipId).box.width).toBe(250);
		s.apply({ label: 'Edit', origin: 'user', commands: [{ type: 'clip.update', clipId, patch: { content: { text: 'Hello world' } } }] });
		expect(clipOf(s, clipId).box.width).toBe(550);
		expect(s.undo().ok).toBe(true);
		expect(clipOf(s, clipId).box.width).toBe(250);
		expect(s.undo().ok).toBe(true);
		expect(Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips)).toEqual([]);
		// redo brings back the clip as it was created (estimated): it is measured again
		expect(s.redo().ok).toBe(true);
		await tick();
		expect(clipOf(s, clipId).layoutPending).toBeUndefined();
		expect(clipOf(s, clipId).box.width).toBe(250);
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add Text', 'Edit']);
		expect(s.redo().ok).toBe(true);
		expect(clipOf(s, clipId).box.width).toBe(550);
		await s.close();
	});

	it('a read-only session and a session without a measurer leave the document alone', async () => {
		const { doc, clipId } = headlessDoc();
		const { m, ready } = loadingMeasurer();
		ready();
		const ro = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			readOnly: true,
			ctx: { ids: createCounterIdSource(100), now: NOW, registries: defaultRegistries(), textMeasurer: m },
		});
		await tick();
		expect(clipOf(ro, clipId).layoutPending).toBe(true);
		const plain = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids: createCounterIdSource(100), now: NOW, registries: defaultRegistries() },
		});
		await tick();
		expect(plain.getCommitted()).toBe(doc);
		expect(plain.relayoutPendingText()).toBeNull();
		await ro.close();
		await plain.close();
	});
});
