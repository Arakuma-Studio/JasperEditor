// S07 §8 test 1 (model): media.derive and clip.replaceSource (PRC-001…007).
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type ClipTracker,
	checkInvariants,
	diffDocuments,
	mediaVersionsOf,
	originalMediaId,
	type ProcessStep,
	type ProjectDocument,
	processedItemName,
	resolveSceneAt,
	type VideoClip,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const STABILIZE: ProcessStep = { op: 'stabilize', method: 'auto', smoothing: 15, borders: 'crop' };
const UPSCALE_2X: ProcessStep = { op: 'upscale', model: 'span-2x', scale: 2 };
const DENOISE: ProcessStep = { op: 'denoise', method: 'nlmeans', strength: 0.4 };

let hashN = 0;
/** What the engine sends: RegisteredMedia fields of the processed file + recipe version/hash. */
function processedAsset(opts: { width: number; height: number; seconds?: number; recipeHash?: string }) {
	const { kind: _k, derivation: _d, importedAt: _i, id: _id, ...rest } = videoAsset({ ...opts, audio: true });
	return {
		...rest,
		container: 'mov,mp4,m4a,3gp,3g2,mj2',
		recipeVersion: 1,
		recipeHash: opts.recipeHash ?? `sha256:${(++hashN).toString(16).padStart(64, '0')}`,
	};
}

function recipe(...steps: ProcessStep[]) {
	return { op: 'process' as const, steps };
}

function patchDoc(h: Harness, fn: (doc: ProjectDocument) => void) {
	const copy = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
	fn(copy);
	h.doc = copy;
}

/** Project with bin "Footage" (in bin "Shoot") holding "crudo" (848×480), placed at 0 on V1/A1 (linked). */
function setup(opts: { width?: number; height?: number; nested?: boolean } = {}) {
	const h = new Harness();
	const r = h.ok([
		...(opts.nested === false ? [] : [{ type: 'bin.create', name: 'Shoot', ref: '$shoot' }]),
		{
			type: 'bin.create',
			name: 'Footage',
			...(opts.nested === false ? {} : { parentBinId: '$shoot' }),
			ref: '$footage',
		},
		{
			type: 'media.register',
			asset: videoAsset({ width: opts.width ?? 848, height: opts.height ?? 480, seconds: 10 }),
			binId: '$footage',
			name: 'crudo',
			ref: '$m',
			itemRef: '$item',
		},
	]);
	h.ok([{ type: 'clip.place', source: { mediaId: r.refs.$m }, at: 0 }]);
	const video = h.clips('V1')[0]!;
	const audio = h.clips('A1')[0]!;
	return {
		h,
		shoot: r.refs.$shoot,
		footage: r.refs.$footage!,
		mediaId: r.refs.$m!,
		itemId: r.refs.$item!,
		videoId: video.id,
		audioId: audio.id,
	};
}

const videoClip = (h: Harness, id: string) => h.seq.clips[id] as VideoClip;
const codeOf = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]!.code);

describe('media.derive (S07:PRC-001, PRC-004, PRC-005)', () => {
	it('adds the asset and its item in a "Processed" bin next to the original bin, and swaps clips in one transaction', () => {
		const { h, shoot, footage, mediaId, videoId, audioId } = setup();
		const before = h.doc;
		const beforeJson = JSON.stringify(before);
		const asset = processedAsset({ width: 1696, height: 960 });
		const r = h.ok(
			[
				{
					type: 'media.derive',
					fromMediaId: mediaId,
					recipe: recipe(STABILIZE, UPSCALE_2X),
					asset,
					replaceInClips: [videoId],
					ref: '$v',
				},
			],
			{ label: 'Process Media' },
		);
		const res = r.results[0] as {
			mediaId: string;
			itemId: string;
			binId: string;
			deduped: boolean;
			clipIds: string[];
		};
		expect(r.refs.$v).toBe(res.mediaId);
		expect(res.deduped).toBe(false);
		expect(res.clipIds).toEqual([videoId]);

		const m = h.doc.media[res.mediaId]!;
		expect(m.kind).toBe('video');
		expect(m.fingerprint).toBe(asset.fingerprint);
		expect(m.probe).toEqual(asset.probe);
		expect(m.locators).toEqual(asset.locators);
		expect(m.derivation).toEqual({
			fromMediaId: mediaId,
			recipe: recipe(STABILIZE, UPSCALE_2X),
			recipeVersion: 1,
			recipeHash: asset.recipeHash,
		});
		expect(m).not.toHaveProperty('recipeHash');

		const item = h.doc.items[res.itemId]!;
		expect(item).toMatchObject({ kind: 'media', name: 'crudo [Stabilized · Upscaled 2×]', mediaId: m.id });
		const bin = h.doc.items[res.binId]!;
		expect(bin).toMatchObject({ kind: 'bin', name: 'Processed', children: [res.itemId] });
		// Sibling of "Footage", right after it, inside "Shoot".
		const shootBin = h.doc.items[shoot!]!;
		expect(shootBin.kind === 'bin' && shootBin.children).toEqual([footage, res.binId]);

		// The video clip switched; timing, links and the linked audio (PRC-007) did not.
		const v = videoClip(h, videoId);
		const vb = before.sequences[h.seqId]!.clips[videoId] as VideoClip;
		expect(v.mediaId).toBe(m.id);
		expect({ ...v, mediaId: vb.mediaId, transform: vb.transform }).toEqual(vb);
		expect((h.seq.clips[audioId] as { mediaId: string }).mediaId).toBe(mediaId);
		expect(v.linkId).not.toBeNull();
		expect(h.seq.clips[audioId]!.linkId).toBe(v.linkId);

		expect(checkInvariants(h.doc)).toEqual([]);
		// One transaction = one history entry: the previous snapshot (undo) is untouched, the diff is complete.
		expect(JSON.stringify(before)).toBe(beforeJson);
		const diff = diffDocuments(before, h.doc);
		expect(diff.created).toEqual(expect.arrayContaining([m.id, res.itemId, res.binId]));
		expect(diff.changed).toEqual(expect.arrayContaining([videoId]));
		expect(diff.changed).not.toContain(audioId);
	});

	it('names items from the step labels', () => {
		expect(processedItemName('crudo', recipe(STABILIZE, UPSCALE_2X))).toBe(
			'crudo [Stabilized · Upscaled 2×]',
		);
		expect(
			processedItemName(
				'x',
				recipe(
					{ op: 'dejudder', mode: 'auto' },
					DENOISE,
					{ op: 'deblock', filter: 'weak' },
					{ op: 'upscale', model: 'm', scale: 4 },
				),
			),
		).toBe('x [De-juddered · Denoised · Deblocked · Upscaled 4×]');
	});

	it('is idempotent: the same file (or the same recipe of the same source) is reused, the swaps still happen', () => {
		const { h, mediaId, videoId } = setup();
		const asset = processedAsset({ width: 848, height: 480 });
		const r1 = h.ok([{ type: 'media.derive', fromMediaId: mediaId, recipe: recipe(DENOISE), asset }]);
		const first = r1.results[0] as { mediaId: string; itemId: string; binId: string };
		expect(videoClip(h, videoId).mediaId).toBe(mediaId);
		const nItems = Object.keys(h.doc.items).length;
		const nMedia = Object.keys(h.doc.media).length;

		const r2 = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(DENOISE),
				asset,
				replaceInClips: [videoId],
			},
		]);
		const second = r2.results[0] as { mediaId: string; itemId: string; deduped: boolean; clipIds: string[] };
		expect(second).toMatchObject({ mediaId: first.mediaId, itemId: first.itemId, deduped: true });
		expect(second.clipIds).toEqual([videoId]);
		expect(r2.warnings.map((w) => w.code)).toContain('W_DEDUPED');
		expect(Object.keys(h.doc.items).length).toBe(nItems);
		expect(Object.keys(h.doc.media).length).toBe(nMedia);
		expect(videoClip(h, videoId).mediaId).toBe(first.mediaId);

		// Same source + recipe hash with a different fingerprint (re-encoded): still the same asset.
		const again = { ...processedAsset({ width: 848, height: 480 }), recipeHash: asset.recipeHash };
		const r3 = h.ok([{ type: 'media.derive', fromMediaId: mediaId, recipe: recipe(DENOISE), asset: again }]);
		expect((r3.results[0] as { mediaId: string }).mediaId).toBe(first.mediaId);

		// Another recipe reuses the "Processed" bin.
		const r4 = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(STABILIZE),
				asset: processedAsset({ width: 848, height: 480 }),
			},
		]);
		const fourth = r4.results[0] as { mediaId: string; binId: string };
		expect(fourth.mediaId).not.toBe(first.mediaId);
		expect(fourth.binId).toBe(first.binId);
		expect(Object.values(h.doc.items).filter((i) => i.kind === 'bin' && i.name === 'Processed')).toHaveLength(
			1,
		);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('puts the bin at the root when the original bin is at the root; binId overrides', () => {
		const { h, footage, mediaId } = setup({ nested: false });
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(DENOISE),
				asset: processedAsset({ width: 848, height: 480 }),
			},
		]);
		const binId = (r.results[0] as { binId: string }).binId;
		expect(h.doc.rootItems.indexOf(binId)).toBe(h.doc.rootItems.indexOf(footage) + 1);

		const r2 = h.ok([
			{ type: 'bin.create', name: 'Mine', ref: '$mine' },
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(STABILIZE),
				asset: processedAsset({ width: 848, height: 480 }),
				binId: '$mine',
			},
		]);
		const res = r2.results[1] as { binId: string; itemId: string };
		expect(res.binId).toBe(r2.refs.$mine);
		const mine = h.doc.items[r2.refs.$mine!]!;
		expect(mine.kind === 'bin' && mine.children).toEqual([res.itemId]);
	});

	it('an original item at the project root gets a "Processed" bin at the root', () => {
		const h = new Harness();
		const mediaId = h.registerVideo({ width: 1280, height: 720 });
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(UPSCALE_2X),
				asset: processedAsset({ width: 2560, height: 1440 }),
			},
		]);
		const res = r.results[0] as { binId: string; itemId: string };
		expect(h.doc.rootItems).toContain(res.binId);
		expect(h.doc.items[res.itemId]!.name).toBe(`${h.doc.media[mediaId]!.originalName} [Upscaled 2×]`);
	});

	it('refuses without an engine asset, for unknown or non-video sources, and rolls back failed swaps', () => {
		const { h, mediaId, audioId, videoId } = setup();
		const noAsset = h.tx([{ type: 'media.derive', fromMediaId: mediaId, recipe: recipe(DENOISE) }]);
		expect(codeOf(noAsset)).toBe('E_INVALID_PARAM');
		if (!noAsset.ok) expect(noAsset.errors[0]!.message).toMatch(/asset/);
		const asset = processedAsset({ width: 848, height: 480 });
		expect(
			codeOf(
				h.tx([{ type: 'media.derive', fromMediaId: 'med_0000000000000000', recipe: recipe(DENOISE), asset }]),
			),
		).toBe('E_NOT_FOUND');
		const audioOnly = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio' }), ref: '$a' }]).refs
			.$a!;
		expect(
			codeOf(h.tx([{ type: 'media.derive', fromMediaId: audioOnly, recipe: recipe(DENOISE), asset }])),
		).toBe('E_INVALID_PARAM');
		// The audio clip cannot switch: the whole transaction (asset, item, bin) is rolled back.
		const doc = h.doc;
		const r = h.tx([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(DENOISE),
				asset,
				replaceInClips: [videoId, audioId],
			},
		]);
		expect(codeOf(r)).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(doc);
	});
});

describe('clip.replaceSource (S07:PRC-005…007)', () => {
	function withVersions() {
		const s = setup();
		const r = s.h.ok([
			{
				type: 'media.derive',
				fromMediaId: s.mediaId,
				recipe: recipe(UPSCALE_2X),
				asset: processedAsset({ width: 1696, height: 960 }),
				ref: '$up',
			},
			{
				type: 'media.derive',
				fromMediaId: '$up',
				recipe: recipe(DENOISE),
				asset: processedAsset({ width: 1920, height: 1080 }),
				ref: '$up2',
			},
		]);
		return { ...s, up: r.refs.$up!, up2: r.refs.$up2! };
	}

	it('follows derivation chains: every version of the same original is a valid target', () => {
		const { h, mediaId, up, up2 } = withVersions();
		expect(originalMediaId(h.doc, up2)).toBe(mediaId);
		expect(mediaVersionsOf(h.doc, up)).toEqual([mediaId, up, up2]);
	});

	it('swaps to a 2× version and back, compensating Motion exactly (framing unchanged)', () => {
		const { h, videoId, mediaId, up, up2, audioId } = withVersions();
		patchDoc(h, (d) => {
			const c = d.sequences[h.seqId]!.clips[videoId] as VideoClip;
			c.transform.scale = { value: 150, keyframes: [] };
			c.transform.scaleWidth = { value: 150, keyframes: [] };
			c.transform.anchor = { value: [300, 200], keyframes: [] };
			c.transform.rotation = { value: 12, keyframes: [] };
		});
		h.ok([
			{
				type: 'effect.add',
				target: { clipId: videoId },
				effectId: 'jasper.crop',
				params: { left: 10, top: 5 },
			},
		]);
		const orig = videoClip(h, videoId);
		const quadAt = (doc: ProjectDocument) =>
			resolveSceneAt(
				buildRenderSnapshot(doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null }),
				3,
			)[0]!.props.quad;
		const q0 = quadAt(h.doc);

		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: up }], { label: 'Replace With Clip' });
		const c = videoClip(h, videoId);
		expect(c.mediaId).toBe(up);
		expect(c.transform.scale.value).toBe(75);
		expect(c.transform.scaleWidth.value).toBe(75);
		expect(c.transform.uniformScale).toBe(true);
		expect(c.transform.anchor.value).toEqual([600, 400]);
		expect(c.transform.position).toEqual(orig.transform.position);
		expect(c.transform.rotation).toEqual(orig.transform.rotation);
		expect(c.effects).toEqual(orig.effects);
		expect([c.start, c.duration, c.sourceIn, c.speed]).toEqual([
			orig.start,
			orig.duration,
			orig.sourceIn,
			orig.speed,
		]);
		expect((h.seq.clips[audioId] as { mediaId: string }).mediaId).toBe(mediaId);
		const q1 = quadAt(h.doc);
		for (let i = 0; i < 4; i++) {
			expect(q1[i]![0]).toBeCloseTo(q0[i]![0], 9);
			expect(q1[i]![1]).toBeCloseTo(q0[i]![1], 9);
		}

		// 1696×960 → 1920×1080 is anisotropic: Uniform Scale is split, the framing is still identical.
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: up2 }]);
		const c2 = videoClip(h, videoId);
		expect(c2.transform.uniformScale).toBe(false);
		expect(c2.transform.scale.value).toBeCloseTo((75 * 960) / 1080, 12);
		expect(c2.transform.scaleWidth.value).toBeCloseTo((75 * 1696) / 1920, 12);
		const q2 = quadAt(h.doc);
		for (let i = 0; i < 4; i++) {
			expect(q2[i]![0]).toBeCloseTo(q0[i]![0], 9);
			expect(q2[i]![1]).toBeCloseTo(q0[i]![1], 9);
		}

		// Back to the original restores Motion (Uniform Scale on again).
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId }]);
		const back = videoClip(h, videoId);
		expect(back.mediaId).toBe(mediaId);
		expect(back.transform.uniformScale).toBe(true);
		expect(back.transform.scale.value).toBeCloseTo(150, 12);
		expect(back.transform.scaleWidth.value).toBeCloseTo(150, 12);
		expect(back.transform.anchor.value[0]).toBeCloseTo(300, 12);
		expect(back.transform.anchor.value[1]).toBeCloseTo(200, 12);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('keeps keyframes, markers and trackers (tracker geometry in media pixels follows the size)', () => {
		const { h, videoId, up } = withVersions();
		const kf = (time: number, value: number) => ({
			id: h.ids.next('kf'),
			time,
			value,
			interpolation: 'linear' as const,
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: { influence: 1 / 3, slope: 0 },
		});
		const tracker: ClipTracker = {
			id: h.ids.next('tkr'),
			name: 'Tracker 1',
			kind: 'planar',
			reference: {
				time: 0,
				corners: [
					[10, 20],
					[110, 20],
					[110, 80],
					[10, 80],
				],
				search: 40,
			},
			samples: {
				start: 0,
				step: 23_520_000,
				stride: 8,
				data: [10, 20, 110, 20, 110, 80, 10, 80],
				confidence: [1],
			},
			method: 'klt-homography@1',
		};
		patchDoc(h, (d) => {
			const c = d.sequences[h.seqId]!.clips[videoId] as VideoClip;
			c.transform.scale = { value: 100, keyframes: [kf(0, 100), kf(705_600_000, 200)] };
			c.transform.scaleWidth = { value: 100, keyframes: [kf(0, 100), kf(705_600_000, 200)] };
			c.trackers = [tracker];
			c.markers = [
				{
					id: h.ids.next('mrk'),
					flicks: 0,
					duration: 0,
					name: 'm',
					comment: '',
					color: 'rose',
					type: 'comment',
					author: 'user',
				},
			];
		});
		const before = videoClip(h, videoId);
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId: up }]);
		const c = videoClip(h, videoId);
		expect(c.transform.scale.keyframes.map((k) => k.value)).toEqual([50, 100]);
		expect(c.transform.scaleWidth.keyframes.map((k) => k.value)).toEqual([50, 100]);
		expect(c.trackers![0]!.reference.corners).toEqual([
			[20, 40],
			[220, 40],
			[220, 160],
			[20, 160],
		]);
		expect(c.trackers![0]!.reference.search).toBe(80);
		expect(c.trackers![0]!.samples!.data).toEqual([20, 40, 220, 40, 220, 160, 20, 160]);
		expect(c.markers).toEqual(before.markers);
		expect(c.transform.scale.keyframes.map((k) => k.id)).toEqual(
			before.transform.scale.keyframes.map((k) => k.id),
		);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('is a no-op for the current media and refuses unrelated media, non-video clips, missing ids and locked tracks', () => {
		const { h, videoId, audioId, mediaId, up } = withVersions();
		const doc = h.doc;
		const same = h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId }]);
		expect(same.results[0]).toMatchObject({ changed: false });
		expect(h.doc).toBe(doc);

		const other = h.registerVideo({ width: 848, height: 480 });
		expect(codeOf(h.tx([{ type: 'clip.replaceSource', clipId: videoId, mediaId: other }]))).toBe(
			'E_INVALID_PARAM',
		);
		expect(codeOf(h.tx([{ type: 'clip.replaceSource', clipId: audioId, mediaId: up }]))).toBe(
			'E_INVALID_PARAM',
		);
		expect(
			codeOf(h.tx([{ type: 'clip.replaceSource', clipId: videoId, mediaId: 'med_0000000000000000' }])),
		).toBe('E_NOT_FOUND');
		expect(codeOf(h.tx([{ type: 'clip.replaceSource', clipId: 'clp_0000000000000000', mediaId: up }]))).toBe(
			'E_NOT_FOUND',
		);
		// A version with a different frame count (e.g. a future range-processed file) cannot cover the clip.
		const short = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(DENOISE),
				asset: processedAsset({ width: 848, height: 480, seconds: 2 }),
				ref: '$s',
			},
		]).refs.$s!;
		expect(codeOf(h.tx([{ type: 'clip.replaceSource', clipId: videoId, mediaId: short }]))).toBe(
			'E_OUT_OF_MEDIA',
		);

		patchDoc(h, (d) => {
			d.sequences[h.seqId]!.videoTracks[0]!.locked = true;
		});
		expect(codeOf(h.tx([{ type: 'clip.replaceSource', clipId: videoId, mediaId: up }]))).toBe(
			'E_TRACK_LOCKED',
		);
	});

	it('works on processed versions that the clip switched to through media.derive (swap back to the original)', () => {
		const { h, videoId, mediaId } = setup({ width: 1280, height: 720 });
		const orig = videoClip(h, videoId);
		const r = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: recipe(STABILIZE, { op: 'upscale', model: 'm', scale: 4 }),
				asset: processedAsset({ width: 5120, height: 2880 }),
				replaceInClips: [videoId],
			},
		]);
		expect(videoClip(h, videoId).transform.scale.value).toBe(orig.transform.scale.value / 4);
		h.ok([{ type: 'clip.replaceSource', clipId: videoId, mediaId }]);
		expect(videoClip(h, videoId)).toEqual(orig);
		expect(h.doc.media[(r.results[0] as { mediaId: string }).mediaId]).toBeDefined();
	});
});
