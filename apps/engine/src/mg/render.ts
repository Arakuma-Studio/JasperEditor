// The motion-graphics render pipeline (ARCHITECTURE §10.2, S04:MG-010/012/013):
//   jasper-mg render --spec - --raw-rgba --threads N | ffmpeg -f rawvideo -pix_fmt rgba … -i -
//     → master.mov (prores_ks profile 4, yuva444p10le) [+ preview.webm (libvpx-vp9 yuva420p, half size)]
// followed by frame-count verification of every output. Argument arrays only, no shell (S04 §22).
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { MgSpecInput } from '@jasper/mg-templates';

export type MgQuality = 'preview' | 'master';

export type MgRenderTools = { mg: string; ffmpeg: string; ffprobe: string };

export class MgRenderError extends Error {
	constructor(
		readonly code:
			| 'INVALID_SPEC'
			| 'RENDER_FAILED'
			| 'FRAME_COUNT_MISMATCH'
			| 'JOB_CANCELLED'
			| 'BINARY_MISSING',
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'MgRenderError';
	}
}

/** ffmpeg arguments for the raw RGBA pipe (exported for tests and the docs). */
export function ffmpegArgs(
	spec: MgSpecInput,
	out: { master: string; preview?: string },
	threads: number,
): string[] {
	const args = [
		'-hide_banner',
		'-nostdin',
		'-loglevel',
		'error',
		'-y',
		'-f',
		'rawvideo',
		'-pix_fmt',
		'rgba',
		'-s',
		`${spec.width}x${spec.height}`,
		'-r',
		`${spec.fps.num}/${spec.fps.den}`,
		'-i',
		'pipe:0',
		'-map',
		'0:v',
		'-c:v',
		'prores_ks',
		'-profile:v',
		'4',
		'-pix_fmt',
		'yuva444p10le',
		'-vendor',
		'apl0',
		'-threads',
		String(threads),
		'-f',
		'mov',
		out.master,
	];
	if (out.preview) {
		args.push(
			'-map',
			'0:v',
			'-vf',
			'scale=trunc(iw/4)*2:trunc(ih/4)*2',
			'-c:v',
			'libvpx-vp9',
			'-pix_fmt',
			'yuva420p',
			'-b:v',
			'0',
			'-crf',
			'32',
			'-deadline',
			'realtime',
			'-cpu-used',
			'8',
			'-row-mt',
			'1',
			'-auto-alt-ref',
			'0',
			'-threads',
			String(threads),
			'-f',
			'webm',
			out.preview,
		);
	}
	return args;
}

function killTree(child: ChildProcess | null) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGTERM');
	const t = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	}, 3000);
	t.unref();
}

/** Resolves on 'exit' (not 'close': a piped stdout may stay paused after its consumer died). */
function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null)
			resolve({ code: child.exitCode, signal: child.signalCode });
		else child.once('exit', (code, signal) => resolve({ code, signal }));
	});
}

/** Waits until a stream closed (all of its data was read), at most `ms`. */
function closed(stream: NodeJS.ReadableStream & { closed?: boolean }, ms: number): Promise<void> {
	return new Promise((resolve) => {
		if (stream.closed) return resolve();
		const t = setTimeout(resolve, ms);
		stream.once('close', () => {
			clearTimeout(t);
			resolve();
		});
	});
}

/** Number of video packets (= frames for intra-only ProRes and VP9 without alt-ref) in a file. */
export function countFrames(ffprobe: string, file: string): Promise<number> {
	return new Promise((resolve, reject) => {
		execFile(
			ffprobe,
			[
				'-v',
				'error',
				'-select_streams',
				'v:0',
				'-count_packets',
				'-show_entries',
				'stream=nb_read_packets',
				'-of',
				'csv=p=0',
				file,
			],
			{ timeout: 60_000 },
			(err, stdout, stderr) => {
				if (err) reject(new Error(`ffprobe ${file}: ${stderr?.trim() || err.message}`));
				else resolve(Number.parseInt(stdout.trim(), 10));
			},
		);
	});
}

export type RunPipeOptions = {
	tools: MgRenderTools;
	spec: MgSpecInput;
	outputs: { master: string; preview?: string };
	threads: number;
	signal?: AbortSignal;
	/** 0..1 while frames are produced. */
	onProgress?: (fraction: number, done: number, total: number) => void;
};

/** Runs jasper-mg piped into ffmpeg and verifies the frame count of every output. */
export async function runMgPipe(opts: RunPipeOptions): Promise<void> {
	const { tools, spec, outputs, threads, signal } = opts;
	if (signal?.aborted) throw new MgRenderError('JOB_CANCELLED', 'Render cancelled');
	const mg = spawn(tools.mg, ['render', '--spec', '-', '--raw-rgba', '--threads', String(threads)], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const ff = spawn(tools.ffmpeg, ffmpegArgs(spec, outputs, threads), { stdio: ['pipe', 'ignore', 'pipe'] });
	const spawnErrors: Error[] = [];
	mg.on('error', (e) => spawnErrors.push(e));
	ff.on('error', (e) => spawnErrors.push(e));
	const onAbort = () => {
		killTree(mg);
		killTree(ff);
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	// stdin errors (EPIPE when a child dies early) are reported through the exit codes instead.
	mg.stdin.on('error', () => {});
	ff.stdin.on('error', () => {});
	mg.stdout.on('error', () => {});
	mg.stdin.end(JSON.stringify(spec));
	mg.stdout.pipe(ff.stdin);
	// If ffmpeg goes away the pipe unpipes and pauses stdout; keep draining so jasper-mg sees EPIPE/exits.
	mg.stdout.on('unpipe', () => mg.stdout.resume());

	let mgError: { code?: string; message?: string } | null = null;
	const mgLog: string[] = [];
	createInterface({ input: mg.stderr }).on('line', (line) => {
		mgLog.push(line);
		if (mgLog.length > 50) mgLog.shift();
		try {
			const ev = JSON.parse(line) as {
				event?: string;
				done?: number;
				total?: number;
				code?: string;
				message?: string;
			};
			if (
				ev.event === 'progress' &&
				typeof ev.done === 'number' &&
				typeof ev.total === 'number' &&
				ev.total > 0
			)
				opts.onProgress?.(ev.done / ev.total, ev.done, ev.total);
			else if (ev.event === 'error') mgError = ev;
		} catch {
			// not NDJSON; kept in the log tail
		}
	});
	let ffLog = '';
	ff.stderr.on('data', (d: Buffer) => {
		ffLog = (ffLog + d.toString()).slice(-4000);
	});

	const [mgExit, ffExit] = await Promise.all([exitOf(mg), exitOf(ff)]);
	await Promise.all([closed(mg.stderr, 2000), closed(ff.stderr, 2000)]);
	signal?.removeEventListener('abort', onAbort);
	if (signal?.aborted) throw new MgRenderError('JOB_CANCELLED', 'Render cancelled');
	if (spawnErrors.length > 0)
		throw new MgRenderError('BINARY_MISSING', spawnErrors.map((e) => e.message).join('; '));
	const mgErr = mgError as { code?: string; message?: string } | null;
	if (mgExit.code === 2)
		throw new MgRenderError('INVALID_SPEC', mgErr?.message ?? 'jasper-mg rejected the spec', { log: mgLog });
	if (mgExit.code !== 0)
		throw new MgRenderError(
			'RENDER_FAILED',
			`jasper-mg exited with ${mgExit.code ?? mgExit.signal}: ${mgErr?.message ?? mgLog.at(-1) ?? ''}`,
			{ log: mgLog, ffmpeg: ffLog },
		);
	if (ffExit.code !== 0)
		throw new MgRenderError(
			'RENDER_FAILED',
			`ffmpeg exited with ${ffExit.code ?? ffExit.signal}: ${ffLog.trim()}`,
		);

	for (const file of [outputs.master, outputs.preview]) {
		if (!file) continue;
		const n = await countFrames(tools.ffprobe, file);
		if (n !== spec.durationFrames)
			throw new MgRenderError(
				'FRAME_COUNT_MISMATCH',
				`${file}: ${n} frames, expected ${spec.durationFrames}`,
				{ file, frames: n, expected: spec.durationFrames },
			);
	}
}

/** Writes a straight-alpha PNG of one frame (`jasper-mg frame`). */
export function renderPoster(mgBinary: string, spec: MgSpecInput, frame: number, out: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			mgBinary,
			['frame', '--spec', '-', '--frame', String(frame), '--out', out],
			{ timeout: 60_000 },
			(err, _stdout, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve()),
		);
		child.stdin?.end(JSON.stringify(spec));
	});
}
