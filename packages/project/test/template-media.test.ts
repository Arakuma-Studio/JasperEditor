// Template media params (social comments: avatars; docs/wp-notes/social-comments.md "Template media params"):
// reference integrity (regression tests for the data-loss paths: each failed before the fix), validation, render
// snapshot and the bounded `collectParamMediaIds` walk.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { collectOrphans } from '../src/commands/handlers/project.ts';
import {
	buildClipsPayload,
	buildItemsPayload,
	buildRenderSnapshot,
	type Clip,
	type ClipboardPayload,
	checkInvariants,
	collectParamMediaIds,
	loadProject,
	makeEnvelope,
	mediaUsage,
	PARAM_MEDIA_MAX_DEPTH,
	type ProjectDocument,
	paramsPropertySpecs,
	planProjectManager,
	repairDocument,
	rewriteParamMedia,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { avatarCard, avatarRegistries } from './template-media-fixture.ts';

type Mg = Extract<Clip, { kind: 'motion-graphic' }>;

const card = avatarCard;
const registries = avatarRegistries;
const invOpts = () => ({ mgTemplates: registries().mgTemplates });

function setup() {
	const h = new Harness({ ctx: { registries: registries() } });
	const reg = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]);
	const { mediaId, itemId } = reg.results[0] as { mediaId: string; itemId: string };
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 90,
			track: 'V1',
			template: { id: 'avatar-card', version: 1 },
			params: { avatar: { mediaId } },
			ref: '$c',
		},
	]);
	return { h, mediaId, itemId, clipId: r.refs.$c! };
}
const mg = (h: Harness, id: string) => h.seq.clips[id] as Mg;
const fail = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);

describe('collectParamMediaIds', () => {
	it('finds {mediaId} objects at any depth, once each, skipping "none"', () => {
		expect(
			collectParamMediaIds({
				a: { mediaId: 'm1' },
				b: [{ mediaId: 'm2' }, null, { mediaId: '' }, { x: { mediaId: 'm1' } }],
				c: 'mediaId',
				d: { mediaId: 3 },
			}),
		).toEqual(['m1', 'm2']);
		expect(collectParamMediaIds(null)).toEqual([]);
		expect(collectParamMediaIds('m1')).toEqual([]);
	});

	it('is cycle-safe and bounded in depth', () => {
		const loop: Record<string, unknown> = { avatar: { mediaId: 'm1' } };
		loop.self = loop;
		expect(collectParamMediaIds(loop)).toEqual(['m1']);
		let deep: unknown = { mediaId: 'deep' };
		for (let i = 0; i < PARAM_MEDIA_MAX_DEPTH + 5; i++) deep = { x: deep };
		expect(collectParamMediaIds(deep)).toEqual([]);
		expect(collectParamMediaIds({ x: { mediaId: 'shallow' } })).toEqual(['shallow']);
	});

	it('agrees with a naive walk on arbitrary JSON (property)', () => {
		const naive = (v: unknown, out = new Set<string>()): Set<string> => {
			if (v && typeof v === 'object') {
				const id = (v as { mediaId?: unknown }).mediaId;
				if (!Array.isArray(v) && typeof id === 'string' && id) out.add(id);
				for (const x of Object.values(v)) naive(x, out);
			}
			return out;
		};
		const ref = fc.record({ mediaId: fc.constantFrom('a', 'b', '', 'c') });
		const json = fc.letrec((tie) => ({
			v: fc.oneof(
				{ depthSize: 'small' },
				fc.jsonValue({ maxDepth: 2 }),
				ref,
				fc.array(tie('v'), { maxLength: 4 }),
				fc.dictionary(fc.string({ maxLength: 4 }), tie('v'), { maxKeys: 4 }),
			),
		})).v;
		fc.assert(
			fc.property(json, (v) => {
				expect(new Set(collectParamMediaIds(v))).toEqual(naive(v));
			}),
		);
	});

	it('rewriteParamMedia maps, clears and keeps references without touching other branches', () => {
		const params = {
			avatar: { mediaId: 'm1' },
			other: { k: 1 },
			list: [{ mediaId: 'm2' }, { mediaId: 'm3' }],
		};
		const { value, changed } = rewriteParamMedia(params, (id) =>
			id === 'm1' ? null : id === 'm2' ? 'n2' : undefined,
		);
		expect(value).toEqual({ avatar: null, other: { k: 1 }, list: [{ mediaId: 'n2' }, { mediaId: 'm3' }] });
		expect(value.other).toBe(params.other);
		expect(changed).toEqual(['avatar', 'list.0']);
		expect(params.avatar).toEqual({ mediaId: 'm1' });
		const same = rewriteParamMedia(params, () => undefined);
		expect(same.value).toBe(params);
		expect(same.changed).toEqual([]);
	});
});

describe('reference integrity of template media (regressions: each lost the avatar before the fix)', () => {
	it('item.delete refuses to delete a medium a template param uses (E_IN_USE naming the clip)', () => {
		const { h, itemId, mediaId, clipId } = setup();
		const r = h.tx([{ type: 'item.delete', itemIds: [itemId] }]);
		expect(fail(r)?.code).toBe('E_IN_USE');
		expect(fail(r)?.blocking).toEqual([clipId]);
		expect(h.doc.media[mediaId]).toBeDefined();
		expect(mg(h, clipId).params.avatar).toEqual({ mediaId });
	});

	it('item.delete with force clears the param (the clip stays) and reports it', () => {
		const { h, itemId, mediaId, clipId } = setup();
		const r = h.ok([{ type: 'item.delete', itemIds: [itemId], force: true }]);
		expect(r.results[0]).toMatchObject({
			removedClips: [],
			clearedParams: [{ clipId, params: ['avatar'], mediaIds: [mediaId] }],
		});
		expect(mg(h, clipId).params.avatar).toBeNull();
		expect(h.doc.media[mediaId]).toBeUndefined();
		expect(checkInvariants(h.doc, invOpts())).toEqual([]);
	});

	it('item.delete keeps the reference when another item still holds the medium', () => {
		const { h, itemId, mediaId, clipId } = setup();
		const again = h.ok([{ type: 'media.register', asset: { ...h.doc.media[mediaId]!, id: undefined } }]);
		expect((again.results[0] as { mediaId: string }).mediaId).toBe(mediaId);
		h.ok([{ type: 'item.delete', itemIds: [itemId] }]);
		expect(mg(h, clipId).params.avatar).toEqual({ mediaId });
		expect(h.doc.media[mediaId]).toBeDefined();
	});

	it('collectOrphans keeps a medium only a template param references (no project item)', () => {
		const { h, itemId, mediaId } = setup();
		const doc = structuredClone(h.doc) as ProjectDocument;
		delete doc.items[itemId];
		doc.rootItems = doc.rootItems.filter((id) => id !== itemId);
		collectOrphans(doc as never);
		expect(doc.media[mediaId]).toBeDefined();
		// …and the invariants agree that it is not a leak (INV-014), nor does repair invent an item for it.
		expect(checkInvariants(doc, invOpts()).filter((i) => i.invariant === 'INV-014')).toEqual([]);
		expect(repairDocument(doc, h.ids, invOpts()).report.filter((e) => e.action === 'add-item')).toEqual([]);
	});

	it('a transaction keeps a medium referenced only from template params (nested in a list)', () => {
		const { h, itemId, mediaId, clipId } = setup();
		h.ok([{ type: 'param.set', target: ['clip', clipId, 'params', 'avatar'], value: null }]);
		h.ok([
			{ type: 'clip.update', clipId, patch: { params: { gallery: [{ mediaId }] } } },
			// the item goes away in the same transaction: the medium stays for the clip that uses it.
		]);
		const r = h.tx([{ type: 'item.delete', itemIds: [itemId] }]);
		expect(fail(r)?.code).toBe('E_IN_USE');
		h.ok([{ type: 'item.delete', itemIds: [itemId], force: true }]);
		expect(mg(h, clipId).params.gallery).toEqual([null]);
	});

	it('media.removeUnused keeps media template params use', () => {
		const { h, itemId, mediaId } = setup();
		const r = h.ok([{ type: 'media.removeUnused' }]);
		expect((r.results[0] as { removed: string[] }).removed).not.toContain(itemId);
		expect(h.doc.media[mediaId]).toBeDefined();
	});

	it('mediaUsage counts clips that use a medium through template params', () => {
		const { h, mediaId } = setup();
		expect(mediaUsage(h.doc)[mediaId]).toEqual({ clips: 1, sequences: [h.seqId] });
	});

	it('Project Manager "Exclude Unused" keeps (and collects) media template params use', () => {
		const { h, itemId, mediaId } = setup();
		const plan = planProjectManager(h.doc, { mode: 'collect', excludeUnused: true, handlesFrames: 0 });
		expect(plan.droppedItems).not.toContain(itemId);
		expect(plan.files.map((f) => f.mediaId)).toContain(mediaId);
		const consolidate = planProjectManager(h.doc, {
			mode: 'consolidate',
			excludeUnused: true,
			handlesFrames: 0,
		});
		expect(consolidate.files.find((f) => f.mediaId === mediaId)?.action).toBe('copy');
	});

	it('INV-006 reports a template param that references missing media', () => {
		const { h, mediaId, clipId } = setup();
		const doc = structuredClone(h.doc) as ProjectDocument;
		(doc.sequences[h.seqId]!.clips[clipId] as Mg).params.gallery = [{ mediaId: 'med_gone' }];
		const issues = checkInvariants(doc, invOpts()).filter((i) => i.invariant === 'INV-006');
		expect(issues).toHaveLength(1);
		expect(issues[0]!.message).toContain('med_gone');
		expect(issues[0]!.path).toEqual(['sequences', h.seqId, 'clips', clipId, 'params', 'gallery', '0']);
		expect(mediaId).toBeTruthy();
	});

	it('repairDocument clears a dangling template media param and reports it; loading repairs it', () => {
		const { h, clipId } = setup();
		const doc = structuredClone(h.doc) as ProjectDocument;
		(doc.sequences[h.seqId]!.clips[clipId] as Mg).params.avatar = { mediaId: 'med_gone' };
		const { document, report } = repairDocument(doc, h.ids, invOpts());
		expect((document.sequences[h.seqId]!.clips[clipId] as Mg).params.avatar).toBeNull();
		expect(report).toContainEqual({
			action: 'clear-template-media',
			entity: clipId,
			detail: 'params.avatar referenced missing media med_gone: cleared',
		});
		expect(checkInvariants(document, invOpts())).toEqual([]);
		const envelope = makeEnvelope(doc, { revision: 3, savedAt: '2026-10-25T10:00:00.000Z', platform: 'web' });
		const loaded = loadProject(JSON.parse(JSON.stringify(envelope)), { ids: h.ids, ...invOpts() });
		expect(loaded.readOnly).toBe(false);
		expect((loaded.document.sequences[h.seqId]!.clips[clipId] as Mg).params.avatar).toBeNull();
		expect(loaded.repairs.map((r) => r.action)).toContain('clear-template-media');
		expect(loaded.issues).toEqual([]);
	});
});

describe('copy / paste and project items across projects (clipboard, .jgt payloads)', () => {
	const other = () => new Harness({ seed: 900, ctx: { registries: registries() } });

	it('copied clips carry the avatar medium; a paste into another project remaps the param', () => {
		const { h, mediaId, clipId } = setup();
		const p = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [clipId]))) as ClipboardPayload;
		expect(p.media.map((m) => m.id)).toContain(mediaId);
		const b = other();
		expect(b.doc.projectId).not.toBe(h.doc.projectId);
		b.ok([{ type: 'clip.paste', payload: p, at: 0, tracks: { video: 'V1' } }]);
		const pasted = b.clips('V1')[0] as Mg;
		const id = (pasted.params.avatar as { mediaId: string }).mediaId;
		expect(b.doc.media[id]?.fingerprint).toBe(h.doc.media[mediaId]!.fingerprint);
		expect(Object.values(b.doc.items).some((it) => it.kind === 'media' && it.mediaId === id)).toBe(true);
		expect(checkInvariants(b.doc, invOpts())).toEqual([]);
	});

	it('a sequence item payload (what .jgt graphic templates hold) carries and remaps template media', () => {
		const { h, mediaId } = setup();
		const seqItem = Object.values(h.doc.items).find((i) => i.kind === 'sequence')!;
		const p = JSON.parse(JSON.stringify(buildItemsPayload(h.doc, [seqItem.id]))) as ClipboardPayload;
		expect(p.media.map((m) => m.id)).toContain(mediaId);
		const b = other();
		const r = b.ok([{ type: 'project.pasteItems', payload: p }]);
		const seq = b.doc.sequences[(r.results[0] as { sequenceIds: string[] }).sequenceIds[0]!]!;
		const pasted = Object.values(seq.clips).find((c) => c.kind === 'motion-graphic') as Mg;
		const id = (pasted.params.avatar as { mediaId: string }).mediaId;
		expect(b.doc.media[id]?.fingerprint).toBe(h.doc.media[mediaId]!.fingerprint);
		expect(checkInvariants(b.doc, invOpts())).toEqual([]);
	});
});

describe('validation of template media params (validateMgParams, param.set)', () => {
	it('refuses a missing medium on insert, update and param.set (E_NOT_FOUND) and accepts null', () => {
		const { h, clipId, mediaId } = setup();
		const add = h.tx([
			{
				type: 'clip.addMotionGraphic',
				at: 100,
				duration: 30,
				track: 'V1',
				template: { id: 'avatar-card', version: 1 },
				params: { avatar: { mediaId: 'med_nope' } },
			},
		]);
		expect(fail(add)?.code).toBe('E_NOT_FOUND');
		const upd = h.tx([
			{ type: 'clip.update', clipId, patch: { params: { gallery: [{ mediaId: 'med_nope' }] } } },
		]);
		expect(fail(upd)?.code).toBe('E_NOT_FOUND');
		const target = ['clip', clipId, 'params', 'avatar'];
		expect(fail(h.tx([{ type: 'param.set', target, value: { mediaId: 'med_nope' } }]))?.code).toBe(
			'E_NOT_FOUND',
		);
		h.ok([{ type: 'param.set', target, value: null }]);
		expect(mg(h, clipId).params.avatar).toBeNull();
		h.ok([{ type: 'param.set', target, value: { mediaId } }]);
		expect(mg(h, clipId).params.avatar).toEqual({ mediaId });
	});

	it('refuses media of a kind the param does not take (E_INVALID_PARAM)', () => {
		const { h, clipId } = setup();
		const audio = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio' }) }]);
		const a = (audio.results[0] as { mediaId: string }).mediaId;
		const video = h.registerVideo();
		const target = ['clip', clipId, 'params', 'avatar'];
		expect(fail(h.tx([{ type: 'param.set', target, value: { mediaId: a } }]))?.code).toBe('E_INVALID_PARAM');
		expect(fail(h.tx([{ type: 'param.set', target, value: { mediaId: video } }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		// `gallery` items take images and video.
		h.ok([{ type: 'clip.update', clipId, patch: { params: { gallery: [{ mediaId: video }] } } }]);
		expect(
			fail(h.tx([{ type: 'clip.update', clipId, patch: { params: { gallery: [{ mediaId: a }] } } }]))?.code,
		).toBe('E_INVALID_PARAM');
	});

	it('paramsPropertySpecs maps media params to the media control with their kinds', () => {
		const specs = paramsPropertySpecs(card);
		const avatar = specs.find((s) => s.key === 'params.avatar')!;
		expect(avatar).toMatchObject({
			kind: 'media',
			mediaKinds: ['image'],
			animatable: 'no',
			defaultValue: null,
			mediaNullable: true,
			ui: { control: 'media' },
		});
		expect(specs.find((s) => s.key === 'params.gallery')?.kind).not.toBe('media');
	});
});

describe('render snapshot', () => {
	it('resolves template media like effect media (handles in snapshot.media)', () => {
		const { h, mediaId, clipId } = setup();
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: (a) => ({
				url: `/media/${a.id}`,
				proxyUrl: null,
				kind: a.kind,
				width: 10,
				height: 10,
				durationFlicks: null,
				hasAudio: false,
				rotation: 0,
			}),
			resolveFont: () => null,
		});
		expect(snap.media[mediaId]?.url).toBe(`/media/${mediaId}`);
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
		expect('mg' in clip.source && clip.source.mg.params.avatar).toEqual({ mediaId });
	});
});
