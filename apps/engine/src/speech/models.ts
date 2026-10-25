// Speech model store (wp speech, spec 16 §2.3). The catalogue is the processing-model catalogue's `speech` list
// (processing/models.json, or JASPER_MODEL_CATALOG in tests and local overrides), validated with zod when it is
// loaded (SG-023: a bad entry is refused with a visible error, the others stay usable); installs run as the same
// `model-download` job and the licences show in Help ▸ About ▸ Licenses with the other models. Every model is a
// directory `<modelsDir>/<id>/` (`<appdir>/models/speech/<id>/`) holding the files of its catalogue entry (pinned
// Hugging Face revision; external-data files such as `encoder_model.onnx_data` are listed like any other file).
// Files download resumably into `<path>.partial` (tools/download.ts: HTTP Range resume, retries with backoff,
// sha256 per file, SG-022) and are renamed into place; `install.json` (written atomically) records what was
// verified (size + mtime per file), so loading a model does not re-hash gigabytes each time.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpeechModel } from '@jasper/api';
import { z } from 'zod';
import { DownloadError, downloadVerified } from '../tools/download.ts';
import { atomicWriteJson, readJsonOrNull, sha256File } from '../tools/fs.ts';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex digits');
/** A file name inside the model directory (no directories, no traversal). */
const FileName = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._-]+$/, 'file names are plain names')
	.refine((s) => s !== '.' && s !== '..' && !s.endsWith('.partial'), 'reserved file name');

export const SpeechModelFileSchema = z.strictObject({
	path: FileName,
	url: z.string().min(1).max(2000),
	sha256: Sha256,
	sizeBytes: z.number().int().positive().max(64 * 1024 ** 3),
});

/** SG-021 tiers the recommendation picks from. */
export const RecommendTierSchema = z.enum(['turbo-fp16', 'turbo', 'small']);

export const SpeechCatalogEntrySchema = z
	.strictObject({
		id: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9][a-z0-9._-]*$/, 'ids are lower-case names'),
		name: z.string().min(1).max(120),
		parameters: z.number().positive(),
		multilingual: z.boolean(),
		default: z.boolean().optional(),
		description: z.string().max(1000),
		license: z.string().min(1).max(300),
		licenseUrl: z.string().max(2000),
		attribution: z.string().max(1000),
		sourceUrl: z.string().max(2000),
		upstreamUrl: z.string().max(2000),
		revision: z.string().min(1).max(100),
		files: z.array(SpeechModelFileSchema).min(1).max(32),
		/** fp16 weights take and return float16 tensors (converted by the worker). */
		precision: z.enum(['fp32', 'fp16']).optional(),
		/** The encoder / decoder files when not `encoder_model.onnx` / `decoder_model_merged.onnx`. */
		encoderFile: FileName.optional(),
		decoderFile: FileName.optional(),
		recommend: RecommendTierSchema.optional(),
		/** Meant for GPUs (fp16: 2–4× slower on a CPU). */
		gpuOnly: z.boolean().optional(),
	})
	.superRefine((e, ctx) => {
		const names = e.files.map((f) => f.path);
		if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'duplicate file paths' });
		for (const f of [e.encoderFile ?? 'encoder_model.onnx', e.decoderFile ?? 'decoder_model_merged.onnx', 'config.json'])
			if (!names.includes(f)) ctx.addIssue({ code: 'custom', message: `missing file ${f}` });
	});

type SpeechModelFile = z.infer<typeof SpeechModelFileSchema>;
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
	precision?: 'fp32' | 'fp16';
	encoderFile?: string;
	decoderFile?: string;
	recommend?: 'turbo-fp16' | 'turbo' | 'small';
	gpuOnly?: boolean;
};

/** SG-023: validates the speech list; refused entries are reported (shown in Preferences and capabilities). */
export function validateSpeechCatalog(raw: unknown): { entries: SpeechCatalogEntry[]; errors: string[] } {
	const entries: SpeechCatalogEntry[] = [];
	const errors: string[] = [];
	if (raw === undefined) return { entries, errors };
	if (!Array.isArray(raw)) return { entries, errors: ['the speech model list is not an array'] };
	const seen = new Set<string>();
	raw.forEach((item, i) => {
		const r = SpeechCatalogEntrySchema.safeParse(item);
		const id = (item as { id?: unknown } | null)?.id;
		const label = typeof id === 'string' ? id : `entry ${i + 1}`;
		if (!r.success) {
			const issue = r.error.issues[0];
			errors.push(`${label}: ${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid'}`);
			return;
		}
		if (seen.has(r.data.id)) {
			errors.push(`${label}: duplicate id`);
			return;
		}
		seen.add(r.data.id);
		entries.push(r.data);
	});
	return { entries, errors };
}

export class SpeechModelError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const InstallRecordSchema = z.object({
	id: z.string(),
	revision: z.string(),
	installedAt: z.string(),
	files: z.record(
		z.string(),
		z.object({ sha256: z.string(), sizeBytes: z.number(), mtimeMs: z.number() }),
	),
});
type InstallRecord = z.infer<typeof InstallRecordSchema>;

type ModelFiles = Pick<SpeechCatalogEntry, 'id' | 'files'>;

const RECORD = 'install.json';

export class SpeechModelStore {
	constructor(
		readonly modelsDir: string,
		readonly entries: SpeechCatalogEntry[],
		/** Catalogue entries refused by validation (SG-023). */
		readonly catalogErrors: string[] = [],
		/** The recommended model for this computer (SG-021), when known. */
		private recommended: () => string | null = () => null,
	) {}

	setRecommendation(fn: () => string | null): void {
		this.recommended = fn;
	}

	entry(id: string): SpeechCatalogEntry | null {
		return this.entries.find((e) => e.id === id) ?? null;
	}

	/** The default model: the recommendation for this computer, else the catalogue default, else the first. */
	defaultId(): string {
		const rec = this.recommended();
		if (rec && this.entry(rec)) return rec;
		return (this.entries.find((e) => e.default) ?? this.entries[0])?.id ?? 'whisper-small';
	}

	dirOf(e: Pick<SpeechCatalogEntry, 'id'>): string {
		return join(this.modelsDir, e.id);
	}

	sizeOf(e: Pick<SpeechCatalogEntry, 'files'>): number {
		return e.files.reduce((s, f) => s + f.sizeBytes, 0);
	}

	/** All files present with their catalogue size. */
	async installed(e: ModelFiles): Promise<boolean> {
		for (const f of e.files) {
			const s = await stat(join(this.dirOf(e), f.path)).catch(() => null);
			if (!s?.isFile() || s.size !== f.sizeBytes) return false;
		}
		return true;
	}

	/** Bytes still to download (files already present with the right size are kept; partial files count). */
	async missingBytes(e: ModelFiles): Promise<number> {
		let n = 0;
		for (const f of e.files) {
			const p = join(this.dirOf(e), f.path);
			const s = await stat(p).catch(() => null);
			if (s?.isFile() && s.size === f.sizeBytes) continue;
			const part = await stat(`${p}.partial`).catch(() => null);
			n += f.sizeBytes - Math.min(f.sizeBytes, part?.isFile() ? part.size : 0);
		}
		return n;
	}

	async list(): Promise<SpeechModel[]> {
		const def = this.defaultId();
		const rec = this.recommended();
		return Promise.all(
			this.entries.map(async (e) => {
				const installed = await this.installed(e);
				return {
					id: e.id,
					name: e.name,
					parameters: e.parameters,
					multilingual: e.multilingual,
					default: e.id === def,
					description: e.description,
					license: e.license,
					licenseUrl: e.licenseUrl,
					attribution: e.attribution,
					sourceUrl: e.sourceUrl,
					revision: e.revision,
					sizeBytes: this.sizeOf(e),
					installed,
					missingBytes: installed ? 0 : await this.missingBytes(e),
					precision: e.precision ?? 'fp32',
					languages: e.multilingual ? 99 : 1,
					recommended: rec !== null && e.id === rec,
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
		const parsed = InstallRecordSchema.safeParse(await readJsonOrNull(join(dir, RECORD)).catch(() => null));
		const rec: InstallRecord | null = parsed.success ? parsed.data : null;
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
			const got = await sha256File(p);
			if (got !== f.sha256)
				throw new SpeechModelError(
					'SPEECH_MODEL_CORRUPT',
					`${e.name}: ${f.path} does not match its sha256 (delete and download the model again)`,
				);
			fresh.files[f.path] = { sha256: got, sizeBytes: s.size, mtimeMs: s.mtimeMs };
			changed = true;
		}
		if (changed) await atomicWriteJson(join(dir, RECORD), fresh, true);
		return { dir, entry: e };
	}

	/**
	 * Downloads the missing files of a model, each verified against its sha256 (resumable: an interrupted or
	 * cancelled install continues from its `.partial` files).
	 */
	async install(
		id: string,
		opts: {
			signal?: AbortSignal;
			onProgress?(done: number, total: number, file: string): void;
			/** Download tuning (tests). */
			download?: { retries?: number; backoffMs?: number; fetch?: typeof fetch };
		} = {},
	): Promise<{ dir: string; alreadyInstalled: boolean }> {
		const e = this.entry(id);
		if (!e) throw new SpeechModelError('SPEECH_MODEL_UNKNOWN', `Unknown speech model ${id}`);
		const dir = this.dirOf(e);
		if (await this.installed(e)) {
			await this.resolve(id);
			return { dir, alreadyInstalled: true };
		}
		const total = this.sizeOf(e);
		let done = 0;
		for (const f of e.files) {
			const dest = join(dir, f.path);
			const s = await stat(dest).catch(() => null);
			if (s?.isFile() && s.size === f.sizeBytes) {
				done += f.sizeBytes;
				opts.onProgress?.(done, total, f.path);
				continue;
			}
			try {
				await downloadVerified(f, dest, {
					...(opts.signal ? { signal: opts.signal } : {}),
					...(opts.download ?? {}),
					onProgress: (bytes) => opts.onProgress?.(done + bytes, total, f.path),
				});
			} catch (err) {
				if (err instanceof DownloadError)
					throw new SpeechModelError(
						err.code === 'CHECKSUM' ? 'SPEECH_MODEL_CHECKSUM' : 'DOWNLOAD_FAILED',
						`${f.path}: ${err.message}`,
					);
				throw err;
			}
			done += f.sizeBytes;
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
			for (const p of [join(dir, f.path), `${join(dir, f.path)}.partial`]) {
				const s = await stat(p).catch(() => null);
				if (s?.isFile()) freed += s.size;
			}
		}
		const { rm } = await import('node:fs/promises');
		await rm(dir, { recursive: true, force: true });
		return { freedBytes: freed };
	}
}

/** Default models directory under an appdir. */
export function speechModelsDir(appdirRoot: string): string {
	return join(appdirRoot, 'models', 'speech');
}
