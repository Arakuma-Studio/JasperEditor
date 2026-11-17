import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StillRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, writeToolImages } from '../src/jasper-cli.ts';
import type { EngineConnection } from '../src/link.ts';
import { decodePng } from '../src/png.ts';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

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

describe('describe without an engine', () => {
	it('describes MCP tools of any toolset like describe_tool, and names both catalogues for an unknown name', async () => {
		const link: EngineConnection = {
			target: null,
			client: async () => {
				throw new Error('describing a tool needs no engine');
			},
			invalidate: () => {},
			close: async () => {},
		};
		const run = async (...args: string[]) => {
			const out: string[] = [];
			const err: string[] = [];
			const code = await runCli(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), link });
			return { code, out: out.join(''), err: err.join('') };
		};
		const tool = await run('describe', 'add_adjustment_layer', '--json');
		expect(tool.code, tool.err).toBe(0);
		expect(JSON.parse(tool.out)).toMatchObject({
			name: 'add_adjustment_layer',
			toolset: 'structure',
			inputSchema: { properties: { projectId: {} } },
		});
		const full = await run('describe', 'add_adjustment_layer', '--full', '--json');
		expect(JSON.parse(full.out)).toMatchObject({ name: 'add_adjustment_layer', advertised: true });
		const unknown = await run('describe', 'add_adjustmnet_layer');
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain('E_NOT_FOUND');
		expect(unknown.err).toContain('jasper tools');
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

/** A fake engine for frame renders: one project, stills succeed at once (`destination` writes the file). */
function stillEngine(dir: string) {
	const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Stills', preset: 'hd-1080p-30' });
	const stills: StillRequest[] = [];
	const png = Buffer.from('89504e470d0a1a0a', 'hex');
	let result: Record<string, unknown> = {};
	const client = {
		agentQuery: async () => ({ result: doc, revision: 0, via: 'headless' }),
		listProjects: async () => ({ projects: [{ projectId: 'prj_s', name: 'Stills' }] }),
		agentUi: async () => ({ result: { projectId: 'prj_s' } }),
		requestStill: async (req: StillRequest) => {
			stills.push(req);
			if (req.destination) {
				const path = join(req.destination.folder, `${req.destination.name}.${req.format ?? 'png'}`);
				writeFileSync(path, png);
				result = { path, format: req.format ?? 'png' };
			} else result = { url: '/stills/1.png' };
			return { id: 'job_still', state: 'queued', progress: 0 };
		},
		getJob: async (id: string) => ({ id, title: 'Still', state: 'succeeded', progress: 1, result }),
		fetchBytes: async () => ({ bytes: new Uint8Array(png), contentType: 'image/png' }),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	const runWith = async (stdin: string, ...args: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runCli(args, {
			stdout: (t) => out.push(t),
			stderr: (t) => err.push(t),
			link,
			env: {},
			cwd: dir,
			stdin: () => stdin,
		});
		return { code, out: out.join(''), err: err.join('') };
	};
	const run = (...args: string[]) => runWith('', ...args);
	return { run, runWith, stills };
}

describe('frame renders and results from the CLI', () => {
	it('call returns the path of every image it writes, with --out or to a temporary file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-cli-img-'));
		try {
			const { run } = stillEngine(dir);
			const named = await run('call', 'render_frame', 'at=10', '--out', 'f.png', '--json');
			expect(named.code, named.err).toBe(0);
			expect(JSON.parse(named.out)).toMatchObject({ frame: 10, images: [join(dir, 'f.png')] });
			const temp = await run('call', 'render_frame', 'at=10', '--json');
			const body = JSON.parse(temp.out) as { images: string[] };
			expect(body.images).toHaveLength(1);
			expect(existsSync(body.images[0]!)).toBe(true);
			rmSync(body.images[0]!, { force: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Video team report (2026-11-17): `jasper call apply_commands '<json>'` failed with "Argument list too long".
	it('call reads its JSON arguments from @file or stdin', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-cli-args-'));
		try {
			const { run, runWith, stills } = stillEngine(dir);
			writeFileSync(join(dir, 'args.json'), JSON.stringify({ at: 12 }));
			const file = await run('call', 'render_frame', '@args.json', '--out', 'a.png', '--json');
			expect(file.code, file.err).toBe(0);
			expect(JSON.parse(file.out)).toMatchObject({ frame: 12 });
			const piped = await runWith('{"at": 7}', 'call', 'render_frame', '-', '--out', 'b.png', '--json');
			expect(piped.code, piped.err).toBe(0);
			expect(JSON.parse(piped.out)).toMatchObject({ frame: 7 });
			expect(stills.map((x) => x.frame)).toEqual([12, 7]);
			const missing = await run('call', 'render_frame', '@nope.json');
			expect(missing.code).toBe(2);
			expect(missing.out).toContain('nope.json');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('render-frame --full writes the full-size frame through export_frame; --width over 1280 names --full', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-cli-full-'));
		try {
			const { run, stills } = stillEngine(dir);
			writeFileSync(join(dir, 'f.png'), 'old');
			const full = await run('render-frame', '--at', '10', '--out', 'f.png', '--full', '--json');
			expect(full.code, full.err).toBe(0);
			expect(stills[0]).toMatchObject({ frame: 10, format: 'png', destination: { folder: dir } });
			expect(stills[0]!.width).toBeUndefined();
			expect(JSON.parse(full.out)).toMatchObject({ out: join(dir, 'f.png'), frame: 10 });
			expect(readFileSync(join(dir, 'f.png'), 'hex')).toBe('89504e470d0a1a0a');
			const wide = await run('render-frame', '--at', '10', '--out', 'f.png', '--width', '1920');
			expect(wide.code).toBe(2);
			expect(wide.err).toContain('--full');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a failed call prints its structured error on stdout, also without --json', async () => {
		const link: EngineConnection = {
			target: null,
			client: async () => {
				throw new Error('engine went away');
			},
			invalidate: () => {},
			close: async () => {},
		};
		const out: string[] = [];
		const err: string[] = [];
		const code = await runCli(['call', 'import_mg_bundle', 'projectId=prj_s', 'path=/tmp/bundle'], {
			stdout: (t) => out.push(t),
			stderr: (t) => err.push(t),
			link,
		});
		expect(code).toBe(1);
		expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
		expect(err.join('')).toContain('engine went away');
	});

	it('an MCP tool name given as a command points to the command or to call', async () => {
		const err: string[] = [];
		expect(await runCli(['render_frame'], { stdout: () => {}, stderr: (t) => err.push(t) })).toBe(2);
		expect(err.join('')).toMatch(/jasper render-frame/);
		expect(err.join('')).toMatch(/jasper call render_frame/);
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
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			},
		);
		engine.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
		engine.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
		await engineReady(engine, PORT, logs);
	});

	afterAll(async () => {
		await stopEngine(engine);
		if (appdir) rmSync(appdir, { recursive: true, force: true });
		if (work) rmSync(work, { recursive: true, force: true });
	});

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
	});

	it('apply a scene file, apply again (nothing), move a title 40 px (one command), export-scene round trip', async () => {
		const scene = (x: number) =>
			[
				'scene: 1',
				'sequence: { name: Teaser, size: [1280, 720], fps: 30, duration: 3 }',
				'layers:',
				'  - { id: card, type: shape, shape: rect, size: [600, 200], fill: "#204060" }',
				`  - id: title`,
				'    type: text',
				'    text: Hello',
				`    position: [${x}, 360]`,
				'    animation: { in: fade }',
				'    keyframes:',
				'      opacity: [{ t: 0, value: 0, ease: ease-out }, { t: 0.5, value: 100 }]',
			].join('\n');
		writeFileSync(join(work, 'scene.yaml'), scene(560));
		const first = await jasper('apply', 'scene.yaml', '--json');
		expect(first.code, first.err).toBe(0);
		expect(first.lines[0]).toMatchObject({
			createdSequence: true,
			layers: [{ status: 'created' }, { status: 'created' }],
		});
		const again = await jasper('apply', 'scene.yaml', '--json');
		expect(again.code, again.err).toBe(0);
		expect(again.lines[0]).toMatchObject({ commands: 0 });
		writeFileSync(join(work, 'scene.yaml'), scene(600));
		const moved = await jasper('apply', 'scene.yaml', '--json');
		expect(moved.lines[0]).toMatchObject({
			commands: 1,
			layers: [{ status: 'unchanged' }, { status: 'updated', aspects: ['position'] }],
		});
		const ex = await jasper('export-scene', '--sequence', 'Teaser', '--out', 'back.json');
		expect(ex.code, ex.err).toBe(0);
		expect(JSON.parse(readFileSync(join(work, 'back.json'), 'utf8')).layers[1]).toMatchObject({
			id: 'title',
			position: [600, 360],
		});
		const back = await jasper('apply', 'back.json', '--json');
		expect(back.lines[0]).toMatchObject({ commands: 0 });
		writeFileSync(join(work, 'bad.yaml'), scene(600).replace('ease-out', 'eas-out'));
		const bad = await jasper('apply', 'bad.yaml');
		expect(bad.code).toBe(1);
		expect(bad.err).toContain('layers[1].keyframes.opacity[0].ease: unknown ease "eas-out"');
	});

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
