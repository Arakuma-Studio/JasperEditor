// The last full Sound Check report per sequence (Phase 5 verification, follow-up (e); spec 12 §2.6 "The summary is
// stored in `soundDesign.lastCheck`"): the summary lives in the document, the full report (findings with their fixes,
// the per-event table, listen-here, curves) used to live only in the engine's job, which the engine forgets on restart.
// Every finished `sound-check` job now also writes its result here, like proposals: `<appdir>/projects/<pid>/
// sound-check/<sequenceId>.json`, one file per sequence, atomic (temp file, fsync, rename), the newest run replacing the
// older one. Bounded: at most 32 sequences per project (writing the 33rd evicts the least recently written) and 16 MB
// per report (a larger one is not kept, with a log line; the job's result is unchanged). A file that does not parse is
// moved aside as `<file>.corrupt-<time>` with a warning, never a crash. The folder lives inside the project's, so deleting
// the project deletes its reports. Staleness is the caller's (`POST /api/sound-design/check/last` compares the report's
// hashes with the live document).
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type SoundCheckResult, SoundCheckResultSchema } from '@jasper/api';
import { z } from 'zod';
import { atomicWriteFile } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

/** Sequence ids are document ids; anything else is not stored (a file name must never come from hostile input). */
const SEQ_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const SOUND_CHECK_STORE_LIMITS = { perProject: 32, maxBytes: 16 * 1024 * 1024 } as const;

const StoredSchema = z.object({
	version: z.literal(1),
	savedAt: z.string(),
	jobId: z.string().nullable(),
	result: SoundCheckResultSchema,
});
export type StoredSoundCheck = z.infer<typeof StoredSchema>;

export type SoundCheckReportStoreOptions = {
	/** `<appdir>/projects/<pid>` (AppdirPaths.projectDir). */
	projectDir: (projectId: string) => string;
	now?: () => Date;
	log?: (msg: string) => void;
	perProject?: number;
	maxBytes?: number;
};

export class SoundCheckReportStore {
	private readonly mutex = new KeyedMutex();
	private readonly now: () => Date;
	private readonly log: (msg: string) => void;
	readonly perProject: number;
	readonly maxBytes: number;

	constructor(private readonly opts: SoundCheckReportStoreOptions) {
		this.now = opts.now ?? (() => new Date());
		this.log = opts.log ?? ((m) => console.warn(m));
		this.perProject = opts.perProject ?? SOUND_CHECK_STORE_LIMITS.perProject;
		this.maxBytes = opts.maxBytes ?? SOUND_CHECK_STORE_LIMITS.maxBytes;
	}

	private dir(projectId: string): string {
		return join(this.opts.projectDir(projectId), 'sound-check');
	}

	private file(projectId: string, sequenceId: string): string | null {
		return SEQ_ID_RE.test(sequenceId) ? join(this.dir(projectId), `${sequenceId}.json`) : null;
	}

	/**
	 * Keeps a finished check's result as the sequence's last report (replacing the one before). Resolves whether it was
	 * kept; never rejects (a full disk or a report over the size bound is logged, not thrown: the job already succeeded).
	 */
	save(projectId: string, result: SoundCheckResult, jobId: string | null): Promise<boolean> {
		return this.mutex.run(projectId, async () => {
			try {
				const file = this.file(projectId, result.sequenceId);
				if (!file) return false;
				const stored: StoredSoundCheck = { version: 1, savedAt: this.now().toISOString(), jobId, result };
				const text = JSON.stringify(stored);
				if (text.length > this.maxBytes) {
					this.log(
						`[sound-check] report of ${projectId}/${result.sequenceId} not kept: ${text.length} bytes (at most ${this.maxBytes})`,
					);
					return false;
				}
				await atomicWriteFile(file, text);
				await this.evict(projectId, `${result.sequenceId}.json`);
				return true;
			} catch (e) {
				this.log(
					`[sound-check] report of ${projectId}/${result.sequenceId} not kept: ${(e as Error).message}`,
				);
				return false;
			}
		});
	}

	/** The sequence's last report, or null (none, unreadable — moved aside with a warning — or not this sequence's). */
	get(projectId: string, sequenceId: string): Promise<StoredSoundCheck | null> {
		return this.mutex.run(projectId, async () => {
			const file = this.file(projectId, sequenceId);
			if (!file) return null;
			let text: string;
			try {
				const st = await stat(file);
				if (st.size > this.maxBytes + 1024 * 1024) return this.aside(file, 'larger than a report can be');
				text = await readFile(file, 'utf8');
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
					return null;
				throw e;
			}
			try {
				const r = StoredSchema.safeParse(JSON.parse(text));
				if (!r.success) return this.aside(file, r.error.issues[0]?.message ?? 'invalid report');
				if (r.data.result.sequenceId !== sequenceId || r.data.result.projectId !== projectId)
					return this.aside(file, 'its sequence or project does not match its file');
				return r.data;
			} catch (e) {
				return this.aside(file, `not JSON (${(e as Error).message.slice(0, 120)})`);
			}
		});
	}

	/** Forgets a sequence's report (the sequence was deleted). */
	remove(projectId: string, sequenceId: string): Promise<void> {
		return this.mutex.run(projectId, async () => {
			const file = this.file(projectId, sequenceId);
			if (file) await rm(file, { force: true });
		});
	}

	private async aside(file: string, problem: string): Promise<null> {
		const to = `${file}.corrupt-${this.now().getTime()}`;
		try {
			await rename(file, to);
		} catch {
			// a concurrent reader moved it already
		}
		this.log(`[sound-check] a stored report could not be read (${problem}); it was moved aside: ${to}`);
		return null;
	}

	/** At most `perProject` reports: the least recently written ones go (never `keep`, just written). */
	private async evict(projectId: string, keep: string): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.dir(projectId))).filter((n) => n.endsWith('.json'));
		} catch {
			return;
		}
		if (names.length <= this.perProject) return;
		const dated: { name: string; t: number }[] = [];
		for (const name of names) {
			if (name === keep) continue;
			try {
				dated.push({ name, t: (await stat(join(this.dir(projectId), name))).mtimeMs });
			} catch {
				// gone meanwhile
			}
		}
		dated.sort((a, b) => a.t - b.t || (a.name < b.name ? -1 : 1));
		for (const d of dated.slice(0, names.length - this.perProject))
			await rm(join(this.dir(projectId), d.name), { force: true });
	}
}
