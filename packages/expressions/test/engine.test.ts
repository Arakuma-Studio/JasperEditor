// The expression engine end to end on a document: object model, helpers, determinism, errors and limits.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExpressionRef } from '@jasper/project';
import { evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc, type Doc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

function ev(d: Doc, owner: string, path: string, text: string, frame = 60) {
	const ref: ExpressionRef = { seq: d.seqId, owner: d.refs[owner] ?? owner, path };
	return evaluateExpressionText(d.doc, ref, text, storedTimeAtFrame(d.doc, ref, frame));
}
function val(d: Doc, owner: string, path: string, text: string, frame = 60) {
	const r = ev(d, owner, path, text, frame);
	if (r.error) throw new Error(r.error);
	return r.value;
}
const num = (d: Doc, text: string, frame = 60) => val(d, '$a', 'transform.rotation', text, frame) as number;
const str = (d: Doc, text: string, frame = 60) => val(d, '$title', 'text.content', text, frame) as string;

describe('globals and the object model', () => {
	const d = basicDoc();
	it('time is sequence seconds, value the keyframed value', () => {
		expect(num(d, 'time', 60)).toBeCloseTo(2, 12);
		expect(num(d, 'time', 45)).toBeCloseTo(1.5, 12);
		expect(num(d, 'value + 1')).toBe(1);
		expect(val(d, '$a', 'transform.position', 'value')).toEqual([960, 540]);
	});
	it('array maths', () => {
		expect(val(d, '$a', 'transform.position', 'value + [10, -20]')).toEqual([970, 520]);
		expect(val(d, '$a', 'transform.position', 'value / 2')).toEqual([480, 270]);
		expect(val(d, '$a', 'transform.position', '[1, 2] * 3 - [1, 1]')).toEqual([2, 5]);
		expect(val(d, '$a', 'transform.position', 'var p = value; p += [1, 1]; p')).toEqual([961, 541]);
		expect(str(d, '"a" + 1 + 2')).toBe('a12');
	});
	it('effect()(…) on this layer and other layers', () => {
		expect(num(d, 'effect("Slider Control")("Slider")')).toBe(42);
		expect(num(d, 'effect("Slider Control")("Slider") * 2')).toBe(84);
		expect(num(d, 'thisLayer.effect(1).param(1)')).toBe(42);
		expect(num(d, 'effect("Slider Control").param("slider").value')).toBe(42);
		expect(val(d, '$bg', 'transform.rotation', 'thisComp.layer("A").effect("Slider Control")("Slider")')).toBe(42);
		expect(str(d, 'thisComp.layer("A").effect(1).name')).toBe('Slider Control');
	});
	it('layers: names, indexes (1 = topmost), in/out points, comp attributes', () => {
		expect(str(d, 'thisComp.layer(1).name + "," + thisComp.layer(2).name + "," + thisComp.layer(3).name')).toBe(
			'Title,A,Bg',
		);
		expect(num(d, 'thisComp.numLayers')).toBe(3);
		expect(num(d, 'index')).toBe(2);
		expect(num(d, 'inPoint')).toBeCloseTo(1, 12);
		expect(num(d, 'outPoint')).toBeCloseTo(5, 12);
		expect(num(d, 'thisComp.width + thisComp.height')).toBe(3000);
		expect(num(d, 'thisComp.frameDuration')).toBeCloseTo(1 / 30, 12);
		expect(num(d, 'thisComp.duration')).toBeCloseTo(10, 12);
		expect(num(d, 'thisComp.layer(index + 1).index')).toBe(3);
		expect(num(d, 'thisComp.layer(thisLayer, -1).index')).toBe(1);
		expect(num(d, 'width')).toBe(1920);
	});
	it('text.sourceText and its style', () => {
		expect(str(d, 'text.sourceText + "!"')).toBe('Hello!');
		expect(str(d, 'thisComp.layer("Title").text.sourceText.length + ""')).toBe('5');
		expect(num(d, 'thisComp.layer("Title").text.sourceText.style.fontSize')).toBeGreaterThan(0);
	});
	it('transform properties of other layers and toComp/fromComp', () => {
		expect(val(d, '$bg', 'transform.position', 'thisComp.layer("A").transform.position')).toEqual([960, 540]);
		expect(val(d, '$a', 'transform.position', 'toComp([0, 0])')).toEqual([0, 0]);
		expect(val(d, '$a', 'transform.position', 'fromComp(toComp([12, 34]))')).toEqual([12, 34]);
	});
	it('errors for missing things', () => {
		expect(ev(d, '$a', 'transform.rotation', 'effect("Nope")("x")').error).toMatch(/Effect "Nope" not found/);
		expect(ev(d, '$a', 'transform.rotation', 'thisComp.layer("Nope")').error).toMatch(/Layer named "Nope"/);
		expect(ev(d, '$a', 'transform.rotation', 'comp("Nope")').error).toMatch(/Comp named "Nope"/);
	});
});

describe('keyframes, loops and time', () => {
	const d = basicDoc();
	// Rotation keys on A: 0 at frame 30 (content 0 s), 90 at frame 60 (content 1 s).
	d.tx([
		{ type: 'keyframe.add', target: ['clip', '$a', 'transform', 'rotation'], at: { sequenceFrame: 30 }, value: 0 },
		{ type: 'keyframe.add', target: ['clip', '$a', 'transform', 'rotation'], at: { sequenceFrame: 60 }, value: 90 },
	]);
	it('numKeys, key(n), nearestKey, valueAtTime, velocity', () => {
		expect(num(d, 'numKeys')).toBe(2);
		expect(num(d, 'key(2).time')).toBeCloseTo(2, 12);
		expect(num(d, 'key(2).value')).toBe(90);
		expect(num(d, 'nearestKey(1.2).index')).toBe(1);
		expect(num(d, 'valueAtTime(1.5)')).toBeCloseTo(45, 9);
		expect(num(d, 'velocityAtTime(1.5)')).toBeCloseTo(90, 6);
		expect(num(d, 'speedAtTime(1.5)')).toBeCloseTo(90, 6);
		expect(ev(d, '$a', 'transform.rotation', 'key(3)').error).toMatch(/out of range/);
	});
	it('loopOut cycle / pingpong / offset / continue', () => {
		// After the last key (t > 2 s), one cycle lasts 1 s.
		expect(num(d, 'loopOut("cycle")', 75)).toBeCloseTo(45, 9);
		expect(num(d, 'loopOut("pingpong")', 75)).toBeCloseTo(45, 9);
		expect(num(d, 'loopOut("pingpong")', 69)).toBeCloseTo(63, 9);
		expect(num(d, 'loopOut("offset")', 75)).toBeCloseTo(135, 9);
		expect(num(d, 'loopOut("continue")', 75)).toBeCloseTo(135, 3);
		expect(num(d, 'loopOut()', 60)).toBe(90);
		expect(num(d, 'loopIn("cycle")', 15)).toBeCloseTo(45, 9);
		expect(num(d, 'loopIn("offset")', 15)).toBeCloseTo(-45, 9);
		expect(num(d, 'loopOutDuration("cycle", 0.5)', 66)).toBeCloseTo(num(d, 'valueAtTime(1.7)'), 9);
		expect(ev(d, '$a', 'transform.rotation', 'loopOut("bogus")').error).toMatch(/unknown type/);
	});
	it('posterizeTime, timeToFrames, framesToTime, timeToTimecode', () => {
		expect(num(d, 'posterizeTime(2); value', 50)).toBeCloseTo(num(d, 'valueAtTime(1.5)', 50), 9);
		expect(num(d, 'timeToFrames()', 47)).toBe(47);
		expect(num(d, 'framesToTime(45)')).toBeCloseTo(1.5, 12);
		expect(str(d, 'timeToTimecode()', 3700)).toBe('00:02:03:10');
		expect(str(d, 'timeToTimecode(3661.5, 30)')).toBe('01:01:01:15');
	});
	it('markers of the comp and of the layer', () => {
		d.tx([{ type: 'marker.add', frame: 90, name: 'Beat', comment: 'drop' } as never]);
		expect(num(d, 'thisComp.marker.numKeys')).toBe(1);
		expect(num(d, 'thisComp.marker.key(1).time')).toBeCloseTo(3, 12);
		expect(str(d, 'thisComp.marker.key("Beat").comment')).toBe('drop');
		expect(num(d, 'marker.numKeys')).toBe(0);
	});
});

describe('interpolation, maths and colour helpers', () => {
	const d = basicDoc();
	it('linear / ease / easeIn / easeOut in both arities', () => {
		expect(num(d, 'linear(0.25, 0, 100)')).toBe(25);
		expect(num(d, 'linear(time, 1, 3, 10, 20)')).toBeCloseTo(15, 12);
		expect(num(d, 'linear(5, 1, 3, 10, 20)')).toBe(20);
		expect(num(d, 'linear(-5, 1, 3, 10, 20)')).toBe(10);
		expect(num(d, 'ease(0.5, 0, 100)')).toBeCloseTo(50, 12);
		expect(num(d, 'ease(0.25, 0, 1)')).toBeCloseTo(0.15625, 12);
		expect(num(d, 'easeIn(0.25, 0, 1)')).toBeCloseTo(0.109375, 12);
		expect(num(d, 'easeOut(0.25, 0, 1)')).toBeCloseTo(0.296875, 12);
		expect(val(d, '$a', 'transform.position', 'linear(0.5, [0, 0], [10, 20])')).toEqual([5, 10]);
	});
	it('vector maths', () => {
		expect(num(d, 'clamp(150, 0, 100)')).toBe(100);
		expect(val(d, '$a', 'transform.position', 'clamp([-5, 50], 0, 10)')).toEqual([0, 10]);
		expect(num(d, 'length([3, 4])')).toBe(5);
		expect(num(d, 'length([0, 0], [6, 8])')).toBe(10);
		expect(val(d, '$a', 'transform.position', 'normalize([3, 4])')).toEqual([0.6, 0.8]);
		expect(num(d, 'dot([1, 2, 3], [4, 5, 6])')).toBe(32);
		expect(str(d, 'cross([1, 0, 0], [0, 1, 0]).join(",")')).toBe('0,0,1');
		expect(val(d, '$a', 'transform.position', 'add([1, 2], [3, 4])')).toEqual([4, 6]);
		expect(val(d, '$a', 'transform.position', 'sub([1, 2], [3, 4])')).toEqual([-2, -2]);
		expect(val(d, '$a', 'transform.position', 'mul([1, 2], 3)')).toEqual([3, 6]);
		expect(val(d, '$a', 'transform.position', 'div([3, 6], 3)')).toEqual([1, 2]);
		expect(num(d, 'radiansToDegrees(degreesToRadians(45))')).toBeCloseTo(45, 12);
	});
	it('colour conversions', () => {
		expect(val(d, '$a', 'opacity', 'hexToRgb("#FF8000")[1] * 100')).toBeCloseTo((128 / 255) * 100, 12);
		expect(str(d, 'hexToRgb("0x00ff0080").join(",")')).toBe(`0,1,0,${128 / 255}`);
		expect(str(d, 'rgbToHsl([1, 0, 0, 1]).join(",")')).toBe('0,1,0.5,1');
		expect(str(d, 'hslToRgb([1/3, 1, 0.5, 1]).map(function (x) { return Math.round(x * 1000) / 1000 }).join(",")')).toBe(
			'0,1,0,1',
		);
	});
});

describe('determinism: random, wiggle, noise, clock', () => {
	const d = basicDoc();
	it('random is seeded per layer, property and time; seedRandom and timeless', () => {
		const a1 = num(d, 'random()', 40);
		expect(num(d, 'random()', 40)).toBe(a1);
		expect(num(d, 'random()', 41)).not.toBe(a1);
		expect(val(d, '$a', 'transform.scale', 'random()', 40)).not.toBe(a1);
		expect(num(d, 'seedRandom(5, true); random(10)', 40)).toBe(num(d, 'seedRandom(5, true); random(10)', 80));
		expect(num(d, 'seedRandom(5, true); random(10)', 40)).not.toBe(num(d, 'seedRandom(6, true); random(10)', 40));
		const r = num(d, 'random(20, 30)', 50);
		expect(r).toBeGreaterThanOrEqual(20);
		expect(r).toBeLessThan(30);
		expect(num(d, 'Math.random()', 40)).toBe(num(d, 'random()', 40));
		// Successive calls differ.
		expect(num(d, 'random() - random()', 40)).not.toBe(0);
	});
	it('gaussRandom falls mostly in range', () => {
		let inside = 0;
		for (let f = 0; f < 200; f++) {
			const g = num(d, 'gaussRandom()', f);
			if (g >= 0 && g <= 1) inside++;
		}
		expect(inside).toBeGreaterThan(160);
	});
	it('wiggle: bounded by amp per octave, smooth, deterministic, per property', () => {
		let prev = num(d, 'wiggle(2, 50)', 30);
		for (let f = 31; f < 150; f++) {
			const w = num(d, 'wiggle(2, 50)', f);
			expect(Math.abs(w)).toBeLessThanOrEqual(50);
			expect(Math.abs(w - prev)).toBeLessThan(15);
			prev = w;
		}
		expect(num(d, 'wiggle(2, 50)', 77)).toBe(num(d, 'wiggle(2, 50)', 77));
		const p = val(d, '$a', 'transform.position', 'wiggle(2, 50)', 77) as number[];
		expect(p[0]).not.toBe(p[1]);
		expect(Math.abs(p[0]! - 960)).toBeLessThanOrEqual(50);
		expect(num(d, 'wiggle(2, 50, 3, 0.5)', 77)).not.toBe(num(d, 'wiggle(2, 50)', 77));
	});
	it('noise is smooth and in −1…1', () => {
		for (let i = 0; i < 50; i++) {
			const v = num(d, `noise(${i * 0.37})`);
			expect(v).toBeGreaterThanOrEqual(-1);
			expect(v).toBeLessThanOrEqual(1);
		}
		expect(Math.abs(num(d, 'noise(1.000) - noise(1.001)'))).toBeLessThan(0.01);
		expect(num(d, 'noise([1.5, 2.5, 3.5])')).toBe(num(d, 'noise([1.5, 2.5, 3.5])'));
	});
	it('no wall clock', () => {
		expect(num(d, 'Date.now()')).toBe(0);
		expect(num(d, 'new Date().getTime()')).toBe(0);
		expect(num(d, 'new Date(2020, 0, 1).getFullYear()')).toBe(2020);
	});
});

describe('errors fall back to the keyframed value', () => {
	const d = basicDoc();
	it('syntax and runtime errors carry the line', () => {
		const s = ev(d, '$a', 'transform.rotation', 'x = 1;\ny = (');
		expect(s.error).toMatch(/^Error at line 2:/);
		expect(s.value).toBe(0);
		const r = ev(d, '$a', 'transform.rotation', 'var a = 1;\nundefinedThing.foo');
		expect(r.error).toMatch(/^Error at line 2: .*undefinedThing/);
	});
	it('dimension and type errors', () => {
		expect(ev(d, '$a', 'transform.rotation', '[1, 2]').error).toMatch(/dimension 1, not 2/);
		expect(ev(d, '$a', 'transform.position', '5').error).toMatch(/dimension 2, not 1/);
		expect(ev(d, '$a', 'transform.rotation', '"abc"').error).toMatch(/must be a number/);
		expect(ev(d, '$a', 'transform.rotation', '1 / 0').error).toMatch(/not a finite number/);
		expect(ev(d, '$a', 'transform.rotation', 'var x = 1;').error).toMatch(/undefined/);
	});
	it('endless loops stop at the operation budget', () => {
		const t0 = Date.now();
		const r = ev(d, '$a', 'transform.rotation', 'while (true) {}');
		expect(r.error).toMatch(/took too long/);
		expect(Date.now() - t0).toBeLessThan(5000);
		// The engine keeps working afterwards.
		expect(num(d, '1 + 1')).toBe(2);
	});
	it('recursion and memory limits', () => {
		expect(ev(d, '$a', 'transform.rotation', 'function f(n) { return f(n + 1) + 1 } f(0)').error).toMatch(
			/too much recursion/,
		);
		expect(ev(d, '$a', 'transform.rotation', 'var a = []; while (true) a.push(new Float64Array(1000000)); 0').error).toMatch(
			/ran out of memory/,
		);
		expect(num(d, '2 + 2')).toBe(4);
	});
	it('expressions reading each other: chains work, cycles stop', () => {
		d.tx([
			{ type: 'expression.set', target: ['clip', '$a', 'transform', 'scale'], text: 'thisComp.layer("Bg").transform.rotation + 1' },
			{ type: 'expression.set', target: ['clip', '$bg', 'transform', 'rotation'], text: '41' },
		]);
		expect(num(d, 'transform.scale.value')).toBe(42);
		d.tx([
			{ type: 'expression.set', target: ['clip', '$bg', 'transform', 'rotation'], text: 'thisComp.layer("A").transform.scale' },
		]);
		const r = ev(d, '$a', 'transform.rotation', 'transform.scale.value');
		expect(r.error).toMatch(/too deeply|circular/);
	});
});

describe('Expression Controls', () => {
	const d = basicDoc();
	d.tx([
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.checkbox-control', ref: '$cb' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.dropdown-control', ref: '$dd' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.color-control', ref: '$col' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.point-control', ref: '$pt' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.point3d-control', ref: '$p3' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.layer-control', ref: '$lc' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.angle-control', ref: '$ang' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.slider-control', ref: '$s2' },
		{ type: 'param.set', target: ['effect', '$cb', 'checkbox'], value: true },
		{ type: 'param.set', target: ['effect', '$dd', 'menu'], value: 2 },
		{ type: 'param.set', target: ['effect', '$s2', 'slider'], value: 7 },
		{ type: 'param.set', target: ['effect', '$ang', 'angle'], value: 30 },
	]);
	d.tx([{ type: 'param.set', target: ['effect', '$lc', 'layer'], value: d.refs.$title }]);
	it('read as AE does', () => {
		expect(num(d, 'effect("Checkbox Control")("Checkbox")')).toBe(1);
		expect(num(d, 'effect("Dropdown Menu Control")("Menu") * 10')).toBe(20);
		expect(str(d, 'thisComp.layer("A").effect("Color Control")("Color").join(",")')).toBe('1,0,0,1');
		expect(val(d, '$a', 'transform.position', 'effect("Point Control")("Point")')).toEqual([960, 540]);
		expect(str(d, 'thisComp.layer("A").effect("3D Point Control")("3D Point").join(",")')).toBe('960,540,0');
		expect(str(d, 'thisComp.layer("A").effect("Layer Control")("Layer").value.name')).toBe('Title');
		expect(str(d, 'thisComp.layer("A").effect("Layer Control")("Layer").text.sourceText')).toBe('Hello');
		expect(num(d, 'effect("Angle Control")("Angle")')).toBe(30);
		// Duplicates are numbered from the second one.
		expect(num(d, 'effect("Slider Control 2")("Slider")')).toBe(7);
	});
	it('renamed instances are found by their name', () => {
		d.tx([{ type: 'effect.rename', effectInstanceId: d.refs.$s2, name: 'Speed' }]);
		expect(num(d, 'effect("Speed")("Slider")')).toBe(7);
		expect(ev(d, '$a', 'transform.rotation', 'effect("Slider Control 2")("Slider")').error).toMatch(/not found/);
	});
	it('a Layer Control expression returns a layer', () => {
		const r = val(d, '$a', `effects.${d.refs.$lc}.layer`, 'thisComp.layer("Bg")');
		expect(r).toBe(d.refs.$bg);
	});
	it('menus take an index or an item name', () => {
		expect(val(d, '$a', `effects.${d.refs.$dd}.menu`, '3')).toBe(3);
		expect(val(d, '$a', `effects.${d.refs.$cb}.checkbox`, '0')).toBe(false);
	});
});
