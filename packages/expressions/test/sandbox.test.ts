// Security review (docs/security-review.md EXPR-1, EXPR-2): one QuickJS realm serves every document of a process, so
// nothing an expression does may outlive its evaluation, and an expression that exhausts the heap (where the
// interrupt hook cannot stop it) is not re-run per frame.
import type { ExpressionRef } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
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
		['__add = function () { return 42 }; 0', '1 + 2', 3],
		['__run = null; __result = null; __json = null; 0', '4', 4],
		['__host = function () { return "123" }; 0', 'thisComp.width', 1920],
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
		// Top-level let/const keep working (no var redeclaration).
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

	it('random and wiggle stay deterministic after attempts to detach the hash buffers', () => {
		const run = setup();
		const before = run('wiggle(2, 30)');
		run('try { __f64.buffer.transfer() } catch (e) {} try { __f64 = new Float64Array(1) } catch (e) {} 0');
		expect(run('wiggle(2, 30)')).toEqual(before);
	});
});

describe('resource limits', () => {
	it('stops endless loops, recursion and huge strings with messages', () => {
		const run = setup();
		expect(run('while (true) {}').error).toMatch(/took too long/);
		expect(run('function f() { return f() } f()').error).toMatch(/stack overflow/);
		expect(run('var s = "x"; while (1) s += s;').error).toMatch(/string too long|memory/);
	});

	it('an expression that exhausted the heap is not run again', { timeout: 60_000 }, () => {
		const run = setup();
		const text = 'var a = []; while (1) a.push([1, 2, 3]);';
		const first = run(text);
		// Which guard stops it depends on the machine: the memory limit, or — when filling 64 MiB takes longer than the
		// wall-clock limit (a slow or busy host) — the wall clock. Either way it blocked for seconds and is quarantined.
		expect(first.error).toMatch(/ran out of memory|took too long/);
		const t0 = performance.now();
		const second = run(text);
		expect(performance.now() - t0).toBeLessThan(50);
		expect(second.error).toMatch(/(ran out of memory|took too long).*not run again/);
		// Other expressions are unaffected.
		expect(run('1 + 1')).toEqual({ value: 2, error: null });
	});
});
