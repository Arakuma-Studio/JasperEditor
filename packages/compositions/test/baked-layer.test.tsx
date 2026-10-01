// Baked pictures of DOM layers (S11:LBK-010, FIX-002): graded previews in the Player, the "Grade pending" chip
// until they exist, the injected graded master in renders, and no change for layers without colour effects.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	LUMETRI_EFFECT_ID,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type BakedLayerPreview,
	bakedFrameUrl,
	DEFAULT_RENDER_OPTIONS,
	hasDomColorEffects,
	layerComponentFor,
	needsBakedPicture,
	type RenderDoc,
	type RenderOptions,
	SequenceComposition,
	setBakedLayerRuntime,
	TextLayer,
} from '../src/index.ts';

function makeDoc(graded: boolean, o: { opacity?: number; fadeIn?: number } = {}): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'B', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: 60,
					track: 'V1',
					content: { text: 'Graded title' },
					box: { autoSize: 'none', width: 600, height: 120 },
					ref: '$t',
				},
				...(graded
					? [
							{
								type: 'effect.add',
								target: { clipId: '$t' },
								effectId: LUMETRI_EFFECT_ID,
								params: { saturation: 0 },
							},
						]
					: []),
				...(o.opacity !== undefined
					? [{ type: 'param.set', target: ['clip', '$t', 'opacity'], value: o.opacity }]
					: []),
				...(o.fadeIn
					? [
							{
								type: 'transition.add',
								clipId: '$t',
								edge: 'in',
								effectId: 'jasper.cross-dissolve',
								duration: o.fadeIn,
							},
						]
					: []),
			] as never,
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	expect(result.ok).toBe(true);
	const seq = Object.values(document.sequences)[0]!;
	return buildRenderSnapshot(document, seq.id, { resolveMedia: () => null, resolveFont: () => null });
}

const textOf = (doc: RenderSnapshot) =>
	doc.videoTracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!;

/** Product of the CSS opacities from `el` up to the composition root. */
function cssOpacity(el: Element | null): number {
	let k = 1;
	for (let e = el as HTMLElement | null; e; e = e.parentElement) {
		const v = e.style?.opacity;
		if (v !== undefined && v !== '') k *= Number(v);
	}
	return k;
}

function renderFrame(doc: RenderDoc, options: RenderOptions = DEFAULT_RENDER_OPTIONS) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={10}
		/>,
	);
}

/** A test runtime: previews by clip id, with change notifications. */
function testRuntime() {
	const previews = new Map<string, BakedLayerPreview>();
	const listeners = new Set<() => void>();
	let ver = 0;
	const rt = {
		previewFor: (clip: RenderVisualClip) => previews.get(clip.clipId) ?? null,
		subscribe: (cb: () => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		version: () => ver,
		set(clipId: string, p: BakedLayerPreview) {
			previews.set(clipId, p);
			ver++;
			for (const l of listeners) l();
		},
	};
	return rt;
}

afterEach(() => setBakedLayerRuntime(null));

describe('baked DOM layers (S11:LBK-010)', () => {
	it('layers without colour effects keep their own component', () => {
		const plain = textOf(makeDoc(false));
		expect(hasDomColorEffects(plain)).toBe(false);
		expect(needsBakedPicture(plain)).toBe(false);
		expect(layerComponentFor({ clip: plain, media: null })).toBe(TextLayer);
		const graded = textOf(makeDoc(true));
		expect(hasDomColorEffects(graded)).toBe(true);
		const wrapped = layerComponentFor({ clip: graded, media: null });
		expect(wrapped).not.toBe(TextLayer);
		// One stable wrapper per component (no remounts between frames).
		expect(layerComponentFor({ clip: graded, media: null })).toBe(wrapped);
	});

	it('a graded title shows ungraded with "Grade pending" until its graded preview exists, then plays it', async () => {
		const doc = makeDoc(true);
		const clip = textOf(doc);
		const rt = testRuntime();
		setBakedLayerRuntime(rt);
		const r = renderFrame(doc);
		expect(r.container.querySelector('[data-text-block]')?.textContent).toBe('Graded title');
		expect(r.container.querySelector('[data-grade-chip]')?.textContent).toBe('Grade pending');
		expect(r.container.querySelector('[data-baked]')).toBeNull();
		await act(async () => {
			rt.set(clip.clipId, {
				url: 'http://localhost/mg/layers/k/preview.webm',
				rect: { x: 100, y: 200, w: 640, h: 360 },
			});
		});
		const baked = r.container.querySelector<HTMLElement>('[data-baked="preview"]')!;
		expect(baked).not.toBeNull();
		expect(baked.style.left).toBe('100px');
		expect(baked.style.top).toBe('200px');
		expect(baked.style.width).toBe('640px');
		expect(baked.style.height).toBe('360px');
		expect(r.container.querySelector('[data-text-block]')).toBeNull();
		expect(r.container.querySelector('[data-grade-chip]')).toBeNull();
	});

	it('the before/after bypass shows the ungraded layer without a chip', () => {
		const doc = makeDoc(true);
		const clip = textOf(doc);
		const rt = testRuntime();
		rt.set(clip.clipId, { url: 'http://localhost/p.webm', rect: null });
		setBakedLayerRuntime(rt);
		const r = renderFrame(doc, { ...DEFAULT_RENDER_OPTIONS, colorBypassClipIds: [clip.clipId] });
		expect(r.container.querySelector('[data-text-block]')).not.toBeNull();
		expect(r.container.querySelector('[data-grade-chip]')).toBeNull();
		expect(r.container.querySelector('[data-baked]')).toBeNull();
	});

	it('renders play the graded master the engine injected, in its region, instead of the DOM layer', () => {
		const doc = makeDoc(true);
		const clip = textOf(doc);
		const withMaster: RenderSnapshot = {
			...doc,
			videoTracks: doc.videoTracks.map((t) => ({
				...t,
				clips: t.clips.map((c) =>
					c.clipId === clip.clipId
						? {
								...c,
								effects: [],
								baked: {
									url: 'http://e/mg/layers/k/graded.png?sig=s&exp=1',
									startFrame: 0,
									frames: 60,
									rect: { x: 10, y: 20, w: 300, h: 100 },
								},
							}
						: c,
				),
			})),
		};
		expect(needsBakedPicture(withMaster.videoTracks[0]!.clips[0]!)).toBe(true);
		const r = renderFrame(withMaster, { ...DEFAULT_RENDER_OPTIONS, isPreview: false });
		const baked = r.container.querySelector<HTMLElement>('[data-baked="master"]')!;
		expect(baked).not.toBeNull();
		expect(baked.style.left).toBe('10px');
		expect(baked.style.width).toBe('300px');
		// The straight-alpha PNG of the current frame (frame 10 of the sequence = frame 10 of the master).
		expect(baked.querySelector('img')?.getAttribute('src')).toBe(
			'http://e/mg/layers/k/graded.png?sig=s&exp=1&n=10',
		);
		expect(r.container.querySelector('[data-text-block]')).toBeNull();
		expect(bakedFrameUrl('http://e/x.png', 3)).toBe('http://e/x.png?n=3');
	});

	describe('opacity and transition fades reach the frame exactly once', () => {
		// Frame 10 of a 20-frame fade-in at opacity 50: the DOM layer draws at 0.5 × 10/20 (ClipLayer's fade factor).
		const faded = () => makeDoc(true, { opacity: 50, fadeIn: 20 });

		it('the ungraded layer (grade pending) applies its opacity and the fade itself', () => {
			const doc = faded();
			const clip = textOf(doc);
			expect(clip.fades?.length).toBeGreaterThan(0);
			const r = renderFrame(doc);
			const k = cssOpacity(r.container.querySelector('[data-text-block]'));
			expect(k).toBeGreaterThan(0.1);
			expect(k).toBeLessThan(0.45);
		});

		it('the graded preview carries opacity and fades in its pixels: no CSS opacity on top', async () => {
			const doc = faded();
			const clip = textOf(doc);
			const rt = testRuntime();
			setBakedLayerRuntime(rt);
			rt.set(clip.clipId, { url: 'http://localhost/mg/layers/k/preview.webm', rect: null });
			const r = renderFrame(doc);
			const baked = r.container.querySelector('[data-baked="preview"]');
			expect(baked).not.toBeNull();
			expect(cssOpacity(baked)).toBe(1);
			expect(cssOpacity(baked?.querySelector('video') ?? null)).toBe(1);
		});

		it('the injected graded master carries them too: no CSS opacity on top', () => {
			const doc = faded();
			const clip = textOf(doc);
			const withMaster: RenderSnapshot = {
				...doc,
				videoTracks: doc.videoTracks.map((t) => ({
					...t,
					clips: t.clips.map((c) =>
						c.clipId === clip.clipId
							? {
									...c,
									effects: [],
									baked: { url: 'http://e/mg/layers/k/graded.png', startFrame: 0, frames: 60 },
								}
							: c,
					),
				})),
			};
			const r = renderFrame(withMaster, { ...DEFAULT_RENDER_OPTIONS, isPreview: false });
			const baked = r.container.querySelector('[data-baked="master"]');
			expect(baked).not.toBeNull();
			expect(cssOpacity(baked)).toBe(1);
		});
	});
});
