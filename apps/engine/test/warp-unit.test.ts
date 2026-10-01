// Warp stage units (S09 §5, ARCHITECTURE §19.5/§19.6): the shared `layerSourceChain`, the warp kernel's sampling
// rules (pixel centres, premultiplied bilinear, transparent outside, opacity), claims and blockers.
import {
	applyTransaction,
	buildRenderSnapshot,
	CORNER_PIN_EFFECT_ID,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type Mat3,
	type RenderSnapshot,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildNativeGraph, layerSourceChain, pickOverride } from '../src/export/native.ts';
import type { NativeExtension } from '../src/export/native-ext.ts';
import { nativeBlockers, type PlanCapabilities } from '../src/export/planner.ts';
import {
	createWarpExtension,
	destRect,
	warpClaims,
	warpFrame,
	warpFrames,
} from '../src/export/warp/index.ts';
import { decoderArgs, encoderArgs } from '../src/export/warp/render.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';

const caps: PlanCapabilities = {
	native: true,
	remotionLocal: 'ready',
	fframes: 'unavailable',
	mgMasters: false,
};
const output = {
	width: 1920,
	height: 1080,
	fps: { num: 30, den: 1 },
	frames: 60,
	durationSec: 2,
	scaling: 'fit',
	crf: 18,
	x264Preset: 'veryfast',
	audioChannels: 2,
	audioBitrateKbps: 192,
} as never;

function snapshotOf(commands: unknown[]): { snap: RenderSnapshot; refs: Record<string, string> } {
	const ids = createSeededIdSource(5);
	const d = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const seqId = Object.keys(d.sequences)[0]!;
	const { document, result } = applyTransaction(
		d,
		{ label: 't', origin: 'user', sequenceId: seqId, commands: commands as never },
		{ ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const snap = buildRenderSnapshot(document, seqId, {
		resolveMedia: (a) => ({
			url: `/media/${a.id}`,
			proxyUrl: null,
			kind: a.kind,
			width: 640,
			height: 360,
			durationFlicks: 10 * FLICKS_PER_SECOND,
			hasAudio: false,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
	return { snap, refs: result.refs };
}

const PIN = { topLeft: [0.1, 0.1], topRight: [0.9, 0.2], bottomRight: [0.8, 0.9], bottomLeft: [0.2, 0.8] };
const fakeMedia = {
	path: '/media/card.png',
	record: {
		fingerprint: 'q1:card',
		sizeBytes: 1,
		mtimeMs: 1,
		probe: {
			streams: [
				{ type: 'video', index: 0, width: 640, height: 360, color: { matrix: 'bt709', range: 'pc' } },
			],
		},
	},
} as never;

describe('layerSourceChain (shared by the builder and the warp stage)', () => {
	it('is exactly the head of every layer chain of the builder (solid with crop/flip, still with Motion)', () => {
		const { snap } = snapshotOf([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
			{
				type: 'effect.add',
				target: { clipId: '$s' },
				effectId: 'jasper.crop',
				params: { left: 10, top: 20 },
			},
			{ type: 'effect.add', target: { clipId: '$s' }, effectId: 'jasper.flip-horizontal', params: {} },
			{ type: 'param.set', target: ['clip', '$s', 'transform', 'scale'], value: 40 },
			{ type: 'param.set', target: ['clip', '$s', 'transform', 'rotation'], value: 30 },
			{ type: 'clip.addSolid', at: 5, duration: 40, track: 'V2', color: [0, 1, 0, 1], ref: '$t' },
		]);
		// Pretend V2 is a still of the fake media.
		const still = snap.videoTracks[1]!.clips[0]!;
		still.kind = 'still';
		still.source = { mediaId: 'm1' };
		still.intrinsicBox = { width: 640, height: 360 };
		const g = buildNativeGraph({
			snapshot: snap,
			output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => fakeMedia, mgMaster: () => null },
			threads: 1,
		});
		const inputs: string[][] = [];
		for (const [i, c] of snap.videoTracks.flatMap((t) => t.clips).entries()) {
			const f0 = c.start;
			const f1 = Math.min(c.start + c.duration, snap.range.end);
			const chain = layerSourceChain({
				clip: c,
				f0,
				f1,
				fps: snap.settings.fps,
				sources: { media: () => fakeMedia, mgMaster: () => null },
				addInput: (a) => {
					inputs.push(a);
					return inputs.length - 1;
				},
			});
			expect(g.filter).toContain(`${chain.input}${chain.filters.join(',')},`);
			expect(chain).toMatchObject({ width: i === 0 ? 1920 : 640, height: i === 0 ? 1080 : 360 });
		}
		expect(g.filter).toContain(
			'crop=1728:864:192:216,pad=1920:1080:192:216:color=black@0,hflip,scale=768:432',
		);
		expect(inputs).toEqual(g.inputs);
		expect(inputs[0]).toEqual(expect.arrayContaining(['-loop', '1', '/media/card.png']));
	});

	it('uses a `layer` override as the source; a `sequence` override of any extension wins in the builder', () => {
		const { snap } = snapshotOf([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		]);
		const c = snap.videoTracks[0]!.clips[0]!;
		const inputs: string[][] = [];
		const chain = layerSourceChain({
			clip: c,
			f0: 3,
			f1: 30,
			fps: snap.settings.fps,
			sources: { media: () => null, mgMaster: () => null },
			override: { path: '/mg/master.mov', space: 'layer', startFrame: 0 },
			addInput: (a) => {
				inputs.push(a);
				return inputs.length - 1;
			},
		});
		expect(chain.input).toBe('[0:v:0]');
		expect(inputs[0]).toEqual(['-ss', '0.100000', '-t', '0.966667', '-i', '/mg/master.mov']);
		expect(chain.filters.join(',')).toContain('trim=end_frame=27,scale=1920:1080');
		const mg: NativeExtension = {
			id: 'mg',
			override: () => ({ path: '/mg/master.mov', space: 'layer', startFrame: 0 }),
		};
		const warp: NativeExtension = {
			id: 'warp',
			override: () => ({ path: '/warp/x.mov', space: 'sequence', startFrame: 0 }),
		};
		expect(pickOverride([mg, warp], new Map(), c)?.path).toBe('/warp/x.mov');
		expect(pickOverride([mg], new Map(), c)?.path).toBe('/mg/master.mov');
		expect(pickOverride([], new Map(), c)).toBeNull();
	});
});

describe('warp kernel (TRK-032/034 sampling rules)', () => {
	const img = (w: number, h: number, px: (x: number, y: number) => number[]) => {
		const a = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(px(x, y), (y * w + x) * 4);
		return a;
	};
	const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

	it('the identity reproduces the source exactly and leaves the rest transparent', () => {
		const src = img(4, 3, (x, y) => [x * 60, y * 100, 7, 255]);
		const dst = new Uint8Array(6 * 5 * 4).fill(99);
		warpFrame(src, 4, 3, dst, 6, 5, 'rgba', I, 1, [0, 0, 6, 5]);
		for (let y = 0; y < 5; y++)
			for (let x = 0; x < 6; x++) {
				const o = (y * 6 + x) * 4;
				const want = x < 4 && y < 3 ? [x * 60, y * 100, 7, 255] : [0, 0, 0, 0];
				expect([...dst.subarray(o, o + 4)], `${x},${y}`).toEqual(want);
			}
	});

	it('a half-pixel shift averages neighbours; edges fade to transparent without darkening (premultiplied)', () => {
		const src = img(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
		const dst = new Uint8Array(3 * 1 * 4);
		// dest x ← source x − 0.5 (inverse map shifts by −0.5).
		warpFrame(src, 2, 1, dst, 3, 1, 'rgba', [1, 0, -0.5, 0, 1, 0, 0, 0, 1], 1, [0, 0, 3, 1]);
		expect([...dst.subarray(0, 4)]).toEqual([255, 0, 0, 128]); // half covered, full red (not darkened)
		expect([...dst.subarray(4, 8)]).toEqual([128, 0, 128, 255]);
		expect([...dst.subarray(8, 12)]).toEqual([0, 0, 255, 128]);
		// A transparent texel does not pull the colour towards black.
		const semi = img(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
		warpFrame(semi, 2, 1, dst, 3, 1, 'rgba', [1, 0, -0.5, 0, 1, 0, 0, 0, 1], 1, [0, 0, 3, 1]);
		expect([...dst.subarray(4, 8)]).toEqual([255, 255, 255, 128]);
	});

	it('multiplies alpha by the opacity; only the rectangle is computed; yuva output is BT.709 TV range', () => {
		const src = img(2, 2, () => [255, 255, 255, 255]);
		const dst = new Uint8Array(2 * 2 * 4);
		warpFrame(src, 2, 2, dst, 2, 2, 'rgba', I, 0.5, [0, 0, 1, 2]);
		expect([...dst]).toEqual([255, 255, 255, 128, 0, 0, 0, 0, 255, 255, 255, 128, 0, 0, 0, 0]);
		const yuv = new Uint8Array(2 * 2 * 8);
		warpFrame(src, 2, 2, yuv, 2, 2, 'yuva444p10', I, 1, [0, 0, 1, 1]);
		const p = new Uint16Array(yuv.buffer);
		// Planes Y, Cb, Cr, A: pixel 0 is white/opaque, the others transparent black.
		expect([...p]).toEqual([940, 64, 64, 64, 512, 512, 512, 512, 512, 512, 512, 512, 1023, 0, 0, 0]);
		const red = img(1, 1, () => [255, 0, 0, 255]);
		const one = new Uint8Array(8);
		warpFrame(red, 1, 1, one, 1, 1, 'yuva444p10', I, 1, [0, 0, 1, 1]);
		// BT.709 red: Y' 0.2126 → 64 + 186 = 250; Cr = 512 + 448 = 960; Cb = 512 − 0.2126/1.8556·896 ≈ 409.
		expect([...new Uint16Array(one.buffer)]).toEqual([250, 409, 960, 1023]);
	});

	it('destRect bounds the projected box with a 1 px fringe, clamped', () => {
		expect(destRect([2, 0, 10, 0, 2, 20, 0, 0, 1], 100, 50, 1920, 1080)).toEqual([9, 19, 211, 121]);
		expect(destRect([1, 0, 5000, 0, 1, 0, 0, 0, 1], 100, 50, 1920, 1080)).toBeNull();
		expect(destRect([1, 0, 0, 0, 1, 0, -0.01, 0, 1], 200, 50, 1920, 1080)).toEqual([0, 0, 1920, 1080]);
	});
});

describe('warp claims and blockers', () => {
	const ext = (others: NativeExtension[] = []) => {
		const warp = createWarpExtension({
			ffmpeg: new Ffmpeg({ ffmpeg: null, ffprobe: null }),
			cacheDir: '/nonexistent',
			getExtensions: () => [...others, warp],
		});
		return warp;
	};

	it('claims corner-pinned / keyframed-Motion / animated-opacity layers of sourceable kinds only', () => {
		const { snap } = snapshotOf([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 0, 0, 1], ref: '$b' },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V3', color: [1, 0, 0, 1], ref: '$c' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
			{
				type: 'keyframe.add',
				target: ['clip', '$b', 'transform', 'rotation'],
				at: { sequenceFrame: 0 },
				value: 0,
			},
			{
				type: 'keyframe.add',
				target: ['clip', '$b', 'transform', 'rotation'],
				at: { sequenceFrame: 9 },
				value: 9,
			},
		]);
		const [a, b, c] = snap.videoTracks.map((t) => t.clips[0]!);
		expect([warpClaims(a!), warpClaims(b!), warpClaims(c!)]).toEqual([true, true, false]);
		const op = structuredClone(c!);
		op.opacity = { ...op.opacity, keyframes: [{ id: 'k', time: 0, value: 50 } as never] };
		expect(warpClaims(op)).toBe(true);
		for (const kind of ['motion-graphic', 'text', 'adjustment', 'nest'] as const)
			expect(warpClaims({ ...a!, kind } as never), kind).toBe(false);
		const disabled = structuredClone(a!);
		disabled.effects[0]!.enabled = false;
		expect(warpClaims(disabled)).toBe(false);
		// Claimed layers skip the M1 Motion/effect checks in the planner.
		expect(nativeBlockers(b!, caps).join()).toMatch(/animated Motion/);
		expect(nativeBlockers(b!, caps, [ext()])).toEqual([]);
		expect(nativeBlockers(a!, caps, [ext()])).toEqual([]);
	});

	it('reports effects nobody renders; accepts other extensions’ effects; composition needs an MG extension', () => {
		const { snap } = snapshotOf([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
			{
				type: 'effect.add',
				target: { clipId: '$a' },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 2 },
			},
		]);
		const a = snap.videoTracks[0]!.clips[0]!;
		expect(ext().blockers!(a).join()).toMatch(/gaussian-blur, which the native path cannot render/);
		const blur: NativeExtension = {
			id: 'blur',
			effectSupport: (id) => (id === 'jasper.gaussian-blur' ? 'static' : false),
		};
		expect(ext([blur]).blockers!(a)).toEqual([]);
		const comp = { ...a, kind: 'composition', effects: [a.effects[0]!] } as never;
		expect(warpClaims(comp)).toBe(true);
		expect(ext().blockers!(comp).join()).toMatch(/pre-rendered composition master/);
		expect(ext([{ id: 'mg', kinds: new Set(['composition']) }]).blockers!(comp)).toEqual([]);
	});

	it('per-frame maps follow the keyframes; source px are scaled to the (unrounded) intrinsic box', () => {
		const { snap } = snapshotOf([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$b' },
			{
				type: 'keyframe.add',
				target: ['clip', '$b', 'transform', 'position'],
				at: { sequenceFrame: 0 },
				value: [960, 540],
			},
			{
				type: 'keyframe.add',
				target: ['clip', '$b', 'transform', 'position'],
				at: { sequenceFrame: 10 },
				value: [1060, 540],
			},
			{ type: 'keyframe.add', target: ['clip', '$b', 'opacity'], at: { sequenceFrame: 0 }, value: 100 },
			{ type: 'keyframe.add', target: ['clip', '$b', 'opacity'], at: { sequenceFrame: 10 }, value: 0 },
		]);
		const c = snap.videoTracks[0]!.clips[0]!;
		const { maps, specs } = warpFrames(c, 0, 11, snap.settings.fps, {
			sw: 1920,
			sh: 1080,
			width: 1920,
			height: 1080,
		});
		expect(maps[0]![2]).toBeCloseTo(0);
		expect(maps[5]![2]).toBeCloseTo(50);
		expect(maps[10]![2]).toBeCloseTo(100);
		expect(specs[5]!.opacity).toBeCloseTo(0.5);
		expect(specs[10]).toEqual({ inv: null, rect: null, opacity: 0 }); // invisible: nothing to warp
		expect(specs[5]!.inv![2]).toBeCloseTo(-50);
		const half = warpFrames({ ...c, intrinsicBox: { width: 1000.5, height: 500 } }, 0, 1, snap.settings.fps, {
			sw: 1001,
			sh: 500,
			width: 1920,
			height: 1080,
		});
		expect(half.maps[0]![0]).toBeCloseTo(1000.5 / 1001, 9);
	});
});

describe('warp ffmpeg commands (D-13)', () => {
	it('decodes raw RGBA frames and encodes ProRes 4444 with alpha; no GPL-only filter anywhere', () => {
		const dec = decoderArgs([['-loop', '1', '-i', '/x.png']], '[0:v:0]fps=30/1,format=rgba', 12);
		expect(dec).toEqual(
			expect.arrayContaining(['-frames:v', '12', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']),
		);
		const enc = encoderArgs(
			{ width: 1920, height: 1080, fps: { num: 30000, den: 1001 }, threads: 4 },
			'/o.mov',
		);
		const at = (k: string) => enc[enc.indexOf(k) + 1];
		expect([at('-c:v'), at('-profile:v'), at('-alpha_bits'), at('-r')]).toEqual([
			'prores_ks',
			'4444',
			'16',
			'30000/1001',
		]);
		expect(enc.filter((a) => a === 'yuva444p10le')).toHaveLength(2); // raw input and encoder format
		const text = [dec[dec.indexOf('-filter_complex') + 1], at('-vf')].join(';');
		const GPL = [
			'eq',
			'perspective',
			'boxblur',
			'hqdn3d',
			'smartblur',
			'delogo',
			'frei0r',
			'spp',
			'pp7',
			'uspp',
			'fspp',
			'mpdecimate',
			'pullup',
		];
		for (const name of GPL)
			expect(text, name).not.toMatch(new RegExp(`(^|[\\],;\\s])${name}(=|[,;\\[\\s]|$)`));
	});
});
