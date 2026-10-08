// Robustness of the engine's file and child-process readers (golden-fuzz; docs/testing.md §Fuzzing): ZIP archives
// (imports and motion-graphics bundles), dotLottie / Lottie JSON files, Photoshop documents, ffprobe JSON, bundle
// manifests and package.json files, upload names, the runtime file and engine events. Every input either reads or
// fails with the reader's typed error; extraction never writes outside its destination.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseEvent } from '@jasper/api';
import { parseEngineRuntime } from '@jasper/config';
import { MediaProbeSchema } from '@jasper/project';
import { bytesTarget, describeFuzz, jsonTarget, textTarget } from '@jasper/testkit/fuzz';
import { afterAll } from 'vitest';
import { makePsd } from '../../../scripts/fixtures/imports.mjs';
import { loadLottieFile } from '../src/imports/lottie.ts';
import { readPsdFile } from '../src/imports/psd.ts';
import { listZip, readZipEntry, writeStoredZip, ZipError } from '../src/imports/zip.ts';
import { JobError } from '../src/jobs/types.ts';
import { mapProbe } from '../src/media/probe.ts';
import { MgBundleError, readProjectPackage } from '../src/mg-bundles/project.ts';
import { readManifest } from '../src/mg-bundles/schemas.ts';
import { ZipError as BundleZipError, extractZip } from '../src/mg-bundles/zip.ts';
import { safeFileName } from '../src/tools/fs.ts';
import { ToolError } from '../src/tools/process.ts';

const work = mkdtempSync(join(tmpdir(), 'engine-fuzz-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
/** A fresh file holding `data` (a new name each call: readers may cache by path). */
function tempFile(data: Uint8Array | string, ext: string): string {
	const f = join(work, `in-${n++}${ext}`);
	writeFileSync(f, data);
	return f;
}
function tempDir(): string {
	const d = join(work, `d-${n++}`);
	mkdirSync(d);
	return d;
}

const LOTTIE = JSON.stringify({
	v: '5.7.4',
	fr: 30,
	ip: 0,
	op: 30,
	w: 64,
	h: 64,
	assets: [{ id: 'img', w: 2, h: 2, u: 'images/', p: 'a.png', e: 0 }],
	layers: [
		{
			ty: 4,
			ind: 1,
			ip: 0,
			op: 30,
			st: 0,
			ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [32, 32, 0] } },
			shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [20, 20] } }],
		},
		{ ty: 2, ind: 2, refId: 'img', ip: 0, op: 30, st: 0, ks: {} },
	],
});
const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64',
);
const dotLottie = () =>
	writeStoredZip([
		{ name: 'manifest.json', data: Buffer.from('{"version":"1","animations":[{"id":"anim"}]}') },
		{ name: 'animations/anim.json', data: Buffer.from(LOTTIE.replace('"u":"images/"', '"u":"/images/"')) },
		{ name: 'images/a.png', data: PNG_1PX },
	]);

const BUNDLE_FILES = [
	{ name: 'package.json', data: Buffer.from('{"name":"b","dependencies":{"remotion":"4.0.499"}}') },
	{ name: 'jasper.mg.json', data: Buffer.from('{"compositions":[{"id":"Main","texts":[]}]}') },
	{ name: 'build/index.html', data: Buffer.from('<html><script src="bundle.js"></script></html>') },
	{ name: 'build/bundle.js', data: Buffer.from('console.log(1)') },
];

/** Every file under `dir` stays inside it (no traversal, no symlink escape). */
function assertInside(dir: string): void {
	const root = realpathSync(dir);
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const real = realpathSync(p);
			if (relative(root, real).startsWith('..')) throw new Error(`extracted outside the destination: ${p}`);
			if (statSync(p).isDirectory()) walk(p);
		}
	};
	walk(root);
	if (readdirSync(work).some((x) => !/^(in|d)-\d+/.test(x)))
		throw new Error('a file appeared next to the destination');
}

const PROBE = {
	streams: [
		{
			index: 0,
			codec_name: 'h264',
			codec_type: 'video',
			width: 1920,
			height: 1080,
			pix_fmt: 'yuv420p',
			r_frame_rate: '30000/1001',
			avg_frame_rate: '30000/1001',
			sample_aspect_ratio: '1:1',
			field_order: 'progressive',
			color_space: 'bt709',
			color_transfer: 'bt709',
			color_primaries: 'bt709',
			color_range: 'tv',
			duration: '10.010000',
			nb_frames: '300',
			bits_per_raw_sample: '8',
			tags: { rotate: '90', timecode: '01:00:00;00' },
			side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
			disposition: { default: 1, attached_pic: 0 },
		},
		{
			index: 1,
			codec_name: 'aac',
			codec_type: 'audio',
			sample_rate: '48000',
			channels: 2,
			channel_layout: 'stereo',
			duration: '10.000000',
		},
	],
	format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.010000', size: '1000000', tags: {} },
};

describeFuzz('@jasper/engine archives', [
	bytesTarget(
		'ZIP (imports): list + read every entry',
		() => [
			writeStoredZip([
				{ name: 'a.json', data: Buffer.from('{"a":1}') },
				{ name: 'dir/b.bin', data: Buffer.alloc(300, 7) },
			]),
			dotLottie(),
		],
		(b) => {
			const buf = Buffer.from(b);
			for (const e of listZip(buf)) readZipEntry(buf, e, 1 << 20);
		},
		ZipError,
	),
	bytesTarget(
		'ZIP (motion-graphics bundles): extract, never outside the destination',
		() => [writeStoredZip(BUNDLE_FILES)],
		async (b) => {
			const dest = tempDir();
			try {
				await extractZip(tempFile(b, '.zip'), dest);
			} finally {
				assertInside(dest);
			}
		},
		BundleZipError,
		{ iterations: 200, properties: 60 },
	),
]);

describeFuzz('@jasper/engine media readers', [
	bytesTarget(
		'dotLottie archive',
		() => [dotLottie()],
		(b) => loadLottieFile(tempFile(b, '.lottie')),
		JobError,
		{
			iterations: 200,
			properties: 60,
		},
	),
	textTarget('Lottie .json file', [LOTTIE], (t) => loadLottieFile(tempFile(t, '.json')), JobError, {
		iterations: 200,
		properties: 60,
	}),
	bytesTarget(
		'Photoshop document',
		() => [makePsd(createRequire(import.meta.url)('ag-psd'))],
		(b) => readPsdFile(tempFile(b, '.psd'), { images: true }),
		JobError,
		{ iterations: 120, properties: 40, slowMs: 5000 },
	),
	jsonTarget(
		'ffprobe JSON → probe (schema-valid)',
		[PROBE],
		(v) => {
			const r = mapProbe(v as Parameters<typeof mapProbe>[0]);
			const ok = MediaProbeSchema.safeParse(r.probe);
			if (!ok.success)
				throw new Error(`probe result fails the media schema: ${ok.error.message.slice(0, 300)}`);
		},
		ToolError,
	),
]);

describeFuzz('@jasper/engine bundle metadata, names and messages', [
	textTarget(
		'bundle manifest (jasper.mg.json)',
		[BUNDLE_FILES[1]!.data.toString()],
		async (t) => {
			const d = tempDir();
			writeFileSync(join(d, 'jasper.mg.json'), t);
			await readManifest(d, []);
		},
		undefined,
		{ iterations: 200, properties: 60 },
	),
	textTarget(
		'bundle package.json',
		[BUNDLE_FILES[0]!.data.toString(), '{"name":"x","devDependencies":{"remotion":"^4.0.0"},"scripts":{}}'],
		async (t) => {
			const d = tempDir();
			writeFileSync(join(d, 'package.json'), t);
			await readProjectPackage(d);
		},
		MgBundleError,
		{ iterations: 200, properties: 60 },
	),
	textTarget('upload file names', ['clip.mp4', '../../etc/passwd', 'a\\b/c:d?.mov'], (t) => {
		const s = safeFileName(t);
		if (typeof s !== 'string' || !s || s.includes('/') || s.includes('\\') || s === '.' || s === '..')
			throw new Error(`unsafe result ${JSON.stringify(s)}`);
	}),
	jsonTarget(
		'engine runtime file',
		[{ version: 1, port: 47900, pid: 1234, token: 'x', startedAt: '2026-10-07T00:00:00.000Z' }],
		parseEngineRuntime,
	),
	jsonTarget(
		'engine events',
		[
			{ type: 'job.progress', jobId: 'j1', progress: 0.5 },
			{ type: 'project.saved', projectId: 'p', revision: 3 },
		],
		parseEvent,
	),
]);
