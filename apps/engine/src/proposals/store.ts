// Proposal store (spec 12 §0, §2.5, P3-R2): `<appdir>/projects/<pid>/proposals/<id>.json`, one file per proposal,
// written atomically (temp file, fsync, rename). At most 50 per project: creating the 51st evicts the oldest decided
// (or expired) one; when every stored proposal still has undecided items, creation is refused with PROPOSAL_LIMIT
// (never evicted silently). A proposal expires 30 days after its last change. A file that does not parse is moved
// aside as `<id>.json.corrupt-<time>` with a warning, never a crash. The folder lives inside the project's, so
// deleting the project deletes its proposals.
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppdirPaths } from '@jasper/config';
import {
	PROPOSAL_ID_RE,
	PROPOSAL_LIMITS,
	type Proposal,
	ProposalSchema,
	proposalDecided,
} from '@jasper/project';
import { atomicWriteFile } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import { HttpError } from '../tools/reply.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Largest proposal file read (the model allows 20 MB of JSON; a little slack for formatting). */
const MAX_FILE_BYTES = PROPOSAL_LIMITS.maxBytes + 1024 * 1024;

export type ProposalStoreOptions = {
	paths: Pick<AppdirPaths, 'projectProposalsDir' | 'projectFile'>;
	now?: () => Date;
	log?: (msg: string) => void;
	maxPerProject?: number;
	expiryDays?: number;
	/** A proposal left the store on its own (expired, evicted). */
	onRemoved?: (projectId: string, proposal: Proposal, why: 'expired' | 'evicted') => void;
};

export const proposalNotFound = (proposalId: string) =>
	new HttpError(404, 'PROPOSAL_NOT_FOUND', `Proposal not found: ${proposalId}`, { code: 'E_NOT_FOUND' });

export class ProposalStore {
	private readonly mutex = new KeyedMutex();
	private readonly now: () => Date;
	private readonly log: (msg: string) => void;
	readonly maxPerProject: number;
	readonly expiryDays: number;

	constructor(private readonly opts: ProposalStoreOptions) {
		this.now = opts.now ?? (() => new Date());
		this.log = opts.log ?? ((m) => console.warn(m));
		this.maxPerProject = opts.maxPerProject ?? PROPOSAL_LIMITS.maxPerProject;
		this.expiryDays = opts.expiryDays ?? PROPOSAL_LIMITS.expiryDays;
	}

	/** When the proposal expires: its last change plus 30 days. */
	expiresAt(p: Pick<Proposal, 'updatedAt' | 'createdAt'>): string {
		const t = Date.parse(p.updatedAt);
		const base = Number.isFinite(t) ? t : Date.parse(p.createdAt);
		return new Date((Number.isFinite(base) ? base : 0) + this.expiryDays * DAY_MS).toISOString();
	}

	private expired(p: Proposal): boolean {
		return Date.parse(this.expiresAt(p)) <= this.now().getTime();
	}

	private dir(projectId: string): string {
		return this.opts.paths.projectProposalsDir(projectId);
	}

	private file(projectId: string, proposalId: string): string {
		if (!PROPOSAL_ID_RE.test(proposalId)) throw proposalNotFound(proposalId);
		return join(this.dir(projectId), `${proposalId}.json`);
	}

	private projectExists(projectId: string): boolean {
		try {
			return existsSync(this.opts.paths.projectFile(projectId));
		} catch {
			return false;
		}
	}

	/** Reads one file: the proposal, null when absent, or null after moving a corrupt file aside (with a warning). */
	private async read(projectId: string, proposalId: string, warnings?: string[]): Promise<Proposal | null> {
		const file = this.file(projectId, proposalId);
		let text: string;
		try {
			text = await readFile(file, 'utf8');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw e;
		}
		let problem: string | null = null;
		let parsed: Proposal | null = null;
		if (text.length > MAX_FILE_BYTES) problem = 'larger than a proposal can be';
		else {
			try {
				const r = ProposalSchema.safeParse(JSON.parse(text));
				if (!r.success) problem = r.error.issues[0]?.message ?? 'invalid proposal';
				else if (r.data.id !== proposalId || r.data.projectId !== projectId)
					problem = 'its id or project does not match its file';
				else parsed = r.data;
			} catch (e) {
				problem = `not JSON (${(e as Error).message.slice(0, 120)})`;
			}
		}
		if (parsed) return parsed;
		const aside = `${file}.corrupt-${this.now().getTime()}`;
		try {
			await rename(file, aside);
		} catch {
			// a concurrent reader moved it already
		}
		const msg = `Proposal ${proposalId} of project ${projectId} could not be read (${problem}); it was moved aside`;
		this.log(`[proposals] ${msg}: ${aside}`);
		warnings?.push(msg);
		return null;
	}

	private async ids(projectId: string): Promise<string[]> {
		try {
			const names = await readdir(this.dir(projectId));
			return names
				.filter((n) => n.endsWith('.json'))
				.map((n) => n.slice(0, -'.json'.length))
				.filter((id) => PROPOSAL_ID_RE.test(id));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
				return [];
			throw e;
		}
	}

	/** Every readable, unexpired proposal (expired ones are deleted), newest first. */
	list(projectId: string): Promise<{ proposals: Proposal[]; warnings: string[] }> {
		return this.mutex.run(projectId, () => this.listUnlocked(projectId));
	}

	private async listUnlocked(projectId: string): Promise<{ proposals: Proposal[]; warnings: string[] }> {
		const warnings: string[] = [];
		const out: Proposal[] = [];
		for (const id of await this.ids(projectId)) {
			const p = await this.read(projectId, id, warnings);
			if (!p) continue;
			if (this.expired(p)) {
				await rm(this.file(projectId, id), { force: true });
				this.opts.onRemoved?.(projectId, p, 'expired');
				continue;
			}
			out.push(p);
		}
		out.sort((a, b) =>
			a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1,
		);
		return { proposals: out, warnings };
	}

	/** One proposal, or null (absent, expired, unreadable). */
	get(projectId: string, proposalId: string): Promise<Proposal | null> {
		return this.mutex.run(projectId, async () => {
			const p = await this.read(projectId, proposalId);
			if (p && this.expired(p)) {
				await rm(this.file(projectId, proposalId), { force: true });
				this.opts.onRemoved?.(projectId, p, 'expired');
				return null;
			}
			return p;
		});
	}

	/**
	 * Stores a new proposal. Over the limit, the oldest decided proposals (by last change) are evicted first; when
	 * every stored one still has undecided items, refuses with 409 PROPOSAL_LIMIT.
	 */
	create(projectId: string, proposal: Proposal): Promise<{ evicted: string[] }> {
		return this.mutex.run(projectId, async () => {
			if (!this.projectExists(projectId))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
			const { proposals } = await this.listUnlocked(projectId);
			const evicted: string[] = [];
			if (proposals.length >= this.maxPerProject) {
				const decided = proposals
					.filter((p) => proposalDecided(p))
					.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
				const need = proposals.length - this.maxPerProject + 1;
				if (decided.length < need) {
					const undecided = proposals.length - decided.length;
					throw new HttpError(
						409,
						'PROPOSAL_LIMIT',
						`The project already has ${proposals.length} proposals (at most ${this.maxPerProject}), ${undecided} of them still under review: accept, reject or delete one first`,
						{ code: 'E_PROPOSAL_LIMIT', limit: this.maxPerProject, undecided },
					);
				}
				for (const p of decided.slice(0, need)) {
					await rm(this.file(projectId, p.id), { force: true });
					evicted.push(p.id);
					this.opts.onRemoved?.(projectId, p, 'evicted');
				}
			}
			await atomicWriteFile(this.file(projectId, proposal.id), JSON.stringify(proposal));
			return { evicted };
		});
	}

	/** Replaces a stored proposal. PROPOSAL_NOT_FOUND when it was deleted, evicted or expired meanwhile. */
	put(projectId: string, proposal: Proposal): Promise<void> {
		return this.mutex.run(projectId, async () => {
			const file = this.file(projectId, proposal.id);
			if (!existsSync(file) || !this.projectExists(projectId)) throw proposalNotFound(proposal.id);
			await atomicWriteFile(file, JSON.stringify(proposal));
		});
	}

	/** Deletes a proposal; false when there was none. */
	delete(projectId: string, proposalId: string): Promise<boolean> {
		return this.mutex.run(projectId, async () => {
			const file = this.file(projectId, proposalId);
			if (!existsSync(file)) return false;
			await rm(file, { force: true });
			return true;
		});
	}
}
