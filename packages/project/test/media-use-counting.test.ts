// Spec 19 TL-120 / TL-021: a medium used only by a light's environment image or by an effect `{mediaId}` param
// (LUT, map, reflection image) counts as used everywhere reference integrity looks. Regression tests for the data-loss
// paths: each failed before the fix (item.delete skipped E_IN_USE, collectOrphans / Remove Unused / Project Manager
// dropped the medium, INV-014 and repair ignored the reference).
import { describe, expect, it } from 'vitest';
import { collectOrphans } from '../src/commands/handlers/project.ts';
import {
	buildClipsPayload,
	type Clip,
	type ClipboardPayload,
	checkInvariants,
	clearEffectMedia,
	clipParamMediaIds,
	createCounterIdSource,
	defaultRegistries,
	EMPTY_PROBE,
	effectMediaRefs,
	type MediaAsset,
	mediaUsage,
	type ProjectDocument,
	planProjectManager,
	repairDocument,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

type Light = Extract<Clip, { kind: 'light' }>;
type Video = Extract<Clip, { kind: 'video' }>;

const lutAsset = (): Omit<MediaAsset, 'id'> => ({
	kind: 'lut',
	fingerprint: `q1:${'9'.repeat(64)}`,
	originalName: 'look.cube',
	sizeBytes: 100,
	container: 'cube',
	probe: EMPTY_PROBE,
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_lut' }],
	derivation: null,
	importedAt: '2026-10-01T00:00:00.000Z',
	lut: { format: 'cube', dimensions: 3, size: 2, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1] },
});

/** A light whose environment is an image that has a project item and no other use. */
function lightSetup() {
	const h = new Harness();
	const reg = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]);
	const { mediaId, itemId } = reg.results[0] as { mediaId: string; itemId: string };
	const clipId = (
		h.ok([{ type: 'clip.addLight', at: 0, lightType: 'environment', environmentMediaId: mediaId }])
			.results[0] as { clipId: string }
	).clipId;
	return { h, mediaId, itemId, clipId };
}

/** A title-like still clip with a Lumetri effect whose `look` param is a LUT used nowhere else. */
function effectSetup() {
	const h = new Harness();
	const lut = h.ok([{ type: 'media.register', asset: lutAsset() }]).results[0] as {
		mediaId: string;
		itemId: string;
	};
	const clipId = (
		h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'T' } }]).results[0] as {
			clipId: string;
		}
	).clipId;
	h.ok([
		{
			type: 'effect.add',
			target: { clipId },
			effectId: 'jasper.lumetri',
			params: { look: { mediaId: lut.mediaId } },
		},
	]);
	return { h, mediaId: lut.mediaId, itemId: lut.itemId, clipId };
}
const effectsOf = (h: Harness, id: string) => (h.seq.clips[id] as Video).effects;

describe('clipParamMediaIds / effectMediaRefs', () => {
	it('counts a light environment, effect values and effect keyframes, each medium once', () => {
		const light = { kind: 'light', light: { environmentMediaId: 'm1' } } as unknown as Clip;
		expect(clipParamMediaIds(light)).toEqual(['m1']);
		expect(
			clipParamMediaIds({ kind: 'light', light: { environmentMediaId: null } } as unknown as Clip),
		).toEqual([]);
		const video = {
			kind: 'video',
			effects: [
				{
					id: 'fx_1',
					params: {
						a: {
							value: { mediaId: 'm2' },
							keyframes: [{ value: { mediaId: 'm3' } }, { value: { mediaId: '' } }],
						},
						b: { value: { mediaId: 'm2' }, keyframes: [] },
						c: { value: 5, keyframes: [] },
					},
				},
				{ id: 'fx_2', params: 'broken' },
			],
		} as unknown as Clip;
		expect(clipParamMediaIds(video)).toEqual(['m2', 'm3']);
		expect(effectMediaRefs((video as Video).effects).map((r) => [r.effectId, r.param, r.mediaId])).toEqual([
			['fx_1', 'a', 'm2'],
			['fx_1', 'a', 'm3'],
			['fx_1', 'b', 'm2'],
		]);
	});

	it('clearEffectMedia sets values and keys to None in place and reports the paths', () => {
		const effects = [
			{
				id: 'fx_1',
				params: {
					a: {
						value: { mediaId: 'gone' },
						keyframes: [{ value: { mediaId: 'keep' } }, { value: { mediaId: 'gone' } }],
					},
					b: { value: { mediaId: 'keep' }, keyframes: [] },
				},
			},
		];
		expect(clearEffectMedia(effects, (m) => m === 'gone')).toEqual(['effects.fx_1.a']);
		expect(effects[0]!.params.a.value).toEqual({ mediaId: '' });
		expect(effects[0]!.params.a.keyframes.map((k) => k.value.mediaId)).toEqual(['keep', '']);
		expect(effects[0]!.params.b.value).toEqual({ mediaId: 'keep' });
	});
});

describe('light environment media is in use (TL-120)', () => {
	it('item.delete refuses to delete the medium (E_IN_USE naming the light)', () => {
		const { h, itemId, mediaId, clipId } = lightSetup();
		const r = h.tx([{ type: 'item.delete', itemIds: [itemId] }]);
		expect(r.ok ? null : r.errors[0]!.code).toBe('E_IN_USE');
		expect(r.ok ? null : r.errors[0]!.blocking).toEqual([clipId]);
		expect(h.doc.media[mediaId]).toBeDefined();
	});

	it('item.delete with force clears the environment (the light stays) and reports it', () => {
		const { h, itemId, mediaId, clipId } = lightSetup();
		const r = h.ok([{ type: 'item.delete', itemIds: [itemId], force: true }]);
		expect(r.results[0]).toMatchObject({
			removedClips: [],
			clearedParams: [{ clipId, params: ['light.environmentMediaId'], mediaIds: [mediaId] }],
		});
		expect((h.seq.clips[clipId] as Light).light.environmentMediaId).toBeNull();
		expect(h.doc.media[mediaId]).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('collectOrphans, Remove Unused and Project Manager keep the medium', () => {
		const { h, itemId, mediaId } = lightSetup();
		const kept = h.ok([{ type: 'media.removeUnused' }]);
		expect((kept.results[0] as { removed: string[] }).removed).not.toContain(itemId);
		expect(h.doc.media[mediaId]).toBeDefined();
		const doc = structuredClone(h.doc) as ProjectDocument;
		delete doc.items[itemId];
		doc.rootItems = doc.rootItems.filter((id) => id !== itemId);
		collectOrphans(doc as never);
		expect(doc.media[mediaId]).toBeDefined();
		expect(checkInvariants(doc).filter((i) => i.invariant === 'INV-014')).toEqual([]);
		expect(repairDocument(doc, h.ids).report.filter((e) => e.action === 'add-item')).toEqual([]);
		const plan = planProjectManager(h.doc, { mode: 'collect', excludeUnused: true, handlesFrames: 0 });
		expect(plan.droppedItems).not.toContain(itemId);
		expect(plan.files.map((f) => f.mediaId)).toContain(mediaId);
	});

	it('mediaUsage counts the light, and copy carries the image to another project', () => {
		const { h, mediaId, clipId } = lightSetup();
		expect(mediaUsage(h.doc)[mediaId]).toEqual({ clips: 1, sequences: [h.seqId] });
		const p = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [clipId]))) as ClipboardPayload;
		expect(p.media.map((m) => m.id)).toContain(mediaId);
		const b = new Harness({ seed: 900 });
		const res = b.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as { clipIds: string[] };
		const pasted = b.seq.clips[res.clipIds[0]!] as Light;
		expect(pasted.light.environmentMediaId).toBeTruthy();
		expect(b.doc.media[pasted.light.environmentMediaId!]).toBeDefined();
		expect(checkInvariants(b.doc)).toEqual([]);
	});

	it('a shared environment survives while another item still holds the medium', () => {
		const { h, itemId, mediaId, clipId } = lightSetup();
		h.ok([{ type: 'media.register', asset: { ...h.doc.media[mediaId]!, id: undefined } }]);
		h.ok([{ type: 'item.delete', itemIds: [itemId] }]);
		expect((h.seq.clips[clipId] as Light).light.environmentMediaId).toBe(mediaId);
	});
});

describe('effect {mediaId} params are in use (TL-120)', () => {
	it('item.delete refuses to delete the medium (E_IN_USE naming the clip)', () => {
		const { h, itemId, mediaId, clipId } = effectSetup();
		const r = h.tx([{ type: 'item.delete', itemIds: [itemId] }]);
		expect(r.ok ? null : r.errors[0]!.code).toBe('E_IN_USE');
		expect(r.ok ? null : r.errors[0]!.blocking).toEqual([clipId]);
		expect(h.doc.media[mediaId]).toBeDefined();
	});

	it('item.delete with force sets the param to None (the clip and effect stay) and reports it', () => {
		const { h, itemId, mediaId, clipId } = effectSetup();
		const fx = effectsOf(h, clipId)[0]!;
		const r = h.ok([{ type: 'item.delete', itemIds: [itemId], force: true }]);
		expect(r.results[0]).toMatchObject({
			removedClips: [],
			clearedParams: [{ clipId, params: [`effects.${fx.id}.look`], mediaIds: [mediaId] }],
		});
		expect(effectsOf(h, clipId)[0]!.params.look!.value).toEqual({ mediaId: '' });
		expect(h.doc.media[mediaId]).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
		// the deletion is one undoable step in the document history: the command result is pure data.
		expect(h.seq.clips[clipId]).toBeDefined();
	});

	it('collectOrphans, Remove Unused and Project Manager keep the medium', () => {
		const { h, itemId, mediaId } = effectSetup();
		const kept = h.ok([{ type: 'media.removeUnused' }]);
		expect((kept.results[0] as { removed: string[] }).removed).not.toContain(itemId);
		const doc = structuredClone(h.doc) as ProjectDocument;
		delete doc.items[itemId];
		doc.rootItems = doc.rootItems.filter((id) => id !== itemId);
		collectOrphans(doc as never);
		expect(doc.media[mediaId]).toBeDefined();
		expect(checkInvariants(doc).filter((i) => i.invariant === 'INV-014')).toEqual([]);
		expect(repairDocument(doc, h.ids).report.filter((e) => e.action === 'add-item')).toEqual([]);
		const plan = planProjectManager(h.doc, { mode: 'collect', excludeUnused: true, handlesFrames: 0 });
		expect(plan.droppedItems).not.toContain(itemId);
		expect(plan.files.map((f) => f.mediaId)).toContain(mediaId);
		expect(mediaUsage(h.doc)[mediaId]?.clips).toBe(1);
	});

	it('repair clears a dangling effect media param and reports it', () => {
		const { h, clipId } = effectSetup();
		const doc = structuredClone(h.doc) as ProjectDocument;
		const clip = doc.sequences[h.seqId]!.clips[clipId] as Video;
		const fx = clip.effects[0]!;
		fx.params.look!.value = { mediaId: 'med_gone' };
		const opts = { effects: defaultRegistries().effects };
		expect(checkInvariants(doc, opts).some((i) => i.invariant === 'INV-006')).toBe(true);
		const { document, report } = repairDocument(doc, createCounterIdSource(5));
		const fixed = (document.sequences[h.seqId]!.clips[clipId] as Video).effects[0]!;
		expect(fixed.params.look!.value).toEqual({ mediaId: '' });
		expect(report).toContainEqual({
			action: 'clear-effect-media',
			entity: clipId,
			detail: `effects.${fx.id}.look referenced missing media: cleared`,
		});
		expect(checkInvariants(document, opts).filter((i) => i.invariant === 'INV-006')).toEqual([]);
	});
});
