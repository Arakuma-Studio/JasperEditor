import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportAle, importAle } from '../src/ale.ts';
import { detectFormat } from '../src/formats.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks } from '../src/time.ts';
import { arbProject, BASIC } from './support/arbitraries.ts';
import { expectOnlyInterchangeErrors, VENV_PYTHON } from './support/fuzz.ts';

const fixture = readFileSync(join(__dirname, 'fixtures/ale/avid-log.ale'), 'utf8');

describe('Avid ALE', () => {
	it('reads an Avid log', () => {
		expect(detectFormat(new TextEncoder().encode(fixture), 'x.ale')).toBe('ale');
		const p = importAle(fixture, {}, new Report());
		const ms = Object.values(p.media);
		expect(ms.map((m) => m.name)).toEqual(['Beach_01', 'Gulls']);
		const r = { num: 24000, den: 1001 };
		expect(ms[0]!.timecode).toEqual({ frames: 86400, rate: r, dropFrame: false });
		expect(ms[0]!.duration).toBe(framesToFlicks(240, r));
		expect(ms[0]!.reel).toBe('A001');
		expect(ms[0]!.path).toBe('/Volumes/Shoot/Beach_01.mov');
		expect(ms[1]!.video).toBeUndefined();
		expect(ms[1]!.audio!.channels).toBe(2);
		expect(ms[0]!.jasper).toEqual({ ale: { Scene: '12', Take: '3', Description: 'Wide of the beach' } });
	});

	it('export → import keeps the logged media', () => {
		fc.assert(
			fc.property(arbProject({ ...BASIC, timecode: true, audioOnlyMedia: true }), (p) => {
				const text = exportAle(p, p.top[0]!, { ale: { scope: 'project' } }, new Report());
				expect(text.includes('\r\n')).toBe(true);
				const back = importAle(text, {}, new Report());
				const pick = (m: {
					name: string;
					path: string | null;
					duration: number | null;
					timecode?: unknown;
				}) => [m.name, m.path, m.duration, m.timecode];
				const orig = Object.values(p.media).filter((m) => !m.generator);
				expect(Object.values(back.media).map(pick)).toEqual(orig.map(pick));
			}),
			{ numRuns: 60 },
		);
	});

	it('only ever throws InterchangeError on corrupt input', () => {
		expectOnlyInterchangeErrors(
			(b) => importAle(new TextDecoder().decode(b), {}, new Report()),
			new TextEncoder().encode(fixture),
			{ runs: 200 },
		);
	});

	it.skipIf(!existsSync(VENV_PYTHON))('is read by OpenTimelineIO’s ale adapter', () => {
		const p = fc.sample(arbProject({ ...BASIC, timecode: true }), { seed: 3, numRuns: 1 })[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'ale-'));
		const file = join(dir, 'x.ale');
		writeFileSync(file, exportAle(p, p.top[0]!, { ale: { scope: 'project' } }, new Report()));
		const out = execFileSync(
			VENV_PYTHON,
			[
				'-c',
				'import json,sys,opentimelineio as otio\nc = otio.adapters.read_from_file(sys.argv[1], "ale")\nprint(json.dumps([x.name for x in c]))',
				file,
			],
			{ encoding: 'utf8' },
		);
		expect(JSON.parse(out)).toEqual(
			Object.values(p.media)
				.filter((m) => !m.generator)
				.map((m) => m.name),
		);
	});
});
