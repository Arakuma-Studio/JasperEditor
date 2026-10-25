// Gallery poster / hover preview framing (`ui.preview`, App QA N7): a template whose content is a small card is drawn
// on the canvas the card is designed for (social-comment: 1080×1920) and that canvas covers the 16:9 thumbnail, so
// the card is not a tiny strip in the middle of a 16:9 stage. Templates without the hint draw on the thumbnail's own
// canvas as before; clips are not affected (the layer never reads the hint).
import { mgRegistry } from '@jasper/mg-templates';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MgTemplatePreview, mgPreviewFraming } from '../src/index.ts';

beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));
afterEach(() => vi.unstubAllEnvs());

function poster(templateId: string, params?: Record<string, unknown>) {
	return render(
		<Thumbnail
			component={MgTemplatePreview}
			inputProps={{ templateId, version: 1, ...(params ? { params } : {}) }}
			compositionWidth={640}
			compositionHeight={360}
			durationInFrames={150}
			fps={30}
			frameToDisplay={75}
		/>,
	);
}

describe('mgPreviewFraming', () => {
	it('covers the preview with the hinted canvas, centred; null without a usable hint', () => {
		expect(mgPreviewFraming({ canvas: { width: 1080, height: 1920 } }, { width: 640, height: 360 })).toEqual({
			canvas: { width: 1080, height: 1920 },
			scale: 640 / 1080,
		});
		expect(
			mgPreviewFraming({ canvas: { width: 1920, height: 1080 } }, { width: 640, height: 360 })!.scale,
		).toBe(1 / 3);
		expect(mgPreviewFraming(undefined, { width: 640, height: 360 })).toBeNull();
		for (const bad of [
			{ width: 0, height: 10 },
			{ width: Number.NaN, height: 10 },
			{ width: '9', height: 16 },
			{},
		])
			expect(mgPreviewFraming({ canvas: bad }, { width: 640, height: 360 })).toBeNull();
		expect(mgPreviewFraming({ canvas: { width: 1080, height: 1920 } }, { width: 0, height: 360 })).toBeNull();
	});
});

describe('MgTemplatePreview framing', () => {
	it('social-comment declares a 9:16 preview canvas', () => {
		expect(mgRegistry.getDefinition('social-comment', 1)!.ui?.preview).toEqual({
			canvas: { width: 1080, height: 1920 },
		});
	});

	it('draws a social card on its 1080×1920 canvas scaled to cover the 16:9 poster', () => {
		const r = poster('social-comment', { variant: 'x-post' });
		const frame = r.container.querySelector<HTMLElement>('[data-mg-preview-frame]');
		expect(frame).not.toBeNull();
		expect(frame!.getAttribute('data-mg-preview-frame')).toBe('1080x1920');
		expect(frame!.style.width).toBe('1080px');
		expect(frame!.style.height).toBe('1920px');
		// centred: (640 − 1080) / 2, (360 − 1920) / 2; scaled by 640 / 1080
		expect(frame!.style.left).toBe('-220px');
		expect(frame!.style.top).toBe('-780px');
		expect(frame!.style.transform).toBe(`scale(${640 / 1080})`);
		expect(frame!.querySelector('[data-social-variant="x-post"]')).not.toBeNull();
		const root = r.container.querySelector<HTMLElement>('[data-mg-preview-template="social-comment"]')!;
		expect(root.style.overflow).toBe('hidden');
		r.unmount();
	});

	it('templates without the hint draw on the poster canvas itself', () => {
		const r = poster('counter');
		expect(r.container.querySelector('[data-mg-preview-template="counter"]')).not.toBeNull();
		expect(r.container.querySelector('[data-mg-preview-frame]')).toBeNull();
		r.unmount();
	});
});
