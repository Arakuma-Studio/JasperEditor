// Raw frame I/O through ffmpeg pipes for jasper-proc steps (S07:PRC-012). Argument arrays only; every child
// runs in its own process group so a cancel (SIGTERM to jasper-proc) takes the whole tree down.
import { type ChildProcess, spawn } from 'node:child_process';
import type { DecodeSpec } from './types.ts';

type RawPixFmt = 'rgb48le' | 'gray';

const BYTES_PER_PIXEL: Record<RawPixFmt, number> = {
	rgb48le: 6,
	gray: 1,
};

export function frameBytes(pixFmt: RawPixFmt, width: number, height: number): number {
	return width * height * BYTES_PER_PIXEL[pixFmt];
}

/** Live children of this process (killed on cancel). */
export const children = new Set<ChildProcess>();

export function killChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
	for (const c of children) {
		try {
			if (c.pid !== undefined && process.platform !== 'win32') process.kill(-c.pid, signal);
			else c.kill(signal);
		} catch {
			// gone
		}
	}
}

export function spawnFfmpeg(
	ffmpeg: string,
	args: string[],
	stdin: 'pipe' | 'ignore' = 'ignore',
): ChildProcess {
	const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...args], {
		stdio: [stdin, 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		windowsHide: true,
	});
	children.add(child);
	child.once('exit', () => children.delete(child));
	return child;
}

/** Collects stderr (bounded) for error messages. */
function tail(child: ChildProcess): () => string {
	let err = '';
	child.stderr?.on('data', (d: Buffer) => {
		err = (err + d.toString()).slice(-4000);
	});
	return () => err.trim();
}

export function exitOf(child: ChildProcess): Promise<number> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) resolve(child.exitCode);
		else child.once('close', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
	});
}

/**
 * The conversion into `pixFmt` with explicit matrices (never guessed from tags: untagged SD would otherwise
 * decode as BT.601): YUV inputs use `spec.matrix`/`spec.range`; RGB outputs are full-range BT.709 R'G'B';
 * grey outputs are full-range BT.709 luma.
 */
function conversionFilter(spec: Pick<DecodeSpec, 'matrix' | 'range'>, pixFmt: RawPixFmt): string {
	const inOpts = spec.matrix ? `in_color_matrix=${spec.matrix}:in_range=${spec.range ?? 'tv'}:` : '';
	const rgb = pixFmt === 'rgb48le';
	return `scale=${inOpts}${rgb ? '' : 'out_color_matrix=bt709:'}out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp,format=${pixFmt}`;
}

/**
 * Decodes the frames of `spec` as raw `pixFmt` frames of `width`×`height` (default: the spec's size, scaled
 * with `area` when smaller). Yields exactly one Buffer per frame (a fresh copy). Throws when ffmpeg fails.
 */
export async function* decodeFrames(
	spec: DecodeSpec,
	opts: { pixFmt: RawPixFmt; width?: number; height?: number; vf?: string; signal?: AbortSignal },
): AsyncGenerator<Buffer> {
	const w = opts.width ?? spec.width;
	const h = opts.height ?? spec.height;
	const filters: string[] = [];
	if (spec.vf) filters.push(spec.vf);
	if (opts.vf) filters.push(opts.vf);
	if (w !== spec.width || h !== spec.height) {
		// Keep the range: FFmpeg 6.1 converts full-range YUV to TV range in a scale without an output range.
		const r = spec.matrix ? (spec.range ?? 'tv') : 'pc';
		filters.push(`scale=${w}:${h}:flags=area:in_range=${r}:out_range=${r}`);
	}
	filters.push(conversionFilter(spec, opts.pixFmt));
	const child = spawnFfmpeg(spec.ffmpeg, [
		...spec.inputArgs,
		'-map',
		'0:v:0',
		'-an',
		'-sn',
		'-dn',
		'-fps_mode',
		'passthrough',
		'-frames:v',
		String(spec.frames),
		'-vf',
		filters.join(','),
		'-f',
		'rawvideo',
		'-',
	]);
	const errText = tail(child);
	const onAbort = () => child.kill('SIGTERM');
	opts.signal?.addEventListener('abort', onAbort, { once: true });
	const size = frameBytes(opts.pixFmt, w, h);
	let pending: Buffer[] = [];
	let pendingLen = 0;
	try {
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			pending.push(chunk);
			pendingLen += chunk.length;
			if (pendingLen < size) continue;
			let all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
			while (all.length >= size) {
				yield Buffer.from(all.subarray(0, size));
				all = all.subarray(size);
			}
			pending = all.length ? [all] : [];
			pendingLen = all.length;
		}
		const code = await exitOf(child);
		if (opts.signal?.aborted) throw new Error('cancelled');
		if (code !== 0) throw new Error(`ffmpeg decode failed (${code}): ${errText()}`);
	} finally {
		opts.signal?.removeEventListener('abort', onAbort);
		if (child.exitCode === null) child.kill('SIGTERM');
	}
}

/** Writes raw frames into an ffmpeg process (encoder / next stage) with back-pressure. */
export class RawWriter {
	private readonly err: () => string;
	constructor(readonly child: ChildProcess) {
		this.err = tail(child);
		// EPIPE when ffmpeg dies early is reported through `close()`.
		child.stdin?.on('error', () => {});
	}

	async write(buf: Uint8Array): Promise<void> {
		const stdin = this.child.stdin;
		if (!stdin || stdin.destroyed) throw new Error(`encoder is gone: ${this.err()}`);
		if (!stdin.write(buf)) {
			await new Promise<void>((resolve, reject) => {
				const onDrain = () => {
					cleanup();
					resolve();
				};
				const onClose = () => {
					cleanup();
					reject(new Error(`encoder exited: ${this.err()}`));
				};
				const cleanup = () => {
					stdin.off('drain', onDrain);
					this.child.off('close', onClose);
				};
				stdin.once('drain', onDrain);
				this.child.once('close', onClose);
			});
		}
	}

	async close(): Promise<void> {
		this.child.stdin?.end();
		const code = await exitOf(this.child);
		if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${this.err()}`);
	}
}

/** Helper: a Uint16Array view (little-endian hosts) over a raw rgb48le buffer without copying. */
export function u16(buf: Buffer): Uint16Array {
	if (buf.byteOffset % 2 === 0) return new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2);
	return new Uint16Array(new Uint8Array(buf).buffer);
}
