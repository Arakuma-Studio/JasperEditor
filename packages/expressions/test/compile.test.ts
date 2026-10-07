// Source transform: array maths (the EffectCraft rewrite.rs cases) and completion values.
import { describe, expect, it } from 'vitest';
import { compileExpressionSource, MAX_NESTING, rewriteForTest } from '../src/compile.ts';

const n = (s: string) => s.replace(/[ \t]/g, '');
const rw = (s: string) => n(rewriteForTest(s));

describe('array maths rewrite (rewrite.rs cases)', () => {
	it('precedence and unary minus', () => {
		expect(rw('a + b * c')).toBe(n('__r=(__add(a,__mul(b,c)))'));
		expect(rw('-x * 2')).toBe(n('__r=(__mul(__neg(x),2))'));
		expect(rw('-2*x')).toBe(n('__r=(__mul(-2,x))'));
		expect(rw('a % b + c')).toBe(n('__r=(__add(a % b,c))'));
		expect(rw('a - b - c')).toBe(n('__r=(__sub(__sub(a,b),c))'));
	});
	it('calls, members and groups', () => {
		expect(rw('f(a+b)[0] / 2')).toBe(n('__r=(__div(f(__add(a,b))[0],2))'));
		expect(rw('thisComp.layer("A").transform.position[0] + 1')).toBe(
			n('__r=(__add(thisComp.layer("A").transform.position[0],1))'),
		);
		expect(rw('x = a ? b + 1 : c')).toBe(n('__r=(x = a ? __add(b,1) : c)'));
		expect(rw('if (a) -b; else c')).toBe(n('__r=void 0;if (a) __r=(__neg(b)); else __r=(c)'));
	});
	it('strings, regexes, comments and template literals', () => {
		expect(rw('\'a+b\' + "c"')).toBe(n('__r=(__add(\'a+b\',"c"))'));
		expect(rw("s.replace(/a+b/g, '')")).toBe(n("__r=(s.replace(/a+b/g, ''))"));
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the expression source contains a template literal
		expect(rw('`${a+b}` + 1')).toBe(n('__r=(__add(`${__add(a,b)}`,1))'));
		expect(rewriteForTest('a /* + */ * b').match(/__mul/g)?.length).toBe(1);
	});
	it('compound assignments, functions, typeof, ++ and **', () => {
		expect(rw('x += [1, 0];')).toBe(n('__r=(x=__add(x,([1, 0])));'));
		expect(rw('function f(a) { return a * 2 }')).toBe(n('function f(a) { return __mul(a,2) }'));
		expect(rw('var g = (a) => a - 1')).toBe(n('var g = (a) => __sub(a,1)'));
		expect(rw("typeof a + 'x'")).toBe(n("__r=(__add(typeof a,'x'))"));
		expect(rw('i++ + 1')).toBe(n('__r=(__add(i++,1))'));
		expect(rw('2 ** 3 * 2')).toBe(n('__r=(__mul(2 ** 3,2))'));
	});
	it('keeps line numbers', () => {
		const out = rewriteForTest('a\n+\nb\nc');
		expect(out.split('\n').length).toBe(4);
		expect(rewriteForTest('x = [\n1,\n2] * 3').split('\n').length).toBe(3);
	});
	it('completion values: statements outside functions only', () => {
		expect(rw('var x = 1; x')).toBe(n('var x = 1; __r=(x)'));
		expect(rw('for (var i = 0; i < 3; i++) { s = i }')).toBe(
			n('__r=void 0;for (var i = 0; __r=(i) < 3; i++) { __r=(s = i) }').replace('__r=(i)<3', 'i<3'),
		);
		expect(rw('[1, 2].map(function (v) { v * 2; return v })')).toBe(
			n('__r=([1, 2].map(function (v) { __mul(v,2); return v }))'),
		);
	});
	it('rejects syntax errors with the line', () => {
		const c = compileExpressionSource('x = 1\ny = (');
		expect(c.ok).toBe(false);
		expect(!c.ok && c.error).toMatch(/^Error at line 2: /);
	});
	it('rejects deep nesting instead of overflowing', () => {
		for (const count of [MAX_NESTING + 1, 1000, 100_000]) {
			const parens = `${'('.repeat(count)}1${')'.repeat(count)}`;
			const c = compileExpressionSource(parens);
			expect(c.ok).toBe(false);
			expect(!c.ok && c.error).toMatch(/nested too deeply/);
		}
		expect(
			compileExpressionSource(`${'('.repeat(MAX_NESTING - 2)}a + b${')'.repeat(MAX_NESTING - 2)}`).ok,
		).toBe(true);
	});
});
