// spec 13 AS-020: the user subtitle template library — one JSON file per appdir,
// `<appdir>/presets/subtitle-templates.json`, shared by every project, every editor window and agents. Writes are
// serialized and atomic (tmp + fsync + rename); every change bumps `revision`. Entries are validated with the
// @jasper/project template schema (`parseSubtitleTemplate`); entries that no longer validate are kept aside in
// `invalid` and written back (never silently dropped); an unreadable file is renamed to `….corrupt-<time>`; a file
// of a newer version is read and never written (read-only).
import { rename } from 'node:fs/promises';
import { parseSubtitleTemplate, type SubtitleTemplate } from '@jasper/project';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

export const SUBTITLE_TEMPLATE_LIBRARY_FORMAT = 'jasper-subtitle-template-library';
export const SUBTITLE_TEMPLATE_LIBRARY_VERSION = 1;
/** Most templates the library holds. */
export const MAX_LIBRARY_TEMPLATES = 2000;

type LibraryFile = {
	format: typeof SUBTITLE_TEMPLATE_LIBRARY_FORMAT;
	version: number;
	revision: number;
	templates: SubtitleTemplate[];
	invalid?: unknown[];
};

const notFound = (id: string) =>
	new HttpError(
		404,
		'TEMPLATE_NOT_FOUND',
		id.startsWith('builtin:') ? 'Built-in subtitle templates are read-only' : `Subtitle template not found: ${id}`,
	);

export class SubtitleTemplateLibrary {
	private state: LibraryFile | null = null;
	private readOnly = false;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly opts: { now?: () => string; onChange?: (revision: number) => void; log?: (m: string) => void } = {},
	) {}

	private now(): string {
		return this.opts.now?.() ?? new Date().toISOString();
	}

	private async load(): Promise<LibraryFile> {
		if (this.state) return this.state;
		const empty: LibraryFile = {
			format: SUBTITLE_TEMPLATE_LIBRARY_FORMAT,
			version: SUBTITLE_TEMPLATE_LIBRARY_VERSION,
			revision: 0,
			templates: [],
		};
		const raw = await readJsonOrNull<Record<string, unknown>>(this.file);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			if (await exists(this.file)) {
				const aside = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, aside).catch(() => undefined);
				this.opts.log?.(`subtitle templates: unreadable library moved to ${aside}`);
			}
			this.state = empty;
			return empty;
		}
		if (typeof raw.version === 'number' && raw.version > SUBTITLE_TEMPLATE_LIBRARY_VERSION) {
			this.readOnly = true;
			this.opts.log?.('subtitle templates: the library was written by a newer JasperEditor (read-only)');
		}
		const templates: SubtitleTemplate[] = [];
		const invalid: unknown[] = Array.isArray(raw.invalid) ? [...raw.invalid] : [];
		const seen = new Set<string>();
		for (const t of Array.isArray(raw.templates) ? raw.templates : []) {
			const r = parseSubtitleTemplate(t);
			if (r.ok && !seen.has(r.template.id) && !r.template.id.startsWith('builtin:')) {
				seen.add(r.template.id);
				templates.push(r.template);
			} else invalid.push(t);
		}
		if (invalid.length) this.opts.log?.(`subtitle templates: ${invalid.length} invalid entries kept aside`);
		this.state = {
			...empty,
			version: typeof raw.version === 'number' ? raw.version : SUBTITLE_TEMPLATE_LIBRARY_VERSION,
			revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) ? raw.revision : 0,
			templates,
			...(invalid.length ? { invalid } : {}),
		};
		return this.state;
	}

	private mutate<T>(fn: (s: LibraryFile) => T): Promise<T> {
		const run = this.chain.then(async () => {
			const s = await this.load();
			if (this.readOnly)
				throw new HttpError(
					409,
					'LIBRARY_READ_ONLY',
					'The subtitle template library was written by a newer JasperEditor and is read-only',
				);
			const next = structuredClone(s);
			const out = fn(next);
			next.revision = s.revision + 1;
			await atomicWriteJson(this.file, next, true);
			this.state = next;
			this.opts.onChange?.(next.revision);
			return out;
		});
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async list(): Promise<{ revision: number; templates: SubtitleTemplate[] }> {
		await this.chain;
		const s = await this.load();
		return structuredClone({ revision: s.revision, templates: s.templates });
	}

	/** Creates or replaces a template by id (timestamps set; built-in ids refused). */
	save(id: string, raw: Record<string, unknown>): Promise<SubtitleTemplate> {
		return this.mutate((s) => {
			if (id.startsWith('builtin:')) throw notFound(id);
			if (!/^[\w:.-]{1,80}$/.test(id)) throw new HttpError(400, 'VALIDATION_FAILED', `Malformed template id ${id}`);
			const now = this.now();
			const old = s.templates.find((t) => t.id === id);
			const { builtIn: _b, ...rest } = raw;
			const r = parseSubtitleTemplate({ ...rest, id, createdAt: old?.createdAt ?? now, updatedAt: now });
			if (!r.ok) throw new HttpError(400, 'TEMPLATE_INVALID', r.message);
			if (!old && s.templates.length >= MAX_LIBRARY_TEMPLATES)
				throw new HttpError(409, 'LIBRARY_FULL', `The library holds at most ${MAX_LIBRARY_TEMPLATES} templates`);
			if (old) s.templates[s.templates.indexOf(old)] = r.template;
			else s.templates.push(r.template);
			return r.template;
		});
	}

	remove(id: string): Promise<{ removed: string }> {
		return this.mutate((s) => {
			if (!s.templates.some((t) => t.id === id)) throw notFound(id);
			s.templates = s.templates.filter((t) => t.id !== id);
			return { removed: id };
		});
	}
}
