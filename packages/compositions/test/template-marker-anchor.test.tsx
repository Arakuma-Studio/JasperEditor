// The "font / image not available" banners sit on the template's card (App QA N8: they were drawn at the canvas
// corner, away from a social card and off screen at Program zoom ≥ 100 %): the layer measures the template's drawn
// content (`templateContentBox`: the outermost elements smaller than the layer, so full-canvas wrappers are looked
// through) and anchors the banners inside its top-left corner, sized to it. Without layout (no size), the canvas
// corner as before.
import { mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	resolveSceneAt,
} from '@jasper/project';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	EmojiTableContext,
	FontsReadyContext,
	type LayerProps,
	MotionGraphicLayer,
	templateContentBox,
} from '../src/index.ts';

beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box) =>
	({
		...b,
		x: b.left,
		y: b.top,
		right: b.left + b.width,
		bottom: b.top + b.height,
		toJSON: () => b,
	}) as DOMRect;

/** Layout stub: `card` for elements matching `cardSelector`, the full canvas (scaled by `scale`) for the rest. */
function stubLayout(cardSelector: string, card: Box, canvas: { width: number; height: number }, scale = 1) {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		if (this.matches(cardSelector)) return rect(card);
		return rect({ left: 0, top: 0, width: canvas.width * scale, height: canvas.height * scale });
	});
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
		return this.matches(cardSelector) ? card.width / scale : canvas.width;
	});
}

function socialLayer() {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'M', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'social-comment', version: 1 },
					params: { variant: 'x-post', text: 'hello' },
					ref: '$a',
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const clipId = result.refs.$a!;
	const snap = buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
		templateAssets: templateAssetOptions(mgRegistry, {
			font: () => null,
			emoji: () => null,
			image: () => null,
		}),
	});
	const l = resolveSceneAt(snap, 75).find((x) => x.clip.clipId === clipId)!;
	const props: LayerProps = {
		clip: l.clip,
		props: l.props,
		localFrame: l.localFrame,
		contentTime: l.contentTime,
		fps: 30,
		media: null,
		options: { ...DEFAULT_RENDER_OPTIONS, isPreview: true },
		fonts: snap.fonts,
	};
	return render(
		<FontsReadyContext.Provider value={{ allLoaded: true }}>
			<EmojiTableContext.Provider value={snap.emoji}>
				<MotionGraphicLayer {...props} />
			</EmojiTableContext.Provider>
		</FontsReadyContext.Provider>,
	);
}

const markers = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-missing-asset-markers]')!;

describe('missing-asset banners on the card', () => {
	it('templateContentBox: the outermost drawn elements smaller than the host, in host px (scale undone)', () => {
		const host = document.createElement('div');
		const wrapper = document.createElement('div');
		const card = document.createElement('div');
		card.className = 'card';
		const skip = document.createElement('div');
		wrapper.append(card);
		host.append(wrapper, skip);
		document.body.append(host);
		stubLayout('.card', { left: 60, top: 400, width: 300, height: 100 }, { width: 1080, height: 1920 }, 0.5);
		expect(templateContentBox(host, skip)).toEqual({ left: 120, top: 800, width: 600, height: 200 });
		host.remove();
	});

	it('no layout (zero size) → null', () => {
		const host = document.createElement('div');
		document.body.append(host);
		expect(templateContentBox(host, null)).toBeNull();
		host.remove();
	});

	it('a social card with a missing font: the banners are anchored inside the card, sized to it', () => {
		stubLayout(
			'[data-social-variant]',
			{ left: 150, top: 820, width: 780, height: 260 },
			{ width: 1920, height: 1080 },
		);
		const r = socialLayer();
		const m = markers(r.container);
		expect(m.querySelector('[data-missing-asset="font"]')).not.toBeNull();
		const size = Math.max(10, Math.min(Math.round(1080 / 40), Math.round(780 / 40)));
		expect(m.style.left).toBe(`${150 + size / 2}px`);
		expect(m.style.top).toBe(`${820 + size / 2}px`);
		expect(m.getAttribute('data-anchor')).toBe('content');
		r.unmount();
	});

	it('without layout the banners stay at the canvas corner', () => {
		const r = socialLayer();
		const m = markers(r.container);
		expect(m.getAttribute('data-anchor')).toBe('canvas');
		expect(m.style.left).toBe(`${Math.max(12, Math.round(1080 / 40)) / 2}px`);
		r.unmount();
	});
});
