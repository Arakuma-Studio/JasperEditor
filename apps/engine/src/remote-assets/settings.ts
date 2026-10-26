// Network-use preferences (Settings ▸ Privacy & Network, spec 04 OF-002) and the first-fetch notice state, stored in
// `<appdir>/engine/network.json` (atomic writes, zod-validated reads: a corrupt file falls back to the defaults and is
// rewritten on the next change, never fatal — AGENTS §0).
import {
	DEFAULT_NETWORK_SETTINGS,
	type NetworkSettings,
	NetworkSettingsSchema,
	type RemoteAssetFetch,
	RemoteAssetFetchSchema,
} from '@jasper/api';
import { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

/** Downloads listed in the first-fetch notice (the first ones; the notice says "and more"). */
export const NOTICE_MAX_ITEMS = 12;

const NoticeSchema = z.object({
	firstFetchAt: z.string(),
	items: z.array(RemoteAssetFetchSchema).max(NOTICE_MAX_ITEMS),
	acknowledged: z.boolean(),
});
type Notice = z.infer<typeof NoticeSchema>;

const FileSchema = z.object({
	settings: NetworkSettingsSchema.catch(DEFAULT_NETWORK_SETTINGS),
	notice: NoticeSchema.nullable().catch(null),
});
type FileShape = z.infer<typeof FileSchema>;

export class NetworkSettingsStore {
	private readonly mutex = new KeyedMutex();
	private cached: FileShape | null = null;

	constructor(private readonly file: string) {}

	private async read(): Promise<FileShape> {
		if (this.cached) return this.cached;
		let raw: unknown = null;
		try {
			raw = await readJsonOrNull(this.file);
		} catch {
			raw = null; // unreadable: defaults
		}
		const r = FileSchema.safeParse(raw ?? {});
		this.cached = r.success ? r.data : { settings: DEFAULT_NETWORK_SETTINGS, notice: null };
		return this.cached;
	}

	private async write(next: FileShape): Promise<void> {
		await atomicWriteJson(this.file, next, true);
		this.cached = next;
	}

	async get(): Promise<NetworkSettings> {
		return (await this.read()).settings;
	}

	async put(next: NetworkSettings): Promise<NetworkSettings> {
		const settings = NetworkSettingsSchema.parse(next);
		return this.mutex.run('network', async () => {
			await this.write({ ...(await this.read()), settings });
			return settings;
		});
	}

	async notice(): Promise<Notice | null> {
		return (await this.read()).notice;
	}

	/**
	 * Records a successful download for the first-fetch notice: the first one creates the notice, later ones are
	 * listed until it is acknowledged (or the list is full). Returns whether the notice is pending.
	 */
	async recordFetch(item: RemoteAssetFetch, now: Date): Promise<boolean> {
		return this.mutex.run('network', async () => {
			const cur = await this.read();
			if (cur.notice?.acknowledged) return false;
			const n: Notice = cur.notice ?? { firstFetchAt: now.toISOString(), items: [], acknowledged: false };
			if (
				n.items.length < NOTICE_MAX_ITEMS &&
				!n.items.some((i) => i.kind === item.kind && i.label === item.label)
			)
				await this.write({ ...cur, notice: { ...n, items: [...n.items, item] } });
			else if (!cur.notice) await this.write({ ...cur, notice: n });
			return true;
		});
	}

	async acknowledge(): Promise<void> {
		await this.mutex.run('network', async () => {
			const cur = await this.read();
			if (!cur.notice || cur.notice.acknowledged) return;
			await this.write({ ...cur, notice: { ...cur.notice, acknowledged: true } });
		});
	}
}
