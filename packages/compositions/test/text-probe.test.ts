// Layout boxes, line wrapping and clipping require a real browser (e2e/mg-texts.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locateTexts, TEXT_PROBE_SCRIPT, textProbeOf } from '../src/mg-host/protocol.ts';

type Win = Window & { __jasperTexts?: unknown; FontFace?: unknown };

describe('text probe (S08:MGC-037/039)', () => {
	beforeEach(() => {
		const w = window as Win;
		delete w.__jasperTexts;
		// A stand-in for the browser's FontFace (happy-dom has none).
		vi.stubGlobal('FontFace', function FontFace(family: string) {
			return { family, status: 'unloaded' };
		});
		document.body.innerHTML = '';
		new Function(TEXT_PROBE_SCRIPT)();
	});
	afterEach(() => {
		document.body.innerHTML = '';
		delete (window as Win).__jasperTexts;
		vi.unstubAllGlobals();
	});

	it('finds copy split into spans and rows, ignoring whitespace, case and *markup*', () => {
		document.body.innerHTML =
			'<div id="cap"><div><span>La clínica sabe que</span></div><div><span>tu paciente </span><span>ha llegado.</span></div></div><p>Other</p>';
		const [m, other, missing] = locateTexts(
			window,
			[
				{ id: 'headline', text: 'La clínica sabe que\ntu paciente *ha llegado.*' },
				{ id: 'other', text: 'OTHER' },
				{ id: 'missing', text: 'Not on screen' },
			],
			{ width: 1920, height: 1080 },
		);
		expect(m).toMatchObject({ id: 'headline', found: true });
		expect(other).toMatchObject({ id: 'other', found: true });
		expect(missing).toMatchObject({ id: 'missing', found: false, rect: null });
		expect(m!.style).not.toBeNull();
	});

	it('hides the located text for the on-canvas editor and restores it', () => {
		document.body.innerHTML =
			'<div><span id="a">Un solo panel.</span><span id="b" style="visibility: visible">Todo tu negocio.</span><span id="c">Keep</span></div>';
		const api = textProbeOf(window)!;
		expect(api.hide('Un solo panel. Todo tu negocio.')).toBe(true);
		const visible = (id: string) =>
			!['hidden', 'collapse'].includes(getComputedStyle(document.getElementById(id)!).visibility);
		expect([visible('a'), visible('b'), visible('c')]).toEqual([false, false, true]);
		api.restore();
		expect([visible('a'), visible('b'), visible('c')]).toEqual([true, true, true]);
		expect(api.hide('nowhere')).toBe(false);
	});

	it('records the fonts the bundle registers through FontFace, with absolute URLs', () => {
		const FF = (window as Win).FontFace as new (f: string, s: unknown, d?: unknown) => unknown;
		new FF('Brand Sans', 'url(public/fonts/brand.woff2) format("woff2")', { weight: '800' });
		new FF('Data Face', new ArrayBuffer(4));
		const fonts = textProbeOf(window)!.fonts();
		expect(fonts[0]).toMatchObject({ family: 'Brand Sans', weight: '800', style: 'normal' });
		expect(fonts[0]!.source).toMatch(/^url\("http.*\/public\/fonts\/brand\.woff2"\) format\("woff2"\)$/);
		expect(fonts[1]).toMatchObject({ family: 'Data Face' });
		expect(fonts[1]!.buffer).toBeInstanceOf(ArrayBuffer);
	});

	it('a page without the probe reports every text as not found', () => {
		expect(locateTexts({}, [{ id: 'x', text: 'y' }], { width: 1, height: 1 })).toEqual([
			{
				id: 'x',
				found: false,
				visible: false,
				rect: null,
				lines: [],
				clippedBy: null,
				truncated: false,
				style: null,
			},
		]);
	});
});
