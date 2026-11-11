// jasper apply / preview / export-scene, the parts that run in the CLI (docs/wp-notes/scene-file.md): YAML / JSON
// parsing with line numbers, the YAML the export writes reads back unchanged, the labelled contact sheet keeps every
// cell's pixels and adds a caption strip, and --watch runs once per burst of saves and survives a failing run.
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/jasper-cli.ts';
import { composeGrid, decodePng, encodePng } from '../src/png.ts';
import {
	type FileWatcher,
	formatSceneText,
	labelSheet,
	parseSceneText,
	parseTimes,
	watchScene,
} from '../src/scene-cli.ts';

describe('scene text', () => {
	it('parses YAML and JSON; a syntax error names its line', () => {
		expect(parseSceneText('scene: 1\nlayers: []\n', 's.yaml')).toEqual({
			ok: true,
			raw: { scene: 1, layers: [] },
		});
		expect(parseSceneText('{"scene": 1}', 's.json')).toEqual({ ok: true, raw: { scene: 1 } });
		const bad = parseSceneText('scene: 1\nlayers:\n  - id: a\n   type: text\n', 's.yml');
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.issues[0]!.message).toMatch(/^not YAML: .+ at line 4, column \d+$/);
		const dup = parseSceneText('scene: 1\nscene: 2\n', 's.yaml');
		expect(!dup.ok && dup.issues[0]!.message).toMatch(/^not YAML: .+ at line 2, column \d+$/);
		expect(parseSceneText('{', 's.json').ok).toBe(false);
	});

	it('the YAML an export writes reads back to the same object', () => {
		const file = {
			scene: 1,
			sequence: { name: 'A: B', size: [1920, 1080], fps: '30000/1001' },
			layers: [
				{
					id: 'x',
					type: 'text',
					text: 'two\nlines # not a comment',
					position: [1, -2.5],
					keyframes: {
						opacity: [
							{ t: 0, value: 0, ease: 'cubic-bezier(0.2, 0, 0, 1)' },
							{ t: 1.5, value: 100 },
						],
					},
					masks: [{ path: { points: [[0, 0], { p: [1, 0], in: [0, 0], out: [0.1, 0] }, [1, 1]] } }],
				},
			],
		};
		const text = formatSceneText(file, 'scene.yaml');
		expect(text).toContain('position: [1, -2.5]');
		expect(text).toContain('- {t: 0, value: 0, ease: "cubic-bezier(0.2, 0, 0, 1)"}');
		expect(parseSceneText(text, 'scene.yaml')).toEqual({ ok: true, raw: file });
		expect(JSON.parse(formatSceneText(file, 'scene.json'))).toEqual(file);
	});

	it('--times: seconds, frames and timecodes', () => {
		expect(parseTimes('0.3, 1,45f,00:00:02:00')).toEqual([
			{ arg: { seconds: 0.3 }, label: '0.3s' },
			{ arg: { seconds: 1 }, label: '1s' },
			{ arg: 45, label: '45f' },
			{ arg: '00:00:02:00', label: '00:00:02:00' },
		]);
	});

	it('usage errors exit 2 before any engine is reached', async () => {
		const err: string[] = [];
		const io = { stdout: () => {}, stderr: (s: string) => err.push(s), env: {}, cwd: '/' };
		expect(await runCli(['apply'], io)).toBe(2);
		expect(await runCli(['preview', 'scene.yaml', '--out', 'x.png'], io)).toBe(2);
		expect(err.join('')).toContain('--times');
	});
});

describe('labelSheet', () => {
	it('keeps every cell and puts its time under it', () => {
		const cell = (v: number) => {
			const data = new Uint8Array(40 * 20 * 4).fill(v);
			for (let i = 3; i < data.length; i += 4) data[i] = 255;
			return { width: 40, height: 20, data };
		};
		const grid = composeGrid([cell(10), cell(200)], 2, 4);
		const body = {
			columns: 2,
			rows: 1,
			cellWidth: 40,
			cellHeight: 20,
			cells: [
				{ cell: 1, row: 1, column: 1, frame: 9, timecode: '00:00:00:09' },
				{ cell: 2, row: 1, column: 2, frame: 30, timecode: '00:00:01:00' },
			],
		};
		const out = decodePng(labelSheet(encodePng(grid), body, ['0.3s', '1s'], 'scene.yaml'));
		expect(out.width).toBe(grid.width);
		expect(out.height).toBeGreaterThan(grid.height);
		const px = (x: number, y: number) => out.data[(y * out.width + x) * 4]!;
		const white = (x0: number, y0: number, w: number, h: number) =>
			[...Array(h).keys()].some((y) => [...Array(w).keys()].some((x) => px(x0 + x, y0 + y) >= 230));
		// a header and one caption row of the same height; the cells keep their pixels between them
		const strip = (out.height - grid.height) / 2;
		expect([px(4, strip + 4), px(4 + 44, strip + 4)]).toEqual([10, 200]);
		expect(white(4, 0, out.width - 8, strip)).toBe(true);
		expect(white(4, strip + 4 + 20, 40, strip)).toBe(true);
		expect(white(4, strip + 4, 40, 20)).toBe(false);
	});
});

describe('watchScene', () => {
	it('runs once per burst of saves, reports a failing run and keeps watching, stops on abort', async () => {
		let fire: () => void = () => {};
		const watcher: FileWatcher = (_p, onChange) => {
			fire = onChange;
			return { close: () => {} };
		};
		const timers: (() => void)[] = [];
		const ac = new AbortController();
		const runs: number[] = [];
		const errors: string[] = [];
		let n = 0;
		let settle: () => void = () => {};
		const done = watchScene({
			path: '/x/scene.yaml',
			watcher,
			signal: ac.signal,
			setTimer: (fn) => timers.push(fn),
			clearTimer: () => timers.pop(),
			run: async () => {
				n++;
				runs.push(n);
				settle();
				if (n === 2) throw new Error('half-written file');
			},
			onError: (e) => errors.push((e as Error).message),
		});
		const ran = () => new Promise<void>((r) => (settle = r));
		await Promise.resolve();
		expect(runs).toEqual([1]);
		// three quick saves: one timer survives, one run
		fire();
		fire();
		fire();
		expect(timers).toHaveLength(1);
		let next = ran();
		timers.shift()!();
		await next;
		await Promise.resolve();
		expect(runs).toEqual([1, 2]);
		expect(errors).toEqual(['half-written file']);
		fire();
		next = ran();
		timers.shift()!();
		await next;
		expect(runs).toEqual([1, 2, 3]);
		ac.abort();
		await done;
	});
});
