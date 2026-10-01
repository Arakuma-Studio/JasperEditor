// Super-resolution model catalogue and installs (S07:PST-031…034). Bundled models ship with the engine
// (apps/engine/models/ in a checkout, `models/` next to the engine bundle); the others install on demand into
// `<appdir>/models/` through a `model-download` job and are verified by sha256. Tests point
// JASPER_MODEL_CATALOG at their own catalogue (a generated tiny model): no download is ever needed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessingModel } from '@jasper/api';
import builtin from './models.json' with { type: 'json' };

export type CatalogEntry = {
	id: string;
	name: string;
	architecture: string;
	scale: 2 | 4;
	file: string;
	bundled?: boolean;
	license: string;
	attribution: string | null;
	sourceUrl: string;
	downloadUrl: string | null;
	sha256: string;
	sizeBytes: number;
	notes?: string;
};

export const MODEL_CATALOG_ENV = 'JASPER_MODEL_CATALOG';
export const MODELS_DIR_ENV = 'JASPER_BUNDLED_MODELS_DIR';

/** Directory of the bundled models: env override, `models/` next to the bundle, or apps/engine/models. */
export function bundledModelsDir(env: Record<string, string | undefined> = process.env): string {
	if (env[MODELS_DIR_ENV]) return resolve(env[MODELS_DIR_ENV] as string);
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, 'models'), join(here, '..', '..', 'models')];
	return candidates.find((d) => existsSync(d)) ?? candidates[candidates.length - 1];
}

/** The catalogue: JASPER_MODEL_CATALOG (a JSON file `{models: [...]}`, paths relative to it) or models.json. */
export function loadCatalog(env: Record<string, string | undefined> = process.env): {
	entries: CatalogEntry[];
	bundledDir: string;
} {
	const file = env[MODEL_CATALOG_ENV];
	if (file) {
		const json = JSON.parse(readFileSync(file, 'utf8')) as { models: CatalogEntry[]; bundledDir?: string };
		const base = dirname(resolve(file));
		const dir = json.bundledDir
			? isAbsolute(json.bundledDir)
				? json.bundledDir
				: join(base, json.bundledDir)
			: base;
		return { entries: json.models, bundledDir: dir };
	}
	return { entries: (builtin as { models: CatalogEntry[] }).models, bundledDir: bundledModelsDir(env) };
}

export function sha256File(file: string): Promise<string> {
	return new Promise((res, rej) => {
		const h = createHash('sha256');
		createReadStream(file)
			.on('data', (c) => h.update(c))
			.on('end', () => res(h.digest('hex')))
			.on('error', rej);
	});
}

export class ModelError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class ModelStore {
	private readonly verified = new Map<string, string>();
	constructor(private readonly opts: { modelsDir: string; entries: CatalogEntry[]; bundledDir: string }) {}

	get entries(): CatalogEntry[] {
		return this.opts.entries;
	}

	entry(id: string): CatalogEntry | null {
		return this.opts.entries.find((e) => e.id === id) ?? null;
	}

	/** Where the model file is (bundled or installed), whether or not it exists. */
	pathOf(e: CatalogEntry): string {
		return e.bundled ? join(this.opts.bundledDir, e.file) : join(this.opts.modelsDir, e.file);
	}

	/** Installed = the file exists with the catalogue size (sha256 is verified once per process on use). */
	async installed(e: CatalogEntry): Promise<boolean> {
		const s = await stat(this.pathOf(e)).catch(() => null);
		return !!s?.isFile() && s.size === e.sizeBytes;
	}

	async list(): Promise<ProcessingModel[]> {
		return Promise.all(
			this.opts.entries.map(async (e) => ({
				id: e.id,
				name: e.name,
				scale: e.scale,
				architecture: e.architecture,
				license: e.license,
				attribution: e.attribution,
				sourceUrl: e.sourceUrl,
				downloadUrl: e.downloadUrl,
				sha256: e.sha256,
				sizeBytes: e.sizeBytes,
				installed: await this.installed(e),
			})),
		);
	}

	/** Path + verified sha256 of an installed model (throws MODEL_NOT_INSTALLED / MODEL_CORRUPT). */
	async resolve(id: string): Promise<{ path: string; sha256: string; scale: number; entry: CatalogEntry }> {
		const e = this.entry(id);
		if (!e) throw new ModelError('MODEL_UNKNOWN', `Unknown model ${id}`);
		const path = this.pathOf(e);
		if (!(await this.installed(e)))
			throw new ModelError('MODEL_NOT_INSTALLED', `Model ${e.name} is not installed`);
		if (this.verified.get(path) !== e.sha256) {
			const got = await sha256File(path);
			if (got !== e.sha256)
				throw new ModelError('MODEL_CORRUPT', `Model ${e.name} does not match its sha256 (reinstall it)`);
			this.verified.set(path, got);
		}
		return { path, sha256: e.sha256, scale: e.scale, entry: e };
	}

	/** Downloads a model (resumable is not needed at these sizes), verifies sha256, installs atomically. */
	async install(
		id: string,
		opts: { signal?: AbortSignal; onProgress?(done: number, total: number): void } = {},
	): Promise<{ path: string; alreadyInstalled: boolean }> {
		const e = this.entry(id);
		if (!e) throw new ModelError('MODEL_UNKNOWN', `Unknown model ${id}`);
		const dest = this.pathOf(e);
		if (await this.installed(e)) {
			await this.resolve(id);
			return { path: dest, alreadyInstalled: true };
		}
		if (e.bundled)
			throw new ModelError('MODEL_MISSING', `The bundled model ${e.name} is missing from this installation`);
		if (!e.downloadUrl) throw new ModelError('MODEL_NO_DOWNLOAD', `Model ${e.name} has no download URL`);
		await mkdir(dirname(dest), { recursive: true });
		const partial = `${dest}.partial`;
		const res = await fetch(e.downloadUrl, { redirect: 'follow', signal: opts.signal });
		if (!res.ok || !res.body) throw new ModelError('DOWNLOAD_FAILED', `Download failed (${res.status})`);
		let done = 0;
		const total = Number(res.headers.get('content-length')) || e.sizeBytes;
		const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
		body.on('data', (c: Buffer) => {
			done += c.length;
			opts.onProgress?.(done, total);
		});
		try {
			await pipeline(body, createWriteStream(partial));
			const got = await sha256File(partial);
			if (got !== e.sha256)
				throw new ModelError(
					'MODEL_CHECKSUM',
					`Downloaded ${e.name} has sha256 ${got}, expected ${e.sha256}`,
				);
			await rename(partial, dest);
		} finally {
			await rm(partial, { force: true });
		}
		this.verified.set(dest, e.sha256);
		return { path: dest, alreadyInstalled: false };
	}
}
