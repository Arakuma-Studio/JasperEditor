// M2 native extensions (ARCHITECTURE §19.6): the planner consults them for kinds, claimed layers and effects;
// the builder asks them for effect filters and pre-rendered layer overrides.
import {
	applyTransaction,
	buildRenderSnapshot,
	CORNER_PIN_EFFECT_ID,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type ProjectDocument,
	type RenderSnapshot,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { type NativeExtension, sampleRuns } from '../src/export/native-ext.ts';
import { nativeBlockers, type PlanCapabilities } from '../src/export/planner.ts';

const caps: PlanCapabilities = {
	native: true,
	remotionLocal: 'ready',
	fframes: 'unavailable',
	mgMasters: false,
};

function doc(commands: unknown[]): { doc: ProjectDocument; seqId: string } {
	const ids = createSeededIdSource(3);
	const d = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const seqId = Object.keys(d.sequences)[0]!;
	const { document, result } = applyTransaction(
		d,
		{ protocol: 'jasper.tx/1', label: 't', origin: 'user', commands: commands as never },
		{ ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { doc: document, seqId };
}

function snapshotOf(commands: unknown[]): RenderSnapshot {
	const { doc: d, seqId } = doc(commands);
	return buildRenderSnapshot(d, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

const output = {
	width: 1920,
	height: 1080,
	fps: { num: 30, den: 1 },
	frames: 30,
	durationSec: 1,
	scaling: 'fit',
	crf: 18,
	x264Preset: 'veryfast',
	audioChannels: 2,
	audioBitrateKbps: 192,
} as never;

describe('native extensions (ARCHITECTURE §19.6)', () => {
	const solidWith = (fx: unknown[]) => [
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		...fx.map((f) => ({ type: 'effect.add', target: { clipId: '$s' }, ...(f as object) })),
	];

	it('an effect nobody realizes blocks; an extension that supports it unblocks it', () => {
		const snap = snapshotOf(solidWith([{ effectId: 'jasper.gaussian-blur', params: { radius: 3 } }]));
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(nativeBlockers(clip, caps).join()).toMatch(/gaussian-blur/);
		const blur: NativeExtension = {
			id: 'blur',
			effectSupport: (id) => (id === 'jasper.gaussian-blur' ? 'static' : false),
			effectFilter: (fx) =>
				fx.effectId === 'jasper.gaussian-blur' ? `gblur=sigma=${fx.params.radius}` : undefined,
		};
		expect(nativeBlockers(clip, caps, [blur])).toEqual([]);
		const g = buildNativeGraph({
			snapshot: snap,
			output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 1,
			extensions: { list: [blur], prepared: new Map() },
		});
		expect(g.filter).toContain('gblur=sigma=3');
	});

	it('a claimed layer skips the generic checks and is overlaid from its sequence-space override', () => {
		const snap = snapshotOf(
			solidWith([
				{
					effectId: CORNER_PIN_EFFECT_ID,
					params: {
						topLeft: [0.1, 0.1],
						topRight: [0.9, 0.1],
						bottomRight: [0.8, 0.9],
						bottomLeft: [0.2, 0.9],
					},
				},
			]),
		);
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(nativeBlockers(clip, caps).join()).toMatch(/corner-pin/);
		const warp: NativeExtension = {
			id: 'warp',
			claimsLayer: (c) => c.effects.some((e) => e.effectId === CORNER_PIN_EFFECT_ID),
			prepare: async () => ({ path: '/cache/warp.mov' }),
			override: (c, prepared) =>
				c.clipId === clip.clipId
					? { path: (prepared as { path: string }).path, space: 'sequence', startFrame: 0 }
					: null,
		};
		expect(nativeBlockers(clip, caps, [warp])).toEqual([]);
		const g = buildNativeGraph({
			snapshot: snap,
			output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 1,
			extensions: { list: [warp], prepared: new Map([['warp', { path: '/cache/warp.mov' }]]) },
		});
		expect(g.inputs.some((a) => a.includes('/cache/warp.mov'))).toBe(true);
		expect(g.filter).toMatch(/overlay=x=0:y=0/);
		expect(g.filter).not.toMatch(/color=c=0xff0000ff/);
	});

	it('extension kinds become native-capable (e.g. composition clips)', () => {
		const snap = snapshotOf([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' } },
		]);
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(nativeBlockers(clip, caps).join()).toMatch(/text layer/);
		const hybrid: NativeExtension = { id: 'hybrid', kinds: new Set(['text']) };
		expect(nativeBlockers(clip, caps, [hybrid])).toEqual([]);
	});

	it('sampleRuns groups equal per-frame values', () => {
		const runs = sampleRuns(
			10,
			16,
			(f) => (f < 13 ? 1 : 2),
			(v) => String(v),
		);
		expect(runs).toEqual([
			{ start: 10, end: 13, value: 1 },
			{ start: 13, end: 16, value: 2 },
		]);
	});
});
