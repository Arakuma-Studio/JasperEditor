// Render previews in the editor (workstream `previews`, docs/wp-notes/previews.md): which segment hashes have preview
// files in the engine. The render bar turns them green and the Program monitor plays them.
//
// Segments and hashes are computed here from the committed document (`previewSegments`, the same pure function the
// engine uses); the engine only answers which hashes have files (`/api/previews/status`). Answers are cached per
// preview format: a hash once seen stays known (files are immutable) until a deletion or a cache cleaning, so an
// undo turns its segments green again without asking. `previews.changed` events add freshly rendered hashes.
import type { PreviewSettings, PreviewStatus, TypedEvent } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';

export type PreviewFormatState = {
	formatKey: string;
	/** Hashes with a video / audio preview file. */
	video: ReadonlySet<string>;
	audio: ReadonlySet<string>;
	videoUrl: string;
	audioUrl: string;
	audioFiles: number;
};

type Entry = PreviewFormatState & {
	/** Hashes already asked about (present or not). */
	asked: Set<string>;
	askedAudio: Set<string>;
};

const settingsKey = (s: PreviewSettings) => `${s.format}|${s.size}|${s.quality}`;

class PreviewStatusStore {
	private client: EngineClient | null = null;
	private readonly entries = new Map<string, Entry>();
	private readonly byFormat = new Map<string, string>();
	private readonly listeners = new Set<() => void>();
	private version = 0;
	private pending = new Map<string, { settings: PreviewSettings; video: Set<string>; audio: Set<string> }>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inflight = 0;

	connect(client: EngineClient | null): void {
		if (this.client === client) return;
		this.client = client;
		this.reset();
	}

	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};

	getVersion = (): number => this.version;

	get(settings: PreviewSettings): PreviewFormatState | null {
		return this.entries.get(settingsKey(settings)) ?? null;
	}

	/** Everything known is dropped (files were deleted or cleaned); the next `ensure` asks again. */
	reset(): void {
		this.entries.clear();
		this.byFormat.clear();
		this.emit();
	}

	private emit(): void {
		this.version++;
		for (const l of [...this.listeners]) l();
	}

	/** Asks the engine (batched, 60 ms) about hashes it has not answered for yet. */
	ensure(settings: PreviewSettings, video: readonly string[], audio: readonly string[]): void {
		if (!this.client) return;
		const key = settingsKey(settings);
		const e = this.entries.get(key);
		const v = e ? video.filter((h) => !e.asked.has(h)) : [...video];
		const a = e ? audio.filter((h) => !e.askedAudio.has(h)) : [...audio];
		if (e && v.length === 0 && a.length === 0) return;
		const p = this.pending.get(key) ?? { settings, video: new Set<string>(), audio: new Set<string>() };
		for (const h of v) p.video.add(h);
		for (const h of a) p.audio.add(h);
		this.pending.set(key, p);
		this.timer ??= setTimeout(() => void this.flush(), 60);
	}

	private async flush(): Promise<void> {
		this.timer = null;
		const client = this.client;
		const batch = [...this.pending.values()];
		this.pending.clear();
		if (!client) return;
		for (const p of batch) {
			this.inflight++;
			try {
				const st = await client.previewStatus({
					settings: p.settings,
					video: [...p.video],
					audio: [...p.audio],
				});
				if (this.client !== client) return;
				this.merge(p.settings, st, p.video, p.audio);
			} catch {
				// engine unavailable: the bar stays yellow/red; the next commit asks again
			} finally {
				this.inflight--;
			}
		}
	}

	private merge(
		settings: PreviewSettings,
		st: PreviewStatus,
		askedV: Set<string>,
		askedA: Set<string>,
	): void {
		const key = settingsKey(settings);
		const prev = this.entries.get(key);
		const e: Entry = {
			formatKey: st.formatKey,
			video: new Set([...(prev?.video ?? []), ...st.video]),
			audio: new Set([...(prev?.audio ?? []), ...st.audio]),
			videoUrl: st.videoUrl,
			audioUrl: st.audioUrl,
			audioFiles: st.audioFiles,
			asked: new Set([...(prev?.asked ?? []), ...askedV]),
			askedAudio: new Set([...(prev?.askedAudio ?? []), ...askedA]),
		};
		this.entries.set(key, e);
		this.byFormat.set(st.formatKey, key);
		this.emit();
	}

	/** Engine events: a rendered segment is green at once; deletions and cleaning forget what is known. */
	onEvent(e: TypedEvent | null): void {
		if (!e) return;
		if (e.type === 'cache.cleaned') {
			this.reset();
			return;
		}
		if (e.type !== 'previews.changed') return;
		const p = e.payload;
		if (p.deleted !== undefined) {
			this.reset();
			return;
		}
		const key = p.formatKey ? this.byFormat.get(p.formatKey) : undefined;
		const entry = key ? this.entries.get(key) : undefined;
		if (!entry || !p.hash) return;
		const next: Entry = {
			...entry,
			...(p.kind === 'audio'
				? { audio: new Set([...entry.audio, p.hash]), audioFiles: entry.audioFiles + 1 }
				: { video: new Set([...entry.video, p.hash]) }),
		};
		this.entries.set(key!, next);
		this.emit();
	}

	/** Pending requests (tests). */
	get busy(): boolean {
		return this.timer !== null || this.inflight > 0;
	}
}

export const previewStatusStore = new PreviewStatusStore();
