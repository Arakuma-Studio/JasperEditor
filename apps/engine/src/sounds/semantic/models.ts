// Describe-it search models (spec 12 P6-E14, WP-E9; ARCHITECTURE D-24): the processing catalogue's `sound` list
// (processing/models.json, or JASPER_MODEL_CATALOG in tests). Same install mechanics as the speech and vision models
// (speech/models.ts `SpeechModelStore`, which this store delegates to): every file pinned by sha256 and size, installed
// into `<appdir>/models/sound/<id>/` by the processing service's `model-download` job after the user has seen the
// licence; never bundled, never required. A file's `url` may be:
//   - https (the upstream repository at a pinned revision), file:// or a path (tests);
//   - `bundled:<path>`: a file shipped with the engine (apps/engine/models/<path>), copied next to the downloaded files
//     (CLAP's weight-free graphs: ONNX Runtime reads their external data from the same folder);
//   - null: nobody hosts it yet. The model then lists as not available ("the model download location is pending")
//     and install refuses with MODEL_DOWNLOAD_PENDING.
// A `NOTICE.txt` naming the authors, licence and source is written next to the files of every install.
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { type SpeechCatalogEntry, SpeechModelError, SpeechModelStore } from '../../speech/models.ts';

type SoundModelFile = { path: string; url: string | null; sha256: string; sizeBytes: number };

export type SoundCatalogEntry = {
	id: string;
	name: string;
	task: 'audio-text';
	description: string;
	license: string;
	licenseUrl: string;
	attribution: string;
	sourceUrl: string;
	upstreamUrl: string;
	revision: string;
	files: SoundModelFile[];
};

/** Why a model cannot be installed yet (a file without a download location). */
export const DOWNLOAD_PENDING = 'Not available yet: the model download location is pending';

export type SoundModelInfo = {
	id: string;
	name: string;
	description: string;
	license: string;
	licenseUrl: string;
	attribution: string;
	sourceUrl: string;
	revision: string;
	sizeBytes: number;
	missingBytes: number;
	installed: boolean;
	available: boolean;
	unavailableReason: string | null;
};

const BUNDLED = 'bundled:';

export class SoundModelStore {
	private readonly store: SpeechModelStore;

	constructor(
		readonly modelsDir: string,
		readonly entries: SoundCatalogEntry[],
		private readonly bundledDir: string,
	) {
		this.store = new SpeechModelStore(
			modelsDir,
			entries.map((e) => ({
				...e,
				multilingual: false,
				parameters: 0,
				files: e.files.map((f) => ({ ...f, url: this.sourceOf(f.url) ?? '' })),
			})) as SpeechCatalogEntry[],
		);
	}

	/** The file a catalogue URL names, or null for a pending one (a bundled path never leaves the bundled folder). */
	private sourceOf(url: string | null): string | null {
		if (url === null || url === '') return null;
		if (!url.startsWith(BUNDLED)) return url;
		const rel = url.slice(BUNDLED.length);
		const p = normalize(join(this.bundledDir, rel));
		if (isAbsolute(rel) || !(p === this.bundledDir || p.startsWith(this.bundledDir + sep))) return null;
		return p;
	}

	entry(id: string): SoundCatalogEntry | null {
		return this.entries.find((e) => e.id === id) ?? null;
	}

	/** The first installed model, else the catalogue's first. */
	async preferred(): Promise<SoundCatalogEntry | null> {
		for (const e of this.entries) if (await this.installed(e)) return e;
		return this.entries[0] ?? null;
	}

	dirOf(e: Pick<SoundCatalogEntry, 'id'>): string {
		return join(this.modelsDir, e.id);
	}

	async installed(e: SoundCatalogEntry): Promise<boolean> {
		return this.store.installed(e);
	}

	/** Files without a download location that are not already in place. */
	private async pendingFiles(e: SoundCatalogEntry): Promise<string[]> {
		const out: string[] = [];
		for (const f of e.files)
			if (this.sourceOf(f.url) === null && (await this.store.missingBytes({ id: e.id, files: [f] as never })) > 0)
				out.push(f.path);
		return out;
	}

	async list(): Promise<SoundModelInfo[]> {
		return Promise.all(
			this.entries.map(async (e) => {
				const installed = await this.installed(e);
				const pending = installed ? [] : await this.pendingFiles(e);
				let missing = 0;
				if (!installed)
					for (const f of e.files)
						if (!f.url?.startsWith(BUNDLED))
							missing += await this.store.missingBytes({ id: e.id, files: [f] as never });
				return {
					id: e.id,
					name: e.name,
					description: e.description,
					license: e.license,
					licenseUrl: e.licenseUrl,
					attribution: e.attribution,
					sourceUrl: e.sourceUrl,
					revision: e.revision,
					sizeBytes: e.files.reduce((s, f) => s + f.sizeBytes, 0),
					missingBytes: missing,
					installed,
					available: pending.length === 0,
					unavailableReason: pending.length ? DOWNLOAD_PENDING : null,
				};
			}),
		);
	}

	/** The verified directory of an installed model (throws SpeechModelError codes). */
	async resolve(id: string): Promise<{ dir: string; entry: SoundCatalogEntry }> {
		const r = await this.store.resolve(id);
		return { dir: r.dir, entry: this.entry(id)! };
	}

	async install(
		id: string,
		opts: { signal?: AbortSignal; onProgress?(done: number, total: number, file: string): void } = {},
	): Promise<{ dir: string; alreadyInstalled: boolean }> {
		const e = this.entry(id);
		if (!e) throw new SpeechModelError('SPEECH_MODEL_UNKNOWN', `Unknown model ${id}`);
		if (!(await this.installed(e)) && (await this.pendingFiles(e)).length)
			throw new SpeechModelError('MODEL_DOWNLOAD_PENDING', `${e.name}: ${DOWNLOAD_PENDING}`);
		const r = await this.store.install(id, opts);
		await writeFile(join(r.dir, 'NOTICE.txt'), noticeText(e));
		return r;
	}

	async remove(id: string): Promise<{ freedBytes: number }> {
		return this.store.remove(id);
	}
}

export function noticeText(e: SoundCatalogEntry): string {
	return [
		`${e.name}`,
		'',
		`Attribution: ${e.attribution}`,
		`Licence: ${e.license} — ${e.licenseUrl}`,
		`Source: ${e.sourceUrl} (revision ${e.revision})`,
		`Upstream: ${e.upstreamUrl}`,
		'',
		'Downloaded unmodified by JasperEditor on request and verified by sha256 (the ONNX graphs were exported by',
		'JasperEditor from the same model and hold no weights). JasperEditor is not affiliated with or endorsed by the',
		'authors. Used for analysis only (search), never to generate audio.',
		'',
	].join('\n');
}

/** Default models directory under an appdir. */
export function soundModelsDir(appdirRoot: string): string {
	return join(appdirRoot, 'models', 'sound');
}
