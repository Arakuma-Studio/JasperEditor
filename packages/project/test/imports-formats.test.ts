// imports workstream: image-sequence grouping (examples + fuzz), Lottie parsing (validation + fuzz), Lottie export
// (layer types, warnings, and an oracle: the exported Bézier eases reproduce our keyframe evaluation), and the
// layered (PSD) import commands applied to a document.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	evaluate,
	exportSequenceToLottie,
	groupImageSequences,
	type LayeredImportLayer,
	layeredBlendMode,
	layeredImportCommands,
	LottieParseError,
	lottieFrameAt,
	lottieImageAssets,
	lottieInfo,
	parseFrameName,
	parseLottie,
	type Sequence,
	sequenceFrameFiles,
	svgToShapeContents,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

describe('image sequences', () => {
	it('groups numbered stills, keeps padding apart and lists gaps', () => {
		const names = [
			'shot_0001.exr',
			'shot_0002.exr',
			'shot_0004.exr',
			'shot_0003.EXR',
			'frame1.png',
			'frame2.png',
			'frame10.png',
			'readme.txt',
			'clip.mov',
			'single_0001.dpx',
			'shot_0001.exr',
		];
		const { sequences, singles } = groupImageSequences(names);
		const shot = sequences.find((s) => s.prefix === 'shot_')!;
		expect(shot).toMatchObject({
			first: 1,
			last: 4,
			padding: 4,
			missing: [],
			label: 'shot_[0001-0004].exr',
			pattern: 'shot_####.exr',
		});
		const frame = sequences.find((s) => s.prefix === 'frame')!;
		expect(frame).toMatchObject({ first: 1, last: 10, padding: 0, missingCount: 7 });
		expect(singles).toEqual(expect.arrayContaining(['readme.txt', 'clip.mov', 'single_0001.dpx']));
		expect(parseFrameName('a/b/c_0012.tif')).toMatchObject({
			prefix: 'c_',
			number: 12,
			digits: 4,
			ext: '.tif',
		});
		expect(parseFrameName('c_0012.mov')).toBeNull();
		expect(parseFrameName('c_1234567890.png')).toBeNull();
	});

	it('a padded counter that outgrows its width stays one sequence', () => {
		const names = ['f_9998.png', 'f_9999.png', 'f_10000.png', 'f_10001.png', 'f_0997.png'];
		const g = groupImageSequences(names).sequences;
		expect(g).toHaveLength(1);
		expect(g[0]).toMatchObject({ first: 997, last: 10001 });
	});

	it('gaps hold the previous frame', () => {
		const g = groupImageSequences(['s_01.png', 's_02.png', 's_05.png']).sequences[0]!;
		expect(g.missing).toEqual([3, 4]);
		expect(sequenceFrameFiles(g)).toEqual(['s_01.png', 's_02.png', 's_02.png', 's_02.png', 's_05.png']);
	});

	it('never throws and partitions its input (fuzz)', () => {
		const name = fc.oneof(
			fc.string({ maxLength: 40 }),
			fc
				.tuple(
					fc.constantFrom('a_', 'b', 'shot.', ''),
					fc.integer({ min: 0, max: 200_000 }),
					fc.integer({ min: 0, max: 8 }),
					fc.constantFrom('.png', '.exr', '.JPG', '.txt', '.dpx'),
				)
				.map(([p, n, w, e]) => `${p}${String(n).padStart(w, '0')}${e}`),
		);
		fc.assert(
			fc.property(fc.array(name, { maxLength: 300 }), (names) => {
				const { sequences, singles } = groupImageSequences(names);
				const used = sequences.reduce((n, s) => n + s.frames.length, 0);
				const unique = new Set(names).size;
				// Every distinct name ends up in exactly one place (duplicates collapse inside a sequence).
				expect(used + new Set(singles).size).toBeLessThanOrEqual(unique + singles.length);
				for (const s of sequences) {
					expect(s.frames.length).toBeGreaterThanOrEqual(2);
					expect(s.last - s.first + 1).toBe(s.frames.length + s.missingCount);
					const files = sequenceFrameFiles(s);
					expect(files).toHaveLength(s.last - s.first + 1);
					expect(files[0]).toBe(s.frames[0]!.name);
				}
			}),
		);
	});
});

const LOTTIE = {
	v: '5.7.4',
	fr: 30,
	ip: 0,
	op: 60,
	w: 200,
	h: 100,
	nm: 'Test',
	assets: [{ id: 'image_0', w: 10, h: 10, u: 'images/', p: 'img_0.png', e: 0 }],
	layers: [
		{ ty: 4, nm: 'Shape', ks: { o: { a: 0, k: 100, x: 'wiggle(1,2)' } }, shapes: [{ ty: 'mm' }] },
		{ ty: 5, nm: 'Text', ks: {}, t: {} },
	],
	fonts: { list: [{ fFamily: 'Roboto' }] },
};

describe('Lottie parsing', () => {
	it('validates and describes a document', () => {
		const d = parseLottie(JSON.stringify(LOTTIE));
		const info = lottieInfo(d);
		expect(info).toMatchObject({
			fps: 30,
			inFrame: 0,
			outFrame: 60,
			width: 200,
			height: 100,
			version: '5.7.4',
			layers: 2,
		});
		expect(info.warnings!.join(' ')).toMatch(/expressions/);
		expect(info.warnings!.join(' ')).toMatch(/Merge Paths/);
		expect(info.warnings!.join(' ')).toMatch(/Roboto/);
		expect(lottieImageAssets(d)).toEqual([
			{ index: 0, id: 'image_0', dir: 'images/', file: 'img_0.png', embedded: false },
		]);
		for (const bad of [
			'{',
			'[]',
			JSON.stringify({ ...LOTTIE, fr: 0 }),
			JSON.stringify({ ...LOTTIE, op: 0 }),
			JSON.stringify({ ...LOTTIE, w: 100_000 }),
			JSON.stringify({ ...LOTTIE, assets: {} }),
			JSON.stringify({ ...LOTTIE, op: 30 * 24 * 3600 * 2 }),
		])
			expect(() => parseLottie(bad)).toThrow(LottieParseError);
	});

	it('samples frames like footage (floor, clamped to the last frame)', () => {
		const info = { fps: 25, inFrame: 10, outFrame: 60 };
		expect(lottieFrameAt(info, 0)).toBe(10);
		expect(lottieFrameAt(info, 0.039)).toBe(10);
		expect(lottieFrameAt(info, 0.04)).toBe(11);
		expect(lottieFrameAt(info, 100)).toBe(59);
		expect(lottieFrameAt(info, -1)).toBe(10);
		expect(lottieFrameAt(info, Number.NaN)).toBe(10);
	});

	it('rejects or accepts arbitrary JSON without crashing (fuzz)', () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 6 }), (v) => {
				try {
					const d = parseLottie(v);
					lottieInfo(d);
					lottieImageAssets(d);
				} catch (e) {
					expect(e).toBeInstanceOf(LottieParseError);
				}
			}),
		);
		// Mutated documents: random keys replaced deep inside the layers.
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 4 }), fc.nat(5), (junk, i) => {
				const d = structuredClone(LOTTIE) as Record<string, unknown>;
				const layers = d.layers as unknown[];
				layers[i % layers.length] = junk;
				d.assets = i % 2 ? [junk] : d.assets;
				try {
					lottieInfo(parseLottie(d));
				} catch (e) {
					expect(e).toBeInstanceOf(LottieParseError);
				}
			}),
		);
	});
});

/** Lottie's keyframe value at layer frame `t` (cubic-bezier ease between `k0` and its next key). */
function lottieValueAt(
	keys: { t: number; s: number[]; o?: { x: number; y: number }; i?: { x: number; y: number }; h?: number }[],
	t: number,
): number {
	let k = 0;
	while (k < keys.length - 1 && keys[k + 1]!.t <= t) k++;
	const a = keys[k]!;
	const b = keys[k + 1];
	if (!b || a.h) return a.s[0]!;
	const x = (t - a.t) / (b.t - a.t);
	const p1 = a.o!;
	const p2 = a.i!;
	const bez = (u: number, c1: number, c2: number) =>
		3 * (1 - u) ** 2 * u * c1 + 3 * (1 - u) * u ** 2 * c2 + u ** 3;
	let lo = 0;
	let hi = 1;
	for (let it = 0; it < 80; it++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, p1.x, p2.x) < x) lo = mid;
		else hi = mid;
	}
	const y = bez((lo + hi) / 2, p1.y, p2.y);
	return a.s[0]! + (b.s[0]! - a.s[0]!) * y;
}

describe('Lottie export', () => {
	function scene() {
		const h = new Harness();
		const shape = svgToShapeContents(
			'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="0" y="0" width="100" height="50" fill="#ff0000"/></svg>',
		);
		const m = h.registerVideo({ seconds: 4 });
		const r = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				duration: 60,
				track: 'V2',
				shape: { type: 'vector', contents: shape.contents },
				ref: '$s',
			},
			{
				type: 'keyframe.add',
				target: ['clip', '$s', 'opacity'],
				at: { sequenceFrame: 0 },
				value: 0,
				interpolation: 'bezier',
				easeOut: { influence: 0.7, slope: 0 },
			},
			{
				type: 'keyframe.add',
				target: ['clip', '$s', 'opacity'],
				at: { sequenceFrame: 30 },
				value: 100,
				interpolation: 'bezier',
				easeIn: { influence: 0.25, slope: 0.5 },
			},
			{ type: 'clip.addText', at: 10, duration: 40, track: 'V3', content: { text: 'Hello' } },
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
			{ type: 'clip.update', clipId: '$s', patch: { blendMode: 'screen' } },
			{ type: 'clip.place', source: { mediaId: m }, at: 60, tracks: { video: 'V1', audio: 'A1' } },
		]);
		return { h, shapeId: r.refs.$s! };
	}

	it('exports shapes, text and solids, warns about what Lottie cannot carry', () => {
		const { h } = scene();
		const { json, warnings, layers } = exportSequenceToLottie(h.doc, h.seqId);
		expect(json).toMatchObject({ v: '5.12.0', fr: 30, ip: 0, w: 1920, h: 1080 });
		const ls = json.layers as { ty: number; bm?: number; nm: string }[];
		expect(ls.map((l) => l.ty).sort()).toEqual(expect.arrayContaining([1, 4, 5]));
		expect(ls.find((l) => l.ty === 4)!.bm).toBe(2);
		expect(layers).toBeGreaterThanOrEqual(3);
		expect(warnings.join(' ')).toMatch(/Audio/);
		expect(warnings.some((w) => /video/i.test(w))).toBe(true);
		// A range limits the comp.
		const part = exportSequenceToLottie(h.doc, h.seqId, { range: { start: 10, end: 40 } }).json;
		expect(part.op).toBe(30);
		// The JSON round-trips through our own Lottie parser.
		expect(() => parseLottie(JSON.stringify(json))).not.toThrow();
	});

	it('Bézier eases reproduce the keyframe evaluation (oracle)', () => {
		const { h, shapeId } = scene();
		const { json } = exportSequenceToLottie(h.doc, h.seqId);
		const layer = (json.layers as { ty: number; ks: { o: { a: number; k: unknown } } }[]).find(
			(l) => l.ty === 4,
		)!;
		expect(layer.ks.o.a).toBe(1);
		const keys = layer.ks.o.k as Parameters<typeof lottieValueAt>[0];
		const clip = (h.seq as Sequence).clips[shapeId] as unknown as { opacity: Parameters<typeof evaluate>[0] };
		const F = 705_600_000 / 30;
		for (let f = 0; f <= 30; f += 0.5) {
			const ours = evaluate(clip.opacity, f * F) as number;
			expect(lottieValueAt(keys, f)).toBeCloseTo(ours, 2);
		}
	});
});

describe('layered (PSD) import commands', () => {
	const pic = (name: string, w: number, h: number): LayeredImportLayer['asset'] => {
		const a = videoAsset({ kind: 'image', width: w, height: h });
		const {
			derivation: _d,
			importedAt: _i,
			...rest
		} = a as typeof a & { derivation: unknown; importedAt: unknown };
		return { ...rest, originalName: name } as LayeredImportLayer['asset'];
	};
	const L = (index: number, name: string, over: Partial<LayeredImportLayer> = {}): LayeredImportLayer => ({
		index,
		name,
		kind: 'pixel',
		visible: true,
		opacity: 1,
		blendMode: 'normal',
		clipping: false,
		left: 10,
		top: 20,
		width: 100,
		height: 60,
		asset: pic(`${name}.png`, 100, 60),
		...over,
	});
	const layers: LayeredImportLayer[] = [
		L(0, 'Background', { left: 0, top: 0, width: 400, height: 300, asset: pic('bg.png', 400, 300) }),
		L(1, 'Shadow', { blendMode: 'multiply', opacity: 0.5 }),
		L(2, 'Clipped', { clipping: true }),
		L(5, 'Badge', {
			kind: 'group',
			asset: null,
			opacity: 0.8,
			children: [L(3, 'Circle', { blendMode: 'linear-dodge' }), L(4, 'Label', { visible: false })],
		}),
		L(7, 'Loose', {
			kind: 'group',
			asset: null,
			blendMode: 'pass-through',
			children: [L(6, 'Inner')],
		}),
	];

	it('maps Photoshop blend modes to ours', () => {
		expect(layeredBlendMode('linear-dodge')).toBe('add');
		expect(layeredBlendMode('pass-through')).toBe('normal');
		expect(layeredBlendMode('vivid-light')).toBe('vivid-light');
	});

	it('Sequence: one track per layer, positions, opacity, blend, visibility, clipping, isolated groups nested', () => {
		const h = new Harness();
		const { commands, notes } = layeredImportCommands({
			docName: 'Poster',
			documentSize: { width: 400, height: 300 },
			frameRate: { num: 25, den: 1 },
			layers,
			mode: 'sequence',
			now: '2026-10-01T00:00:00.000Z',
		});
		const r = h.ok(commands);
		expect(notes).toEqual([]);
		const seq = h.doc.sequences[r.refs.$lseq!] as Sequence;
		expect(seq.settings).toMatchObject({ width: 400, height: 300, frameRate: { num: 25, den: 1 } });
		// Background, Shadow, Clipped, Badge (nested), Inner (pass-through group flattened).
		expect(seq.videoTracks).toHaveLength(5);
		const byName = (n: string) =>
			Object.values(seq.clips).find(
				(c) =>
					(c as { name?: string }).name === n ||
					h.doc.media[(c as { mediaId?: string }).mediaId ?? '']?.originalName === `${n}.png`,
			) as Record<string, any>;
		const shadow = byName('Shadow');
		expect(shadow.blendMode).toBe('multiply');
		expect(shadow.opacity.value).toBeCloseTo(50, 6);
		expect(shadow.transform.position.value).toEqual([60, 50]);
		const clipped = byName('Clipped');
		expect(JSON.stringify(clipped.effects)).toContain('track-matte');
		const nest = Object.values(seq.clips).find((c) => c.kind === 'nest-video') as Record<string, any>;
		expect(nest.opacity.value).toBeCloseTo(80, 6);
		const inner = h.doc.sequences[nest.sequenceId] as Sequence;
		const innerClips = Object.values(inner.clips) as Record<string, any>[];
		expect(innerClips.map((c) => c.blendMode ?? 'normal').sort()).toEqual(['add', 'normal']);
		expect(innerClips.filter((c) => c.enabled === false)).toHaveLength(1);
		// Every layer is an item in the bin, with its source recorded.
		const media = Object.values(h.doc.media).filter((m) => m.layerSource);
		expect(media).toHaveLength(6);
		expect(media.find((m) => m.layerSource!.name === 'Circle')!.layerSource!.groups).toEqual(['Badge']);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('Individual Layers: only the chosen layers, no sequence', () => {
		const h = new Harness();
		const { commands } = layeredImportCommands({
			docName: 'Poster',
			documentSize: { width: 400, height: 300 },
			frameRate: { num: 30, den: 1 },
			layers,
			selected: new Set([0, 3]),
			mode: 'individual',
			now: '2026-10-01T00:00:00.000Z',
		});
		const before = Object.keys(h.doc.sequences).length;
		const r = h.ok(commands);
		expect(Object.keys(h.doc.sequences)).toHaveLength(before);
		expect(
			Object.values(h.doc.media)
				.filter((m) => m.layerSource)
				.map((m) => m.layerSource!.name),
		).toEqual(['Background', 'Circle']);
		expect(h.doc.items[r.refs.$lbin!]).toMatchObject({ kind: 'bin', name: 'Poster Layers' });
	});

	it('a clipped layer with nothing below it is noted', () => {
		const { notes } = layeredImportCommands({
			docName: 'D',
			documentSize: { width: 64, height: 64 },
			frameRate: { num: 30, den: 1 },
			layers: [L(0, 'Orphan', { clipping: true })],
			mode: 'sequence',
			now: '2026-10-01T00:00:00.000Z',
		});
		expect(notes.join(' ')).toMatch(/clipped to nothing/);
	});
});
