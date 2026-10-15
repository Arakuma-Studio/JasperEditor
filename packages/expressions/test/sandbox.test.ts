// One QuickJS realm serves every document of a process, so
// nothing an expression does may outlive its evaluation, and an expression that exhausts the heap (where the
// interrupt hook cannot stop it) is not re-run per frame.
import type { ExpressionRef } from '@jasper/project';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});
afterEach(() => {
	vi.restoreAllMocks();
});

function setup() {
	const d = basicDoc();
	const ref: ExpressionRef = { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' };
	const t = storedTimeAtFrame(d.doc, ref, 45);
	return (text: string) => evaluateExpressionText(d.doc, ref, text, t);
}

describe('expression realm isolation', () => {
	it.each([
		['Math.sin = function () { return 12345 }; 0', 'Math.sin(1)', Math.sin(1)],
		['Array.prototype.map = null; 0', '[1, 2].map(function (x) { return x }).length', 2],
		['JSON.stringify = function () { return "{\\"r\\":99}" }; 0', '5', 5],
		['Object.prototype.valueOf = function () { return 7 }; 0', '({}) + 1 === "[object Object]1" ? 1 : 0', 1],
		['wiggle = function () { return 9 }; 0', 'typeof wiggle === "function" && wiggle(0, 0) === 0 ? 1 : 0', 1],
		['thisComp.constructor.prototype.layer = 5; 0', 'typeof thisComp.layer === "function" ? 1 : 0', 1],
		['Date.now = function () { return 5 }; 0', 'Date.now()', 0],
	])('%s does not leak into the next evaluation', (attack, check, expected) => {
		const run = setup();
		run(attack);
		expect(run(check)).toEqual({ value: expected, error: null });
	});

	it('implicit globals work within an evaluation and vanish with it', () => {
		const run = setup();
		expect(run('x = 5; x * 2')).toEqual({ value: 10, error: null });
		expect(run('typeof x === "undefined" ? 1 : 0')).toEqual({ value: 1, error: null });
		expect(run('for (i = 0, n = 0; i < 4; i++) n += i; n')).toEqual({ value: 6, error: null });
		expect(run('[a, b] = [3, 4]; a * b')).toEqual({ value: 12, error: null });
		expect(run('function f() { y = 7 } f(); y')).toEqual({ value: 7, error: null });
		expect(run('typeof y === "undefined" && typeof i === "undefined" ? 1 : 0')).toEqual({
			value: 1,
			error: null,
		});
		expect(run('let q = 2; q = q * 3; q')).toEqual({ value: 6, error: null });
	});

	it('the global object cannot gain properties', () => {
		const run = setup();
		run('globalThis.k = 3; this.k2 = 4; 0');
		expect(run('typeof k === "undefined" && typeof k2 === "undefined" ? 1 : 0')).toEqual({
			value: 1,
			error: null,
		});
		expect(run('try { Object.defineProperty(globalThis, "z", { value: 1 }); 0 } catch (e) { 1 }')).toEqual({
			value: 1,
			error: null,
		});
	});

	it('shadowing layer attributes and writing the evaluation state stay per evaluation', () => {
		const run = setup();
		expect(run('width = width / 2; width')).toEqual({ value: 960, error: null });
		expect(run('width')).toEqual({ value: 1920, error: null });
		const before = run('time').value;
		expect(run('time = 99; time')).toEqual({ value: 99, error: null });
		expect(run('time').value).toBe(before);
	});

	it('the wall clock is unreachable (Date through its prototype constructor)', () => {
		const run = setup();
		expect(run('new Date().constructor.now()')).toEqual({ value: 0, error: null });
		expect(run('new (new Date(0).constructor)().getTime()')).toEqual({ value: 0, error: null });
		expect(run('Date.now() + new Date().getTime()')).toEqual({ value: 0, error: null });
	});

	it('overriding inherited methods on own objects still works (no override mistake)', () => {
		const run = setup();
		expect(run('var o = {}; o.toString = function () { return "7" }; Number(String(o))')).toEqual({
			value: 7,
			error: null,
		});
		expect(
			run('class E extends Error { constructor(m) { super(m); this.name = "E2" } } new E("x").name.length'),
		).toEqual({ value: 2, error: null });
		expect(run('try { Object.prototype.toString = null; 0 } catch (e) { 1 }')).toEqual({
			value: 1,
			error: null,
		});
	});
});

describe('resource limits', () => {
	it('stops endless loops, recursion and huge strings with messages', () => {
		const run = setup();
		expect(run('while (true) {}').error).toMatch(/took too long/);
		expect(run('function f() { return f() } f()').error).toMatch(/stack overflow/);
		expect(run('var s = "x"; while (1) s += s;').error).toMatch(/string too long|memory/);
	});

	// An expression stopped by any resource limit must not run again in the realm.
	// Which limit trips first depends on the machine and its load, so each path is driven explicitly (the clock is
	// replaced where the test is about it, frozen where it is not).
	const quarantined = /not run again until the editor or engine restarts/;

	it('the heap limit: quarantined, the next run is immediate', () => {
		const run = setup();
		const text = 'var big = new ArrayBuffer(200 * 1024 * 1024); 1';
		expect(run(text).error).toMatch(/ran out of memory/);
		const t0 = performance.now();
		const second = run(text);
		expect(performance.now() - t0).toBeLessThan(50);
		expect(second.error).toMatch(/ran out of memory/);
		expect(second.error).toMatch(quarantined);
		expect(run('1 + 1')).toEqual({ value: 2, error: null });
	});

	it('the operation budget: quarantined (the clock is frozen, so only the budget can stop it)', () => {
		const run = setup();
		vi.spyOn(performance, 'now').mockReturnValue(0);
		const first = run('var n = 0; while (true) n++;');
		expect(first.error).toMatch(/operation limit reached/);
		expect(first.error).not.toMatch(quarantined);
		const second = run('var n = 0; while (true) n++;');
		expect(second.error).toMatch(/operation limit reached/);
		expect(second.error).toMatch(quarantined);
	});

	it('the wall clock: quarantined, also when it trips before the heap or the budget would', () => {
		const run = setup();
		// A busy host: every reading of the clock is a second later.
		let t = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += 1000));
		const text = 'var a = []; while (1) a.push([1, 2, 3]);';
		const first = run(text);
		expect(first.error).toMatch(/took too long \(over 2 s\)/);
		clock.mockRestore();
		const t0 = performance.now();
		const second = run(text);
		expect(performance.now() - t0).toBeLessThan(50);
		expect(second.error).toMatch(/over 2 s/);
		expect(second.error).toMatch(quarantined);
	});

	it('ordinary errors are not quarantined (they are cheap and may depend on the frame)', () => {
		const run = setup();
		const first = run('nothingHere + 1');
		expect(first.error).toMatch(/nothingHere/);
		expect(run('nothingHere + 1')).toEqual(first);
		expect(first.error).not.toMatch(quarantined);
	});
});
