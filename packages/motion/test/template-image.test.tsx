// TemplateImage (C1, docs/wp-notes/social-comments.md "Template media params"): holds the Remotion render until the
// picture is loaded and decoded; a failed load releases the render and draws a visible placeholder (never a crash).
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateImage } from '../src/templates/index.ts';

type RemotionWindow = Window & { remotion_renderReady?: boolean; remotion_delayRenderHandles?: number[] };
const w = window as RemotionWindow;
const held = () => (w.remotion_delayRenderHandles ?? []).length;
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

afterEach(() => {
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

	it('a failed load releases the render and draws a visible placeholder', async () => {
		const before = held();
		const view = render(<TemplateImage src="https://engine.test/media/broken.png" style={{ width: 80 }} />);
		fireEvent.error(view.container.querySelector('img')!);
		await flush();
		expect(view.container.querySelector('img')).toBeNull();
		const ph = view.container.querySelector('[data-template-image="placeholder"]') as HTMLElement;
		expect(ph).not.toBeNull();
		expect(ph.style.width).toBe('80px');
		expect(ph.style.background).not.toBe('');
		expect(held()).toBe(before);
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
