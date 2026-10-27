// The personal speech glossary (spec 17 SC-070; docs/wp-notes/script-correction.md "Personal glossary"): one JSON
// file per app dir, `<appdir>/speech/glossary.json` `{format: 'jasper-speech-glossary', version: 1, revision,
// entries, invalid?}`, shared by every project, editor window and agent, like the cleanup preset library.
//
// Writes are serialized and atomic (temp file, fsync, rename, directory fsync: `atomicWriteJson`); a change bumps
// `revision` and announces it (`glossary.changed`); a save that changes nothing writes nothing. Opening repairs
// conservatively and reports every repair (`repairs`, shown in Preferences): an unreadable file (not JSON, not an
// object, another format) is renamed `glossary.json.corrupt-<time>` before starting empty; entries that no longer
// validate, duplicates and entries over the 2,000 cap are kept aside in `invalid` and written back, never dropped. A
// file written by a newer version (version > 1) is listed (known fields only, `readOnly`) but never rewritten: every
// write is refused with 409 GLOSSARY_READ_ONLY. Entry rules (texts, caps, merge by target) are @jasper/project's.
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { basename } from 'node:path';
import {
	GLOSSARY_FORMAT,
	GLOSSARY_LIMITS,
	GLOSSARY_VERSION,
	type GlossaryEntry,
	GlossaryEntryReadSchema,
	GlossaryEntrySchema,
	GlossaryError,
	type GlossaryFile,
	type GlossaryInput,
	type GlossaryPatch,
	glossaryIdFrom,
	importGlossaryEntries,
	parseGlossaryImport,
	updateGlossaryEntry,
	upsertGlossaryEntry,
} from '@jasper/project';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

type State = {
	version: number;
	revision: number;
	entries: GlossaryEntry[];
	invalid: unknown[];
};

export type GlossaryListing = {
	revision: number;
	readOnly: boolean;
	repairs: string[];
	limits: { maxEntries: number; maxSpellings: number; maxChars: number };
	entries: GlossaryEntry[];
};

/** Maps a refusal of the merge rules to the route error. */
function httpOf(e: unknown): unknown {
	if (!(e instanceof GlossaryError)) return e;
	const status =
		e.code === 'GLOSSARY_NOT_FOUND'
			? 404
			: e.code === 'GLOSSARY_INVALID'
				? 400
				: 409; /* GLOSSARY_LIMIT, GLOSSARY_DUPLICATE */
	return new HttpError(status, e.code, e.message, e.detail);
}

const keyOf = (e: GlossaryEntry) => `${e.lang ?? ''}\u0000${e.to}`;

export class SpeechGlossary {
	private state: State | null = null;
	private chain: Promise<void> = Promise.resolve();
	private readonly repairs: string[] = [];

	constructor(
		private readonly file: string,
		private readonly opts: {
			onChange?: (revision: number) => void;
			log?: (m: string) => void;
			now?: () => string;
		} = {},
	) {}

	private note(m: string): void {
		this.repairs.push(m);
		this.opts.log?.(`speech glossary: ${m}`);
	}

	private now(): string {
		return this.opts.now?.() ?? new Date().toISOString();
	}

	private async load(): Promise<State> {
		if (this.state) return this.state;
		const empty: State = { version: GLOSSARY_VERSION, revision: 0, entries: [], invalid: [] };
		let raw: Record<string, unknown> | null = null;
		try {
			raw = await readJsonOrNull<Record<string, unknown>>(this.file);
		} catch (e) {
			// A directory where the file should be is as unreadable as broken JSON; real I/O failures propagate.
			if ((e as { code?: string }).code !== 'EISDIR') throw e;
		}
		const version =
			raw && typeof raw === 'object' && typeof raw.version === 'number' && Number.isInteger(raw.version)
				? raw.version
				: null;
		if (
			!raw ||
			typeof raw !== 'object' ||
			Array.isArray(raw) ||
			raw.format !== GLOSSARY_FORMAT ||
			version === null ||
			version < 1
		) {
			if (await exists(this.file)) {
				const aside = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, aside);
				this.note(
					`the glossary file was unreadable; it was moved aside as ${basename(aside)} and an empty glossary was started`,
				);
			}
			this.state = empty;
			return empty;
		}
		const readOnly = version > GLOSSARY_VERSION;
		// Reported as `readOnly` (not a repair: nothing was changed).
		if (readOnly)
			this.opts.log?.(
				`speech glossary: written by a newer JasperEditor (version ${version}); read-only here`,
			);
		const schema = readOnly ? GlossaryEntryReadSchema : GlossaryEntrySchema;
		const entries: GlossaryEntry[] = [];
		const invalid: unknown[] = Array.isArray(raw.invalid) ? [...(raw.invalid as unknown[])] : [];
		const ids = new Set<string>();
		const keys = new Set<string>();
		let bad = 0;
		let over = 0;
		const list = Array.isArray(raw.entries) ? (raw.entries as unknown[]) : [];
		if (!Array.isArray(raw.entries) && raw.entries !== undefined && !readOnly)
			this.note('the glossary had no list of entries; it was started empty');
		for (const item of list) {
			const r = schema.safeParse(item);
			if (!r.success || ids.has(r.data.id) || keys.has(keyOf(r.data as GlossaryEntry))) {
				bad++;
				invalid.push(item);
				continue;
			}
			if (entries.length >= GLOSSARY_LIMITS.maxEntries) {
				over++;
				invalid.push(item);
				continue;
			}
			ids.add(r.data.id);
			keys.add(keyOf(r.data as GlossaryEntry));
			entries.push(r.data as GlossaryEntry);
		}
		if (bad)
			this.note(
				readOnly
					? `${bad} glossary entr${bad === 1 ? 'y' : 'ies'} could not be read`
					: `${bad} glossary entr${bad === 1 ? 'y' : 'ies'} that no longer validate${bad === 1 ? 's' : ''} ${bad === 1 ? 'was' : 'were'} kept aside in the file (key “invalid”)`,
			);
		if (over)
			this.note(
				`${over} entr${over === 1 ? 'y' : 'ies'} over the limit of ${GLOSSARY_LIMITS.maxEntries} ${over === 1 ? 'was' : 'were'} kept aside in the file (key “invalid”)`,
			);
		this.state = {
			version,
			revision:
				typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0
					? raw.revision
					: 0,
			entries,
			invalid: readOnly ? [] : invalid,
		};
		return this.state;
	}

	private get readOnlyNow(): boolean {
		return (this.state?.version ?? GLOSSARY_VERSION) > GLOSSARY_VERSION;
	}

	/**
	 * Runs a change alone: `fn` returns the next entries (or null: nothing changed, nothing written); the file is
	 * written atomically before the in-memory state moves, so a failed write changes nothing.
	 */
	private mutate<T>(fn: (entries: readonly GlossaryEntry[]) => { entries: GlossaryEntry[] | null; out: T }) {
		const run = this.chain.then(async () => {
			const s = await this.load();
			if (this.readOnlyNow)
				throw new HttpError(
					409,
					'GLOSSARY_READ_ONLY',
					'The glossary was written by a newer JasperEditor; it cannot be changed with this version',
				);
			let r: { entries: GlossaryEntry[] | null; out: T };
			try {
				r = fn(s.entries);
			} catch (e) {
				throw httpOf(e);
			}
			if (!r.entries) return { out: r.out, revision: s.revision };
			const next: State = { ...s, revision: s.revision + 1, entries: r.entries };
			const file: GlossaryFile & { invalid?: unknown[] } = {
				format: GLOSSARY_FORMAT,
				version: GLOSSARY_VERSION,
				revision: next.revision,
				entries: next.entries,
				...(next.invalid.length ? { invalid: next.invalid } : {}),
			};
			await atomicWriteJson(this.file, file, true);
			this.state = next;
			this.opts.onChange?.(next.revision);
			return { out: r.out, revision: next.revision };
		});
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private ctx() {
		return { now: this.now(), newId: () => glossaryIdFrom(randomBytes(16)) };
	}

	async list(): Promise<GlossaryListing> {
		await this.chain;
		const s = await this.load();
		return structuredClone({
			revision: s.revision,
			readOnly: this.readOnlyNow,
			repairs: [...this.repairs],
			limits: {
				maxEntries: GLOSSARY_LIMITS.maxEntries,
				maxSpellings: GLOSSARY_LIMITS.maxSpellings,
				maxChars: GLOSSARY_LIMITS.maxChars,
			},
			entries: s.entries,
		});
	}

	async get(id: string): Promise<GlossaryEntry> {
		const e = (await this.list()).entries.find((x) => x.id === id);
		if (!e) throw new HttpError(404, 'GLOSSARY_NOT_FOUND', `Glossary entry not found: ${id.slice(0, 40)}`);
		return e;
	}

	/** The importable file (`jasper-speech-glossary` v1; entries kept aside are not exported). */
	async exportFile(): Promise<GlossaryFile> {
		const l = await this.list();
		return { format: GLOSSARY_FORMAT, version: GLOSSARY_VERSION, revision: l.revision, entries: l.entries };
	}

	/** Add, or merge into the entry with the same target and language; `remember` also counts it (SC-071). */
	async save(
		input: GlossaryInput,
		remember = false,
	): Promise<{ revision: number; created: boolean; changed: boolean; entry: GlossaryEntry }> {
		const ctx = this.ctx();
		const r = await this.mutate((entries) => {
			const u = upsertGlossaryEntry(entries, input, { ...ctx, remember });
			return {
				entries: u.changed ? u.entries : null,
				out: { created: u.created, changed: u.changed, entry: u.entry },
			};
		});
		return { revision: r.revision, ...r.out };
	}

	async update(id: string, patch: GlossaryPatch): Promise<{ revision: number; entry: GlossaryEntry }> {
		const now = this.now();
		const r = await this.mutate((entries) => {
			const u = updateGlossaryEntry(entries, id, patch, now);
			return { entries: u.changed ? u.entries : null, out: u.entry };
		});
		return { revision: r.revision, entry: r.out };
	}

	async remove(id: string): Promise<{ removed: string; revision: number }> {
		const r = await this.mutate((entries) => {
			if (!entries.some((e) => e.id === id))
				throw new GlossaryError('GLOSSARY_NOT_FOUND', `Glossary entry not found: ${id.slice(0, 40)}`);
			return { entries: entries.filter((e) => e.id !== id), out: id };
		});
		return { removed: r.out, revision: r.revision };
	}

	/** Merges a glossary file (SC-070 import; additive). A file of another format or a newer version → 400. */
	async import(raw: unknown): Promise<{
		revision: number;
		added: number;
		merged: number;
		unchanged: number;
		skipped: Array<{ index: number; reason: string }>;
	}> {
		const parsed = parseGlossaryImport(raw);
		if (!parsed.ok) throw new HttpError(400, 'GLOSSARY_IMPORT_INVALID', parsed.reason);
		const ctx = this.ctx();
		const r = await this.mutate((entries) => {
			const m = importGlossaryEntries(entries, parsed.entries, ctx);
			return {
				entries: m.added || m.merged ? m.entries : null,
				out: { added: m.added, merged: m.merged, unchanged: m.unchanged, skipped: m.skipped },
			};
		});
		return {
			revision: r.revision,
			...r.out,
			skipped: [
				...parsed.skipped,
				...r.out.skipped.map((x) => ({ ...x, index: parsed.indices[x.index] ?? x.index })),
			]
				.sort((a, b) => a.index - b.index)
				.slice(0, 1000),
		};
	}
}
