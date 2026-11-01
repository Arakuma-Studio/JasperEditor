// AF-SEC-003 / AF-SEC-004 (spec 18 §2.1): generated filtergraphs are checked against the GPL-only filter list
// before FFmpeg starts, with a coded error; AGENTS.md §2 rule 2 names exactly that list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLgplFilters, GPL_FILTERS, LgplFilterError } from '../src/processing/proc/filters.ts';
import { assertLgplGraphArgs } from '../src/tools/ffmpeg.ts';
import { ROOT } from './fixtures.ts';

const refusal = (f: () => void) => {
	try {
		f();
	} catch (e) {
		return e;
	}
	return null;
};

describe('assertLgplFilters', () => {
	it('refuses every GPL-only filter with the coded GPL_FILTER_REFUSED error', () => {
		for (const name of GPL_FILTERS) {
			if (name.startsWith('vidstab')) continue;
			const e = refusal(() => assertLgplFilters(`[0:v]scale=320:-2,${name}=1[v]`));
			expect(e, name).toBeInstanceOf(LgplFilterError);
			expect((e as LgplFilterError).code).toBe('GPL_FILTER_REFUSED');
			expect((e as Error).message).toContain(`"${name}"`);
		}
	});

	it('vidstab* only with explicit approval (our pinned LGPL vid.stab build)', () => {
		expect(refusal(() => assertLgplFilters('vidstabtransform=input=x'))).toBeInstanceOf(LgplFilterError);
		expect(() => assertLgplFilters('vidstabtransform=input=x', { allowVidstab: true })).not.toThrow();
	});

	it('reads filter names only: expressions, quoted or escaped option values and labels are not filters', () => {
		const ok = [
			"select='eq(n,0)',scale=320:-2",
			'select=if(gt(t\\,1)\\,eq(n\\,0)\\,0),setpts=N/FRAME_RATE/TB',
			"[0:v]geq=lum='if(eq(X,Y),255,0)':cb=128:cr=128[eq]",
			'[eq][1:v]overlay=x=0:y=0[out]',
			"scale='min(160,iw)':-2",
			'color=c=black:s=2x2,format=rgba;\n[a]trim=end_frame=3[phase]',
		];
		for (const g of ok) expect(() => assertLgplFilters(g), g).not.toThrow();
		expect(refusal(() => assertLgplFilters('[a]format=yuv420p;\n[b] eq=contrast=2[c]'))).toBeInstanceOf(
			LgplFilterError,
		);
	});
});

describe('every FFmpeg run checks its filter arguments before it starts (AF-SEC-003)', () => {
	it('checks -filter_complex, -lavfi, -vf, -af, -filter:v and lavfi inputs', () => {
		for (const args of [
			['-i', 'a.mp4', '-filter_complex', '[0:v]hqdn3d[v]', '-map', '[v]', 'o.mp4'],
			['-i', 'a.mp4', '-lavfi', 'boxblur=2', 'o.mp4'],
			['-i', 'a.mp4', '-vf', 'scale=2:2,delogo=x=1:y=1:w=1:h=1', 'o.mp4'],
			['-i', 'a.mp4', '-filter:v', 'pp7', 'o.mp4'],
			['-f', 'lavfi', '-i', 'mptestsrc', 'o.mp4'],
		])
			expect(
				refusal(() => assertLgplGraphArgs(args)),
				args.join(' '),
			).toBeInstanceOf(LgplFilterError);
		expect(() =>
			assertLgplGraphArgs(['-i', 'a.mp4', '-vf', 'scale=2:2', '-af', 'aresample=48000', '-f', 'null', '-']),
		).not.toThrow();
	});
});

describe('AF-SEC-004: AGENTS.md names the same GPL-only filters as filters.ts', () => {
	it('the lists are equal', () => {
		const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
		const rule = /Never generate GPL-only filters:([\s\S]*?)\.\s*\n\s*The sole `vidstab\*` exception/.exec(
			agents,
		);
		expect(rule, 'AGENTS.md §2 rule 2').not.toBeNull();
		const listed = [...rule![1]!.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!);
		expect([...listed].sort()).toEqual([...GPL_FILTERS].sort());
		expect(new Set(listed).size).toBe(listed.length);
	});
});
