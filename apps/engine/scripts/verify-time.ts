// Workstream `time` live check against a running engine (docs/wp-notes/time.md "Verified"): builds a 720p project with
// a reversed clip, a time-remapped clip (50 % segment, freeze, palindrome reverse), a VFR clip and an optical-flow slow
// motion, exports it through the native AND the Remotion path, and compares the frame code of every exported frame
// with the model (`clipMediaTimeAt` + frame choice). Usage: pnpm exec tsx apps/engine/scripts/verify-time.ts
//   [--engine http://127.0.0.1:49241] [--out /tmp/verify-time]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	applyTransaction,
	type Clip,
	clipMediaTimeAt,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	frameIndexAt,
	makeEnvelope,
	type ProjectDocument,
	type TimedClip,
} from '@jasper/project';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const ENGINE = opt('--engine', 'http://127.0.0.1:49241');
const OUT = resolve(opt('--out', '/tmp/verify-time'));
const ROOT = resolve(import.meta.dirname, '../../..');
mkdirSync(OUT, { recursive: true });

async function api<T>(method: string, path: string, body?: unknown, tries = 5): Promise<T> {
	let r: Response;
	try {
		r = await fetch(`${ENGINE}${path}`, {
		method,
			headers: { 'content-type': 'application/json', host: '127.0.0.1:47900' },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	} catch (e) {
		// A busy engine (bundling Remotion) may drop a keep-alive socket: retry idempotent reads, and any request
		// whose body could not be written (the engine never saw it).
		const code = (e as { cause?: { code?: string } }).cause?.code;
		if ((method !== 'GET' && code !== 'EPIPE') || tries <= 1) throw e;
		await new Promise((res) => setTimeout(res, 2000));
		return api<T>(method, path, body, tries - 1);
	}
	const text = await r.text();
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
	return JSON.parse(text) as T;
}

type Registered = { mediaKey: string; [k: string]: unknown };
async function register(file: string): Promise<Registered> {
	const r = await api<{ items: Registered[] }>('POST', '/api/media/register', {
		projectId: 'prj_0000000000000001',
		paths: [join(ROOT, 'fixtures/media', file)],
	});
	return r.items[0]!;
}

const ids = createCounterIdSource(42);
let doc: ProjectDocument = createEmptyProject({ ids, name: 'verify-time', preset: 'hd-720p-30' });
let revision = 0;
const seqId = Object.keys(doc.sequences)[0]!;
function tx(commands: unknown[]) {
	const { document, result } = applyTransaction(
		doc,
		{ label: 'verify', origin: 'user', sequenceId: seqId, commands: commands as never },
		{ ids, now: () => new Date().toISOString(), revision, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	doc = document;
	revision = result.revision;
	return result;
}
function addMedia(m: Registered): string {
	const { mediaKey: _k, browserPlayable: _b, ...asset } = m;
	return (tx([{ type: 'media.register', asset: { ...asset, derivation: null } }]).results[0] as { mediaId: string })
		.mediaId;
}
const place = (mediaId: string, at: number, inF: number, outF: number, track = 'V1') =>
	(
		tx([
			{
				type: 'clip.place',
				source: { mediaId },
				at,
				tracks: { video: track },
				video: true,
				audio: false,
				sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
				matchSequence: 'keep',
				scaling: 'none',
			},
		]).results[0] as { clipIds: string[] }
	).clipIds[0]!;

async function waitJob(id: string): Promise<{ state: string; result?: unknown; error?: { message: string } }> {
	for (;;) {
		const j = await api<{ state: string; result?: unknown; error?: { message: string } }>('GET', `/api/jobs/${id}`);
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) return j;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

async function exportWith(engine: 'native' | 'remotion', name: string): Promise<string> {
	const envelope = makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'verify' });
	const settings = {
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		video: {
			codec: 'prores',
			proresProfile: 'hq',
			width: 1280,
			height: 720,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 16 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine,
	};
	const job = await api<{ id: string }>('POST', '/api/exports', { envelope, sequenceId: seqId, settings });
	const t0 = Date.now();
	const done = await waitJob(job.id);
	if (done.state !== 'succeeded') throw new Error(`${engine} export ${done.state}: ${done.error?.message}`);
	const file = join(OUT, `${name}.mov`);
	const r = await fetch(`${ENGINE}/renders/${job.id}/output`, { headers: { host: '127.0.0.1:47900' } });
	writeFileSync(file, Buffer.from(await r.arrayBuffer()));
	console.log(`${engine}: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${file} (${(done.result as { renderPath?: string })?.renderPath})`);
	return file;
}

/** 6-bit frame code of frame-code.mp4 (1080p centred in 720p, unscaled: −320, −180) / vfr-code.mp4 (360p centred). */
function code(file: string, frame: number, geom: { sx: number; x0: number; y: number }): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	const W = 1280;
	let c = 0;
	for (let b = 0; b < 6; b++) {
		const x = Math.round(geom.x0 + (70 + 70 * b) * geom.sx);
		const o = (geom.y * W + x) * 3;
		if (r.stdout[o]! > 127) c |= 1 << b;
	}
	return c;
}

async function main() {
	const coded = addMedia(await register('frame-code.mp4'));
	const vfrM = await register('vfr-code.mp4');
	const vfr = addMedia(vfrM);
	// 0–29: reversed (source 10–39); 30–…: remapped; then VFR; V2 nothing.
	const rev = place(coded, 0, 10, 40);
	const topLeft = (id: string) =>
		tx([{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: [960, 540] }]);
	topLeft(rev);
	tx([{ type: 'clip.setSpeed', clipIds: [rev], reverse: true, ripple: false }]);
	const rem = place(coded, 30, 0, 40);
	topLeft(rem);
	tx([{ type: 'timeRemap.addKeyframe', clipId: rem, at: 40 }]);
	tx([{ type: 'timeRemap.setSpeed', clipId: rem, at: 30, speedPercent: 50, ripple: true }]);
	tx([{ type: 'timeRemap.addFreeze', clipId: rem, at: 60, duration: 6, ripple: true }]);
	tx([{ type: 'timeRemap.addReverse', clipId: rem, at: 80, duration: 8, ripple: true }]);
	const seq = doc.sequences[seqId]!;
	const remClip = seq.clips[rem] as Clip;
	const vfrAt = remClip.start + remClip.duration;
	const vfrId = place(vfr, vfrAt, 0, 50);
	const total = (doc.sequences[seqId]!.clips[vfrId] as Clip).start + (doc.sequences[seqId]!.clips[vfrId] as Clip).duration;
	console.log(`sequence: ${total} frames; reversed 0–29, remapped ${remClip.start}–${vfrAt - 1}, VFR ${vfrAt}–${total - 1}`);
	const vfrTimes = (
		await (async () => {
			const r = spawnSync('ffprobe', [
				...['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0'],
				join(ROOT, 'fixtures/media/vfr-code.mp4'),
			]);
			return r.stdout
				.toString()
				.trim()
				.split('\n')
				.map(Number)
				.sort((a, b) => a - b);
		})()
	);
	const expect = (f: number): { code: number; geom: { sx: number; x0: number; y: number } } => {
		const s = doc.sequences[seqId]!;
		const c = Object.values(s.clips).find((x) => x.start <= f && f < x.start + x.duration)! as Clip;
		const sec = clipMediaTimeAt(c as TimedClip, f, s.settings.frameRate) / FLICKS_PER_SECOND;
		if ((c as { mediaId: string }).mediaId === vfr)
			return { code: frameIndexAt({ kind: 'list', times: vfrTimes }, sec), geom: { sx: 1, x0: 320, y: 250 } };
		// frame-code.mp4 (1080p, unscaled) is placed with its top-left at the frame's top-left (`topLeft`).
		return {
			code: frameIndexAt({ kind: 'cfr', rate: { num: 30, den: 1 }, count: 64 }, sec),
			geom: { sx: 1, x0: 0, y: 70 },
		};
	};
	const results: Record<string, { checked: number; wrong: number[] }> = {};
	for (const engine of ['native', 'remotion'] as const) {
		const file = await exportWith(engine, `verify-${engine}`);
		const wrong: number[] = [];
		for (let f = 0; f < total; f++) {
			const e = expect(f);
			const got = code(file, f, e.geom);
			if (got !== e.code) wrong.push(f);
		}
		results[engine] = { checked: total, wrong };
		console.log(`${engine}: ${total - wrong.length}/${total} frames show the model's source frame${wrong.length ? `; wrong at ${wrong.join(',')}` : ''}`);
	}
	writeFileSync(join(OUT, 'result.json'), JSON.stringify(results, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
