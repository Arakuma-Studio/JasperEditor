// social-comment §7.8: emoji drawn as pack images, the "not available" marker, reporting and retry.
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	EmojiImage,
	emojiUrlOf,
	MissingAssetMarker,
	type MissingTemplateAsset,
	missingAssetLabel,
	retryTemplateAssets,
	TemplateAssetScopeContext,
} from '../src/templates/index.ts';

const GRIN = '\u{1F600}';

function scope() {
	const live = new Map<string, MissingTemplateAsset>();
	return {
		live,
		value: {
			report(id: string, a: MissingTemplateAsset | null) {
				if (a) live.set(id, a);
				else live.delete(id);
			},
		},
	};
}

// Remotion counts NODE_ENV=test as a render (getRemotionEnvironment): the Player behaviour needs another value.
// happy-dom reports every image as complete at once (a browser does so only once it loaded or broke).
const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
	Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, 'complete', completeDesc);
	document.body.innerHTML = '';
});

describe('EmojiImage', () => {
	it('draws the image at the given size and reports nothing', () => {
		const s = scope();
		const r = render(
			<TemplateAssetScopeContext.Provider value={s.value}>
				<EmojiImage url="/fonts/emoji/apple/1/1f600.png" size={48} alt={GRIN} pack="apple" />
			</TemplateAssetScopeContext.Provider>,
		);
		const img = r.container.querySelector('img')!;
		expect(img.getAttribute('src')).toBe('/fonts/emoji/apple/1/1f600.png');
		expect(img.style.width).toBe('48px');
		expect(img.getAttribute('alt')).toBe(GRIN);
		expect(s.live.size).toBe(0);
	});

	it('shows the marker for an unavailable emoji and reports it', () => {
		const s = scope();
		const r = render(
			<TemplateAssetScopeContext.Provider value={s.value}>
				<EmojiImage url={undefined} size={32} alt={GRIN} pack="apple" />
			</TemplateAssetScopeContext.Provider>,
		);
		const marker = r.container.querySelector('[data-missing-asset="emoji"]') as HTMLElement;
		expect(marker).not.toBeNull();
		expect(marker.style.width).toBe('32px');
		expect(marker.getAttribute('aria-label')).toContain('not available');
		expect([...s.live.values()]).toEqual([{ kind: 'emoji', pack: 'apple', grapheme: GRIN }]);
		r.unmount();
		expect(s.live.size).toBe(0);
	});

	it('turns into the marker when the image fails, and loads again on retry', async () => {
		const s = scope();
		const r = render(
			<TemplateAssetScopeContext.Provider value={s.value}>
				<EmojiImage url="/fonts/emoji/apple/1/1f600.png" size={20} alt={GRIN} pack="apple" />
			</TemplateAssetScopeContext.Provider>,
		);
		await act(async () => {
			fireEvent.error(r.container.querySelector('img')!);
		});
		expect(r.container.querySelector('[data-missing-asset="emoji"]')).not.toBeNull();
		expect(s.live.size).toBe(1);
		await act(async () => retryTemplateAssets());
		expect(r.container.querySelector('img')).not.toBeNull();
		expect(s.live.size).toBe(0);
	});
});

describe('EmojiImage in a render', () => {
	it('fails the render instead of drawing a marker', () => {
		vi.stubEnv('NODE_ENV', 'test');
		expect(() => render(<EmojiImage url={undefined} size={32} alt={GRIN} pack="apple" />)).toThrow(
			/not available/,
		);
	});
});

describe('MissingAssetMarker and helpers', () => {
	it('renders a font banner with its label', () => {
		const r = render(<MissingAssetMarker kind="font" label='Font "Chirp" 700 is not available' size={14} />);
		const el = r.container.querySelector('[data-missing-asset="font"]')!;
		expect(el.textContent).toBe('Font "Chirp" 700 is not available');
		expect(el.getAttribute('role')).toBe('alert');
	});

	it('labels missing assets and looks emoji up by pack', () => {
		expect(missingAssetLabel({ kind: 'font', family: 'Chirp', weight: 700, style: 'italic' })).toBe(
			'Font "Chirp" 700 italic',
		);
		expect(missingAssetLabel({ kind: 'emoji', pack: 'twemoji', grapheme: GRIN })).toBe(
			`Emoji ${GRIN} (twemoji)`,
		);
		expect(emojiUrlOf({ [`apple:${GRIN}`]: '/x.png' }, 'apple', GRIN)).toBe('/x.png');
		expect(emojiUrlOf({ [`apple:${GRIN}`]: '/x.png' }, 'noto', GRIN)).toBeUndefined();
	});
});
