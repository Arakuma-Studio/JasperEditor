// Spec 19 TL-112: the PSD is opened with ag-psd and checked for layers, registration, order and blend. Pictures come from a
// fake painter here (a real render is in delivery.e2e.test.ts), so every path of the plan and writer is tested on any host.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeCanvas, type Layer, readPsd } from 'ag-psd';
import {
	buildRenderSnapshot,
	type LookRecipe,
	MAX_APPEARANCE_LAYERS,
	type RenderSnapshot,
	titleLookOf,
} from '@jasper/project';
import { MAX_PSD_LAYERS } from '@jasper/api';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { neutralClip, onLargerCanvas, onlyClips } from '../src/export/delivery/frames.ts';
import { assertWritable, trimmedPixels, writePsdFile } from '../src/export/delivery/psd-job.ts';
import { planPsd, type PsdRender, psdRenderDoc } from '../src/export/delivery/psd-plan.ts';
import { layerSlices, PsdAssembler, PsdTooLargeError } from '../src/export/delivery/psd-writer.ts';
import { writePsdUint8Array } from 'ag-psd';
import { DocBuilder } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'jasper-psd-'));

beforeAll(() => {
	initializeCanvas(
		() => {
			throw new Error('no canvas');
		},
		(width: number, height: number) =>
			({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData,
	);
});

function snapshotOf(d: DocBuilder, frame = 0): RenderSnapshot {
	return buildRenderSnapshot(d.doc, d.seqId, {
		range: { start: frame, end: frame + 1 },
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

const W = 320;
const H = 180;

/** Paints each clip as a rectangle of its own, so every layer has a known position. */
function painter(boxes: Record<string, { x: number; y: number; w: number; h: number; c: number[] }>) {
	return async (render: PsdRender): Promise<Uint8Array> => {
		const px = new Uint8Array(W * H * 4);
		if (render.background) for (let i = 0; i < px.length; i += 4) px.set([9, 9, 9, 255], i);
		for (const id of render.clips) {
			const b = boxes[id];
			if (!b) continue;
			for (let y = b.y; y < b.y + b.h; y++)
				for (let x = b.x; x < b.x + b.w; x++) px.set(b.c, (y * W + x) * 4);
		}
		return px;
	};
}

function twoClips(preset = 'hd-720p-30') {
	const d = new DocBuilder(preset);
	const r = d.tx([
		{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'Title' }, name: 'Headline', ref: '$t' },
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.1, 0.2, 0.3, 1], ref: '$s' },
	]);
	return { d, t: r.refs.$t!, s: r.refs.$s! };
}

const flat = (layers: Layer[] | undefined): Layer[] => (layers ?? []).flatMap((l) => [l, ...flat(l.children)]);

describe('plan (TL-112)', () => {
	it('one layer per visible clip, bottom first, and says what is rasterised', () => {
		const { d } = twoClips();
		const { plan } = planPsd(snapshotOf(d), 0);
		expect(plan.layers.map((l) => l.kind)).toEqual(['pixels', 'pixels', 'pixels']);
		expect(plan.layers[0]!.name).toBe('Background');
		expect(plan.layers[2]!.name).toBe('Headline');
		expect(plan.baked.join()).toContain('Headline: text rasterised');
		expect(plan.warnings.map((w) => w.code)).toContain('PSD_RASTERISED');
		expect(plan.blockers).toEqual([]);
	});

	it('a clip not at the frame is not a layer', () => {
		const { d } = twoClips();
		const snap = snapshotOf(d, 40);
		const clear = { ...snap, settings: { ...snap.settings, backgroundColor: [0, 0, 0, 0] as [number, number, number, number] } };
		expect(planPsd(clear, 40).plan.blockers.map((b) => b.code)).toEqual(['PSD_EMPTY']);
		expect(planPsd(snap, 40).plan.layers.map((l) => l.name)).toEqual(['Background']);
	});

	it('a blend mode and opacity go on the PSD layer, and the render is neutral', () => {
		const d = new DocBuilder('hd-720p-30');
		const c = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		]).refs.$s!;
		d.tx([
			{ type: 'param.set', target: ['clip', c, 'opacity'], value: 40 },
			{ type: 'clip.update', clipId: c, patch: { blendMode: 'multiply' } },
		]);
		const snap = snapshotOf(d);
		const layout = planPsd(snap, 0);
		expect(layout.plan.layers[1]).toMatchObject({ blend: 'multiply', opacity: 0.4 });
		const node = layout.nodes[1]!;
		if (node.kind !== 'pixels') throw new Error('expected pixels');
		const drawn = psdRenderDoc(snap, node.render).videoTracks[0]!.clips[0]!;
		expect(drawn.blendMode).toBe('normal');
		expect(drawn.opacity.value).toBe(100);
	});

	it('an adjustment layer flattens what is below it, which stays hidden', () => {
		const { d } = twoClips();
		d.tx([{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V3', name: 'Grade' }]);
		const { plan, nodes } = planPsd(snapshotOf(d), 0);
		expect(plan.layers.map((l) => [l.name, l.hidden])).toEqual([
			['Background', true],
			[expect.any(String), true],
			['Headline', true],
			['Grade (baked)', false],
		]);
		expect(plan.baked.join()).toContain('Grade: adjustment layer, flattened');
		const top = nodes[3]!;
		if (top.kind !== 'pixels') throw new Error('expected pixels');
		expect(top.render.clips).toHaveLength(3);
		expect(top.render.background).toBe(true);
	});

	it('names blockers before anything runs', () => {
		const d = new DocBuilder('hd-720p-30');
		const snap = snapshotOf(d);
		const tooWide = { ...snap, settings: { ...snap.settings, width: 40_000 } };
		const r = planPsd(tooWide, 0).plan;
		expect(r.blockers.map((b) => b.code)).toContain('PSD_FRAME_TOO_LARGE');
		expect(() => assertWritable(r)).toThrow(/30000/);
		const big = { ...snap, settings: { ...snap.settings, width: 20_000, height: 20_000 } };
		expect(planPsd(big, 0).plan.blockers.map((b) => b.code)).toContain('PSD_FRAME_TOO_LARGE');
	});

	it('refuses more layers than a PSD job may hold', () => {
		const d = new DocBuilder('hd-720p-30');
		const snap = snapshotOf(d);
		const clip = { ...twoClipsSnapshotClip(), start: 0, duration: 10 };
		const many = {
			...snap,
			videoTracks: Array.from({ length: MAX_PSD_LAYERS + 1 }, (_, i) => ({
				trackId: `t${i}`,
				clips: [{ ...clip, clipId: `c${i}` }],
			})),
		};
		expect(planPsd(many, 0).plan.blockers.map((b) => b.code)).toContain('PSD_TOO_MANY_LAYERS');
	});

	it('splits a title with a look into rims, face and fx; a part keeps the rest at zero', () => {
		const { d, t } = twoClips();
		const recipe: LookRecipe = {
			layers: [
				{ type: 'rim', name: 'Outer', params: { width: 5 } },
				{ type: 'rim', params: { width: 3 } },
				{ type: 'face' },
			],
		};
		d.tx([{ type: 'look.apply', clipIds: [t], look: { name: 'Two rims', recipe } }]);
		expect(titleLookOf(d.doc, Object.values(d.doc.titleLooks ?? {})[0]!.id)).toBeTruthy();
		const snap = snapshotOf(d);
		const { nodes, plan } = planPsd(snap, 0, { splitTitles: true });
		const group = nodes.at(-1)!;
		if (group.kind !== 'group') throw new Error('expected a group');
		expect(group.children.map((c) => [c.name, c.hidden])).toEqual([
			['Outer', true],
			['rim 1', true],
			['face', true],
			['fx', false],
		]);
		expect(plan.layers.find((l) => l.kind === 'group')?.children).toBe(4);
		// The inner rim alone: the outer rim stays above zero growth, unpainted, and the face is off.
		const inner = group.children[1]!;
		if (inner.kind !== 'pixels') throw new Error('expected pixels');
		const clip = psdRenderDoc(snap, inner.render).videoTracks.flatMap((v) => v.clips).find((c) => c.clipId === t)!;
		const a = clip.effects[0]!.appearance as { layers: { type: string; enabled: boolean; params: Record<string, { value: unknown }> }[] };
		expect(a.layers).toHaveLength(MAX_APPEARANCE_LAYERS === 24 ? 3 : 3);
		const [outer, kept, face] = a.layers;
		expect(outer!.enabled).toBe(true);
		expect(outer!.params.opacity!.value).toBe(0);
		expect(outer!.params.width!.value).toBe(5);
		expect(kept!.params.opacity!.value).toBe(100);
		expect(face!.enabled).toBe(false);
	});
});

function twoClipsSnapshotClip() {
	const { d } = twoClips();
	return snapshotOf(d).videoTracks[0]!.clips[0]!;
}

describe('writer (TL-112)', () => {
	it('round trip: ag-psd reads back layers, order, registration, blend, opacity, hidden and pixels', async () => {
		const { d, t, s } = twoClips();
		const layout = planPsd(snapshotOf(d), 0);
		layout.plan.width = W;
		layout.plan.height = H;
		const dest = join(dir, 'round.psd');
		const size = await writePsdFile({
			layout,
			paint: painter({
				[t]: { x: 50, y: 60, w: 40, h: 20, c: [255, 0, 0, 128] },
				[s]: { x: 0, y: 0, w: W, h: H, c: [0, 0, 255, 255] },
			}),
			dest,
			scratch: dir,
			signal: new AbortController().signal,
		});
		expect(statSync(dest).size).toBe(size);
		const psd = readPsd(readFileSync(dest), { useImageData: true });
		expect(psd.width).toBe(W);
		expect(psd.height).toBe(H);
		expect(psd.bitsPerChannel).toBe(8);
		expect(psd.children).toHaveLength(3);
		const [, bottom, top] = psd.children as [Layer, Layer, Layer];
		expect(top.name).toBe('Headline');
		expect([top.left, top.top, top.right, top.bottom]).toEqual([50, 60, 90, 80]);
		// A straight alpha pixel, colour untouched.
		const data = (top.imageData as unknown as { data: Uint8Array }).data;
		expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
		expect([bottom.left, bottom.top, bottom.right, bottom.bottom]).toEqual([0, 0, W, H]);
		expect(psd.imageResources?.resolutionInfo?.horizontalResolution).toBe(72);
		// The flattened picture is the render's.
		const comp = psd.imageData as unknown as { data: Uint8Array };
		expect(comp.data[0]).toBe(0);
		expect(comp.data[2]).toBe(255);
		// Nothing is left behind.
		expect(readdirSync(dir).filter((f) => f.includes('.tmp') || f.includes('channels'))).toEqual([]);
	});

	it('groups round-trip as groups, in order, with the title parts hidden', async () => {
		const { d, t } = twoClips();
		d.tx([
			{
				type: 'look.apply',
				clipIds: [t],
				look: { name: 'One rim', recipe: { layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }] } },
			},
		]);
		const layout = planPsd(snapshotOf(d), 0, { splitTitles: true });
		layout.plan.width = W;
		layout.plan.height = H;
		const dest = join(dir, 'groups.psd');
		await writePsdFile({
			layout,
			paint: painter({ [t]: { x: 10, y: 10, w: 8, h: 8, c: [1, 2, 3, 255] } }),
			dest,
			scratch: dir,
			signal: new AbortController().signal,
		});
		const psd = readPsd(readFileSync(dest), { useImageData: true });
		const group = psd.children!.find((l) => l.children)!;
		expect(group.name).toBe('Headline');
		expect(group.sectionDivider?.key).toBe('pass');
		expect(group.children!.map((l) => [l.name, !!l.hidden])).toEqual([
			['rim 1', true],
			['face', true],
			['fx', false],
		]);
		expect(flat(psd.children).filter((l) => l.name === 'fx')[0]!.left).toBe(10);
	});

	it('an empty picture is an empty layer, not a failure', async () => {
		const a = new PsdAssembler(join(dir, 'c1.bin'), { width: 8, height: 8, resources: {} });
		await a.addPixels({ name: 'nothing', blend: 'normal', opacity: 1, hidden: false, pixels: null });
		const dest = join(dir, 'empty.psd');
		await a.finish(new Uint8Array(8 * 8 * 4), dest);
		expect(readPsd(readFileSync(dest), { useImageData: true }).children?.[0]?.name).toBe('nothing');
	});

	it('cancels between layers and leaves no output', async () => {
		const { d, s } = twoClips();
		const layout = planPsd(snapshotOf(d), 0);
		layout.plan.width = W;
		layout.plan.height = H;
		const abort = new AbortController();
		const dest = join(dir, 'cancel.psd');
		const inner = painter({ [s]: { x: 0, y: 0, w: 4, h: 4, c: [1, 1, 1, 255] } });
		await expect(
			writePsdFile({
				layout,
				paint: async (r) => {
					abort.abort();
					return inner(r);
				},
				dest,
				scratch: dir,
				signal: abort.signal,
			}),
		).rejects.toThrow();
		expect(readdirSync(dir)).not.toContain('cancel.psd');
	});

	it('a render that fails leaves the previous file whole (atomic write)', async () => {
		const { d } = twoClips();
		const layout = planPsd(snapshotOf(d), 0);
		layout.plan.width = W;
		layout.plan.height = H;
		const dest = join(dir, 'kept.psd');
		writeFileSync(dest, 'previous');
		await expect(
			writePsdFile({
				layout,
				paint: async () => {
					throw new Error('render died');
				},
				dest,
				scratch: dir,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('render died');
		expect(readFileSync(dest, 'utf8')).toBe('previous');
	});

	it('holds one layer at a time: channels go to disk, and a file past 2 GiB is refused by name', async () => {
		const a = new PsdAssembler(join(dir, 'c2.bin'), { width: 30_000, height: 30_000, resources: {} });
		// The composite alone would take a frame this size past the limit.
		const data = new Uint8Array(4 * 4 * 4).fill(200);
		await expect(
			a.addPixels({
				name: 'x',
				blend: 'normal',
				opacity: 1,
				hidden: false,
				pixels: { data, width: 4, height: 4, left: 0, top: 0 },
			}),
		).rejects.toBeInstanceOf(PsdTooLargeError);
		a.close();
	});

	it('slices one layer out of an ag-psd document at the record boundary', () => {
		const px = new Uint8ClampedArray(4 * 4 * 4).fill(255);
		const doc = writePsdUint8Array(
			{
				width: 8,
				height: 8,
				children: [{ name: 'layer', top: 2, left: 3, imageData: { data: px, width: 4, height: 4 } as never }],
			},
			{ noBackground: true },
		);
		const { record, channels } = layerSlices(doc);
		const view = new DataView(record.buffer, record.byteOffset);
		expect([view.getInt32(0), view.getInt32(4), view.getInt32(8), view.getInt32(12)]).toEqual([2, 3, 6, 7]);
		expect(channels.length).toBeGreaterThan(0);
	});

	it('trims to visible pixels, keeping registration', () => {
		const px = new Uint8Array(10 * 10 * 4);
		px.set([9, 8, 7, 1], (3 * 10 + 4) * 4);
		const t = trimmedPixels(px, 10, 10)!;
		expect([t.left, t.top, t.width, t.height]).toEqual([4, 3, 1, 1]);
		expect([...t.data]).toEqual([9, 8, 7, 1]);
		expect(trimmedPixels(new Uint8Array(40), 5, 2)).toBeNull();
	});

	it('property: layers at any position come back where they were', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						x: fc.nat(30),
						y: fc.nat(30),
						w: fc.integer({ min: 1, max: 16 }),
						h: fc.integer({ min: 1, max: 16 }),
					}),
					{ minLength: 1, maxLength: 5 },
				),
				async (boxes) => {
					const a = new PsdAssembler(join(dir, 'c3.bin'), { width: 64, height: 64, resources: {} });
					for (const [i, b] of boxes.entries())
						await a.addPixels({
							name: `l${i}`,
							blend: 'normal',
							opacity: 1,
							hidden: false,
							pixels: { data: new Uint8Array(b.w * b.h * 4).fill(i + 1), width: b.w, height: b.h, left: b.x, top: b.y },
						});
					const dest = join(dir, 'p.psd');
					await a.finish(new Uint8Array(64 * 64 * 4), dest);
					const back = readPsd(readFileSync(dest), { useImageData: true }).children!;
					expect(back.map((l) => [l.left, l.top, l.right, l.bottom])).toEqual(
						boxes.map((b) => [b.x, b.y, b.x + b.w, b.y + b.h]),
					);
				},
			),
			{ numRuns: 30 },
		);
	});
});

describe('frames (TL-114)', () => {
	it('a larger canvas moves every clip with it, keeping what is in sequence space', () => {
		const { d, s } = twoClips();
		const snap = snapshotOf(d);
		const big = onLargerCanvas(snap, 100);
		expect(big.settings.width).toBe(snap.settings.width + 200);
		const p = (x: RenderSnapshot) => x.videoTracks[0]!.clips[0]!.transform!.position.value;
		expect(p(big)[0]).toBe(p(snap)[0] + 100);
		expect(p(big)[1]).toBe(p(snap)[1] + 100);
		expect(onLargerCanvas(snap, 0)).toBe(snap);
		expect(onlyClips(big, new Set([s])).videoTracks).toHaveLength(1);
	});

	it('neutral clips are normal and at 100 %', () => {
		const { d } = twoClips();
		const c = neutralClip(snapshotOf(d).videoTracks[0]!.clips[0]!);
		expect([c.blendMode, c.opacity.value]).toEqual(['normal', 100]);
	});
});
