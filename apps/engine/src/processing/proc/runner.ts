// The jasper-proc step runner (S07:PRC-011…014). Steps are grouped into chains:
//
//   decode (ffmpeg: accurate seek, explicit BT.709 conversion, leading filter steps fused)
//     → frame steps (rgb48le through pipes; filter steps between them run as ffmpeg raw→raw processes)
//     → encoder (ffmpeg: trailing filter steps fused, ProRes 422 HQ / 4444, BT.709 tags, audio copied)
//
// A frame step with an analysis pass (vid.stab) that is not first in its chain splits the chain: everything
// before it is written to a lossless FFV1 (gbrp16le) intermediate in the scratch directory, which the step
// then analyses and reads. A recipe of filter steps only runs in one ffmpeg process.
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { sha256File } from '../../tools/fs.ts';
import {
	children,
	decodeFrames,
	exitOf,
	frameBytes,
	killChildren,
	RawWriter,
	spawnFfmpeg,
	u16,
} from './ffio.ts';
import { assertLgplFilters, fromFormatToRgb48, toFormat } from './filters.ts';
import { countFrames, probeInput } from './probe.ts';
import { PROC_NAME, PROC_VERSION, RECIPE_VERSION, recipeHash } from './recipe.ts';
import type {
	DecodeSpec,
	FilterStep,
	FrameStep,
	ProcEvent,
	ProcSpec,
	Rational,
	RgbFrame,
	StepContext,
	StepImpl,
} from './types.ts';

export class ProcError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type StepFactory = (step: ProcessStep, env: StepEnv) => Promise<StepImpl> | StepImpl;

/** What the factory may know about the runtime (capabilities of the ffmpeg in use). */
export type StepEnv = { ffmpeg: string; spec: ProcSpec; filters: ReadonlySet<string> };

export type RunResult = {
	frames: number;
	width: number;
	height: number;
	fps: Rational;
	notes: string[];
	sidecar: string;
	sidecarData: Sidecar;
};

type Sidecar = {
	name: string;
	version: string;
	recipeVersion: number;
	recipeHash: string;
	input: {
		path: string;
		frames: number;
		width: number;
		height: number;
		fps: string;
		range: [number, number];
	};
	output: {
		path: string;
		frames: number;
		width: number;
		height: number;
		codec: string;
		sha256: string;
		bytes: number;
	};
	steps: Array<{ op: string; name: string; info: Record<string, unknown>; seconds: number }>;
	notes: string[];
	models: Array<{ id: string; sha256: string }>;
	device: 'cpu' | 'cuda';
	threads: number;
	timings: { totalSeconds: number };
	createdAt: string;
};

type StageInfo = { name: string; op: string; info: Record<string, unknown>; seconds: number };

const fpsText = (r: Rational) => `${r.num}/${r.den}`;

/** Filters of the LGPL build (`ffmpeg -filters`), used to pick vid.stab native vs WASM and for guards. */
export async function listFilters(ffmpeg: string): Promise<Set<string>> {
	const child = spawnFfmpeg(ffmpeg, ['-filters']);
	let out = '';
	child.stdout?.on('data', (d: Buffer) => {
		out += d.toString();
	});
	await exitOf(child);
	const set = new Set<string>();
	for (const line of out.split('\n')) {
		const m = /^\s*[A-Z.|]{2,4}\s+(\S+)\s+\S+->\S+/.exec(line);
		if (m) set.add(m[1]);
	}
	return set;
}

/** An ffmpeg filter step run between frame steps: raw rgb48le in → filter → raw rgb48le out. */
export function filterAdapter(
	step: FilterStep,
	ffmpeg: string,
	opts: { allowVidstab?: boolean } = {},
): FrameStep {
	let child: ReturnType<typeof spawnFfmpeg> | null = null;
	let writer: RawWriter | null = null;
	const queue: RgbFrame[] = [];
	let outSize = { width: 0, height: 0 };
	let pending: Buffer[] = [];
	let pendingLen = 0;
	let nextIndex = 0;
	let done: Promise<void> = Promise.resolve();
	return {
		name: step.name,
		async open(ctx) {
			outSize = { width: ctx.width, height: ctx.height };
			const vf = `${toFormat(step.format)},${step.filter(ctx)},${fromFormatToRgb48(step.format)}`;
			assertLgplFilters(vf, opts);
			child = spawnFfmpeg(
				ffmpeg,
				[
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgb48le',
					'-s',
					`${ctx.width}x${ctx.height}`,
					'-r',
					fpsText(ctx.fps),
					'-i',
					'-',
					'-vf',
					vf,
					'-fps_mode',
					'passthrough',
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgb48le',
					'-',
				],
				'pipe',
			);
			writer = new RawWriter(child);
			const size = frameBytes('rgb48le', outSize.width, outSize.height);
			const c = child;
			done = new Promise<void>((resolve) => {
				c.stdout?.on('data', (chunk: Buffer) => {
					pending.push(chunk);
					pendingLen += chunk.length;
					if (pendingLen < size) return;
					let all = Buffer.concat(pending, pendingLen);
					while (all.length >= size) {
						const buf = Buffer.from(all.subarray(0, size));
						queue.push({ index: nextIndex++, width: outSize.width, height: outSize.height, data: u16(buf) });
						all = all.subarray(size);
					}
					pending = all.length ? [all] : [];
					pendingLen = all.length;
				});
				c.stdout?.on('end', () => resolve());
			});
			return outSize;
		},
		async push(frame) {
			if (!writer) throw new Error('filter adapter not opened');
			await writer.write(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
			return queue.splice(0);
		},
		async end() {
			if (!writer) return [];
			await writer.close();
			await done;
			return queue.splice(0);
		},
	};
}

type Stage =
	| { kind: 'filter'; index: number; op: string; step: FilterStep }
	| { kind: 'frames'; index: number; op: string; step: FrameStep };

export type RunOptions = {
	emit(e: ProcEvent): void;
	signal: AbortSignal;
	createStep: StepFactory;
};

export async function runProc(spec: ProcSpec, opts: RunOptions): Promise<RunResult> {
	const t0 = performance.now();
	const { emit, signal } = opts;
	const probe = await probeInput(spec.ffprobe, spec.input);
	const start = spec.range?.startFrame ?? 0;
	const end = spec.range?.endFrame ?? probe.frames;
	if (!(end > start) || end > probe.frames || start < 0)
		throw new ProcError('INVALID_RANGE', `range ${start}..${end} outside 0..${probe.frames}`);
	const frames = end - start;
	const fps = probe.fps;
	const geometric = spec.steps.some((s) => s.op === 'stabilize' || s.op === 'dejudder' || s.op === 'upscale');
	if (probe.hasAlpha && geometric)
		throw new ProcError(
			'ALPHA_UNSUPPORTED',
			'sources with alpha can only be denoised or deblocked (stabilise, de-judder and upscale need an opaque source)',
		);
	const filters = await listFilters(spec.ffmpeg);
	const env: StepEnv = { ffmpeg: spec.ffmpeg, spec, filters };
	const stages: Stage[] = [];
	for (const [i, s] of spec.steps.entries()) {
		const impl = await opts.createStep(s, env);
		stages.push({ ...impl, index: i, op: s.op });
	}
	emit({ event: 'start', frames, steps: stages.map((s) => s.step.name) });

	const notes: string[] = [];
	const infos: StageInfo[] = stages.map((s) => ({
		name: s.step.name,
		op: s.op,
		info: {},
		seconds: 0,
	}));
	const seekArgs =
		start > 0
			? ['-ss', (((start - 0.5) * fps.den) / fps.num).toFixed(6), '-i', spec.input]
			: ['-i', spec.input];
	let source: DecodeSpec = {
		ffmpeg: spec.ffmpeg,
		inputArgs: seekArgs,
		frames,
		width: probe.width,
		height: probe.height,
		fps,
		matrix: probe.pixFmt.startsWith('yuv') || probe.pixFmt.startsWith('nv') ? probe.matrix : undefined,
		range: probe.range,
	};
	if (/^(yuvj)/.test(probe.pixFmt)) source.range = 'pc';

	const ctxFor = (stage: Stage, geom: { width: number; height: number }): StepContext => ({
		ffmpeg: spec.ffmpeg,
		ffprobe: spec.ffprobe,
		threads: spec.threads,
		device: spec.device,
		scratch: spec.scratch,
		width: geom.width,
		height: geom.height,
		frames,
		fps,
		models: spec.models,
		signal,
		note: (message) => {
			notes.push(message);
			emit({ event: 'note', message });
		},
		info: (key, value) => {
			infos[stage.index].info[key] = value;
		},
		analysisProgress: (f) =>
			emit({
				event: 'progress',
				step: stage.index,
				stage: `${stage.step.name}: analysis`,
				done: Math.round(f * frames),
				total: frames,
			}),
	});

	const checkAbort = () => {
		if (signal.aborted) throw new ProcError('CANCELLED', 'cancelled');
	};

	/** Leading filter stages fused into a decode spec (the stream is then full-range BT.709). */
	const fuse = (src: DecodeSpec, filtersIn: Stage[]): DecodeSpec => {
		if (!filtersIn.length) return src;
		const parts: string[] = src.vf ? [src.vf] : [];
		const geom = { width: src.width, height: src.height };
		let matrix = src.matrix;
		let range = src.range;
		for (const st of filtersIn) {
			const f = st.step as FilterStep;
			const ctx = ctxFor(st, geom);
			const rgb = f.format === 'rgb48le' || f.format === 'gbrp16le';
			parts.push(toFormat(f.format, matrix, range));
			parts.push(f.filter(ctx));
			matrix = rgb ? undefined : 'bt709';
			range = rgb ? undefined : 'pc';
		}
		const vf = parts.join(',');
		assertLgplFilters(vf);
		return { ...src, vf, width: geom.width, height: geom.height, matrix, range };
	};

	/** One source frame at absolute index `abs` decoded like `src` (null outside the file) — range context. */
	const rangeContextFrame = async (src: DecodeSpec, abs: number, rel: number): Promise<RgbFrame | null> => {
		if (abs < 0 || abs >= probe.frames) return null;
		const inputArgs =
			abs > 0
				? ['-ss', (((abs - 0.5) * fps.den) / fps.num).toFixed(6), '-i', spec.input]
				: ['-i', spec.input];
		let got: RgbFrame | null = null;
		for await (const buf of decodeFrames({ ...src, inputArgs, frames: 1 }, { pixFmt: 'rgb48le', signal }))
			got ??= { index: rel, width: src.width, height: src.height, data: u16(buf) };
		return got;
	};
	/** True while the chain reads the source file itself (not an FFV1 intermediate). */
	let onSource = true;

	const alpha = probe.hasAlpha;
	const encodeArgs = (): string[] => {
		const audio =
			probe.audioStreams > 0
				? spec.range
					? ['-map', '1:a?', '-c:a', 'pcm_s24le']
					: ['-map', '1:a?', '-c:a', 'copy']
				: [];
		return [
			...audio,
			'-c:v',
			'prores_ks',
			'-profile:v',
			alpha ? '4' : '3',
			'-vendor',
			'apl0',
			...(alpha ? [] : ['-quant_mat', 'hq']),
			'-pix_fmt',
			alpha ? 'yuva444p12le' : 'yuv422p10le',
			'-color_primaries',
			'bt709',
			'-color_trc',
			'bt709',
			'-colorspace',
			'bt709',
			'-color_range',
			'tv',
			'-movflags',
			'+write_colr',
			'-fps_mode',
			'passthrough',
			// A range is cut here (and the PCM audio by -t on its input); a whole file ends at the input's EOF so
			// the copied audio is never truncated by an early stop of the muxer.
			...(spec.range ? ['-frames:v', String(frames)] : []),
			'-metadata',
			`comment=${PROC_NAME} ${PROC_VERSION} recipe ${recipeHash(spec.steps, RECIPE_VERSION, spec.range ?? null).slice(0, 16)}`,
			'-y',
			spec.output,
		];
	};
	const audioInput =
		probe.audioStreams > 0
			? spec.range
				? [...seekArgs.slice(0, -2), '-t', ((frames * fps.den) / fps.num).toFixed(6), ...seekArgs.slice(-2)]
				: seekArgs
			: [];
	const toProres = (fmtFrom: 'rgb' | 'yuv') =>
		`scale=${fmtFrom === 'yuv' ? 'in_color_matrix=bt709:in_range=pc:' : ''}out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp+lanczos,format=${alpha ? 'yuva444p12le' : 'yuv422p10le'},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;

	let outW = probe.width;
	let outH = probe.height;
	let pos = 0;
	let intermediateCount = 0;
	const tmpFiles: string[] = [];

	const onlyFilters = stages.every((s) => s.kind === 'filter');
	if (onlyFilters) {
		// One ffmpeg process: decode → filters → ProRes (PRC-012).
		const fused = fuse(source, stages);
		outW = fused.width;
		outH = fused.height;
		const tf = performance.now();
		const vfColor = fused.vf ? `${fused.vf},${toProres(fused.matrix ? 'yuv' : 'rgb')}` : toProres('rgb');
		let graph: string;
		if (alpha) {
			graph = `[0:v]split[c][a];[a]alphaextract[al];[c]${vfColor.replace(/yuva444p12le/, 'yuv444p12le')}[f];[f][al]alphamerge,format=yuva444p12le[v]`;
		} else graph = `[0:v]${vfColor}[v]`;
		assertLgplFilters(graph);
		const args = [
			...seekArgs,
			...(audioInput.length ? audioInput : []),
			'-filter_complex',
			graph,
			'-map',
			'[v]',
			...encodeArgs(),
			'-progress',
			'pipe:1',
		];
		const child = spawnFfmpeg(spec.ffmpeg, args);
		let err = '';
		child.stderr?.on('data', (d: Buffer) => {
			err = (err + d.toString()).slice(-4000);
		});
		child.stdout?.on('data', (d: Buffer) => {
			const m = /frame=(\d+)/g;
			let last: RegExpExecArray | null = null;
			for (let x = m.exec(d.toString()); x; x = m.exec(d.toString())) last = x;
			if (last) {
				const written = Number(last[1]);
				emit({ event: 'progress', step: stages.length - 1, stage: 'filters', done: written, total: frames });
			}
		});
		const onAbort = () => killChildren('SIGTERM');
		signal.addEventListener('abort', onAbort, { once: true });
		const code = await exitOf(child);
		signal.removeEventListener('abort', onAbort);
		checkAbort();
		if (code !== 0) throw new ProcError('FFMPEG_FAILED', `ffmpeg failed (${code}): ${err.trim()}`);
		const secs = (performance.now() - tf) / 1000;
		for (const i of infos) i.seconds = Math.round((secs / infos.length) * 1000) / 1000;
	} else {
		while (pos < stages.length) {
			checkAbort();
			// 1. Leading filters fuse into the decode.
			const lead: Stage[] = [];
			while (pos < stages.length && stages[pos].kind === 'filter') lead.push(stages[pos++]);
			source = fuse(source, lead);
			// (Only filters left after an intermediate: the chain below is empty and decode+filters feed the encoder.)
			// 2. The chain: frame stages (+ filters between them) up to the next analysing frame stage.
			const chain: Stage[] = [];
			let q = pos;
			while (q < stages.length) {
				const st = stages[q];
				if (st.kind === 'frames' && st.step.analyse && chain.some((c) => c.kind === 'frames')) break;
				chain.push(st);
				q++;
			}
			const last = q >= stages.length;
			// Trailing filters before a split belong to the next decode (fused there).
			if (!last) while (chain.length && chain[chain.length - 1].kind === 'filter') chain.pop();
			pos += chain.length;
			const tailFilters: Stage[] = [];
			if (last)
				while (chain.length && chain[chain.length - 1].kind === 'filter')
					tailFilters.unshift(chain.pop() as Stage);

			// 3. Analysis of the first frame stage.
			const first = chain[0];
			if (first && first.kind === 'frames' && first.step.analyse) {
				const ta = performance.now();
				await first.step.analyse(source, ctxFor(first, source));
				infos[first.index].seconds += (performance.now() - ta) / 1000;
				checkAbort();
			}
			// 3b. PST-013 (M3): a de-judder working directly on a source RANGE reads its edge neighbours from the
			// source (the frame before / after the range, through the same fused head filters) instead of copying
			// the edge frames. Used for the flow only, never emitted.
			if (
				spec.range &&
				onSource &&
				first?.kind === 'frames' &&
				'setRangeContext' in first.step &&
				typeof first.step.setRangeContext === 'function'
			) {
				const src = source;
				(
					first.step as unknown as { setRangeContext(f: (rel: number) => Promise<RgbFrame | null>): void }
				).setRangeContext((rel) => rangeContextFrame(src, start + rel, rel));
			}
			// 4. Open the stages (geometry propagates).
			const runners: Array<{ stage: Stage; step: FrameStep; count: number }> = [];
			let geom = { width: source.width, height: source.height };
			for (const st of chain) {
				const step = st.kind === 'frames' ? st.step : filterAdapter(st.step, spec.ffmpeg);
				const g = await step.open(ctxFor(st, geom));
				runners.push({ stage: st, step, count: 0 });
				geom = g;
			}
			// 5. The sink: encoder (last chain) or FFV1 intermediate.
			let sinkArgs: string[];
			let sinkPath: string;
			if (last) {
				let vf = '';
				let fmtFrom: 'rgb' | 'yuv' = 'rgb';
				const parts: string[] = [];
				for (const st of tailFilters) {
					const f = st.step as FilterStep;
					const ctx = ctxFor(st, geom);
					parts.push(toFormat(f.format), f.filter(ctx));
					fmtFrom = f.format === 'rgb48le' || f.format === 'gbrp16le' ? 'rgb' : 'yuv';
				}
				parts.push(toProres(fmtFrom));
				vf = parts.join(',');
				assertLgplFilters(vf);
				outW = geom.width;
				outH = geom.height;
				sinkPath = spec.output;
				sinkArgs = [
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgb48le',
					'-s',
					`${geom.width}x${geom.height}`,
					'-r',
					fpsText(fps),
					'-i',
					'-',
					...audioInput,
					'-map',
					'0:v',
					'-vf',
					vf,
					...encodeArgs(),
				];
			} else {
				sinkPath = join(spec.scratch, `intermediate-${intermediateCount++}.mkv`);
				tmpFiles.push(sinkPath);
				sinkArgs = [
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgb48le',
					'-s',
					`${geom.width}x${geom.height}`,
					'-r',
					fpsText(fps),
					'-i',
					'-',
					'-c:v',
					'ffv1',
					'-level',
					'3',
					'-g',
					'1',
					'-slices',
					'4',
					'-pix_fmt',
					'gbrp16le',
					'-fps_mode',
					'passthrough',
					'-y',
					sinkPath,
				];
			}
			const sink = new RawWriter(spawnFfmpeg(spec.ffmpeg, sinkArgs, 'pipe'));
			const onAbort = () => killChildren('SIGTERM');
			signal.addEventListener('abort', onAbort, { once: true });
			let sunk = 0;
			let lastEmit = 0;
			const report = (force = false) => {
				const now = performance.now();
				if (!force && now - lastEmit < 250) return;
				lastEmit = now;
				for (const r of runners)
					emit({ event: 'progress', step: r.stage.index, stage: r.step.name, done: r.count, total: frames });
				if (!runners.length)
					emit({ event: 'progress', step: stages.length - 1, stage: 'encode', done: sunk, total: frames });
			};
			const flow = async (from: number, framesIn: RgbFrame[]): Promise<void> => {
				let cur = framesIn;
				for (let k = from; k < runners.length && cur.length; k++) {
					const r = runners[k];
					const next: RgbFrame[] = [];
					for (const f of cur) {
						const t = performance.now();
						const out = await r.step.push(f);
						infos[r.stage.index].seconds += (performance.now() - t) / 1000;
						r.count += out.length;
						next.push(...out);
					}
					cur = next;
				}
				for (const f of cur) {
					await sink.write(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
					sunk++;
				}
				report();
			};
			try {
				let index = 0;
				for await (const buf of decodeFrames(source, { pixFmt: 'rgb48le', signal })) {
					checkAbort();
					await flow(0, [{ index: index++, width: source.width, height: source.height, data: u16(buf) }]);
				}
				if (index !== frames)
					throw new ProcError('FRAME_COUNT_MISMATCH', `decoded ${index} frames, expected ${frames}`);
				for (let k = 0; k < runners.length; k++) {
					const t = performance.now();
					const out = await runners[k].step.end();
					infos[runners[k].stage.index].seconds += (performance.now() - t) / 1000;
					runners[k].count += out.length;
					await flow(k + 1, out);
				}
				await sink.close();
			} finally {
				signal.removeEventListener('abort', onAbort);
				for (const r of runners) await r.step.close?.();
			}
			checkAbort();
			report(true);
			for (const r of runners)
				if (r.count !== frames)
					throw new ProcError(
						'FRAME_COUNT_MISMATCH',
						`step ${r.step.name} produced ${r.count} frames for ${frames} input frames`,
					);
			if (sunk !== frames)
				throw new ProcError('FRAME_COUNT_MISMATCH', `wrote ${sunk} frames, expected ${frames}`);
			if (!last) {
				onSource = false;
				source = {
					ffmpeg: spec.ffmpeg,
					inputArgs: ['-i', sinkPath],
					frames,
					width: geom.width,
					height: geom.height,
					fps,
				};
			} else break;
		}
	}
	for (const f of tmpFiles) rmSync(f, { force: true });

	// Verify (PRC-013).
	const got = await countFrames(spec.ffprobe, spec.output);
	if (got !== frames)
		throw new ProcError('FRAME_COUNT_MISMATCH', `output has ${got} frames, expected ${frames}`);
	const sidecarPath = `${spec.output}.json`;
	const modelsUsed = spec.steps
		.filter((s): s is Extract<ProcessStep, { op: 'upscale' }> => s.op === 'upscale')
		.map((s) => ({ id: s.model, sha256: spec.models[s.model]?.sha256 ?? '' }));
	const sidecar: Sidecar = {
		name: PROC_NAME,
		version: PROC_VERSION,
		recipeVersion: RECIPE_VERSION,
		recipeHash: recipeHash(spec.steps, RECIPE_VERSION, spec.range ?? null),
		input: {
			path: spec.input,
			frames: probe.frames,
			width: probe.width,
			height: probe.height,
			fps: fpsText(fps),
			range: [start, end],
		},
		output: {
			path: spec.output,
			frames: got,
			width: outW,
			height: outH,
			codec: alpha ? 'prores 4444' : 'prores 422 hq',
			sha256: await sha256File(spec.output),
			bytes: statSync(spec.output).size,
		},
		steps: infos.map((i) => ({
			op: i.op,
			name: i.name,
			info: i.info,
			seconds: Math.round(i.seconds * 1000) / 1000,
		})),
		notes,
		models: modelsUsed,
		device: spec.device,
		threads: spec.threads,
		timings: { totalSeconds: Math.round((performance.now() - t0) / 10) / 100 },
		createdAt: new Date().toISOString(),
	};
	writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
	return { frames, width: outW, height: outH, fps, notes, sidecar: sidecarPath, sidecarData: sidecar };
}

export function cleanupPartial(spec: ProcSpec): void {
	killChildren('SIGKILL');
	children.clear();
	rmSync(spec.output, { force: true });
	rmSync(`${spec.output}.json`, { force: true });
}
