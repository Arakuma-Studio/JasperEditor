import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	bytesTarget,
	describeFuzz,
	formatFailures,
	jsonTarget,
	runFuzzTarget,
	textTarget,
} from '../src/fuzz.ts';
import { decodePng, encodePng, PngError, rgba8 } from '../src/index.ts';

class ParseError extends Error {}

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
	it('passes a robust parser and catches a buggy one, saving the failing input', async () => {
		const seeds = ['a=1\nb=2', 'x=-3.5'];
		expect(await runFuzzTarget(textTarget('good', seeds, goodParser, ParseError), { scale: 1 })).toEqual([]);
		const failures = await runFuzzTarget(textTarget('buggy', seeds, buggyParser, ParseError), { scale: 1 });
		expect(failures.length).toBeGreaterThan(0);
		expect(failures[0]!.error).toMatch(/TypeError/);
		expect(failures[0]!.file).toMatch(/fuzz-failures/);
	});

	it('reports an artifact write error without losing the parser failure', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'testkit-artifact-'));
		const file = join(dir, 'file');
		writeFileSync(file, 'not a directory');
		vi.stubEnv('JASPER_TEST_RESULTS', file);
		try {
			const target = textTarget('unwritable artifact', ['invalid'], buggyParser);
			const failures = await runFuzzTarget(target, { maxFailures: 1 });
			expect(failures).toHaveLength(1);
			expect(failures[0]?.error).toContain('TypeError');
			expect(failures[0]?.artifactError).toMatch(/Could not save failing input:.*ENOTDIR/);
			expect(formatFailures(target, failures)).toContain('Could not save failing input');
		} finally {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('flags slow inputs', async () => {
		let elapsed = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
		const slow = jsonTarget(
			'slow',
			[1],
			() => {
				elapsed += 30;
			},
			undefined,
			{ slowMs: 5, iterations: 2, properties: 1 },
		);
		try {
			const f = await runFuzzTarget(slow, { scale: 1, maxFailures: 1 });
			expect(f[0]!.error).toMatch(/took 30 ms \(limit 5 ms\)/);
		} finally {
			clock.mockRestore();
		}
	});
});

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
