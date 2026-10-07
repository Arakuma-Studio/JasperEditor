// audio-fx: the native audio mix as a file (WAV, f32) — the Remotion path's audio when the sequence has audio effects,
// pan or reversed audio, which Remotion cannot render (planner: `audio.mode = 'native-mix'`). Same graph and DSP
// streams as the native composite (graph.ts, stream.ts).
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { terminateTree } from '../../tools/process.ts';
import type { LocalMedia, PlannedExport } from '../planner.ts';
import { buildAudioMix } from './graph.ts';
import { SAMPLE_RATE } from './plan.ts';
import { streamAudioClip } from './stream.ts';

/** ffmpeg arguments (and DSP streams) that write the export's audio mix to `file` (WAV, 32-bit float). */
export function audioMixArgs(planned: Pick<PlannedExport, 'snapshot' | 'output' | 'media'>, file: string) {
	const inputs: string[][] = [];
	const mix = buildAudioMix({
		snapshot: planned.snapshot,
		durationSec: planned.output.durationSec,
		audioChannels: planned.output.audioChannels,
		media: (id): LocalMedia | null => planned.media[id] ?? null,
		addInput: (args) => {
			inputs.push(args);
			return inputs.length - 1;
		},
		firstFd: 3,
	});
	const args = [
		...inputs.flat(),
		'-filter_complex',
		mix.chains.join(';\n'),
		'-map',
		'[aout]',
		'-c:a',
		'pcm_f32le',
		'-ar',
		String(SAMPLE_RATE),
		'-ac',
		String(planned.output.audioChannels),
		'-f',
		'wav',
		file,
	];
	return { args, streams: mix.streams };
}

/** Renders the mix to `file`; `onProgress` gets 0…1. */
export async function renderAudioMix(
	ff: Ffmpeg,
	planned: Pick<PlannedExport, 'snapshot' | 'output' | 'media'>,
	file: string,
	opts: {
		signal: AbortSignal;
		onSpawn?(child: ChildProcess): void;
		onProgress?(fraction: number): void;
		log?(line: string): void;
	},
): Promise<void> {
	const { args, streams } = audioMixArgs(planned, file);
	opts.log?.(`ffmpeg ${args.join(' ')}`);
	const abort = new AbortController();
	const onJobAbort = () => abort.abort();
	opts.signal.addEventListener('abort', onJobAbort, { once: true });
	const producers: Promise<void>[] = [];
	let streamError: Error | null = null;
	const total = planned.output.durationSec;
	try {
		await ff.run(args, {
			signal: opts.signal,
			...(streams.length > 0 ? { pipes: streams.length } : {}),
			onSpawn: (child) => {
				opts.onSpawn?.(child);
				for (const s of streams) {
					producers.push(
						streamAudioClip(ff, s.plan, child.stdio[s.fd] as Writable, {
							signal: abort.signal,
							...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
						}).catch((e: Error) => {
							if (abort.signal.aborted) return;
							streamError ??= e;
							void terminateTree(child, 500);
						}),
					);
				}
			},
			onProgress: (p) => {
				if (total > 0) opts.onProgress?.(Math.min(1, p.outTimeUs / 1e6 / total));
			},
		});
	} catch (e) {
		abort.abort();
		await Promise.all(producers);
		throw streamError ?? e;
	} finally {
		opts.signal.removeEventListener('abort', onJobAbort);
	}
	abort.abort();
	await Promise.all(producers);
	if (streamError) throw streamError;
}
