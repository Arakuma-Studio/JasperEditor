// User sound folders (spec 12 §2.1 source 3, §2.8; wp-note "WP1.2"): `<appdir>/sounds/roots.json`, folders indexed in
// place, each with the licence the user declares for it. Local mode only (D-47: paths from requests are taken in
// local mode only); paths must be absolute, without NUL, are normalised and resolved through symlinks, must be an
// existing folder, and may not be a file-system root (a whole disk is not a sound folder; scans are bounded anyway).
// Writes are atomic; an unreadable file is moved aside and the list starts empty (the index keeps nothing of it).
import { randomBytes } from 'node:crypto';
import { realpath, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { SOUND_ROOTS_MAX, type SoundRoot, SoundRootSchema, type SoundRootsPutRequest } from '@jasper/api';
import { USER_PROVIDED_LICENSE } from '@jasper/project';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

type RootsFile = { version: 1; roots: SoundRoot[] };

/** A folder whose credit line changes, and how (for the approval card). */
export type SoundRootCreditChange = { root: SoundRoot; changes: string[] };

export type SoundRootsPlan = {
	next: SoundRoot[];
	added: SoundRoot[];
	removed: SoundRoot[];
	relicensed: SoundRoot[];
	recredited: SoundRootCreditChange[];
	/** The list's revision the plan was made from. */
	revision: number;
};

export function newRootId(): string {
	return `root_${randomBytes(6).toString('hex')}`;
}

/** Validates a folder path from a request and returns its real, normalised location. */
export async function checkRootPath(p: string): Promise<string> {
	if (p.includes('\0')) throw new HttpError(400, 'BAD_PATH', 'The path contains a NUL byte');
	if (!isAbsolute(p)) throw new HttpError(400, 'BAD_PATH', 'The folder path must be absolute');
	let real: string;
	try {
		real = await realpath(resolve(p));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'EACCES' || code === 'EPERM')
			throw new HttpError(403, 'PERMISSION_DENIED', 'The folder cannot be read (permission denied)');
		throw new HttpError(404, 'NOT_FOUND', 'The folder does not exist');
	}
	const st = await stat(real).catch(() => null);
	if (!st?.isDirectory()) throw new HttpError(400, 'NOT_A_FOLDER', 'The path is not a folder');
	if (parse(real).root === real || dirname(real) === real)
		throw new HttpError(400, 'BAD_PATH', 'A whole disk cannot be a sound folder; choose a folder on it');
	return real;
}

export class SoundRootStore {
	private roots: SoundRoot[] | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	/** Bumped on every change (the index job rescans when it changed during a run). */
	revision = 0;

	constructor(
		private readonly file: string,
		private readonly log: (m: string) => void = () => {},
	) {}

	async list(): Promise<SoundRoot[]> {
		await this.chain.catch(() => undefined);
		return structuredClone(await this.load());
	}

	private async load(): Promise<SoundRoot[]> {
		if (this.roots) return this.roots;
		let raw: unknown = null;
		try {
			raw = await readJsonOrNull(this.file);
		} catch {
			raw = null;
		}
		const roots: SoundRoot[] = [];
		const list = raw && typeof raw === 'object' ? (raw as { roots?: unknown }).roots : undefined;
		if (raw === null && (await exists(this.file))) {
			const aside = `${this.file}.corrupt-${Date.now()}`;
			await rename(this.file, aside).catch(() => undefined);
			this.log(`sound folders: unreadable list moved to ${aside}`);
		}
		const seen = new Set<string>();
		for (const r of Array.isArray(list) ? list.slice(0, SOUND_ROOTS_MAX) : []) {
			const p = SoundRootSchema.safeParse(r);
			if (p.success && !seen.has(p.data.id)) {
				seen.add(p.data.id);
				roots.push(p.data);
			}
		}
		this.roots = roots;
		return roots;
	}

	/**
	 * Works out the new list of a `PUT` (validating every new or moved path) without saving it: what an agent would
	 * change is shown on the approval card first. `revision` is the list's revision the plan was made from: saving it
	 * with `save(next, revision)` refuses when the list changed meanwhile.
	 */
	async plan(body: SoundRootsPutRequest, now: string): Promise<SoundRootsPlan> {
		const current = await this.list();
		const revision = this.revision;
		const byId = new Map(current.map((r) => [r.id, r]));
		const next: SoundRoot[] = [];
		const paths = new Set<string>();
		for (const item of body.roots) {
			const prev = item.id ? byId.get(item.id) : undefined;
			const path = prev && resolve(item.path) === prev.path ? prev.path : await checkRootPath(item.path);
			if (paths.has(path)) throw new HttpError(400, 'DUPLICATE_FOLDER', `The folder ${path} is listed twice`);
			paths.add(path);
			const label = (item.label ?? prev?.label ?? (path.split(/[\\/]/).filter(Boolean).pop() || path)).trim();
			const root: SoundRoot = {
				id: prev?.id ?? newRootId(),
				path,
				label: label.slice(0, 200),
				license: item.license ?? prev?.license ?? (USER_PROVIDED_LICENSE as SoundRoot['license']),
				enabled: item.enabled ?? prev?.enabled ?? true,
				addedAt: prev?.addedAt ?? now,
			};
			const tpl = item.attributionTemplate ?? prev?.attributionTemplate;
			if (tpl?.trim()) root.attributionTemplate = tpl.trim();
			const author = item.author ?? prev?.author;
			if (author?.trim()) root.author = author.trim();
			next.push(SoundRootSchema.parse(root));
		}
		const nextIds = new Set(next.map((r) => r.id));
		const added = next.filter((r) => {
			const prev = byId.get(r.id);
			return !prev || prev.path !== r.path;
		});
		const removed = current.filter(
			(r) => !nextIds.has(r.id) || next.find((n) => n.id === r.id)?.path !== r.path,
		);
		const relicensed = next.filter((r) => {
			const prev = byId.get(r.id);
			return !!prev && prev.path === r.path && prev.license !== r.license;
		});
		// The credit line of its sounds changes: another author or template, or (when the template names the folder)
		// another label.
		const recredited: SoundRootCreditChange[] = [];
		for (const r of next) {
			const prev = byId.get(r.id);
			if (!prev || prev.path !== r.path) continue;
			const changes: string[] = [];
			if ((prev.author ?? '') !== (r.author ?? ''))
				changes.push(`author "${prev.author ?? ''}" → "${r.author ?? ''}"`);
			if ((prev.attributionTemplate ?? '') !== (r.attributionTemplate ?? ''))
				changes.push(
					`credit template "${prev.attributionTemplate ?? ''}" → "${r.attributionTemplate ?? ''}"`,
				);
			else if (prev.label !== r.label && (r.attributionTemplate ?? '').includes('{folder}'))
				changes.push(`folder name in its credit line "${prev.label}" → "${r.label}"`);
			if (changes.length) recredited.push({ root: r, changes });
		}
		return { next, added, removed, relicensed, recredited, revision };
	}

	/**
	 * Saves a planned list (atomic). With `expectedRevision`, refuses (409 `SOUND_ROOTS_CHANGED`) when the list was
	 * changed since that revision (a plan made before another change must not undo it).
	 */
	save(next: SoundRoot[], expectedRevision?: number): Promise<SoundRoot[]> {
		const run = this.chain
			.catch(() => undefined)
			.then(async () => {
				if (expectedRevision !== undefined && expectedRevision !== this.revision)
					throw new HttpError(
						409,
						'SOUND_ROOTS_CHANGED',
						'The sound folder list changed while this change waited; read the folders again and repeat it',
					);
				const file: RootsFile = { version: 1, roots: next };
				await atomicWriteJson(this.file, file, true);
				this.roots = structuredClone(next);
				this.revision++;
				return structuredClone(next);
			});
		this.chain = run;
		return run;
	}
}
