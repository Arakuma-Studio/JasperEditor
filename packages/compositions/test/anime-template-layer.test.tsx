// MotionGraphicLayer with both renderers (wp-m2-anime-templates): FIX-001 (LayerBox: effects, corner pin, blend
// incl. `add`), ATP-005 dispatch, ATP-006 keyframed params evaluated per frame, ATP-004 responsive time through the
// layer, FIX-003 gating on font readiness, ATP-010 placeholder, and the gallery preview component (ATP-007).
import { lowerThird, mgRegistry, titleReveal } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	resolveSceneAt,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	FontsReadyContext,
	type LayerProps,
	MgTemplatePreview,
	MotionGraphicLayer,
	type RenderDoc,
	SequenceComposition,
} from '../src/index.ts';

function setup(
	extra: unknown[] = [],
	duration = 150,
): { doc: ProjectDocument; refs: Record<string, string> } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration,
					track: 'V2',
					template: { id: 'title-reveal', version: 1 },
					params: { title: 'Hi there' },
					ref: '$a',
				},
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration,
					track: 'V1',
					template: { id: 'lower-third', version: 1 },
					ref: '$f',
				},
				...extra,
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { doc: document, refs: result.refs };
}

function snapshotOf(doc: ProjectDocument): RenderDoc {
	return buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

function layerAt(doc: ProjectDocument, clipId: string, frame: number): LayerProps {
	const snap = snapshotOf(doc);
	const layer = resolveSceneAt(snap, frame).find((l) => l.clip.clipId === clipId)!;
	return {
		clip: layer.clip,
		props: layer.props,
		localFrame: layer.localFrame,
		contentTime: layer.contentTime,
		fps: 30,
		media: null,
		options: DEFAULT_RENDER_OPTIONS,
	};
}

function renderFrame(doc: RenderDoc, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={frame}
		/>,
	);
}

describe('both renderers through LayerBox (S11:FIX-001, ATP-005)', () => {
	it('effects, corner pin and every blend mode (incl. add) apply to anime and fframes templates', () => {
		const pin = { topLeft: [0.05, 0.1], topRight: [0.95, 0], bottomRight: [1, 1], bottomLeft: [0, 0.9] };
		const { doc, refs } = setup();
		const { document } = applyTransaction(
			doc,
			{
				label: 'fx',
				origin: 'user',
				commands: [
					{
						type: 'effect.add',
						target: { clipId: refs.$a! },
						effectId: 'jasper.gaussian-blur',
						params: { radius: 6 },
					},
					{ type: 'effect.add', target: { clipId: refs.$a! }, effectId: 'jasper.corner-pin', params: pin },
					{
						type: 'effect.add',
						target: { clipId: refs.$f! },
						effectId: 'jasper.gaussian-blur',
						params: { radius: 3 },
					},
					{ type: 'clip.update', clipId: refs.$f!, patch: { blendMode: 'add' } },
					{ type: 'clip.update', clipId: refs.$a!, patch: { blendMode: 'screen' } },
				],
			},
			{
				ids: createCounterIdSource(50),
				now: () => 't',
				revision: 1,
				registries: defaultRegistries(mgRegistry),
			},
		);
		const r = renderFrame(snapshotOf(document), 40);
		const anime = r.container.querySelector<HTMLElement>(`[data-clip-id="${refs.$a}"]`)!;
		const fframes = r.container.querySelector<HTMLElement>(`[data-clip-id="${refs.$f}"]`)!;
		expect(
			anime.querySelector('[data-mg-renderer="anime"] [data-anime-template="title-reveal@1"]'),
		).not.toBeNull();
		expect(anime.querySelector('[data-effect="jasper.gaussian-blur"]')).not.toBeNull();
		expect(anime.style.transform).toMatch(/^matrix3d\(/);
		expect(anime.style.mixBlendMode).toBe('screen');
		expect(fframes.querySelector('[data-mg-renderer="fframes"] svg')).not.toBeNull();
		expect(fframes.querySelector('[data-effect="jasper.gaussian-blur"]')).not.toBeNull();
		expect(fframes.style.mixBlendMode).toBe('plus-lighter');
	});

	it('anime templates clip to their canvas = the layer box, like the hybrid crop (review fix)', () => {
		// callout with the label near the right edge, scaled to 50 %: the label box leaves the canvas; the layer
		// clips it at the box (the hybrid export crops the box + bleed, so both show the same).
		const { doc, refs } = setup([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 150,
				track: 'V3',
				template: { id: 'callout', version: 1 },
				params: { labelX: 0.95 },
				ref: '$c',
			},
		]);
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'scale',
				origin: 'user',
				commands: [{ type: 'param.set', target: ['clip', refs.$c!, 'transform', 'scale'], value: 50 }],
			},
			{
				ids: createCounterIdSource(60),
				now: () => 't',
				revision: 1,
				registries: defaultRegistries(mgRegistry),
			},
		);
		expect(result.ok).toBe(true);
		const r = renderFrame(snapshotOf(document), 90);
		const layer = r.container.querySelector<HTMLElement>(`[data-clip-id="${refs.$c}"]`)!;
		const root = layer.querySelector<HTMLElement>(
			'[data-mg-renderer="anime"] [data-anime-template="callout@1"]',
		)!;
		expect(root.style.overflow).toBe('hidden');
		expect(root.style.position).toBe('absolute');
		// the content root fills the template's FILL div, which fills the layer box (the canvas)
		const fill = root.parentElement!;
		expect(fill.style.inset).toMatch(/^0(px)?$/);
		const label = root.querySelector<HTMLElement>('[data-part="label"]')!;
		expect(Number.parseFloat(label.style.left) + Number.parseFloat(label.style.width)).toBeGreaterThan(1920);
	});

	it('keeps the fframes twin markup identical and its badge in preview only', () => {
		const { doc, refs } = setup();
		const layer = layerAt(doc, refs.$f!, 60);
		const r = render(<MotionGraphicLayer {...layer} />);
		const expected = lowerThird.renderSvg(
			lowerThird.defaults,
			60,
			30,
			{ width: 1920, height: 1080 },
			{
				durationFrames: 150,
				idPrefix: `mg-${refs.$f}`,
			},
		);
		const normalize = (html: string) => html.replace(/<(rect)([^>]*)\/>/g, '<$1$2></$1>');
		expect(r.container.innerHTML).toContain(normalize(expected));
		expect(r.container.querySelector('[data-mg-badge]')).not.toBeNull();
		const anime = render(<MotionGraphicLayer {...layerAt(doc, refs.$a!, 60)} />);
		expect(anime.container.querySelector('[data-mg-badge]')).toBeNull();
	});
});

describe('keyframed params (S11:ATP-006) and responsive time (ATP-004) through the layer', () => {
	it('evaluates keyframes of colour params per frame with the shared evaluator', () => {
		const { doc, refs } = setup();
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'kf',
				origin: 'user',
				commands: [
					{
						type: 'keyframe.add',
						target: ['clip', refs.$a!, 'params', 'titleColor'],
						at: { frames: 50 },
						value: [1, 0, 0, 1],
					},
					{
						type: 'keyframe.add',
						target: ['clip', refs.$a!, 'params', 'titleColor'],
						at: { frames: 100 },
						value: [0, 0, 1, 1],
					},
				],
			},
			{
				ids: createCounterIdSource(80),
				now: () => 't',
				revision: 1,
				registries: defaultRegistries(mgRegistry),
			},
		);
		expect(result.ok).toBe(true);
		const colorAt = (frame: number) => {
			const r = render(<MotionGraphicLayer {...layerAt(document, refs.$a!, frame)} />);
			const c = r.container.querySelector<HTMLElement>('[data-part="title"]')!.style.color;
			r.unmount();
			return c;
		};
		expect(colorAt(50)).toBe('rgba(255, 0, 0, 1)');
		expect(colorAt(75)).toBe('rgba(128, 0, 128, 1)');
		expect(colorAt(100)).toBe('rgba(0, 0, 255, 1)');
		expect(colorAt(140)).toBe('rgba(0, 0, 255, 1)');
	});

	it('the intro and the outro are identical when the clip is stretched', () => {
		const a = setup([], 150);
		const b = setup([], 400);
		const markup = (s: typeof a, frame: number) => {
			const r = render(<MotionGraphicLayer {...layerAt(s.doc, s.refs.$a!, frame)} />);
			const html = r.container.innerHTML;
			r.unmount();
			return html;
		};
		for (const f of [0, 5, 20, 36]) expect(markup(b, f)).toBe(markup(a, f));
		for (const k of [1, 5, 17]) expect(markup(b, 400 - k)).toBe(markup(a, 150 - k));
		expect(markup(a, 0)).not.toBe(markup(a, 20));
	});
});

describe('readiness and missing templates', () => {
	it('draws nothing before the document fonts have settled (S11:FIX-003)', () => {
		const { doc, refs } = setup();
		const layer = layerAt(doc, refs.$a!, 60);
		const waiting = render(
			<FontsReadyContext.Provider value={{ allLoaded: false }}>
				<MotionGraphicLayer {...layer} />
			</FontsReadyContext.Provider>,
		);
		expect(waiting.container.querySelector('[data-anime-template]')).toBeNull();
		expect(waiting.container.querySelector('[data-mg-renderer="anime"]')).not.toBeNull();
	});

	it('draws the "not installed" card for unknown templates, whatever their stamp (S11:ATP-010)', () => {
		const { doc, refs } = setup();
		const layer = layerAt(doc, refs.$a!, 10);
		for (const renderer of ['anime', undefined] as const) {
			const clip = {
				...layer.clip,
				source: {
					mg: {
						template: { id: 'later', version: 9 },
						params: {},
						canvas: { width: 1920, height: 1080 },
						...(renderer ? { renderer } : {}),
					},
				},
			};
			const r = render(<MotionGraphicLayer {...layer} clip={clip} />);
			expect(r.container.textContent).toContain('Template later@9 is not installed');
			expect(r.container.querySelector('[data-mg-installed="false"]')).not.toBeNull();
			expect(r.container.querySelector('[data-mg-badge]')).toBeNull();
			r.unmount();
		}
	});
});

describe('MgTemplatePreview (S11:ATP-007 posters and hover previews)', () => {
	it('draws anime and fframes templates alone on the canvas', () => {
		const thumb = (templateId: string, frame: number) =>
			render(
				<Thumbnail
					component={MgTemplatePreview}
					inputProps={{ templateId, version: 1 }}
					compositionWidth={640}
					compositionHeight={360}
					durationInFrames={150}
					fps={30}
					frameToDisplay={frame}
				/>,
			);
		const a = thumb(titleReveal.id, 60);
		expect(a.container.querySelector('[data-anime-template="title-reveal@1"]')).not.toBeNull();
		expect(a.container.textContent).toContain(titleReveal.defaults.subtitle);
		const f = thumb(lowerThird.id, 60);
		expect(f.container.querySelector('svg')?.getAttribute('width')).toBe('640');
		const missing = thumb('nope', 0);
		expect(missing.container.textContent).toContain('Template nope@1 is not installed');
	});
});
