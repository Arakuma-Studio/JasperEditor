// TemplateImage (C1, docs/wp-notes/social-comments.md "Template media params"): holds the Remotion render until the
// picture is loaded and decoded; a failed load fails a render by name, and in the Player releases the render, draws a
// visible placeholder and reports the medium (never a crash, never silent).
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type MissingTemplateAsset,
	TemplateAssetScopeContext,
	TemplateImage,
	TemplateImageError,
	TemplateMediaIdsContext,
} from '../src/templates/index.ts';

type RemotionWindow = Window & { remotion_renderReady?: boolean; remotion_delayRenderHandles?: number[] };
const w = window as RemotionWindow;
const held = () => (w.remotion_delayRenderHandles ?? []).length;
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

afterEach(() => {
	vi.unstubAllEnvs();
	w.remotion_delayRenderHandles = [];
	w.remotion_renderReady = true;
});

describe('TemplateImage', () => {
	it('holds the render until the picture is loaded and decoded, then shows it', async () => {
		const before = held();
		const view = render(<TemplateImage src="https://engine.test/media/a.png" style={{ width: 80 }} />);
		const img = view.container.querySelector('img')!;
		expect(img.getAttribute('src')).toBe('https://engine.test/media/a.png');
		expect(img.getAttribute('crossorigin')).toBe('anonymous');
		expect(img.dataset.templateImage).toBe('loading');
		expect(held()).toBe(before + 1);
		expect(w.remotion_renderReady).toBe(false);
		fireEvent.load(img);
		await flush();
		expect(view.container.querySelector('img')!.dataset.templateImage).toBe('ready');
		expect(held()).toBe(before);
		expect(w.remotion_renderReady).toBe(true);
		view.unmount();
	});

	it('Player: a failed load releases the render, draws a visible placeholder and reports the medium', async () => {
		// Remotion counts NODE_ENV=test as a render (getRemotionEnvironment); the Player needs another value.
		vi.stubEnv('NODE_ENV', 'development');
		const before = held();
		const live = new Map<string, MissingTemplateAsset>();
		const scope = {
			report: (id: string, a: MissingTemplateAsset | null) => (a ? live.set(id, a) : live.delete(id)),
		};
		const url = 'https://engine.test/media/broken.png?sig=1';
		const view = render(
			<TemplateAssetScopeContext.Provider value={scope}>
				<TemplateMediaIdsContext.Provider value={{ [url]: 'med_avatar' }}>
					<TemplateImage src={url} style={{ width: 80 }} />
				</TemplateMediaIdsContext.Provider>
			</TemplateAssetScopeContext.Provider>,
		);
		fireEvent.error(view.container.querySelector('img')!);
		await flush();
		expect(view.container.querySelector('img')).toBeNull();
		const ph = view.container.querySelector('[data-template-image="placeholder"]') as HTMLElement;
		expect(ph).not.toBeNull();
		expect(ph.style.width).toBe('80px');
		expect(ph.style.background).not.toBe('');
		expect(held()).toBe(before);
		expect([...live.values()]).toEqual([{ kind: 'media', mediaId: 'med_avatar' }]);
		view.unmount();
		expect(live.size).toBe(0);
	});

	it('render: a failed load fails the render with a TemplateImageError naming the picture (no placeholder)', async () => {
		vi.stubEnv('NODE_ENV', 'test');
		const url = 'https://engine.test/media/broken.png?sig=secret';
		const view = render(
			<TemplateMediaIdsContext.Provider value={{ [url]: 'med_avatar' }}>
				<TemplateImage src={url} style={{ width: 80 }} />
			</TemplateMediaIdsContext.Provider>,
		);
		let error: unknown;
		try {
			await act(async () => {
				fireEvent.error(view.container.querySelector('img')!);
			});
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(TemplateImageError);
		expect((error as TemplateImageError).mediaId).toBe('med_avatar');
		expect((error as Error).message).toContain('https://engine.test/media/broken.png');
		expect((error as Error).message).toContain('med_avatar');
		expect((error as Error).message).not.toMatch(/sig=|secret/);
		view.unmount();
	});

	it('no picture: the fallback (or the placeholder) without holding the render', () => {
		const before = held();
		const a = render(<TemplateImage src={null} fallback={<span data-testid="fb">AB</span>} />);
		expect(a.getByTestId('fb').textContent).toBe('AB');
		expect(held()).toBe(before);
		a.unmount();
		const b = render(<TemplateImage src="" />);
		expect(b.container.querySelector('[data-template-image="placeholder"]')).not.toBeNull();
		b.unmount();
	});

	it('a new URL holds the render again; unmounting while loading releases it', async () => {
		const before = held();
		const view = render(<TemplateImage src="https://engine.test/media/1.png" />);
		fireEvent.load(view.container.querySelector('img')!);
		await flush();
		expect(held()).toBe(before);
		view.rerender(<TemplateImage src="https://engine.test/media/2.png" />);
		const img = view.container.querySelector('img')!;
		expect(img.getAttribute('src')).toBe('https://engine.test/media/2.png');
		expect(img.dataset.templateImage).toBe('loading');
		expect(held()).toBe(before + 1);
		view.unmount();
		expect(held()).toBe(before);
	});
});
