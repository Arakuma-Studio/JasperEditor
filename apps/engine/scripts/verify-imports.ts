// imports workstream live check against a running engine (docs/wp-notes/imports.md "Verified"): registers the
// imports fixtures (`pnpm fixtures`), builds a 720p project with a Lottie animation, an SVG scaled 300 %, a PDF page,
// still formats (EXR, TGA with alpha, DPX, HEIF, JPEG XL, PSD flattened), an image sequence with a gap, interlaced and
// anamorphic footage and a premultiplied picture with Interpret Footage settings, exports it through the native (auto:
// native + layer bakes) AND the Remotion path, extracts frames and compares both paths with each other and with values
// computed from the fixtures. Usage:
//   pnpm exec tsx apps/engine/scripts/verify-imports.ts [--engine http://127.0.0.1:49401] [--out /tmp/verify-imports]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const ENGINE = opt('--engine', 'http://127.0.0.1:49401');
const OUT = resolve(opt('--out', '/tmp/verify-imports'));
const ROOT = resolve(import.meta.dirname, '../../..');
const FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`, 'ffmpeg');
const ONLY = opt('--only', '');
mkdirSync(OUT, { recursive: true });

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const r = await fetch(`${ENGINE}${path}`, {
		method,
		headers: { 'content-type': 'application/json', host: '127.0.0.1:47900' },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
	return JSON.parse(text) as T;
}

type Registered = { mediaKey: string; [k: string]: unknown };
async function register(file: string): Promise<Registered> {
	const r = await api<{ items: Registered[]; errors: unknown[] }>('POST', '/api/media/register', {
		projectId: 'prj_0000000000000001',
		paths: [join(ROOT, 'fixtures/media', file)],
	});
	if (!r.items[0]) throw new Error(`register ${file}: ${JSON.stringify(r.errors)}`);
	return r.items[0];
}

const ids = createCounterIdSource(7);
let doc: ProjectDocument = createEmptyProject({ ids, name: 'verify-imports', preset: 'hd-720p-30' });
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
function addMedia(m: Registered, extra: Record<string, unknown> = {}): string {
	const { mediaKey, browserPlayable: _b, ...rest } = m;
	const asset = {
		...rest,
		locators: [{ type: 'engine-store', engineId: 'local', key: mediaKey }],
		derivation: null,
		...extra,
	};
	return (tx([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
}
const place = (mediaId: string, at: number, frames: number, track: string, scaling = 'none') =>
	(
		tx([
			{
				type: 'clip.place',
				source: { mediaId },
				at,
				tracks: { video: track },
				video: true,
				audio: false,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: frames } },
				matchSequence: 'keep',
				scaling,
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

async function exportWith(engine: 'auto' | 'remotion', name: string): Promise<string> {
	const envelope = makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'verify' });
	const settings = {
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		video: {
			codec: 'prores',
			proresProfile: '4444',
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
	const plan = await api<{ path: string; blockers: unknown[]; warnings: unknown[] }>('POST', '/api/exports/plan', {
		envelope,
		sequenceId: seqId,
		settings,
	});
	console.log(`${engine} plan: ${plan.path}, blockers ${JSON.stringify(plan.blockers)}, warnings ${JSON.stringify(plan.warnings)}`);
	const job = await api<{ id: string }>('POST', '/api/exports', { envelope, sequenceId: seqId, settings });
	const t0 = Date.now();
	const done = await waitJob(job.id);
	if (done.state !== 'succeeded') throw new Error(`${engine} export ${done.state}: ${done.error?.message}`);
	const file = join(OUT, `${name}.mov`);
	const r = await fetch(`${ENGINE}/renders/${job.id}/output`, { headers: { host: '127.0.0.1:47900' } });
	writeFileSync(file, Buffer.from(await r.arrayBuffer()));
	console.log(
		`${engine}: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${file} (${(done.result as { renderPath?: string })?.renderPath})`,
	);
	return file;
}

/** RGB24 pixels of frame `n` of a file. */
function frameRgb(file: string, n: number): Buffer {
	const r = spawnSync(FFMPEG, [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${n}),format=rgb24`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	return r.stdout;
}
function savePng(file: string, n: number, out: string) {
	spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', out]);
}
function meanDiff(a: Buffer, b: Buffer): { mean: number; over8: number } {
	let s = 0;
	let over = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const d = Math.abs(a[i]! - b[i]!);
		s += d;
		if (d > 8) over++;
	}
	return { mean: s / Math.max(1, n), over8: over / Math.max(1, n) };
}

async function main() {
	const sections: { name: string; at: number; frames: number }[] = [];
	let t = 0;
	const section = (name: string, frames: number) => {
		sections.push({ name, at: t, frames });
		t += frames;
		return sections[sections.length - 1]!;
	};
	const want = (name: string) => !ONLY || ONLY.split(',').includes(name);
	if (want('lottie')) {
		const s = section('lottie', 30);
		const m = addMedia(await register('imports-anim.json'));
		place(m, s.at, 30, 'V1');
	}
	if (want('vector')) {
		const s = section('vector', 20);
		const svg = addMedia(await register('imports-logo.svg'));
		const c = place(svg, s.at, 20, 'V1');
		tx([{ type: 'param.set', target: ['clip', c, 'transform', 'scale'], value: 300 }]);
		const pdf = await register('imports-doc.pdf');
		const pv = (pdf as { vector: Record<string, unknown> }).vector;
		const p2 = addMedia(pdf, { vector: { ...pv, page: 2, width: 300, height: 200 } });
		const pc = place(p2, s.at, 20, 'V2');
		tx([{ type: 'param.set', target: ['clip', pc, 'transform', 'position'], value: [1000, 560] }]);
	}
	if (want('stills')) {
		for (const f of ['imports-still.exr', 'imports-still.tga', 'imports-still.dpx', 'imports-layers.psd', 'imports-still.heic', 'imports-still.jxl']) {
			const s = section(f, 4);
			const m = addMedia(await register(f));
			place(m, s.at, 4, 'V1');
		}
	}
	if (want('sequence')) {
		const s = section('sequence', 12);
		const job = await api<{ id: string }>('POST', '/api/imports/image-sequence', {
			path: join(ROOT, 'fixtures/media/imports-seq/shot_0001.png'),
			frameRate: { num: 30, den: 1 },
		});
		const done = await waitJob(job.id);
		if (done.state !== 'succeeded') throw new Error(`sequence: ${done.error?.message}`);
		const m = addMedia(done.result as Registered);
		place(m, s.at, 12, 'V1');
	}
	if (want('sequence16')) {
		// 16-bit PNG frames (deep sequences are conformed to 16-bit RGB).
		const dir = join(OUT, 'seq16');
		mkdirSync(dir, { recursive: true });
		for (let n = 1; n <= 6; n++)
			spawnSync(FFMPEG, [
				...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${(n * 30).toString(16).padStart(2, '0')}60a0:size=160x90:duration=1`],
				...['-frames:v', '1', '-pix_fmt', 'rgb48be', join(dir, `deep_${n}.png`)],
			]);
		const s = section('sequence16', 6);
		const job = await api<{ id: string }>('POST', '/api/imports/image-sequence', {
			path: join(dir, 'deep_1.png'),
			frameRate: { num: 30, den: 1 },
		});
		const done = await waitJob(job.id);
		if (done.state !== 'succeeded') throw new Error(`sequence16: ${done.error?.message}`);
		const m = addMedia(done.result as Registered);
		place(m, s.at, 6, 'V1');
	}
	if (want('interlaced')) {
		const s = section('interlaced', 10);
		const m = addMedia(await register('imports-interlaced.mkv'));
		place(m, s.at, 10, 'V1');
	}
	if (want('anamorphic')) {
		const s = section('anamorphic', 6);
		const m = addMedia(await register('imports-anamorphic.mkv'));
		place(m, s.at, 6, 'V1');
	}
	if (want('premul')) {
		const s = section('premul', 4);
		const m = addMedia(await register('imports-premul.png'));
		tx([{ type: 'media.interpret', mediaIds: [m], interpretation: { alpha: { mode: 'premultiplied' } } }]);
		place(m, s.at, 4, 'V1');
	}
	if (want('conform')) {
		// 30 fps footage assumed 15 fps: half speed, every file frame shown twice.
		const s = section('conform', 12);
		const m = addMedia(await register('frame-code.mp4'));
		tx([{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: { num: 15, den: 1 } } }]);
		const c = place(m, s.at, 12, 'V1');
		void c;
	}
	console.log(sections.map((s) => `${s.name} ${s.at}–${s.at + s.frames - 1}`).join(', '));
	const native = await exportWith('auto', 'native');
	const remotion = await exportWith('remotion', 'remotion');
	for (const s of sections) {
		for (const k of [0, Math.floor(s.frames / 2), s.frames - 1]) {
			const n = s.at + k;
			const a = frameRgb(native, n);
			const b = frameRgb(remotion, n);
			const d = meanDiff(a, b);
			savePng(native, n, join(OUT, `${s.name}-${n}-native.png`));
			savePng(remotion, n, join(OUT, `${s.name}-${n}-remotion.png`));
			console.log(`${s.name} frame ${n}: native vs remotion mean |Δ| ${d.mean.toFixed(2)}, >8: ${(d.over8 * 100).toFixed(2)} %`);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
