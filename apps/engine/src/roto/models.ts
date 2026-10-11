// Vision models of the roto workstream: the Roto Brush segmentation model (SAM 2.1) and the face models (MediaPipe
// Face Landmarker), the `vision` list of the processing-model catalogue (processing/models.json, or
// JASPER_MODEL_CATALOG in tests). They are multi-file ONNX models pinned to a Hugging Face revision and verified by
// sha256 — the same install mechanics as the speech models (speech/models.ts `SpeechModelStore`, which this store
// delegates to), into `<appdir>/models/vision/<id>/`, installed by the processing service's `model-download` job
// after the user has seen the licence. A `NOTICE.txt` naming the authors, licence and source is written next to the
// files of every install.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VisionModel } from '@jasper/api';
import { type SpeechCatalogEntry, SpeechModelStore } from '../speech/models.ts';

export type VisionCatalogEntry = Omit<SpeechCatalogEntry, 'multilingual' | 'default'> & {
	task: 'segmentation' | 'face';
	multilingual?: boolean;
};

export class VisionModelStore {
	private readonly store: SpeechModelStore;

	constructor(
		readonly modelsDir: string,
		readonly entries: VisionCatalogEntry[],
	) {
		this.store = new SpeechModelStore(
			modelsDir,
			entries.map((e) => ({ multilingual: false, ...e })),
		);
	}

	entry(id: string): VisionCatalogEntry | null {
		return this.entries.find((e) => e.id === id) ?? null;
	}

	/** First catalogue model of a task. */
	defaultFor(task: VisionCatalogEntry['task']): VisionCatalogEntry | null {
		return this.entries.find((e) => e.task === task) ?? null;
	}

	async installed(e: VisionCatalogEntry): Promise<boolean> {
		return this.store.installed(e);
	}

	async list(): Promise<VisionModel[]> {
		return Promise.all(
			this.entries.map(async (e) => {
				const installed = await this.installed(e);
				const sizeBytes = e.files.reduce((s, f) => s + f.sizeBytes, 0);
				return {
					id: e.id,
					name: e.name,
					task: e.task,
					description: e.description,
					license: e.license,
					licenseUrl: e.licenseUrl,
					attribution: e.attribution,
					sourceUrl: e.sourceUrl,
					revision: e.revision,
					sizeBytes,
					installed,
					missingBytes: installed ? 0 : await this.store.missingBytes(e),
				};
			}),
		);
	}

	/** The verified directory of an installed model (throws SpeechModelError codes). */
	async resolve(id: string): Promise<{ dir: string; entry: VisionCatalogEntry }> {
		const r = await this.store.resolve(id);
		return { dir: r.dir, entry: this.entry(id)! };
	}

	async install(
		id: string,
		opts: { signal?: AbortSignal; onProgress?(done: number, total: number, file: string): void } = {},
	): Promise<{ dir: string; alreadyInstalled: boolean }> {
		const r = await this.store.install(id, opts);
		const e = this.entry(id)!;
		await writeFile(join(r.dir, 'NOTICE.txt'), noticeText(e));
		return r;
	}

	async remove(id: string): Promise<{ freedBytes: number }> {
		return this.store.remove(id);
	}
}

export function noticeText(e: VisionCatalogEntry): string {
	return [
		`${e.name}`,
		'',
		`Attribution: ${e.attribution}`,
		`Licence: ${e.license} — ${e.licenseUrl}`,
		`Source: ${e.sourceUrl} (revision ${e.revision})`,
		`Upstream: ${e.upstreamUrl}`,
		'',
		'Downloaded unmodified by JasperEditor on request and verified by sha256. JasperEditor is not affiliated with',
		'or endorsed by the authors.',
		'',
	].join('\n');
}

/** Default models directory under an appdir. */
export function visionModelsDir(appdirRoot: string): string {
	return join(appdirRoot, 'models', 'vision');
}
