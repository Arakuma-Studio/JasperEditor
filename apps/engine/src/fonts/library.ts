// The user font library (wp fonts, docs/wp-notes/fonts.md): fonts the user installs once and uses in every project,
// like fonts installed on the OS. App-level, beside the effect preset and sound libraries (ARCHITECTURE §4.3):
//
//   <appdir>/fonts/library.json   {format: 'jasper-font-library', version: 1, revision, fonts: LibraryFont[], invalid?}
//   <appdir>/fonts/files/<id>.<ext>  one face per file (a collection is split into its faces); id = `f` + 24 hex
//                                    digits of the SHA-256 of the file, so URLs are immutable and content-addressed
//
// Writes are serialized and atomic (temp + fsync + rename + directory fsync, `atomicWriteFile`); every change bumps
// `revision`. Install writes the face files before the index (a crash leaves a stray file, adopted on the next
// open); removal deletes the file before the index entry (a crash leaves an entry without a file, dropped on the next
// open), so a removed font never comes back. Opening repairs conservatively and reports every repair: an unreadable
// index is kept aside (`library.json.corrupt-<time>`) and rebuilt from the files; entries that no longer validate
// are kept aside in `invalid`; entries whose file is missing are dropped; stray face files are re-parsed and adopted;
// leftover temp files are removed. An index written by a newer build (version > 1) is listed but never rewritten.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type LibraryFont, LibraryFontSchema } from '@jasper/api';
import { atomicWriteFile, atomicWriteJson, exists, fsyncDir, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import { FONT_LIMITS, FontParseError, type ParsedFaceFile, parseFont } from './sfnt.ts';

export const FONT_LIBRARY_LIMITS = {
	maxFileBytes: FONT_LIMITS.maxFileBytes,
	maxFonts: 1000,
	maxTotalBytes: 2 * 1024 * 1024 * 1024,
} as const;

const FORMAT = 'jasper-font-library';
const VERSION = 1;
const FILE_RE = /^(f[0-9a-f]{24})\.(ttf|otf|woff|woff2)$/;

type IndexFile = {
	format: typeof FORMAT;
	version: number;
	revision: number;
	fonts: LibraryFont[];
	invalid?: unknown[];
};

export type FontLibraryOptions = {
	onChange?: (revision: number) => void;
	log?: (m: string) => void;
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fontIdOf = (hash: string) => `f${hash.slice(0, 24)}`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\]/g;
/** A display file name: the base name, no control characters or separators, ≤ 255 characters. */
export function cleanFileName(name: string | undefined): string {
	const base = basename(String(name ?? '').replace(/\\/g, '/'));
	return base.replace(UNSAFE_NAME, '').trim().slice(0, 255) || 'font';
}

/** Maps reader refusals to HTTP errors (route boundary). */
export function fontParseHttpError(e: FontParseError): HttpError {
	const status = e.code === 'FONT_TOO_LARGE' ? 413 : e.code === 'FONT_UNSUPPORTED' ? 415 : 400;
	return new HttpError(status, e.code, e.message);
}

export class FontLibrary {
	private state: IndexFile;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly limits = FONT_LIBRARY_LIMITS;
	readonly repairs: string[] = [];
	readOnly = false;

	private constructor(
		readonly dir: string,
		private readonly opts: FontLibraryOptions,
	) {
		this.state = { format: FORMAT, version: VERSION, revision: 0, fonts: [] };
	}

	get indexFile(): string {
		return join(this.dir, 'library.json');
	}
	get filesDir(): string {
		return join(this.dir, 'files');
	}

	/** Opens (and repairs) the library in `dir`; never throws for damaged content, only for I/O failures. */
	static async open(dir: string, opts: FontLibraryOptions = {}): Promise<FontLibrary> {
		const lib = new FontLibrary(dir, opts);
		await lib.load();
		return lib;
	}

	private note(m: string): void {
		this.repairs.push(m);
		this.opts.log?.(`fonts: ${m}`);
	}

	private async load(): Promise<void> {
		await mkdir(this.filesDir, { recursive: true });
		let dirty = false;
		let raw: Record<string, unknown> | null = null;
		try {
			raw = await readJsonOrNull<Record<string, unknown>>(this.indexFile);
		} catch (e) {
			if ((e as { code?: string }).code !== 'EISDIR') throw e;
		}
		if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) raw = null;
		if (!raw && (await exists(this.indexFile))) {
			const aside = `${this.indexFile}.corrupt-${Date.now()}`;
			await rename(this.indexFile, aside).catch(() => undefined);
			this.note(
				`the library index was unreadable; it was rebuilt from the font files (old index kept as ${basename(aside)})`,
			);
			dirty = true;
		}
		const version = typeof raw?.version === 'number' && Number.isInteger(raw.version) ? raw.version : VERSION;
		if (version > VERSION) {
			this.readOnly = true;
			this.note(
				`the library was written by a newer JasperEditor (index version ${version}); it is read-only here`,
			);
		}
		const fonts: LibraryFont[] = [];
		const invalid: unknown[] = Array.isArray(raw?.invalid) ? [...(raw.invalid as unknown[])] : [];
		const seen = new Set<string>();
		for (const entry of Array.isArray(raw?.fonts) ? (raw.fonts as unknown[]) : []) {
			const r = LibraryFontSchema.safeParse(entry);
			if (!r.success) {
				invalid.push(entry);
				this.note('a library entry that no longer validates was kept aside');
				dirty = true;
				continue;
			}
			const f = r.data as LibraryFont;
			if (seen.has(f.id)) {
				this.note(`a duplicate entry of "${f.fullName}" was removed`);
				dirty = true;
				continue;
			}
			const file = join(this.filesDir, `${f.id}.${f.format}`);
			const st = await stat(file).catch(() => null);
			if (!st?.isFile()) {
				this.note(`"${f.fullName}" was removed from the library: its file is missing`);
				dirty = true;
				continue;
			}
			if (st.size !== f.sizeBytes) {
				// the file changed under the index: trust the file when it still reads as this face, else drop it
				const again = await this.readFace(file, f.originalName, f.addedAt);
				if (!again || again.id !== f.id) {
					invalid.push(entry);
					await rm(file, { force: true });
					this.note(`"${f.fullName}" was removed from the library: its file is damaged`);
					dirty = true;
					continue;
				}
			}
			seen.add(f.id);
			fonts.push(f);
		}
		// Stray face files (an install interrupted before its index write) are adopted; temp files removed.
		for (const name of await readdir(this.filesDir).catch(() => [] as string[])) {
			if (name.startsWith('.') && name.endsWith('.tmp')) {
				await rm(join(this.filesDir, name), { force: true });
				continue;
			}
			const m = FILE_RE.exec(name);
			if (!m || seen.has(m[1]!) || this.readOnly) continue;
			if (fonts.length >= this.limits.maxFonts) break;
			const face = await this.readFace(join(this.filesDir, name), name, new Date().toISOString());
			if (face && face.id === m[1] && `${face.id}.${face.format}` === name) {
				fonts.push(face);
				seen.add(face.id);
				this.note(`"${face.fullName}" was found in the font folder and added back to the library`);
				dirty = true;
			}
		}
		this.state = {
			format: FORMAT,
			version: this.readOnly ? version : VERSION,
			revision:
				typeof raw?.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0
					? raw.revision
					: 0,
			fonts,
			...(invalid.length ? { invalid } : {}),
		};
		if (dirty && !this.readOnly) {
			this.state.revision++;
			await atomicWriteJson(this.indexFile, this.state, true);
		}
	}

	/** Re-reads a stored face file; null when it does not read as exactly one face within the caps. */
	private async readFace(file: string, originalName: string, addedAt: string): Promise<LibraryFont | null> {
		try {
			const st = await stat(file);
			if (st.size > this.limits.maxFileBytes) return null;
			const bytes = new Uint8Array(await readFile(file));
			const parsed = parseFont(bytes);
			if (parsed.container === 'ttc' || parsed.faces.length !== 1) return null;
			return this.entryOf(parsed.faces[0]!, sha256(bytes), cleanFileName(originalName), addedAt);
		} catch {
			return null;
		}
	}

	private entryOf(
		face: ParsedFaceFile,
		hash: string,
		originalName: string,
		addedAt: string,
		collectionIndex?: number,
	): LibraryFont {
		const { bytes, format, ...names } = face;
		return {
			id: fontIdOf(hash),
			format,
			...names,
			sizeBytes: bytes.length,
			sha256: hash,
			originalName,
			...(collectionIndex !== undefined ? { collectionIndex } : {}),
			addedAt,
		} as LibraryFont;
	}

	get revision(): number {
		return this.state.revision;
	}

	/** Installed faces (a copy). */
	fonts(): LibraryFont[] {
		return structuredClone(this.state.fonts);
	}

	/** The faces without copying (catalog building; do not mutate). */
	get faces(): readonly LibraryFont[] {
		return this.state.fonts;
	}

	totalBytes(): number {
		return this.state.fonts.reduce((s, f) => s + f.sizeBytes, 0);
	}

	list() {
		return {
			revision: this.state.revision,
			readOnly: this.readOnly,
			fonts: this.fonts(),
			totalBytes: this.totalBytes(),
			limits: { ...this.limits },
			repairs: [...this.repairs],
		};
	}

	get(id: string): LibraryFont | null {
		return this.state.fonts.find((f) => f.id === id) ?? null;
	}

	/** Absolute path of a face file by its served name `<id>.<ext>`, or null. */
	filePath(name: string): string | null {
		const m = FILE_RE.exec(name);
		if (!m) return null;
		const f = this.get(m[1]!);
		if (!f || `${f.id}.${f.format}` !== name) return null;
		return join(this.filesDir, name);
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private assertWritable(): void {
		if (this.readOnly)
			throw new HttpError(
				409,
				'FONT_LIBRARY_READ_ONLY',
				'The font library was written by a newer JasperEditor; it cannot be changed with this version',
			);
	}

	/**
	 * Installs the faces of a font file. Same bytes as an installed face = already installed (idempotent); a different
	 * file whose face has the PostScript name of an installed one is refused (remove that one first). All or nothing.
	 */
	install(
		bytes: Uint8Array,
		originalName: string,
	): Promise<{ revision: number; installed: LibraryFont[]; existing: LibraryFont[] }> {
		return this.serial(async () => {
			this.assertWritable();
			if (bytes.length > this.limits.maxFileBytes)
				throw new HttpError(
					413,
					'FONT_TOO_LARGE',
					`The font file is ${bytes.length} bytes; the library accepts files up to ${this.limits.maxFileBytes} bytes`,
				);
			let parsed: ReturnType<typeof parseFont>;
			try {
				parsed = parseFont(bytes);
			} catch (e) {
				if (e instanceof FontParseError) throw fontParseHttpError(e);
				throw e;
			}
			const name = cleanFileName(originalName);
			const addedAt = new Date().toISOString();
			const installed: LibraryFont[] = [];
			const existing: LibraryFont[] = [];
			const existingIds = new Set<string>();
			const fresh: { entry: LibraryFont; bytes: Uint8Array }[] = [];
			for (const [i, face] of parsed.faces.entries()) {
				const hash = sha256(face.bytes);
				const entry = this.entryOf(face, hash, name, addedAt, parsed.container === 'ttc' ? i : undefined);
				const installedFace = this.get(entry.id);
				if (installedFace) {
					if (!existingIds.has(entry.id)) existing.push(structuredClone(installedFace));
					existingIds.add(entry.id);
					continue;
				}
				if (fresh.some((x) => x.entry.id === entry.id)) continue; // the same face twice in one collection
				const ps = entry.postscriptName.toLowerCase();
				const clash =
					this.state.fonts.find((f) => f.postscriptName.toLowerCase() === ps) ??
					fresh.find((x) => x.entry.postscriptName.toLowerCase() === ps)?.entry;
				if (clash)
					throw new HttpError(
						409,
						'FONT_EXISTS',
						`A different "${clash.fullName}" (${clash.postscriptName}, from ${clash.originalName}) is already installed; remove it first to replace it`,
						{ fontId: clash.id },
					);
				fresh.push({ entry, bytes: face.bytes });
			}
			const count = this.state.fonts.length + fresh.length;
			if (count > this.limits.maxFonts)
				throw new HttpError(
					409,
					'FONT_LIBRARY_FULL',
					`The font library holds at most ${this.limits.maxFonts} fonts; remove some first`,
				);
			const total = this.totalBytes() + fresh.reduce((s, x) => s + x.bytes.length, 0);
			if (total > this.limits.maxTotalBytes)
				throw new HttpError(
					409,
					'FONT_LIBRARY_FULL',
					`The font library holds at most ${this.limits.maxTotalBytes} bytes of fonts; remove some first`,
				);
			if (fresh.length === 0) return { revision: this.state.revision, installed, existing };
			for (const x of fresh)
				await atomicWriteFile(join(this.filesDir, `${x.entry.id}.${x.entry.format}`), x.bytes);
			const next: IndexFile = {
				...this.state,
				revision: this.state.revision + 1,
				fonts: [...this.state.fonts, ...fresh.map((x) => x.entry)],
			};
			await atomicWriteJson(this.indexFile, next, true);
			this.state = next;
			installed.push(...fresh.map((x) => structuredClone(x.entry)));
			this.opts.onChange?.(next.revision);
			return { revision: next.revision, installed, existing };
		});
	}

	/** Removes a face: its file first, then the index entry (see the header). */
	remove(id: string): Promise<{ revision: number; removed: string[] }> {
		return this.serial(async () => {
			this.assertWritable();
			const f = this.get(id);
			if (!f) throw new HttpError(404, 'FONT_NOT_FOUND', `Font not found: ${id}`);
			await rm(join(this.filesDir, `${f.id}.${f.format}`), { force: true });
			await fsyncDir(this.filesDir);
			const next: IndexFile = {
				...this.state,
				revision: this.state.revision + 1,
				fonts: this.state.fonts.filter((x) => x.id !== id),
			};
			await atomicWriteJson(this.indexFile, next, true);
			this.state = next;
			this.opts.onChange?.(next.revision);
			return { revision: next.revision, removed: [id] };
		});
	}
}
