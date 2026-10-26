import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, writeToolImages } from '../src/jasper-cli.ts';
import { decodePng } from '../src/png.ts';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.JASPER_CLI_TEST_PORT);
const fixture = join(ROOT, 'fixtures', 'media', 'clip-a.mp4');

describe('argument parsing', () => {
	it('usage errors exit 2, --help 0, --version 0', async () => {
		const io = () => {
			const out: string[] = [];
			const err: string[] = [];
			return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
		};
		const a = io();
		expect(await runCli([], a)).toBe(2);
		const b = io();
		expect(await runCli(['frobnicate'], b)).toBe(2);
		const c = io();
		expect(await runCli(['--help'], c)).toBe(0);
		expect(c.out.join('')).toContain('render-frame');
		const d = io();
		expect(await runCli(['--version'], d)).toBe(0);
		const e = io();
		expect(await runCli(['query', 'not-a-query'], e)).toBe(2);
	});
});

describe('call --out', () => {
	it('writes every image of a result: one to the path, several to <stem>-<i><ext> (none dropped)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-cli-out-'));
		try {
			const img = (b: number) => ({
				type: 'image' as const,
				mimeType: 'image/png',
				data: Buffer.from([b]).toString('base64'),
			});
			const text = { type: 'text' as const, text: '{}' };
			expect(writeToolImages({ content: [text, img(1)] }, join(dir, 'one.png'))).toEqual([
				join(dir, 'one.png'),
			]);
			expect([...readFileSync(join(dir, 'one.png'))]).toEqual([1]);
			const many = writeToolImages({ content: [text, img(1), img(2), img(3)] }, join(dir, 'p.png'));
			expect(many).toEqual([join(dir, 'p-0.png'), join(dir, 'p-1.png'), join(dir, 'p-2.png')]);
			expect(many.map((f) => [...readFileSync(f)])).toEqual([[1], [2], [3]]);
			expect(writeToolImages({ content: [img(4), img(5)] }, join(dir, 'noext'))).toEqual([
				join(dir, 'noext-0'),
				join(dir, 'noext-1'),
			]);
			expect(writeToolImages({ content: [text] }, join(dir, 'none.png'))).toEqual([]);
			expect(existsSync(join(dir, 'none.png'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

let engine: ChildProcess | null = null;
let appdir = '';
let work = '';

type Result = { code: number; out: string; err: string; lines: unknown[] };
async function jasper(...args: string[]): Promise<Result> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli([...args, '--appdir', appdir], {
		stdout: (s) => out.push(s),
		stderr: (s) => err.push(s),
		env: cleanEnv(),
		cwd: work,
	});
	const text = out.join('');
	const lines = text
		.split('\n')
		.filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['))
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	return { code, out: text, err: err.join(''), lines };
}

describe('jasper against a real engine', () => {
	let projectId = '';
	let clipId = '';

	beforeAll(async () => {
		if (!existsSync(fixture)) {
			const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], {
				stdio: 'inherit',
			});
			if (r.status !== 0) throw new Error('fixture generation failed');
		}
		appdir = mkdtempSync(join(tmpdir(), 'jasper-cli-it-'));
		work = mkdtempSync(join(tmpdir(), 'jasper-cli-work-'));
		const logs: string[] = [];
		engine = spawn(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
			{
				cwd: ROOT,
				env: cleanEnv({ JASPER_LOCAL_TOKEN: randomBytes(16).toString('hex') }),
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		engine.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
		engine.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
		await waitFor(
			async () =>
				existsSync(join(appdir, 'engine', 'runtime.json')) &&
				(await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
			90_000,
			`engine on ${PORT}: ${logs.join('')}`,
		);
	}, 180_000);

	afterAll(async () => {
		if (engine && engine.exitCode === null) {
			const exited = new Promise((r) => engine!.once('exit', r));
			engine.kill('SIGTERM');
			await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
		}
		if (appdir) rmSync(appdir, { recursive: true, force: true });
		if (work) rmSync(work, { recursive: true, force: true });
	}, 30_000);

	it('status, project creation through call, and project resolution', async () => {
		const s = await jasper('status', '--json');
		expect(s.code, s.err).toBe(0);
		expect(s.lines[0]).toMatchObject({ engine: { foundBy: 'runtime-file' } });
		const none = await jasper('inspect');
		expect(none.code).toBe(2);
		expect(none.err).toContain('no projects yet');
		const c = await jasper('call', 'create_project', 'name=CLI test', '--json');
		expect(c.code, c.err).toBe(0);
		projectId = (c.lines[0] as { projectId: string }).projectId;
		const p = await jasper('projects');
		expect(p.out).toContain(projectId);
		const byName = await jasper('inspect', '--project', 'CLI test');
		expect(byName.code, byName.err).toBe(0);
		expect(byName.out).toContain('V1');
		const wrong = await jasper('inspect', '--project', 'Nope');
		expect(wrong.code).toBe(2);
	});

	it('import, exec with k=v and JSON, describe, run with JSON-lines output', async () => {
		writeFileSync(join(work, 'a.mp4'), readFileSync(fixture));
		const imp = await jasper('import', 'a.mp4', '--json');
		expect(imp.code, imp.err).toBe(0);
		const mediaId = (imp.lines[0] as { imported: { mediaId: string }[] }).imported[0]!.mediaId;
		const placed = await jasper(
			'exec',
			'clip.place',
			`source.mediaId=${mediaId}`,
			'at=0',
			'tracks={"video":"V1","audio":"A1"}',
			'--label',
			'Place A',
			'--json',
		);
		expect(placed.code, placed.err).toBe(0);
		const body = placed.lines[0] as { created: string[]; revision: number };
		expect(body.created.length).toBeGreaterThan(0);
		const tl = await jasper('query', 'sequence.clipsInRange', 'from=0', 'to=100', '--json');
		clipId = (tl.lines[0] as { clips: { id: string; track: string }[] }).clips.find(
			(x) => x.track === 'V1',
		)!.id;
		const marker = await jasper('exec', '{"type":"marker.add","frame":12,"name":"CLI"}', '--json');
		expect(marker.code, marker.err).toBe(0);
		// Unknown keys fail with the accepted ones (exit 1, JSON error on stdout).
		const bad = await jasper('exec', 'marker.add', 'frame=3', 'nmae=x', '--json');
		expect(bad.code).toBe(1);
		expect(JSON.stringify(bad.lines[0])).toContain('nmae');
		const d = await jasper('describe', 'marker.add', '--json');
		expect(JSON.stringify(d.lines[0])).toContain('marker.add');
		writeFileSync(
			join(work, 'tx.jsonl'),
			[
				'# two markers, a failure, then a third that is not reached',
				'{"type":"marker.add","frame":20,"name":"R1"}',
				'{"label":"Two","commands":[{"type":"marker.add","frame":21},{"type":"marker.add","frame":22}]}',
				'{"type":"marker.add","frame":-5}',
				'{"type":"marker.add","frame":23}',
			].join('\n'),
		);
		const run = await jasper('run', 'tx.jsonl', '--json');
		expect(run.code).toBe(1);
		expect(run.lines.map((l) => (l as { ok: boolean; line: number }).ok)).toEqual([true, true, false, false]);
		expect((run.lines[2] as { line: number }).line).toBe(4);
		const kept = await jasper('run', 'tx.jsonl', '--keep-going', '--dry-run', '--json');
		expect(kept.lines.filter((l) => (l as { line?: number }).line).length).toBe(4);
	});

	it('get / set / props report value and evaluated', async () => {
		const set = await jasper('set', `clip/${clipId}/opacity`, '40', '--json');
		expect(set.code, set.err).toBe(0);
		const got = await jasper('get', `clip/${clipId}/opacity`, '--at', '5', '--json');
		expect(got.code, got.err).toBe(0);
		expect((got.lines[0] as { property: { value: number; evaluated: number } }).property).toMatchObject({
			value: 40,
			evaluated: 40,
		});
		const props = await jasper('props', clipId);
		expect(props.out).toMatch(/opacity\t40/);
		const bad = await jasper('set', 'sequences/x', '1');
		expect(bad.code).toBe(2);
	});

	it('render-frame writes a PNG, export writes a video', async () => {
		const r = await jasper('render-frame', '--at', '0.5s', '--out', 'f.png', '--width', '320', '--json');
		expect(r.code, r.err).toBe(0);
		const img = decodePng(readFileSync(join(work, 'f.png')));
		expect(img.width).toBe(320);
		const e = await jasper('export', '--out', 'cut.mp4', '--range', '0..15', '--json');
		expect(e.code, e.err).toBe(0);
		const path = (e.lines.at(-1) as { result: { path: string } }).result.path;
		expect(path).toBe(join(work, 'cut.mp4'));
		const probe = spawnSync('ffprobe', [
			'-v',
			'error',
			'-count_frames',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=nb_read_frames',
			'-of',
			'csv=p=0',
			path,
		]);
		expect(Number(probe.stdout.toString().trim())).toBe(15);
		expect(e.err).toMatch(/\[jasper\] \d+%/);
	}, 300_000);

	it('the bin entry runs and returns the exit status', () => {
		const r = spawnSync(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'apps/mcp/src/jasper.ts'), 'projects', '--json', '--appdir', appdir],
			{ cwd: ROOT, env: cleanEnv(), encoding: 'utf8' },
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(projectId);
		const u = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'apps/mcp/src/jasper.ts'), 'exec'], {
			cwd: ROOT,
			env: cleanEnv(),
			encoding: 'utf8',
		});
		expect(u.status).toBe(2);
	});
});
