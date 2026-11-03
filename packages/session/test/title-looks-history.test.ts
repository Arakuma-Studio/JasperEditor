// Spec 19 (Title Looks) through the session History (AGENTS §6): each of the main new commands is ONE History entry;
// Undo restores the exact previous document and Redo the exact result. Appearance layers, project looks, a letters'
// finish, generators, template insert (with its sequence 3D look), 3D bevel bands and backplates, and a user look.
import {
	type Appearance,
	type Clip,
	type CommandInput,
	clipLook,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectInstance,
	type LookRecipe,
	type ProjectDocument,
	parseUserLook,
	USER_LOOK_VERSION,
	userLookSource,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const NOW = '2026-11-03T10:00:00.000Z';
const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }],
};

async function open() {
	const ids = createCounterIdSource(1);
	const now = () => NOW;
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Looks', preset: 'hd-1080p-30' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries() },
		sessionId: 's1',
	});
	return s;
}

const seqOf = (d: ProjectDocument) => Object.values(d.sequences)[0]!;
const lookFx = (d: ProjectDocument, clipId: string) =>
	clipLook((seqOf(d).clips[clipId] as unknown as { effects: EffectInstance[] }).effects)!;
const entries = (s: EditorSession) => s.getState().history.entries.length;

/** Applies `commands` as one user edit; checks it is one History entry, that Undo gives the document before and Redo
 * the one after (deep equality: the History restores documents, it never re-runs them partially). */
function roundTrip(s: EditorSession, label: string, commands: unknown[]) {
	const before = s.getCommitted();
	const n = entries(s);
	const r = s.apply({ label, origin: 'user', commands: commands as CommandInput[] });
	if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.errors)}`);
	const after = s.getCommitted();
	expect(after, label).not.toBe(before);
	expect(entries(s), label).toBe(n + 1);
	expect(s.undo().ok, label).toBe(true);
	expect(s.getCommitted(), `${label}: undo`).toEqual(before);
	expect(s.redo().ok, label).toBe(true);
	expect(s.getCommitted(), `${label}: redo`).toEqual(after);
	return r;
}

describe('Title Looks in the session history', () => {
	it('look.apply, appearance layers, look.update, look.delete: each undoes and redoes exactly', async () => {
		const s = await open();
		const add = roundTrip(s, 'Add Title', [
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		]);
		const t = add.refs.$t!;
		roundTrip(s, 'Apply Look', [{ type: 'look.apply', clipIds: [t], look: { name: 'Gold', recipe } }]);
		const fx = lookFx(s.getCommitted(), t);
		const lookId = (fx.appearance as Appearance).lookId!;
		roundTrip(s, 'Add Layer', [{ type: 'appearance.addLayer', effectInstanceId: fx.id, layerType: 'glow' }]);
		const rim = (lookFx(s.getCommitted(), t).appearance as Appearance).layers.find((l) => l.type === 'rim')!;
		roundTrip(s, 'Layer Off', [
			{ type: 'appearance.setLayerEnabled', effectInstanceId: fx.id, layerId: rim.id, enabled: false },
		]);
		roundTrip(s, 'Remove Layer', [
			{ type: 'appearance.removeLayer', effectInstanceId: fx.id, layerId: rim.id },
		]);
		roundTrip(s, 'Update Look', [{ type: 'look.update', lookId, fromClipId: t }]);
		roundTrip(s, 'Delete Look', [{ type: 'look.delete', lookId }]);
		expect((lookFx(s.getCommitted(), t).appearance as Appearance).lookId).toBeUndefined();
	});

	it('a finish on some letters (TL-093) undoes and redoes exactly', async () => {
		const s = await open();
		const t = roundTrip(s, 'Add Title', [
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Gold' }, ref: '$t' },
			{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Gold', recipe } },
		]).refs.$t!;
		roundTrip(s, 'Letters Finish', [
			{
				type: 'clip.update',
				clipId: t,
				patch: { content: { text: 'Gold', runs: [{ from: 0, to: 2, style: {}, finish: 'metal' }] } },
			},
		]);
		const text = seqOf(s.getCommitted()).clips[t] as Extract<Clip, { kind: 'text' }>;
		expect((text.content.runs ?? []).some((r) => (r as { finish?: string }).finish === 'metal')).toBe(true);
	});

	it('a generator clip and a user look undo and redo exactly', async () => {
		const s = await open();
		roundTrip(s, 'Add Generator', [
			{ type: 'clip.addGenerator', effectId: 'jasper.generator.lightning', at: 0, duration: 60, track: 'V1' },
		]);
		const user = parseUserLook({
			id: 'ulk_0123456789ABCDEF',
			version: USER_LOOK_VERSION,
			name: 'Mine',
			recipe,
			createdAt: NOW,
			updatedAt: NOW,
		});
		if (!user.ok) throw new Error(user.message);
		const r = roundTrip(s, 'Add Title with My Look', [
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V3', content: { text: 'Mine' }, ref: '$t' },
			{ type: 'look.apply', clipIds: ['$t'], look: userLookSource(user.look) },
		]);
		const looks = Object.values(s.getCommitted().titleLooks ?? {});
		expect(looks.map((l) => l.sourceId)).toEqual(['ulk_0123456789ABCDEF']);
		expect(lookFx(s.getCommitted(), r.refs.$t!)).toBeTruthy();
	});

	it('a 3D template, its bands and backplates undo and redo exactly, the sequence 3D look included', async () => {
		const s = await open();
		const r = roundTrip(s, 'Insert Template', [
			{ type: 'title.insertTemplate', templateId: 'template.gold-glint-end-card', at: 0 },
		]);
		expect(r.warnings.map((w) => w.code)).toContain('W_SCENE3D_SET');
		expect(seqOf(s.getCommitted()).threeD?.renderer).toBe('advanced');
		const { slots } = r.results[0] as { slots: Record<string, string> };
		const title = Object.values(slots)[0]!;
		roundTrip(s, 'Add Band', [{ type: 'threeD.addBand', clipId: title, width: 4, depth: 3 }]);
		roundTrip(s, 'Add Backplate', [{ type: 'threeD.addBackplate', clipId: title, grow: 12, depth: 8 }]);
		// The whole insert goes back in one step: renderer, look of 3D, clips and the copied looks.
		const empty = s.getCommitted();
		expect(s.undo().ok && s.undo().ok && s.undo().ok).toBe(true);
		expect(seqOf(s.getCommitted()).threeD).toBeUndefined();
		expect(s.getCommitted().titleLooks).toBeUndefined();
		expect(s.redo().ok && s.redo().ok && s.redo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(empty);
	});
});
