// Program-monitor text editing (WP7b canvas-edit): the edited anime-template clip is drawn at its rest frame in previews
// (template-edit-hold.ts), never in renders, and live instead of its graded preview while held.
import { animeTemplateTiming } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	LUMETRI_EFFECT_ID,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@jasper/mg-templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/mg-templates')>();
	const { HOLD_TEST_TEMPLATE } = await import('../../mg-templates/test/fixtures/hold-test-template.ts');
	return { ...m, mgRegistry: m.createMgRegistry([...m.MG_CATALOG, HOLD_TEST_TEMPLATE]) };
});
vi.mock('@jasper/motion/templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/motion/templates')>();
	const { HoldTest } = await import('./fixtures/hold-test-impl.tsx');
	return {
		...m,
		ANIME_TEMPLATE_IMPLS: Object.freeze({ ...m.ANIME_TEMPLATE_IMPLS, 'hold-test@1': HoldTest }),
	};
});

const { mgRegistry } = await import('@jasper/mg-templates');
const {
	animeTemplateRestMs,
	DEFAULT_RENDER_OPTIONS,
	SequenceComposition,
	setBakedLayerRuntime,
	setTemplateEditHold,
	templateEditHold,
} = await import('../src/index.ts');

function project(extra: unknown[] = []): { snap: RenderSnapshot; clipId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Hold', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) };
	const r = applyTransaction(
		base,
		{
			label: 'add',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 90,
					track: 'V1',
					template: { id: 'hold-test', version: 1 },
					ref: '$t',
				},
				...extra,
			] as never,
		},
		ctx,
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	const clipId = r.result.refs.$t!;
	const snap = buildRenderSnapshot(r.document, Object.keys(r.document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	return { snap, clipId };
}

function renderFrame(snap: RenderSnapshot, isPreview: boolean, frame = 5) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc: snap, options: { ...DEFAULT_RENDER_OPTIONS, isPreview } }}
			compositionWidth={snap.settings.width}
			compositionHeight={snap.settings.height}
			durationInFrames={Math.max(1, snap.durationFrames)}
			fps={30}
			frameToDisplay={frame}
		/>,
	);
}

const timeOf = (c: HTMLElement) => Number(c.querySelector('[data-hold-test]')?.getAttribute('data-time'));

afterEach(() => {
	setTemplateEditHold(null);
	setBakedLayerRuntime(null);
});

describe('animeTemplateRestMs', () => {
	it('is the last frame before the outro, or the end of a compressed intro', () => {
		const t = animeTemplateTiming(
			{ introFrames: 15, outroFrames: 6 },
			{ fps: 30, localFrame: 3, durationFrames: 90 },
		);
		expect(animeTemplateRestMs(t)).toBeCloseTo((83 * 1000) / 30);
		// Intro and outro fill the clip: the end of the intro (= the start of the outro).
		const c = animeTemplateTiming(
			{ introFrames: 15, outroFrames: 6 },
			{ fps: 30, localFrame: 0, durationFrames: 14 },
		);
		expect(animeTemplateRestMs(c)).toBeCloseTo(c.introMs);
		expect(animeTemplateRestMs(c)).toBeLessThanOrEqual(c.totalMs - c.outroMs + 1e-9);
	});

	it('stays inside the clip and after the intro for any timing (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 600 }),
				fc.integer({ min: 0, max: 600 }),
				fc.integer({ min: 1, max: 100_000 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.constantFrom(23.976, 24, 25, 29.97, 30, 50, 60),
				(intro, outro, duration, sourceIn, fps) => {
					const t = animeTemplateTiming(
						{ introFrames: intro, outroFrames: outro },
						{ fps, localFrame: 0, durationFrames: duration, sourceInFrames: sourceIn },
					);
					const ms = animeTemplateRestMs(t);
					expect(Number.isFinite(ms)).toBe(true);
					expect(ms).toBeGreaterThanOrEqual(t.introMs - 1e-6);
					expect(ms).toBeLessThanOrEqual(t.totalMs);
				},
			),
		);
	});
});

describe('template edit hold', () => {
	it('draws the held clip at its rest time in previews only; releasing restores the playhead time', () => {
		const { snap, clipId } = project();
		const view = renderFrame(snap, true);
		expect(timeOf(view.container)).toBeCloseTo((5 * 1000) / 30, 2);
		expect(view.container.querySelector('[data-template-hold]')).toBeNull();
		act(() => setTemplateEditHold(clipId));
		expect(templateEditHold()).toBe(clipId);
		expect(timeOf(view.container)).toBeCloseTo((83 * 1000) / 30, 2);
		expect(view.container.querySelector('[data-template-hold="true"]')).not.toBeNull();
		act(() => setTemplateEditHold(null));
		expect(timeOf(view.container)).toBeCloseTo((5 * 1000) / 30, 2);
		view.unmount();

		// Renders (export, stills) never see the hold.
		setTemplateEditHold(clipId);
		const out = renderFrame(snap, false);
		expect(timeOf(out.container)).toBeCloseTo((5 * 1000) / 30, 2);
		expect(out.container.querySelector('[data-template-hold]')).toBeNull();
		out.unmount();
	});

	it('only the held clip is affected', () => {
		const { snap } = project();
		setTemplateEditHold('clp_other');
		const view = renderFrame(snap, true);
		expect(timeOf(view.container)).toBeCloseTo((5 * 1000) / 30, 2);
		view.unmount();
	});

	it('a held clip with a graded preview is drawn live (the editor measures its DOM)', () => {
		const { snap, clipId } = project([
			{ type: 'effect.add', target: { clipId: '$t' }, effectId: LUMETRI_EFFECT_ID },
		]);
		setBakedLayerRuntime({
			previewFor: () => ({ url: 'https://engine.test/preview.webm', rect: null }),
			subscribe: () => () => {},
			version: () => 1,
		});
		const view = renderFrame(snap, true);
		expect(view.container.querySelector('[data-hold-test]')).toBeNull();
		act(() => setTemplateEditHold(clipId));
		expect(view.container.querySelector('[data-hold-test]')).not.toBeNull();
		expect(timeOf(view.container)).toBeCloseTo((83 * 1000) / 30, 2);
		view.unmount();
	});
});
