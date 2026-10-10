// Speech model store (wp speech). The catalogue is the processing-model catalogue's `speech` list
// (processing/models.json, or JASPER_MODEL_CATALOG in tests); installs run as the same `model-download` job and the
// licences show in Help ▸ About ▸ Licenses with the other models. Every model is a directory `<modelsDir>/<id>/`
// (`<appdir>/models/speech/<id>/`) holding the files of its catalogue entry (pinned Hugging Face revision). Files download into `<path>.partial` while their sha256 is
// computed, are checked against the catalogue and renamed into place; `install.json` then records what was
// verified (size + mtime per file), so loading a model does not re-hash a gigabyte each time. File URLs may be
// https, file:// or plain paths (tests).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { SpeechModel } from '@jasper/api';

export type SpeechModelFile = { path: string; url: string; sha256: string; sizeBytes: number };
export type SpeechCatalogEntry = {
	id: string;
	name: string;
	parameters: number;
	multilingual: boolean;
	default?: boolean;
	description: string;
	license: string;
	licenseUrl: string;
	attribution: string;
	sourceUrl: string;
	upstreamUrl: string;
	revision: string;
	files: SpeechModelFile[];
};

export class SpeechModelError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type InstallRecord = {
	id: string;
	revision: string;
	installedAt: string;
	files: Record<string, { sha256: string; sizeBytes: number; mtimeMs: number }>;
};

const RECORD = 'install.json';

export class SpeechModelStore {
	constructor(
		readonly modelsDir: string,
		readonly entries: SpeechCatalogEntry[],
	) {}

	entry(id: string): SpeechCatalogEntry | null {
		return this.entries.find((e) => e.id === id) ?? null;
	}

	defaultId(): string {
		return (this.entries.find((e) => e.default) ?? this.entries[0])?.id ?? 'whisper-base';
	}

	dirOf(e: SpeechCatalogEntry): string {
		return join(this.modelsDir, e.id);
	}

	sizeOf(e: SpeechCatalogEntry): number {
		return e.files.reduce((s, f) => s + f.sizeBytes, 0);
	}

	/** All files present with their catalogue size. */
	async installed(e: SpeechCatalogEntry): Promise<boolean> {
		for (const f of e.files) {
			const s = await stat(join(this.dirOf(e), f.path)).catch(() => null);
			if (!s?.isFile() || s.size !== f.sizeBytes) return false;
		}
		return true;
	}

	/** Bytes still to download (files already present with the right size are kept). */
	async missingBytes(e: SpeechCatalogEntry): Promise<number> {
		let n = 0;
		for (const f of e.files) {
			const s = await stat(join(this.dirOf(e), f.path)).catch(() => null);
			if (!s?.isFile() || s.size !== f.sizeBytes) n += f.sizeBytes;
		}
		return n;
	}

	async list(): Promise<SpeechModel[]> {
		return Promise.all(
			this.entries.map(async (e) => {
				const installed = await this.installed(e);
				return {
					id: e.id,
					name: e.name,
					parameters: e.parameters,
					multilingual: e.multilingual,
					default: e.id === this.defaultId(),
					description: e.description,
					license: e.license,
					licenseUrl: e.licenseUrl,
					attribution: e.attribution,
					sourceUrl: e.sourceUrl,
					revision: e.revision,
					sizeBytes: this.sizeOf(e),
					installed,
					missingBytes: installed ? 0 : await this.missingBytes(e),
				};
			}),
		);
	}

	/** The verified directory of an installed model (throws SPEECH_MODEL_NOT_INSTALLED / SPEECH_MODEL_CORRUPT). */
	async resolve(id: string): Promise<{ dir: string; entry: SpeechCatalogEntry }> {
		const e = this.entry(id);
		if (!e) throw new SpeechModelError('SPEECH_MODEL_UNKNOWN', `Unknown speech model ${id}`);
		if (!(await this.installed(e)))
			throw new SpeechModelError(
				'SPEECH_MODEL_NOT_INSTALLED',
				`The speech model ${e.name} is not downloaded`,
			);
		const dir = this.dirOf(e);
		const rec = (await readFile(join(dir, RECORD), 'utf8')
			.then((s) => JSON.parse(s) as InstallRecord)
			.catch(() => null)) as InstallRecord | null;
		const fresh: InstallRecord = {
			id: e.id,
			revision: e.revision,
			installedAt: rec?.installedAt ?? new Date().toISOString(),
			files: {},
		};
		let changed = !rec || rec.revision !== e.revision;
		for (const f of e.files) {
			const p = join(dir, f.path);
			const s = await stat(p);
			const r = rec?.files[f.path];
			if (r && r.sha256 === f.sha256 && r.sizeBytes === s.size && r.mtimeMs === s.mtimeMs) {
				fresh.files[f.path] = r;
				continue;
			}
			const got = await sha256Of(p);
			if (got !== f.sha256)
				throw new SpeechModelError(
					'SPEECH_MODEL_CORRUPT',
					`${e.name}: ${f.path} does not match its sha256 (delete and download the model again)`,
				);
			fresh.files[f.path] = { sha256: got, sizeBytes: s.size, mtimeMs: s.mtimeMs };
			changed = true;
		}
		if (changed) await writeFile(join(dir, RECORD), `${JSON.stringify(fresh, null, 2)}\n`);
		return { dir, entry: e };
	}

	/** Downloads the missing files of a model, verifying each against its sha256. */
	async install(
		id: string,
		opts: { signal?: AbortSignal; onProgress?(done: number, total: number, file: string): void } = {},
	): Promise<{ dir: string; alreadyInstalled: boolean }> {
		const e = this.entry(id);
		if (!e) throw new SpeechModelError('SPEECH_MODEL_UNKNOWN', `Unknown speech model ${id}`);
		const dir = this.dirOf(e);
		if (await this.installed(e)) {
			await this.resolve(id);
			return { dir, alreadyInstalled: true };
		}
		await mkdir(dir, { recursive: true });
		const total = await this.missingBytes(e);
		let done = 0;
		for (const f of e.files) {
			const dest = join(dir, f.path);
			const s = await stat(dest).catch(() => null);
			if (s?.isFile() && s.size === f.sizeBytes) continue;
			const partial = `${dest}.partial`;
			try {
				const body = await openSource(f.url, opts.signal);
				const hash = createHash('sha256');
				let got = 0;
				const meter = new Transform({
					transform(chunk: Buffer, _enc, cb) {
						hash.update(chunk);
						got += chunk.length;
						// A body longer than the catalogue size is never the pinned file: stop before it fills the disk.
						if (got > f.sizeBytes)
							return cb(
								new SpeechModelError(
									'SPEECH_MODEL_CHECKSUM',
									`${f.path}: the download is larger than the expected ${f.sizeBytes} bytes`,
								),
							);
						opts.onProgress?.(done + got, total, f.path);
						cb(null, chunk);
					},
				});
				await pipeline(body, meter, createWriteStream(partial), { signal: opts.signal });
				const sha = hash.digest('hex');
				if (sha !== f.sha256 || got !== f.sizeBytes)
					throw new SpeechModelError(
						'SPEECH_MODEL_CHECKSUM',
						`${f.path}: checksum mismatch (got ${sha}, ${got} bytes; expected ${f.sha256}, ${f.sizeBytes} bytes)`,
					);
				await rename(partial, dest);
				done += f.sizeBytes;
			} finally {
				await rm(partial, { force: true });
			}
		}
		await this.resolve(id);
		return { dir, alreadyInstalled: false };
	}

	/** Removes an installed (or partly downloaded) model. */
	async remove(id: string): Promise<{ freedBytes: number }> {
		const e = this.entry(id);
		if (!e) throw new SpeechModelError('SPEECH_MODEL_UNKNOWN', `Unknown speech model ${id}`);
		const dir = this.dirOf(e);
		let freed = 0;
		for (const f of e.files) {
			const s = await stat(join(dir, f.path)).catch(() => null);
			if (s?.isFile()) freed += s.size;
		}
		await rm(dir, { recursive: true, force: true });
		return { freedBytes: freed };
	}
}

async function openSource(url: string, signal?: AbortSignal): Promise<Readable> {
	if (url.startsWith('file:')) return createReadStream(fileURLToPath(url));
	if (!/^https?:/.test(url)) return createReadStream(resolve(url));
	let res: Response;
	try {
		res = await fetch(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new SpeechModelError('DOWNLOAD_FAILED', `Download failed: ${(err as Error).message}`);
	}
	if (!res.ok || !res.body)
		throw new SpeechModelError('DOWNLOAD_FAILED', `Download failed (HTTP ${res.status})`);
	return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
}

export async function sha256Of(path: string): Promise<string> {
	const h = createHash('sha256');
	for await (const c of createReadStream(path)) h.update(c as Buffer);
	return h.digest('hex');
}

/** Default models directory under an appdir. */
export function speechModelsDir(appdirRoot: string): string {
	return join(appdirRoot, 'models', 'speech');
}
