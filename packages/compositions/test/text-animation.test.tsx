// Text animation rendering edge cases from S11:TXA-010 and wp-m2-text-anim.
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
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../src/index.ts';

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

describe('text animation rendering', () => {
	it('a 1-frame clip with In and Out shows the rest state (S11:TXA-004: one frame stays at rest)', () => {
		const v = view(docWith({ textAnimation: SLIDE_FADE }, 1), 0);
		expect(v.block().textContent).toBe('Hello brave world');
		expect(v.block().style.visibility).not.toBe('hidden');
	});
	it('unknown presets render at rest', () => {
		const doc = docWith({ textAnimation: SLIDE_FADE });
		const clip = doc.videoTracks.flatMap((t) => t.clips)[0]!;
		if (!('text' in clip.source)) throw new Error('not text');
		clip.source.animation = { in: { preset: 'hologram', version: 1, params: {}, frames: 20 } };
		const v = view(doc, 3);
		expect(v.block().textContent).toBe('Hello brave world');
		expect(v.block().style.visibility).not.toBe('hidden');
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
	it('typewriter@2 caret blinks as a function of the frame: solid while typing, blinking when idle, never at rest', () => {
		const caret = (v: ReturnType<typeof view>) => v.container.querySelector<HTMLElement>('[data-text-caret]');
		// In (45 frames): 15 characters typed every 60 ms until 840 ms (frame 26), then lit 250 ms / dark 250 ms
		const v = view(docWith({ textAnimation: { in: { preset: 'typewriter' } } }), 0);
		const lit = (f: number) => {
			v.at(f);
			return caret(v) !== null;
		};
		expect([0, 5, 10, 20, 26, 32].map(lit)).toEqual([true, true, true, true, true, true]);
		expect([33, 36, 40].map(lit)).toEqual([false, false, false]);
		expect([41, 44].map(lit)).toEqual([true, true]);
		// the text is fully typed while the caret is dark: only the caret blinks
		v.at(36);
		expect(v.units().every((u) => u.style.visibility !== 'hidden')).toBe(true);
		// Rest after the window: the full title has no caret.
		v.at(50);
		expect(caret(v)).toBeNull();
		expect(v.block().textContent).toBe('Hello brave world');
		// the same frames visited in another order give the same caret
		expect([40, 0, 33, 44, 26].map(lit)).toEqual([false, true, false, true, true]);
		// Out (frames 15…59, mirrored): blinks first (dark at Out frames 8…14), then deletes with a solid caret
		const o = view(docWith({ textAnimation: { out: { preset: 'typewriter' } } }), 10);
		expect(caret(o)).toBeNull();
		expect(o.block().textContent).toBe('Hello brave world');
		const outLit = (f: number) => {
			o.at(f);
			return caret(o) !== null;
		};
		expect([15, 22, 23, 29, 30, 40, 59].map(outLit)).toEqual([true, true, false, false, true, true, true]);
		// caretBlink: false keeps it solid; typewriter@1 (saved projects) never blinks
		const solid = view(
			docWith({ textAnimation: { in: { preset: 'typewriter', params: { caretBlink: false } } } }),
			36,
		);
		expect(caret(solid)).not.toBeNull();
		const v1 = view(docWith({ textAnimation: { in: { preset: 'typewriter', version: 1 } } }), 29);
		expect(caret(v1)).not.toBeNull();
		expect(v1.units().every((u) => u.style.visibility !== 'hidden')).toBe(true);
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
