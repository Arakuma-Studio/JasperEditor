// Security review EXP-1 (AGENTS.md §4: export never silently drops or approximates a feature). Enumerates the
// registries — every video effect, every transition, every audio effect, the clip kinds and clip features — and
// checks, with the engine's real native extensions, that each is
//  - rendered by the native path by a stage that implements it (built-in effects, colour ops fused into a LUT, a
//    claiming extension), or
//  - baked by an extension (graphics groups, rendered by the compositions), or
//  - refused for the native path by a blocker that names the clip (the export then goes through Remotion), and
//  - in the last two cases, actually drawn by the compositions (a GPU shader, a colour op, a CSS/SVG preview or a
//    dedicated stage), since a feature the compositions do not draw would be dropped on that path too;
// and that every audio effect has an export processor (the planner refuses the others by name on every path).
import {
	CORNER_PIN_EFFECT_ID,
	defaultEffectRegistry,
	type EffectSpec,
	hasAudioProcessor,
	type RenderVisualClip,
	TRANSITION_SPECS,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_NATIVE_EFFECTS } from '../src/export/native-ext.ts';
import { allVideoTracks, allVisualClips, nativeBlockers, planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, type TestApp } from './helpers.ts';

const caps = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };

let app: TestApp;
beforeAll(async () => {
	app = await makeApp();
});
afterAll(async () => {
	await closeApps();
});

function exportService() {
	return (coreServices(app) as unknown as { exports: { nativeExtensions: { all(): never[] } } }).exports;
}

async function snapshotOf(d: DocBuilder) {
	const core = coreServices(app) as unknown as { registry: never; fonts: never };
	const planned = await planExport(
		{
			envelope: d.envelope() as never,
			sequenceId: d.seqId,
			settings: { container: 'mp4', range: { type: 'entire' }, engine: 'auto' } as never,
		},
		{
			registry: core.registry,
			fonts: core.fonts,
			capabilities: caps,
			extensions: exportService().nativeExtensions.all(),
		},
	);
	return planned;
}

/** The compositions draw this effect (shader, colour op, CSS/SVG, or a dedicated stage). */
function drawnByCompositions(spec: EffectSpec): boolean {
	return (
		!!spec.gpu ||
		!!spec.color ||
		!!spec.preview.css ||
		!!spec.preview.svgFilter ||
		spec.id === CORNER_PIN_EFFECT_ID ||
		BUILTIN_NATIVE_EFFECTS.has(spec.id)
	);
}

type Route = { route: 'native' | 'baked' | 'blocked'; reasons: string[] };

function routeOf(c: RenderVisualClip): Route {
	const exts = exportService().nativeExtensions.all() as Parameters<typeof nativeBlockers>[2];
	const reasons = nativeBlockers(c, caps, exts, defaultEffectRegistry);
	if (reasons.length) return { route: 'blocked', reasons };
	if (exts.some((e) => (e.bakes?.(c) ?? null) !== null)) return { route: 'baked', reasons };
	return { route: 'native', reasons };
}

/** Native without a blocker: every enabled effect must be implemented by a native stage. */
function nativelyImplemented(c: RenderVisualClip, effectId: string): boolean {
	const exts = exportService().nativeExtensions.all() as Parameters<typeof nativeBlockers>[2];
	const spec = defaultEffectRegistry.get(effectId);
	if (BUILTIN_NATIVE_EFFECTS.has(effectId)) return true;
	if (exts.some((e) => (e.effectSupport?.(effectId, spec ?? undefined) ?? false) !== false)) return true;
	// A claiming extension (e.g. the warp stage for Corner Pin) renders the whole layer and reports its own blockers.
	return exts.some((e) => e.claimsLayer?.(c));
}

const videoEffects = defaultEffectRegistry
	.list()
	.filter((e) => e.appliesTo === 'video' && !e.passthrough && !e.internal);

describe('EXP-1: every video effect is rendered, baked or named by a blocker', () => {
	it(`covers all ${videoEffects.length} video effects`, async () => {
		const d = new DocBuilder();
		const refused: string[] = [];
		const clipOf = new Map<string, string>();
		videoEffects.forEach((spec, i) => {
			const at = i * 2;
			const r = d.tx([
				{
					type: 'clip.addSolid',
					at,
					duration: 2,
					track: 'V1',
					color: [0.2, 0.4, 0.6, 1],
					name: spec.id,
					ref: '$c',
				},
			]);
			const clipId = r.refs.$c!;
			try {
				d.tx([{ type: 'effect.add', target: { clipId }, effectId: spec.id }]);
				clipOf.set(spec.id, clipId);
			} catch (e) {
				refused.push(`${spec.id}: ${(e as Error).message.slice(0, 160)}`);
			}
		});
		// effect.add on a solid may refuse an effect that needs another layer kind; that must be the exception.
		expect(refused.length, refused.join('\n')).toBeLessThan(videoEffects.length / 10);
		const planned = await snapshotOf(d);
		const byClip = new Map(allVisualClips(planned.snapshot).map((c) => [c.clipId, c]));
		const silent: string[] = [];
		const undrawn: string[] = [];
		const routes: Record<string, number> = {};
		for (const spec of videoEffects) {
			const clipId = clipOf.get(spec.id);
			if (!clipId) continue;
			const c = byClip.get(clipId);
			if (!c) {
				silent.push(`${spec.id}: the clip is missing from the render snapshot`);
				continue;
			}
			if (!c.effects.some((fx) => fx.effectId === spec.id && fx.enabled)) {
				silent.push(`${spec.id}: the effect is missing from the render snapshot`);
				continue;
			}
			const r = routeOf(c);
			routes[r.route] = (routes[r.route] ?? 0) + 1;
			if (r.route === 'blocked' && !r.reasons.some((x) => x.includes(c.name) || x.includes(spec.id)))
				silent.push(`${spec.id}: blocker does not name the clip or effect (${r.reasons.join('; ')})`);
			if (r.route === 'native' && !nativelyImplemented(c, spec.id))
				silent.push(`${spec.id}: no blocker, no bake and no native implementation`);
			if (r.route !== 'native' && !drawnByCompositions(spec))
				undrawn.push(`${spec.id}: routed to ${r.route} but the compositions do not draw it`);
		}
		expect(silent, silent.join('\n')).toEqual([]);
		expect(undrawn, undrawn.join('\n')).toEqual([]);
		expect((routes.blocked ?? 0) + (routes.baked ?? 0) + (routes.native ?? 0)).toBe(clipOf.size);
	}, 300_000);
});

describe('EXP-1: transitions', () => {
	const video = TRANSITION_SPECS.filter((t) => t.appliesTo !== 'audio');
	it(`every one of the ${video.length} video transitions is a ramp, baked, or named by a blocker`, async () => {
		const d = new DocBuilder();
		const placed: { id: string; at: number }[] = [];
		video.forEach((t, i) => {
			const at = i * 40;
			const r = d.tx([
				{ type: 'clip.addSolid', at, duration: 20, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
				{ type: 'clip.addSolid', at: at + 20, duration: 20, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
			]);
			d.tx([
				{
					type: 'transition.add',
					clipId: r.refs.$b,
					edge: 'in',
					effectId: t.id,
					duration: 6,
					alignment: 'center',
				},
			]);
			placed.push({ id: t.id, at });
		});
		const planned = await snapshotOf(d);
		const tracks = allVideoTracks(planned.snapshot);
		const inSnapshot = new Set(tracks.flatMap((tr) => (tr.transitions ?? []).map((t) => t.effectId)));
		const fades = allVisualClips(planned.snapshot).some((c) => (c.fades ?? []).length > 0);
		const exts = exportService().nativeExtensions.all() as Parameters<typeof nativeBlockers>[2];
		const silent: string[] = [];
		for (const t of video) {
			if (!inSnapshot.has(t.id)) {
				// The built-in ramps are rendered as clip fades by every path.
				if (t.gpu || !fades) silent.push(`${t.id}: not in the render snapshot as a transition or a fade`);
				continue;
			}
			const tr = tracks
				.flatMap((x) => (x.transitions ?? []).map((y) => ({ y, track: x.trackId })))
				.find(({ y }) => y.effectId === t.id)!;
			const baked = exts.some((e) => (e.bakesTransition?.(tr.y, tr.track) ?? null) !== null);
			const named = planned.plan.blockers.some((b) => b.itemId === tr.y.id && b.reason.includes(t.label));
			if (!baked && !named) silent.push(`${t.id}: neither baked nor named by a blocker`);
			if (!t.gpu && !baked) silent.push(`${t.id}: no GPU stage and not baked`);
		}
		expect(silent, silent.join('\n')).toEqual([]);
	}, 300_000);
});

describe('EXP-1: audio effects', () => {
	it('every audio effect has an export processor (the planner names the others on every path)', () => {
		const audio = defaultEffectRegistry.list().filter((e) => e.appliesTo === 'audio' && !e.passthrough);
		const missing = audio.filter((e) => !hasAudioProcessor(e.id)).map((e) => e.id);
		expect(missing).toEqual([]);
	});
});

describe('EXP-1: clip kinds and clip features', () => {
	it('every kind and feature on a clip is native, baked or named', async () => {
		const d = new DocBuilder();
		const r = d.tx([
			{
				type: 'clip.addSolid',
				at: 0,
				duration: 30,
				track: 'V1',
				color: [1, 1, 1, 1],
				name: 'solid',
				ref: '$solid',
			},
			{
				type: 'clip.addText',
				at: 30,
				duration: 30,
				track: 'V1',
				content: { text: 'kind' },
				name: 'text',
				ref: '$text',
			},
			{
				type: 'clip.addShape',
				at: 60,
				duration: 30,
				track: 'V1',
				shape: { type: 'rect', size: [100, 100], fill: [1, 0, 0, 1] },
				name: 'shape',
				ref: '$shape',
			},
			{ type: 'clip.addCamera', at: 0, duration: 30, name: 'camera' },
			{ type: 'caption.add', at: 0, duration: 30, text: 'caption' },
			{
				type: 'clip.addSolid',
				at: 90,
				duration: 30,
				track: 'V1',
				color: [0, 1, 0, 1],
				name: 'masked',
				ref: '$masked',
			},
			{
				type: 'clip.addSolid',
				at: 120,
				duration: 30,
				track: 'V1',
				color: [0, 1, 0, 1],
				name: 'threeD',
				ref: '$threeD',
			},
			{
				type: 'clip.addSolid',
				at: 150,
				duration: 30,
				track: 'V1',
				color: [0, 1, 0, 1],
				name: 'blend',
				ref: '$blend',
			},
		]);
		d.tx([
			{ type: 'mask.add', clipId: r.refs.$masked, shape: 'ellipse' },
			{ type: 'clip.set3d', clipIds: [r.refs.$threeD], enabled: true },
			{ type: 'clip.update', clipId: r.refs.$blend, patch: { blendMode: 'screen' } },
		]);
		const planned = await snapshotOf(d);
		const silent: string[] = [];
		const seen = new Set<string>();
		for (const c of allVisualClips(planned.snapshot)) {
			seen.add(c.kind);
			const route = routeOf(c);
			if (route.route === 'blocked' && !route.reasons.some((x) => x.includes(c.name)))
				silent.push(`${c.kind} "${c.name}": blocker does not name it (${route.reasons.join('; ')})`);
			for (const fx of c.effects)
				if (fx.enabled && route.route === 'native' && !nativelyImplemented(c, fx.effectId))
					silent.push(`${c.kind} "${c.name}": effect ${fx.effectId} silently dropped on the native path`);
			if (c.threeD && route.route !== 'blocked')
				silent.push(`3D layer "${c.name}" is not refused by the native path`);
		}
		expect(silent, silent.join('\n')).toEqual([]);
		expect([...seen].sort()).toEqual(expect.arrayContaining(['captions', 'shape', 'solid', 'text']));
	}, 300_000);
});
