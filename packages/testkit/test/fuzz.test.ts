import { describe, expect, it } from 'vitest';
import {
	bytesTarget,
	describeFuzz,
	isExpected,
	jsonTarget,
	mutateBytes,
	mutateJson,
	mutateText,
	Rng,
	runFuzzTarget,
	textTarget,
} from '../src/fuzz.ts';
import { decodePng, encodePng, PngError, rgba8 } from '../src/index.ts';

class ParseError extends Error {}

/** A tiny "key=number" parser that validates properly (typed errors only). */
function goodParser(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const m = /^(\w+)=(-?\d+(?:\.\d+)?)$/.exec(line.trim());
		if (!m) throw new ParseError(`bad line ${JSON.stringify(line)}`);
		out[m[1]!] = Number(m[2]);
	}
	return out;
}

/** The same parser with a classic bug: indexes a missing match. */
function buggyParser(text: string): number {
	return text
		.split('\n')
		.map((l) => /^(\w+)=(.*)$/.exec(l)![2]!.length)
		.reduce((a, b) => a + b, 0);
}

describe('fuzz kit', () => {
	it('the RNG is deterministic and roughly uniform', () => {
		const a = new Rng(42);
		const b = new Rng(42);
		const xs = Array.from({ length: 1000 }, () => a.next());
		expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
		const counts = new Array(10).fill(0);
		const r = new Rng(7);
		for (let i = 0; i < 10_000; i++) counts[r.below(10)]++;
		for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(150);
	});

	it('mutators are deterministic per seed and produce variety', () => {
		const seedBytes = Uint8Array.from({ length: 64 }, (_, i) => i);
		const m1 = Array.from(
			{ length: 50 },
			(
				(r) => () =>
					mutateBytes(r, seedBytes)
			)(new Rng(1)),
		);
		const m2 = Array.from(
			{ length: 50 },
			(
				(r) => () =>
					mutateBytes(r, seedBytes)
			)(new Rng(1)),
		);
		expect(m1).toEqual(m2);
		expect(new Set(m1.map((m) => Buffer.from(m).toString('hex'))).size).toBeGreaterThan(40);
		const rng = new Rng(3);
		const texts = new Set(Array.from({ length: 100 }, () => mutateText(rng, 'a=1\nb=2.5\nc=-3')));
		expect(texts.size).toBeGreaterThan(60);
		const json = new Set(
			Array.from({ length: 100 }, () => JSON.stringify(mutateJson(rng, { a: [1, 2, { b: 'x' }], c: true }))),
		);
		expect(json.size).toBeGreaterThan(50);
	});

	it('typed failures are accepted, anything else is not', () => {
		expect(isExpected(new ParseError('x'), ParseError)).toBe(true);
		expect(isExpected(new TypeError('x'), ParseError)).toBe(false);
		expect(isExpected(new TypeError('x'), [ParseError, TypeError])).toBe(true);
		expect(isExpected({ code: 'E' }, (e) => (e as { code?: string }).code === 'E')).toBe(true);
		expect(isExpected(new Error('x'), undefined)).toBe(false);
	});

	it('passes a robust parser and catches a buggy one, saving the failing input', async () => {
		const seeds = ['a=1\nb=2', 'x=-3.5'];
		expect(await runFuzzTarget(textTarget('good', seeds, goodParser, ParseError), { scale: 1 })).toEqual([]);
		const failures = await runFuzzTarget(textTarget('buggy', seeds, buggyParser, ParseError), { scale: 1 });
		expect(failures.length).toBeGreaterThan(0);
		expect(failures[0]!.error).toMatch(/TypeError/);
		expect(failures[0]!.file).toMatch(/fuzz-failures/);
	});

	it('flags slow inputs', async () => {
		const slow = jsonTarget(
			'slow',
			[1],
			() => {
				const t = Date.now();
				while (Date.now() - t < 30);
			},
			undefined,
			{ slowMs: 5, iterations: 2, properties: 1 },
		);
		const f = await runFuzzTarget(slow, { scale: 1, maxFailures: 1 });
		expect(f[0]!.error).toMatch(/took \d+ ms/);
	});
});

// The testkit's own parser is a fuzz target too.
describeFuzz('@jasper/testkit', [
	bytesTarget(
		'PNG decoder',
		() => {
			const img = rgba8(9, 7);
			for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) & 0xff;
			const opaque = rgba8(
				9,
				7,
				img.data.map((v, i) => (i % 4 === 3 ? 255 : v)),
			);
			return [encodePng(img), encodePng(opaque)];
		},
		(b) => decodePng(b),
		PngError,
	),
]);
