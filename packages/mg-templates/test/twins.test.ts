import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { lowerThird, mgRegistry, mgRenderKeyMaterial, specFromClip } from '../src/index.ts';

const fps = { num: 30, den: 1 };

// The renderer receives this SVG as markup, so user text must stay text.
describe('fframes SVG preview', () => {
	it('escapes user-provided text', () => {
		const svg = lowerThird.renderSvg(
			{ ...lowerThird.defaults, name: 'Ana <script>alert(1)</script> & Bo' },
			60,
			30,
			{ width: 1920, height: 1080 },
			{ durationFrames: 150 },
		);
		const window = new Window();
		try {
			const document = new window.DOMParser().parseFromString(svg, 'image/svg+xml');
			expect(document.querySelector('script')).toBeNull();
			expect(document.documentElement.textContent).toContain('Ana <script>alert(1)</script> & Bo');
		} finally {
			void window.happyDOM.close();
		}
	});
});

describe('render spec and cache material', () => {
	it('converts source-in from flicks to content frames', () => {
		const spec = specFromClip(
			{
				source: {
					mg: {
						template: { id: 'lower-third', version: 1 },
						params: { name: 'Ana' },
						canvas: { width: 1920, height: 1080 },
					},
				},
				duration: 150,
				sourceIn: 705_600_000,
			},
			fps,
			mgRegistry,
		)!;
		expect(spec.sourceInFrames).toBe(30);
	});

	it('reuses cache material for equivalent params and changes it for each render input', () => {
		const spec = {
			template: { id: 'lower-third', version: 1 },
			params: { name: 'Ana', title: 'Producer' },
			width: 1920,
			height: 1080,
			fps,
			durationFrames: 150,
			sourceInFrames: 0,
		};
		const base = mgRenderKeyMaterial(spec, 'r1');
		expect(mgRenderKeyMaterial({ ...spec, params: { title: 'Producer', name: 'Ana' } }, 'r1')).toBe(base);
		for (const changed of [
			{ ...spec, template: { ...spec.template, version: 2 } },
			{ ...spec, params: { ...spec.params, name: 'Bo' } },
			{ ...spec, width: 1280 },
			{ ...spec, fps: { num: 25, den: 1 } },
			{ ...spec, durationFrames: 151 },
			{ ...spec, sourceInFrames: 1 },
		])
			expect(mgRenderKeyMaterial(changed, 'r1')).not.toBe(base);
		expect(mgRenderKeyMaterial(spec, 'r2')).not.toBe(base);
	});
});
