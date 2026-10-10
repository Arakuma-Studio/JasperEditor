// SVG path data and SVG documents → vector shape contents (wp shapes).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildShapeItems,
	evaluateVectorShape,
	matrixToGroupTransform,
	parseCssColor,
	parseSvgPath,
	parseTransform,
	type ShapeItem,
	SvgImportError,
	shapeBoolean,
	shapeGeom,
	svgDocumentSize,
	svgPathToShapeItems,
	svgToShapeContents,
} from '../../src/index.ts';

let n = 0;
const ids = { item: () => `shp_${n++}`, keyframe: () => `kf_${n++}` };
const build = (items: unknown[]) => buildShapeItems(items, ids);
const fillArea = (items: ShapeItem[]) => {
	const d = evaluateVectorShape(items, 0).filter((x) => x.kind === 'fill');
	return d.reduce((a, x) => a + shapeBoolean.filledArea(x.paths, x.fillRule), 0);
};

describe('parseSvgPath', () => {
	it('reads every command, relative forms and implicit repeats', () => {
		const p = parseSvgPath(
			'M10 10 h20 v20 H10 z m40 0 l10 0 10 10 Q60 40 50 40 T40 30 C40 20 45 15 50 10 S60 5 70 10 A10 10 0 0 1 90 10',
		);
		expect(p).toHaveLength(2);
		expect(p[0]!.closed).toBe(true);
		expect(shapeGeom.signedArea([p[0]!])).toBeCloseTo(400, 6);
		const last = p[1]!.segs[p[1]!.segs.length - 1]!;
		expect(last[3][0]).toBeCloseTo(90, 9);
	});
	it('compact syntax and arc flags without separators', () => {
		const p = parseSvgPath('M0,0L10-5.5.5.5A5 5 0 1110 10z');
		expect(p[0]!.segs[1]![3]).toEqual([0.5, 0.5]);
		expect(p[0]!.closed).toBe(true);
	});
	it('a circle from two arcs has the circle area', () => {
		const p = parseSvgPath('M-50 0 A50 50 0 1 0 50 0 A50 50 0 1 0 -50 0Z');
		// Quarter-arc cubics overshoot a circle's area by ≈ 0.03 %.
		expect(Math.abs(Math.abs(shapeGeom.signedArea(p)) / (Math.PI * 2500) - 1)).toBeLessThan(5e-4);
	});
	it('rejects garbage', () => {
		expect(() => parseSvgPath('M 10 x')).toThrow();
		expect(() => parseSvgPath('10 10')).toThrow();
	});
	it('never throws anything but Error on random input (fuzz)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), (s) => {
				try {
					const p = parseSvgPath(s);
					expect(Array.isArray(p)).toBe(true);
				} catch (e) {
					expect(e).toBeInstanceOf(Error);
				}
			}),
			{ numRuns: 300 },
		);
	});
});

describe('colours and transforms', () => {
	it('parses CSS colours', () => {
		expect(parseCssColor('#f00')).toEqual([1, 0, 0, 1]);
		expect(parseCssColor('#00ff0080')![3]).toBeCloseTo(128 / 255, 6);
		expect(parseCssColor('rgb(255, 0, 255)')).toEqual([1, 0, 1, 1]);
		expect(parseCssColor('rgba(0,0,255,0.5)')).toEqual([0, 0, 1, 0.5]);
		expect(parseCssColor('hsl(120, 100%, 50%)')!.map((x) => Math.round(x * 255))).toEqual([0, 255, 0, 255]);
		expect(parseCssColor('rebeccapurple')).toEqual([0x66 / 255, 0x33 / 255, 0x99 / 255, 1]);
		expect(parseCssColor('none')).toBeNull();
	});
	it('decomposes affine matrices exactly into group transforms', () => {
		const m = parseTransform('translate(30 40) rotate(25) skewX(20) scale(2 -0.5)');
		const t = matrixToGroupTransform(m)!;
		const items = build([
			{
				type: 'group',
				transform: t,
				contents: [{ type: 'rect', size: [10, 10], position: [3, 4] }, { type: 'fill' }],
			},
		]);
		const pts = evaluateVectorShape(items, 0)[0]!.paths[0]!.segs.map((c) => c[0]);
		const raw: [number, number][] = [
			[8, -1],
			[8, 9],
			[-2, 9],
			[-2, -1],
		];
		raw.forEach((q, i) => {
			const want = [m[0] * q[0] + m[2] * q[1] + m[4], m[1] * q[0] + m[3] * q[1] + m[5]];
			expect(pts[i]![0]).toBeCloseTo(want[0]!, 4);
			expect(pts[i]![1]).toBeCloseTo(want[1]!, 4);
		});
	});
});

describe('svgToShapeContents', () => {
	it('converts shapes, paints, groups and the viewBox', () => {
		const r = svgToShapeContents(`<?xml version="1.0"?>
<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">
  <style>.blue { fill: #0000ff } #r2 { stroke: red; stroke-width: 2 }</style>
  <rect x="0" y="0" width="100" height="50" fill="white"/>
  <g transform="translate(10 10)" opacity="0.5">
    <circle cx="10" cy="10" r="10" class="blue"/>
    <rect id="r2" x="30" y="0" width="20" height="20" rx="4" fill="none"/>
  </g>
  <text x="0" y="0">hi</text>
  <!-- comment -->
</svg>`);
		expect(r.width).toBe(200);
		expect(r.viewBox).toEqual([0, 0, 100, 50]);
		expect(r.warnings.some((w) => w.includes('text'))).toBe(true);
		const items = build(r.contents);
		const root = items[0] as Extract<ShapeItem, { type: 'group' }>;
		expect(root.transform.scale.value).toEqual([200, 200]);
		expect(root.transform.anchor.value).toEqual([50, 25]);
		// Later SVG elements are listed first: the group, then the background rect.
		expect(root.contents.map((i) => i.type)).toEqual(['group', 'group']);
		const g = root.contents[0] as Extract<ShapeItem, { type: 'group' }>;
		expect(g.transform.opacity.value).toBe(50);
		const draws = evaluateVectorShape(items, 0);
		const blue = draws.find(
			(d) => d.paint.type === 'solid' && d.paint.color[2] === 1 && d.paint.color[0] === 0,
		)!;
		expect(blue.kind).toBe('fill');
		const red = draws.find((d) => d.kind === 'stroke')!;
		expect(red.stroke!.width).toBe(2);
		// Background: 100×50 viewBox at 2× = 200×100 px, centred.
		const bg = draws[draws.length - 1]!;
		const b = shapeGeom.pathBounds(bg.paths)!;
		expect([b.x0, b.y0, b.x1, b.y1]).toEqual([-100, -50, 100, 50]);
	});

	it('gradients: objectBoundingBox, stops with opacity, radial focal point', () => {
		const r = svgToShapeContents(`<svg viewBox="0 0 100 100">
<defs>
  <linearGradient id="g1"><stop offset="0" stop-color="red"/><stop offset="100%" stop-color="blue" stop-opacity="0.5"/></linearGradient>
  <radialGradient id="g2" cx="50" cy="50" r="40" fx="70" fy="50" gradientUnits="userSpaceOnUse" href="#g1"/>
</defs>
<rect x="10" y="20" width="80" height="40" fill="url(#g1)"/>
<circle cx="50" cy="50" r="40" fill="url(#g2)"/>
</svg>`);
		const items = build(r.contents);
		const draws = evaluateVectorShape(items, 0);
		const lin = draws.find((d) => d.paint.type === 'linear')!;
		expect(lin.paint.type === 'linear' && [lin.paint.start, lin.paint.end]).toEqual([
			[10, 20],
			[90, 20],
		]);
		const rad = draws.find((d) => d.paint.type === 'radial')!;
		if (rad.paint.type !== 'radial') throw new Error();
		expect(rad.paint.start).toEqual([50, 50]);
		expect(rad.paint.highlightLength).toBeCloseTo(50, 6);
		expect(rad.paint.gradient.opacities[1]!.opacity).toBe(0.5);
	});

	it('use, symbol, polygon, evenodd and stroke details', () => {
		const r = svgToShapeContents(`<svg viewBox="0 0 100 100">
<defs><path id="tri" d="M0 0 L10 0 L5 10Z"/></defs>
<use href="#tri" x="20" y="30" fill="lime"/>
<polygon points="0,0 100,0 100,100 0,100 0,0 50,50" fill-rule="evenodd"/>
<polyline points="0,0 10,10 20,0" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-dasharray="5 2 1" stroke-dashoffset="1"/>
</svg>`);
		const items = build(r.contents);
		const draws = evaluateVectorShape(items, 0);
		const st = draws.find((d) => d.kind === 'stroke')!;
		expect(st.stroke).toMatchObject({
			width: 3,
			cap: 'round',
			dash: { pattern: [5, 2, 1, 5, 2, 1], offset: 1 },
		});
		expect(draws.some((d) => d.fillRule === 'evenodd')).toBe(true);
		expect(fillArea(items)).toBeGreaterThan(0);
	});

	it('refuses non-SVG text and survives hostile input', () => {
		expect(() => svgToShapeContents('<html></html>')).toThrow(SvgImportError);
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (s) => {
				try {
					const r = svgToShapeContents(
						`<svg viewBox="0 0 10 10"><path d="${s.replace(/"/g, '')}" fill="${s.slice(0, 5)}"/>${s}</svg>`,
					);
					build(r.contents);
				} catch (e) {
					expect(e).toBeInstanceOf(Error);
				}
			}),
			{ numRuns: 200 },
		);
	});

	it('svgPathToShapeItems gives one path per subpath and paints', () => {
		const items = build(
			svgPathToShapeItems('M0 0 H10 V10Z M20 20 h5 v5z', {
				fill: '#ff0000',
				stroke: { color: '#000000', width: 2 },
			}),
		);
		expect(items.map((i) => i.type)).toEqual(['path', 'path', 'stroke', 'fill']);
	});
});

describe('hostile character references (security review PAR-1)', () => {
	it('out-of-range and surrogate references become U+FFFD instead of throwing RangeError', () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>&#x110000;&#99999999999;&#xD800;</title><rect width="5" height="5" fill="red"/></svg>';
		expect(() => svgToShapeContents(svg)).not.toThrow();
		expect(svgToShapeContents(svg).contents.length).toBeGreaterThan(0);
		expect(svgDocumentSize(svg)).toMatchObject({ width: 10, height: 10 });
	});
});
