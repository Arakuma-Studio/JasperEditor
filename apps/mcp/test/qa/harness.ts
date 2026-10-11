// Scenario harness modelled on EffectCraft's crates/automation/tests/qa; rendered pixels provide independent evidence.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProjectDocument, trackLabel } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decodePng } from '../../src/png.ts';
import { cleanEnv, waitFor } from '../helpers.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FIXTURES = join(ROOT, 'fixtures', 'media');
/** Opt-in tier: `pnpm qa:mcp`, or with the other render suites (`REMOTION_E2E=1`). */
export const QA_ENABLED = process.env.MCP_QA === '1' || process.env.REMOTION_E2E === '1';

export type Img = { width: number; height: number; data: Uint8Array };
export type Px = [number, number, number, number];

export class Qa {
	private engine: ChildProcess | null = null;
	private client: Client | null = null;
	readonly appdir: string;
	readonly dir: string;
	readonly logs: string[] = [];
	projectId = '';
	projectName = '';

	constructor(
		readonly name: string,
		readonly port: number,
	) {
		this.appdir = mkdtempSync(join(tmpdir(), `jasper-qa-${name}-appdir-`));
		this.dir = mkdtempSync(join(tmpdir(), `jasper-qa-${name}-`));
	}

	path(rel: string): string {
		return join(this.dir, rel);
	}

	async start(): Promise<void> {
		if (!existsSync(join(FIXTURES, 'clip-a.mp4'))) {
			const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], {
				stdio: 'inherit',
			});
			if (r.status !== 0) throw new Error('fixture generation failed');
		}
		const pass: Record<string, string> = {};
		for (const k of ['JASPER_BROWSER_EXECUTABLE', 'JASPER_REMOTION_GL'])
			if (process.env[k]) pass[k] = process.env[k]!;
		this.engine = spawn(
			process.execPath,
			[
				'--import',
				'tsx',
				join(ROOT, 'apps/engine/src/cli.ts'),
				'--port',
				String(this.port),
				'--appdir',
				this.appdir,
			],
			{ cwd: ROOT, env: cleanEnv({ ...pass, JASPER_DEV: '1' }), stdio: ['ignore', 'pipe', 'pipe'] },
		);
		this.engine.stdout?.on('data', (d: Buffer) => this.logs.push(d.toString()));
		this.engine.stderr?.on('data', (d: Buffer) => this.logs.push(d.toString()));
		await waitFor(
			async () =>
				existsSync(join(this.appdir, 'engine', 'runtime.json')) &&
				(await fetch(`http://127.0.0.1:${this.port}/health`)).ok,
			120_000,
			`engine on ${this.port}: ${this.logs.join('').slice(-4000)}`,
		);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				'--import',
				'tsx',
				join(ROOT, 'apps/mcp/src/cli.ts'),
				'--appdir',
				this.appdir,
				'--agent-name',
				'qa',
			],
			cwd: ROOT,
			env: cleanEnv(),
			stderr: 'pipe',
		});
		transport.stderr?.on('data', (d: Buffer) => this.logs.push(d.toString()));
		this.client = new Client({ name: `qa-${this.name}`, version: '1' });
		await this.client.connect(transport);
	}

	async stop(): Promise<void> {
		await this.client?.close().catch(() => {});
		const e = this.engine;
		if (e && e.exitCode === null) {
			const exited = new Promise((r) => e.once('exit', r));
			e.kill('SIGTERM');
			await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
		}
		rmSync(this.appdir, { recursive: true, force: true });
		rmSync(this.dir, { recursive: true, force: true });
	}

	/** A `tools/call`; `Err` = the tool's `{error}` body. */
	async tryTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
		if (!this.client) throw new Error('Qa.start() first');
		return (await this.client.callTool({ name, arguments: args }, undefined, {
			timeout: 600_000,
			resetTimeoutOnProgress: true,
			onprogress: () => {},
		})) as CallToolResult;
	}

	/** A raw `tools/call` with request options (abort signal, progress) for cancellation checks. */
	callRaw(
		name: string,
		args: Record<string, unknown>,
		opts: { signal?: AbortSignal; onprogress?: (p: { progress: number; total?: number }) => void },
	): Promise<unknown> {
		if (!this.client) throw new Error('Qa.start() first');
		return this.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, ...opts });
	}

	async engineJson<T>(path: string): Promise<T> {
		const rt = JSON.parse(readFileSync(join(this.appdir, 'engine', 'runtime.json'), 'utf8')) as {
			url: string;
			token?: string;
		};
		const r = await fetch(`${rt.url}${path}`, {
			headers: rt.token ? { authorization: `Bearer ${rt.token}` } : {},
		});
		return (await r.json()) as T;
	}

	async tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
		const r = await this.tryTool(name, args);
		if (r.isError)
			throw new Error(
				`${name} ${JSON.stringify(args)} failed: ${text(r)}\n${this.logs.join('').slice(-3000)}`,
			);
		return JSON.parse(text(r)) as T;
	}

	async toolError(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<{ code: string; message: string; hint?: string }> {
		const r = await this.tryTool(name, args);
		if (!r.isError) throw new Error(`${name} should have failed: ${text(r)}`);
		return (JSON.parse(text(r)) as { error: { code: string; message: string; hint?: string } }).error;
	}

	async tx<T = { refs?: Record<string, string>; created: string[] }>(
		label: string,
		commands: unknown[],
	): Promise<T> {
		return this.tool<T>('apply_commands', { projectId: this.projectId, label, commands });
	}

	async project(name: string, preset = 'hd-720p-30'): Promise<string> {
		this.projectName = name;
		this.projectId = (await this.tool<{ projectId: string }>('create_project', { name, preset })).projectId;
		return this.projectId;
	}

	async importMedia(...names: string[]): Promise<Record<string, string>> {
		const r = await this.tool<{ imported: { mediaId: string; name?: string; path?: string }[] }>(
			'import_media',
			{
				projectId: this.projectId,
				paths: names.map((n) => (n.startsWith('/') ? n : join(FIXTURES, n))),
			},
		);
		const out: Record<string, string> = {};
		r.imported.forEach((m, i) => {
			out[names[i]!.split('/').pop()!] = m.mediaId;
		});
		return out;
	}

	async frame(at: unknown, width = 640): Promise<Img> {
		const r = await this.tryTool('render_frame', { projectId: this.projectId, at, width });
		if (r.isError) throw new Error(`render_frame: ${text(r)}`);
		const img = r.content.find((c) => c.type === 'image') as { data: string } | undefined;
		if (!img) throw new Error('render_frame returned no image');
		const png = Buffer.from(img.data, 'base64');
		if (process.env.MCP_QA_KEEP) {
			mkdirSync(join(ROOT, 'test-results', 'mcp-qa'), { recursive: true });
			writeFileSync(
				join(
					ROOT,
					'test-results',
					'mcp-qa',
					`${this.projectName.replace(/\W+/g, '-')}-${JSON.stringify(at).replace(/\W+/g, '_')}.png`,
				),
				png,
			);
		}
		return decodePng(png);
	}

	/** The project document, read as the `jasper://projects/{id}/document` resource (live editor state). */
	async doc(): Promise<ProjectDocument> {
		if (!this.client) throw new Error('Qa.start() first');
		const r = await this.client.readResource({ uri: `jasper://projects/${this.projectId}/document` });
		return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
	}

	async clips(): Promise<
		{ id: string; kind: string; track: string; start: number; end: number; name: string }[]
	> {
		const doc = await this.doc();
		const seq = Object.values(doc.sequences)[0]!;
		return Object.values(seq.clips)
			.map((c) => ({
				id: c.id,
				kind: c.kind,
				track: trackLabel(seq, c.trackId) ?? c.trackId,
				start: c.start,
				end: c.start + c.duration,
				name: c.name,
			}))
			.sort((x, y) => x.start - y.start || x.track.localeCompare(y.track));
	}
}

export const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '';

export function px(img: Img, x: number, y: number): Px {
	const i = (Math.round(y) * img.width + Math.round(x)) * 4;
	return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

export const luma = (p: Px | readonly number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;

export function coverage(
	img: Img,
	f: (p: Px) => boolean,
	rect?: { x: number; y: number; w: number; h: number },
): number {
	const r = rect ?? { x: 0, y: 0, w: img.width, h: img.height };
	let n = 0;
	for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (f(px(img, x, y))) n++;
	return n / Math.max(1, r.w * r.h);
}

export function centroid(img: Img, f: (p: Px) => boolean): { x: number; y: number } | null {
	let sx = 0;
	let sy = 0;
	let n = 0;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++)
			if (f(px(img, x, y))) {
				sx += x;
				sy += y;
				n++;
			}
	return n ? { x: sx / n, y: sy / n } : null;
}

export function meanLuma(img: Img, rect?: { x: number; y: number; w: number; h: number }): number {
	const r = rect ?? { x: 0, y: 0, w: img.width, h: img.height };
	let s = 0;
	for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s += luma(px(img, x, y));
	return s / Math.max(1, r.w * r.h);
}

/** Mean absolute difference per RGB channel (0–255) of two same-size images. */
export function meanDiff(a: Img, b: Img): number {
	if (a.width !== b.width || a.height !== b.height)
		throw new Error(`size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
	let s = 0;
	for (let i = 0; i < a.data.length; i += 4)
		s +=
			Math.abs(a.data[i]! - b.data[i]!) +
			Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
			Math.abs(a.data[i + 2]! - b.data[i + 2]!);
	return s / ((a.data.length / 4) * 3);
}

export function meanColor(img: Img): [number, number, number] {
	const s = [0, 0, 0];
	for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) s[c]! += img.data[i + c]!;
	const n = img.data.length / 4;
	return [s[0]! / n, s[1]! / n, s[2]! / n];
}

export function videoFrame(file: string, seconds: number, width: number, dir: string): Img {
	const out = join(dir, `vf-${Math.round(seconds * 1000)}-${Math.random().toString(36).slice(2)}.png`);
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-ss',
		String(seconds),
		'-i',
		file,
		'-frames:v',
		'1',
		'-vf',
		`scale=${width}:-2`,
		out,
	]);
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`);
	return decodePng(readFileSync(out));
}

export function ffprobe(file: string): { width: number; height: number; frames: number; codec: string } {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-count_frames',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height,nb_read_frames,codec_name',
		'-of',
		'json',
		file,
	]);
	const s = (JSON.parse(r.stdout.toString()) as { streams: Record<string, unknown>[] }).streams[0]!;
	return {
		width: Number(s.width),
		height: Number(s.height),
		frames: Number(s.nb_read_frames),
		codec: String(s.codec_name),
	};
}
