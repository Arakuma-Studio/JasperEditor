// sessionStorage survives reloads but is copied by duplicated tabs. A remembered lease may be reclaimed
// only after asking live pages over BroadcastChannel whether they still hold it. Page-unload releases
// are best effort, so memory must survive until a clean release or confirmed takeover.
import { z } from 'zod';

const STORAGE_KEY = 'jasper:tab-leases';
const CHANNEL = 'jasper:tab-leases';
/** How long a probe waits for a live page to claim a lease (BroadcastChannel delivers in milliseconds). */
export const TAB_LEASE_PROBE_MS = 250;

const ProbeSchema = z.object({
	kind: z.literal('probe'),
	nonce: z.string(),
	projectId: z.string(),
	sessionId: z.string(),
});
const ClaimSchema = z.object({ kind: z.literal('claim'), nonce: z.string() });
type LeaseMessage = z.infer<typeof ProbeSchema> | z.infer<typeof ClaimSchema>;
const LeaseMapSchema = z.record(z.string(), z.string());

export type TabLeaseRegistry = {
	/** Records that this tab holds the project's lease as `sessionId` (and claims it while the page lives). */
	remember(projectId: string, sessionId: string): void;
	/** The lease was released cleanly (or lost to someone else): neither remember nor claim it. */
	forget(projectId: string, sessionId: string): void;
	/** The page is going away: stop claiming leases, but keep remembering them for the next page of the tab. */
	unload(): void;
	/**
	 * True while a session of this page holds or is releasing a lease (a route change or a React StrictMode
	 * double mount closes one session while the next opens: the opener waits for that release).
	 */
	isPageSession(sessionId: string): boolean;
	/**
	 * True when `holderSessionId` held `projectId` for an earlier page of this tab and no live page claims it
	 * any more, i.e. the lease is a leftover of a reload and may be taken over.
	 */
	isLeftover(projectId: string, holderSessionId: string): Promise<boolean>;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type ChannelLike = {
	postMessage(m: LeaseMessage): void;
	/** Node's BroadcastChannel keeps the process alive unless unref'd (tests under happy-dom). */
	unref?(): void;
	addEventListener(type: 'message', l: (e: { data: unknown }) => void): void;
	removeEventListener(type: 'message', l: (e: { data: unknown }) => void): void;
};

export type BrowserTabLeaseOptions = {
	/** The tab's `sessionStorage`; null outside a browser (the page then only tracks its own sessions). */
	storage: StorageLike | null;
	channel: ChannelLike | null;
	probeMs?: number;
};

function readMap(storage: StorageLike | null): Record<string, string> {
	if (!storage) return {};
	try {
		const raw = storage.getItem(STORAGE_KEY);
		const parsed = LeaseMapSchema.safeParse(raw ? JSON.parse(raw) : {});
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

function writeMap(storage: StorageLike | null, map: Record<string, string>): void {
	if (!storage) return;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(map));
	} catch {
		// quota or a disabled storage: the tab just cannot reclaim after a reload
	}
}

const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The registry over a storage and a channel (injected so tests can model several tabs). */
export function createTabLeaseRegistry(opts: BrowserTabLeaseOptions): TabLeaseRegistry {
	const { storage, channel } = opts;
	const probeMs = opts.probeMs ?? TAB_LEASE_PROBE_MS;
	/** Leases this page holds right now (projectId → sessionId); only these are claimed. */
	const live = new Map<string, string>();
	/** Session ids holding or releasing a lease from this page. */
	const pageSessions = new Set<string>();
	const onMessage = (e: { data: unknown }) => {
		const parsed = ProbeSchema.safeParse(e.data);
		if (!parsed.success) return;
		const m = parsed.data;
		if (live.get(m.projectId) === m.sessionId) channel?.postMessage({ kind: 'claim', nonce: m.nonce });
	};
	let listening = false;
	const listen = (on: boolean) => {
		if (!channel || on === listening) return;
		if (on) channel.addEventListener('message', onMessage);
		else channel.removeEventListener('message', onMessage);
		listening = on;
	};

	return {
		remember(projectId, sessionId) {
			live.set(projectId, sessionId);
			pageSessions.add(sessionId);
			listen(true);
			const map = readMap(storage);
			if (map[projectId] !== sessionId) writeMap(storage, { ...map, [projectId]: sessionId });
		},
		forget(projectId, sessionId) {
			if (live.get(projectId) === sessionId) live.delete(projectId);
			pageSessions.delete(sessionId);
			if (live.size === 0) listen(false);
			const map = readMap(storage);
			if (map[projectId] === sessionId) {
				delete map[projectId];
				writeMap(storage, map);
			}
		},
		unload() {
			live.clear();
			pageSessions.clear();
			listen(false);
		},
		isPageSession: (sessionId) => pageSessions.has(sessionId),
		async isLeftover(projectId, holderSessionId) {
			if (readMap(storage)[projectId] !== holderSessionId) return false;
			if (pageSessions.has(holderSessionId)) return false;
			if (!channel) return true;
			const id = nonce();
			const claimed = await new Promise<boolean>((resolve) => {
				const done = (v: boolean) => {
					clearTimeout(timer);
					channel.removeEventListener('message', onClaim);
					resolve(v);
				};
				const onClaim = (e: { data: unknown }) => {
					const parsed = ClaimSchema.safeParse(e.data);
					if (parsed.success && parsed.data.nonce === id) done(true);
				};
				const timer = setTimeout(() => done(false), probeMs);
				channel.addEventListener('message', onClaim);
				channel.postMessage({ kind: 'probe', nonce: id, projectId, sessionId: holderSessionId });
			});
			// A duplicated tab inherited the id from a live tab: drop it so this tab stops asking.
			if (claimed) {
				const map = readMap(storage);
				if (map[projectId] === holderSessionId) {
					delete map[projectId];
					writeMap(storage, map);
				}
			}
			return !claimed;
		},
	};
}

let pageRegistry: TabLeaseRegistry | null = null;

/**
 * The registry of this page: `sessionStorage` + a BroadcastChannel when the page has them; outside a browser it
 * only tracks the page's (process's) own sessions, so a held lease is never reclaimed there.
 */
export function pageTabLeases(): TabLeaseRegistry {
	if (pageRegistry) return pageRegistry;
	const g = globalThis as {
		sessionStorage?: StorageLike;
		BroadcastChannel?: new (name: string) => ChannelLike;
		window?: Window;
	};
	let storage: StorageLike | undefined;
	try {
		storage = g.window ? g.sessionStorage : undefined;
	} catch {
		storage = undefined; // sandboxed iframes throw on access
	}
	let channel: ChannelLike | null = null;
	try {
		channel = storage && g.BroadcastChannel ? new g.BroadcastChannel(CHANNEL) : null;
		channel?.unref?.();
	} catch {
		channel = null;
	}
	pageRegistry = createTabLeaseRegistry({ storage: storage ?? null, channel });
	return pageRegistry;
}
