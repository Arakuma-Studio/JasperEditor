// Spec 19 TL-124 / TL-125 / TL-123: the export plan reports WebGL. A sequence whose browser-drawn parts need WebGL2 (GPU
// effects, also inside nested sequences; GPU transitions…) is refused at plan time, naming the cause, when the render
// browser has none; an effect that requires float render targets is refused when they are missing. Before, the plan
// succeeded and the render failed in the middle (nested sequences were not even looked at).
import {
	createEffectRegistry,
	defaultEffectRegistry,
	type EffectRegistry,
	type GlNeed,
	snapshotGlNeeds,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type PlanCapabilities, PlanError, planExport } from '../src/export/planner.ts';
import { webglRefusal } from '../src/remotion/webgl-refusal.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, ensureFixtures, makeApp, type TestApp } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string, engine = 'auto') => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine,
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

const caps = (webgl?: PlanCapabilities['webgl']): PlanCapabilities => ({
	native: true,
	remotionLocal: 'ready',
	fframes: 'ready',
	mgMasters: true,
	...(webgl ? { webgl } : {}),
});

/** A glow (GPU effect) on a red solid; `nested` puts the solid in a nested sequence instead of the main one. */
function glowDoc(nested: boolean): DocBuilder {
	const d = new DocBuilder();
	const r = d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$c' },
	]);
	const clip = r.refs.$c!;
	d.tx([{ type: 'effect.add', target: { clipId: clip }, effectId: 'jasper.s.glow' }]);
	if (nested) d.tx([{ type: 'clip.nest', clipIds: [clip] }]);
	return d;
}
const plan = (d: DocBuilder, c: PlanCapabilities, effects?: EffectRegistry, engine = 'auto') =>
	planExport(
		{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engine) as never },
		{
			registry: coreServices(app).registry,
			fonts: coreServices(app).fonts,
			capabilities: c,
			extensions: [],
			...(effects ? { effects } : {}),
		},
	);
const refused = async (p: Promise<unknown>): Promise<PlanError> => {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(PlanError);
		return e as PlanError;
	}
	throw new Error('the plan was accepted');
};

describe('webglRefusal', () => {
	const glow: GlNeed = { kind: 'effect', id: 'jasper.s.glow', label: 'Glow', clipId: 'clp_1' };
	const floaty: GlNeed = {
		kind: 'effect',
		id: 'x',
		label: 'X',
		float: { code: 'X_NEEDS_FLOAT', message: 'X needs float' },
	};
	it('refuses a missing WebGL2 by name, and a missing float target by the effect’s code', () => {
		expect(webglRefusal([], { state: 'unavailable' })).toBeNull();
		expect(webglRefusal([glow], { state: 'unavailable', message: 'no gl' })).toMatchObject({
			code: 'WEBGL_UNAVAILABLE',
		});
		expect(webglRefusal([glow], { state: 'unavailable', message: 'no gl' })!.message).toContain('Glow');
		expect(webglRefusal([glow, floaty], { state: 'ok', floatTargets: false })).toMatchObject({
			code: 'X_NEEDS_FLOAT',
		});
	});
	it('refuses nothing it does not know: not probed, float present or unprobed, no float effect', () => {
		expect(webglRefusal([glow, floaty], { state: 'unknown' })).toBeNull();
		expect(webglRefusal([glow, floaty], { state: 'ok', floatTargets: true })).toBeNull();
		expect(webglRefusal([glow, floaty], { state: 'ok' })).toBeNull();
		expect(webglRefusal([glow], { state: 'ok', floatTargets: false })).toBeNull();
	});
});

describe('snapshotGlNeeds sees nested sequences (TL-125)', () => {
	it('finds the glow of a nested clip that the top level hides behind a nest clip', async () => {
		const d = glowDoc(true);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const top = planned.snapshot.videoTracks.flatMap((t) => t.clips);
		expect(top.every((c) => c.effects.length === 0)).toBe(true); // the top level has no effect of its own
		expect(snapshotGlNeeds(planned.snapshot).map((n) => n.id)).toEqual(['jasper.s.glow']);
	});
});

describe('the plan reports WebGL (TL-124)', () => {
	it('refuses a GPU effect when the render browser has no WebGL2, naming it and its clip', async () => {
		const d = glowDoc(false);
		const err = await refused(
			plan(
				d,
				caps(async () => ({ state: 'unavailable', message: 'no gl' })),
			),
		);
		expect(err.code).toBe('WEBGL_UNAVAILABLE');
		expect(err.status).toBe(409);
		expect(err.message).toContain('Glow');
		const detail = err.detail as { blockers: { reason: string; itemId?: string }[] };
		expect(detail.blockers[0]!.reason).toContain('Glow');
		expect(detail.blockers[0]!.itemId).toBeTruthy();
	});

	it('does so for a GPU effect inside a nested sequence too (TL-125)', async () => {
		const d = glowDoc(true);
		const err = await refused(
			plan(
				d,
				caps(async () => ({ state: 'unavailable' })),
			),
		);
		expect(err.code).toBe('WEBGL_UNAVAILABLE');
	});

	it('plans normally with WebGL2, with an unknown probe, and without the capability', async () => {
		const d = glowDoc(true);
		for (const c of [
			caps(async () => ({ state: 'ok', floatTargets: true })),
			caps(async () => ({ state: 'unknown' })),
			caps(),
		])
			expect((await plan(d, c)).plan.path).toBe('remotion');
	});

	it('never asks for WebGL when the browser draws nothing (a native sequence)', async () => {
		const d = new DocBuilder();
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const webgl = vi.fn(async () => ({ state: 'unavailable' as const }));
		expect((await plan(d, caps(webgl))).plan.path).toBe('native');
		expect(webgl).not.toHaveBeenCalled();
	});
});

describe('an effect that requires float render targets is refused without them (TL-123)', () => {
	const glow = defaultEffectRegistry.get('jasper.s.glow')!;
	const needsFloat = (code: boolean | string): EffectRegistry =>
		createEffectRegistry([
			...defaultEffectRegistry.list().filter((s) => s.id !== glow.id),
			{ ...glow, gpu: { ...glow.gpu!, requiresFloat: code } },
		]);

	it('names the effect’s own code as the blocker', async () => {
		const d = glowDoc(false);
		const err = await refused(
			plan(
				d,
				caps(async () => ({ state: 'ok', floatTargets: false })),
				needsFloat('TITLE_LOOK_NEEDS_FLOAT'),
			),
		);
		expect(err.code).toBe('TITLE_LOOK_NEEDS_FLOAT');
		expect(err.message).toContain('Glow');
		expect(err.message).toContain('float');
	});

	it('uses FX_NEEDS_FLOAT when the effect names no code', async () => {
		const err = await refused(
			plan(
				glowDoc(true),
				caps(async () => ({ state: 'ok', floatTargets: false })),
				needsFloat(true),
			),
		);
		expect(err.code).toBe('FX_NEEDS_FLOAT');
	});

	it('plans when float targets exist, and effects that do not declare it keep today’s behaviour', async () => {
		const noFloat = caps(async () => ({ state: 'ok', floatTargets: false }));
		expect(
			(
				await plan(
					glowDoc(false),
					caps(async () => ({ state: 'ok', floatTargets: true })),
					needsFloat(true),
				)
			).plan.path,
		).toBe('remotion');
		expect((await plan(glowDoc(false), noFloat)).plan.path).toBe('remotion');
	});
});
