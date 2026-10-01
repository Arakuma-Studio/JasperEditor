// Text layer with animators (S11:TXA-010…013, ANM-009, FIX-003): rest output identical to an un-animated text,
// unit split/overlay inside the windows, unknown presets at rest, fonts gate, RTL fallback, caps and runs,
// masks and the caret, the same output for any frame visit order, and the preview composition.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	SequenceComposition,
	TEXT_ANIMATION_PREVIEW,
	TextAnimationPreview,
	textAnimationPreviewDoc,
	textAnimationPreviewTiming,
} from '../src/index.ts';
import { runStyleCss, styledSpans } from '../src/layers/TextLayer.tsx';

type Cmd = Record<string, unknown>;

function docWith(text: Cmd, duration = 60, fontUrl: string | null = null): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration,
					track: 'V1',
					content: { text: 'Hello brave world' },
					box: { autoSize: 'none', width: 900, height: 200 },
					...text,
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(result.errors[0]!.message);
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => fontUrl,
	});
}

function view(doc: RenderDoc, frame: number) {
	const thumb = (f: number) => (
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={f}
		/>
	);
	const r = render(thumb(frame));
	return {
		...r,
		block: () => r.container.querySelector<HTMLElement>('[data-text-block]')!,
		units: () => [...r.container.querySelectorAll<HTMLElement>('[data-text-unit-index]')],
		at: (f: number) => r.rerender(thumb(f)),
	};
}

const SLIDE_FADE = { in: { preset: 'slide-up', params: { unit: 'word' } }, out: { preset: 'fade' } };

describe('rest state (S11:ANM-009, TXA-010)', () => {
	it('outside the windows the DOM equals the same text without animation', () => {
		const plain = view(docWith({}), 30).block().outerHTML;
		const animated = view(docWith({ textAnimation: SLIDE_FADE }), 30);
		expect(animated.block().outerHTML).toBe(plain);
		expect(animated.block().textContent).toBe('Hello brave world');
		// …and after the In window, at every frame between the windows
		for (const f of [20, 25, 44]) {
			animated.at(f);
			expect(animated.block().outerHTML).toBe(plain);
		}
	});
	it('unknown presets render at rest', () => {
		const doc = docWith({ textAnimation: SLIDE_FADE });
		const clip = doc.videoTracks.flatMap((t) => t.clips)[0]!;
		if (!('text' in clip.source)) throw new Error('not text');
		clip.source.animation = { in: { preset: 'hologram', version: 1, params: {}, frames: 20 } };
		const v = view(doc, 3);
		expect(v.block().dataset.textAnimating).toBeUndefined();
		expect(v.block().outerHTML).toBe(view(docWith({}), 3).block().outerHTML);
	});
	it('FIX-003: before the faces are ready the text is hidden and never split', () => {
		// The face is still loading on the first render (FontFace settles asynchronously).
		const v = view(docWith({ textAnimation: SLIDE_FADE }, 60, 'https://fonts.test/slow.woff2'), 3);
		expect(v.block().style.visibility).toBe('hidden');
		expect(v.block().dataset.textAnimating).toBeUndefined();
		expect(v.units()).toHaveLength(0);
	});
});

describe('inside a window (S11:TXA-010/011/012)', () => {
	it('splits the text into word units over a hidden copy of the same flow, styled from the seeked values', () => {
		const v = view(docWith({ textAnimation: SLIDE_FADE }), 0);
		const block = v.block();
		expect(block.dataset.textAnimating).toBe('in');
		expect(block.style.visibility).toBe('hidden');
		expect(block.querySelector<HTMLElement>('[data-text-overlay]')!.style.visibility).toBe('visible');
		const units = v.units();
		expect(units.map((u) => u.textContent)).toEqual(['Hello', 'brave', 'world']);
		// frame 0 of slide-up: every unit starts 60 px below and transparent
		expect(units[0]!.style.transform).toBe('translate(0px, 60px)');
		expect(units[0]!.style.opacity).toBe('0');
		// the hidden flow keeps the whitespace as text and every unit as an inline span
		expect(block.querySelectorAll('[data-text-piece]')).toHaveLength(3);
		expect(block.querySelector('[data-text-piece]')!.parentElement).toBe(block);
		// no clipping on the layer or the overlay (units may leave the box)
		expect(block.querySelector<HTMLElement>('[data-text-overlay]')!.style.overflow).toBe('');
	});
	it('plays Out mirrored to the clip end and clamps in transition handles', () => {
		const v = view(docWith({ textAnimation: SLIDE_FADE }), 59);
		expect(v.block().dataset.textAnimating).toBe('out');
		expect(v.units().every((u) => u.style.opacity === '0')).toBe(true);
		v.at(45);
		expect(v.block().dataset.textAnimating).toBe('out');
		expect(Number(v.units()[0]!.style.opacity || '1')).toBeGreaterThan(0.5);
	});
	it('char units fall back to words for RTL text; caps apply before segmentation', () => {
		const rtl = view(
			docWith({
				content: { text: 'مرحبا بالعالم', style: { direction: 'rtl' } },
				textAnimation: { in: { preset: 'pop' } },
			}),
			2,
		);
		expect(rtl.units().map((u) => u.textContent)).toEqual(['مرحبا', 'بالعالم']);
		const caps = view(
			docWith({
				content: { text: 'Straße', style: { allCaps: true } },
				textAnimation: { in: { preset: 'pop' } },
			}),
			2,
		);
		expect(caps.units().map((u) => u.textContent)).toEqual(['S', 'T', 'R', 'A', 'S', 'S', 'E']);
	});
	it('line units animate whole lines (grouped by layout boxes)', () => {
		const v = view(docWith({ textAnimation: { in: { preset: 'tracking' } } }), 1);
		expect(v.units()).toHaveLength(0);
		const lines = v.container.querySelectorAll('[data-text-line]');
		expect(lines).toHaveLength(1);
		const line = lines[0]!.firstElementChild as HTMLElement;
		expect(line.textContent).toBe('Hellobraveworld');
		expect(line.style.opacity).not.toBe('');
		expect([...line.querySelectorAll('span')].every((s) => s.style.letterSpacing.endsWith('em'))).toBe(true);
	});
	it('mask-reveal draws one clipping mask per line; typewriter draws a caret', () => {
		const mask = view(
			docWith({ textAnimation: { in: { preset: 'mask-reveal', params: { unit: 'word' } } } }),
			2,
		);
		const masks = mask.container.querySelectorAll<HTMLElement>('[data-text-mask]');
		expect(masks).toHaveLength(1);
		expect(masks[0]!.style.overflow).toBe('hidden');
		expect(mask.units()[2]!.style.transform).toMatch(/^translate\(0px, [1-9]/);
		const tw = view(docWith({ textAnimation: { in: { preset: 'typewriter' } } }), 10);
		expect(tw.container.querySelector('[data-text-caret]')).not.toBeNull();
		const shown = tw.units().filter((u) => u.style.visibility !== 'hidden').length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(tw.units().length);
		const noCaret = view(
			docWith({ textAnimation: { in: { preset: 'typewriter', params: { caret: false } } } }),
			10,
		);
		expect(noCaret.container.querySelector('[data-text-caret]')).toBeNull();
	});
	it('styled runs keep their style per unit (units cut at run boundaries)', () => {
		const v = view(
			docWith({
				content: {
					text: 'Bold move',
					runs: [{ from: 0, to: 2, style: { weight: 800, fill: [1, 0, 0, 1] } }],
				},
				textAnimation: { in: { preset: 'fade', params: { unit: 'word' } } },
			}),
			2,
		);
		const first = v.units()[0]!;
		const spans = [...first.querySelectorAll('span')];
		expect(spans.map((s) => s.textContent)).toEqual(['Bo', 'ld']);
		expect(spans[0]!.style.fontWeight).toBe('800');
		expect(spans[0]!.style.color).toBe('rgba(255, 0, 0, 1)');
		expect(spans[1]!.style.fontWeight).toBe('');
	});
});

describe('determinism of the layer (S11:ANM-013)', () => {
	it('any frame visit order renders what a fresh mount renders', () => {
		const doc = docWith({
			textAnimation: {
				in: { preset: 'drop', params: { order: 'random', stagger: 0.7 } },
				out: { preset: 'blur', durationFrames: 12 },
			},
		});
		const frames = [0, 1, 4, 9, 17, 24, 30, 48, 50, 55, 59];
		const fresh = new Map(frames.map((f) => [f, view(doc, f).block().outerHTML]));
		fc.assert(
			fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => {
				const v = view(doc, order[0]!);
				for (const f of order) {
					v.at(f);
					expect(v.block().outerHTML).toBe(fresh.get(f));
				}
				v.unmount();
			}),
			{ seed: 77, numRuns: 6 },
		);
	});
});

describe('styled runs at rest', () => {
	it('cuts the text at run boundaries (later runs win) and maps run fields to CSS', () => {
		expect(
			styledSpans('abcdef', [
				{ from: 1, to: 4, style: { weight: 700 } },
				{ from: 3, to: 6, style: { italic: true } },
			]),
		).toEqual([
			{ from: 0, to: 1, style: null },
			{ from: 1, to: 3, style: { weight: 700 } },
			{ from: 3, to: 4, style: { weight: 700, italic: true } },
			{ from: 4, to: 6, style: { italic: true } },
		]);
		expect(styledSpans('', undefined)).toEqual([]);
		const doc = docWith({
			content: { text: 'Big deal', runs: [{ from: 0, to: 3, style: { sizePx: 300 } }] },
		});
		const v = view(doc, 30);
		const span = v.block().querySelector('span')!;
		expect(span.textContent).toBe('Big');
		expect(span.style.fontSize).toBe('300px');
		expect(v.block().textContent).toBe('Big deal');
		const clip = doc.videoTracks.flatMap((t) => t.clips)[0]!;
		if (!('text' in clip.source)) throw new Error('not text');
		expect(runStyleCss({ allCaps: false, shadow: null }, clip.source.text.style, [])).toEqual({
			textTransform: 'none',
			textShadow: 'none',
		});
	});
});

describe('preview composition (S11:TXA-020/021)', () => {
	it('builds a one-clip document per preset and side', () => {
		expect(textAnimationPreviewTiming(20, 'in')).toEqual({
			durationInFrames: 44,
			posterFrame: 10,
			clipFrames: 44,
		});
		expect(textAnimationPreviewTiming(20, 'out')).toMatchObject({ durationInFrames: 52, posterFrame: 34 });
		const doc = textAnimationPreviewDoc({ preset: 'pop', version: 1, side: 'both' })!;
		const clip = doc.videoTracks.flatMap((t) => t.clips)[0]!;
		expect('text' in clip.source && clip.source.animation?.in?.preset).toBe('pop');
		expect('text' in clip.source && clip.source.animation?.out?.frames).toBe(20);
		expect(doc.settings.width).toBe(TEXT_ANIMATION_PREVIEW.width);
		expect(textAnimationPreviewDoc({ preset: 'nope', version: 1, side: 'in' })).toBeNull();
		const r = render(
			<Thumbnail
				component={TextAnimationPreview}
				inputProps={{ preset: 'slide-up', version: 1, side: 'in' as const }}
				compositionWidth={1920}
				compositionHeight={1080}
				durationInFrames={44}
				fps={30}
				frameToDisplay={5}
			/>,
		);
		expect(r.container.querySelector('[data-text-animating="in"]')?.textContent).toContain('Aa');
	});
});
