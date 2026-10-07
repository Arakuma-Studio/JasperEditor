// Lottie export on the engine (imports workstream): reads the pictures a sequence's still and Lottie clips need,
// runs the pure exporter (`exportSequenceToLottie`, @jasper/project) and writes a `.json` or `.lottie` (dotLottie v1:
// `manifest.json` + `animations/<id>.json`).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { LottieExportRequest, LottieExportResult } from '@jasper/api';
import {
	browserPictureNeed,
	exportSequenceToLottie,
	type LottieExportMedia,
	loadProject,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { mgRegistry } from '@jasper/mg-templates';
import { mediaKeyOf } from '../export/planner.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
import { HttpError } from '../tools/reply.ts';
import { writeStoredZip } from './zip.ts';

const MIME: Record<string, string> = {
	png: 'image/png',
	mjpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
};

/** Media ids of still / animated-image clips in a sequence and the sequences nested in it (cycle-safe). */
function usedMedia(doc: ProjectDocument, sequenceId: string, seen = new Set<string>()): Set<string> {
	const out = new Set<string>();
	if (seen.has(sequenceId)) return out;
	seen.add(sequenceId);
	const seq = doc.sequences[sequenceId];
	if (!seq) return out;
	for (const c of Object.values(seq.clips)) {
		if (c.kind === 'still' || c.kind === 'animated-image') out.add(c.mediaId);
		if (c.kind === 'nest-video') for (const id of usedMedia(doc, c.sequenceId, seen)) out.add(id);
	}
	return out;
}

export async function exportLottie(
	req: LottieExportRequest,
	deps: {
		registry: MediaRegistry;
		readMedia(key: string): Promise<Buffer | null>;
		lottieJson(r: MediaRecord): Promise<Record<string, unknown>>;
		displayPng(r: MediaRecord, variant: string): Promise<Buffer>;
		outDir: string;
	},
): Promise<LottieExportResult> {
	let doc: ProjectDocument;
	try {
		doc = loadProject(req.envelope, { mgTemplates: mgRegistry }).document;
	} catch (e) {
		throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
	}
	if (!doc.sequences[req.sequenceId]) throw new HttpError(404, 'NOT_FOUND', 'Sequence not found');
	const media: LottieExportMedia = {};
	const warnings: string[] = [];
	for (const id of usedMedia(doc, req.sequenceId)) {
		const asset = doc.media[id] as MediaAsset | undefined;
		const key = asset ? mediaKeyOf(asset) : null;
		const r = key ? deps.registry.get(key) : null;
		if (!asset || !r) {
			warnings.push(`Media ${asset?.originalName ?? id} is offline: its clips are skipped`);
			continue;
		}
		const need = browserPictureNeed(asset);
		try {
			if (asset.lottie) media[id] = { kind: 'lottie', doc: await deps.lottieJson(r) };
			else if (asset.vector?.format === 'svg') {
				const bytes = await deps.readMedia(r.mediaKey);
				if (bytes)
					media[id] = {
						kind: 'image',
						dataUri: `data:image/svg+xml;base64,${bytes.toString('base64')}`,
						width: asset.vector.width,
						height: asset.vector.height,
					};
			} else if (asset.vector) warnings.push(`${asset.originalName}: PDF pages cannot be embedded in Lottie`);
			else if (asset.kind === 'image') {
				const vs = r.probe.streams.find((s) => s.type === 'video');
				const codec = vs?.type === 'video' ? vs.codec : '';
				const direct = need.picture === null && MIME[codec];
				const bytes = direct ? await deps.readMedia(r.mediaKey) : await deps.displayPng(r, need.variant);
				if (bytes)
					media[id] = {
						kind: 'image',
						dataUri: `data:${direct ? MIME[codec] : 'image/png'};base64,${bytes.toString('base64')}`,
						width: vs?.type === 'video' ? vs.width : 1,
						height: vs?.type === 'video' ? vs.height : 1,
					};
			}
		} catch (e) {
			warnings.push(`${asset.originalName}: ${(e as Error).message.slice(0, 200)}`);
		}
	}
	const range = req.range && req.range.end > req.range.start ? req.range : undefined;
	const result = exportSequenceToLottie(doc, req.sequenceId, { media, ...(range ? { range } : {}) });
	const allWarnings = [...warnings, ...result.warnings];
	const format = req.format ?? 'json';
	const seqName =
		(result.json.nm as string | undefined)?.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'animation';
	const json = Buffer.from(JSON.stringify(result.json));
	const bytes =
		format === 'dotlottie'
			? writeStoredZip([
					{
						name: 'manifest.json',
						data: Buffer.from(
							JSON.stringify({
								version: '1',
								generator: 'JasperEditor',
								author: '',
								animations: [{ id: seqName, speed: 1, loop: false }],
							}),
						),
					},
					{ name: `animations/${seqName}.json`, data: json },
				])
			: json;
	const fileName = `${seqName}.${format === 'dotlottie' ? 'lottie' : 'json'}`;
	if (req.outputPath) {
		if (!isAbsolute(req.outputPath)) throw new HttpError(400, 'BAD_REQUEST', 'outputPath must be absolute');
		const out = resolve(req.outputPath);
		await mkdir(dirname(out), { recursive: true });
		const tmp = `${out}.${Date.now().toString(36)}.partial`;
		await writeFile(tmp, bytes);
		await rename(tmp, out);
		return { warnings: allWarnings, layers: result.layers, bytes: bytes.length, outputPath: out, fileName };
	}
	void deps.outDir;
	return {
		warnings: allWarnings,
		layers: result.layers,
		bytes: bytes.length,
		contentBase64: bytes.toString('base64'),
		fileName,
	};
}
