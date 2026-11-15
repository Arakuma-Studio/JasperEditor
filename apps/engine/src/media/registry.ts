// Media registry: `<appdir>/engine/media-index.json` maps engine-issued media keys to files on disk
// (ARCHITECTURE §4.3, D-09). Written atomically. The engine is the only authority mapping a key to bytes
// (S04:AS-004, SC-003); offline detection compares size and mtime (S04:AS-010).
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { RegisteredMedia } from '@jasper/api';
import type {
	ColorConfigInfo,
	ImageSequenceInfo,
	LayeredInfo,
	LottieInfo,
	LutInfo,
	MediaKind,
	MediaLocator,
	MediaProbe,
	MgBundleInfo,
	VectorInfo,
} from '@jasper/project';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import type { BrowserPlayable } from './probe.ts';

type MediaStorage =
	/** The user's own file, referenced in place and never modified (S04:AS-003). */
	| { type: 'path'; path: string }
	/** A copy owned by the engine under `<appdir>/media/<mediaKey>/` (uploads, "copy into project"). */
	| { type: 'managed'; path: string };

export type MediaRecord = {
	mediaKey: string;
	fingerprint: string;
	originalName: string;
	sizeBytes: number;
	mtimeMs: number;
	container: string;
	kind: MediaKind;
	probe: MediaProbe;
	browserPlayable: BrowserPlayable;
	storage: MediaStorage;
	durationSec: number | null;
	display: { width: number; height: number } | null;
	hasAudio: boolean;
	interlaced?: boolean;
	registeredAt: string;
	lut?: LutInfo;
	vector?: VectorInfo;
	lottie?: LottieInfo;
	layered?: LayeredInfo;
	imageSequence?: ImageSequenceInfo;
	/** Bundle media are stored as directories. */
	mgBundle?: MgBundleInfo;
	colorConfig?: ColorConfigInfo;
	/**
	 * M2: an engine-produced processed version (wp-m2-process): source key and recipe hash; M3 (S07:PRC-015): the
	 * processed source frames when a range was processed.
	 */
	derivedFrom?: { mediaKey: string; recipeHash: string; range?: { startFrame: number; endFrame: number } };
};

type IndexFile = { version: 1; engineId: string; items: Record<string, MediaRecord> };

type Availability = 'online' | 'missing';

/**
 * The file of a record is still the one registered: it exists with the recorded size and, for the user's own files,
 * the recorded mtime (S04:AS-010). An export checks the records it planned with against it when it ends.
 */
export async function fileMatches(
	r: Pick<MediaRecord, 'storage' | 'sizeBytes' | 'mtimeMs'>,
): Promise<boolean> {
	try {
		const s = await stat(r.storage.path);
		if (!s.isFile() || s.size !== r.sizeBytes) return false;
		// Managed copies are ours: only the size matters. User files must keep their mtime.
		return r.storage.type !== 'path' || Math.abs(s.mtimeMs - r.mtimeMs) <= 1;
	} catch {
		return false;
	}
}

export class MediaRegistry {
	private readonly mutex = new KeyedMutex();
	private constructor(
		private readonly file: string,
		private index: IndexFile,
	) {}

	static async open(file: string): Promise<MediaRegistry> {
		const raw = await readJsonOrNull<IndexFile>(file);
		const index: IndexFile =
			raw && raw.version === 1 && raw.items && typeof raw.engineId === 'string'
				? raw
				: { version: 1, engineId: `eng_${randomBytes(8).toString('hex')}`, items: {} };
		const reg = new MediaRegistry(file, index);
		if (!raw) await reg.flush();
		return reg;
	}

	/** Stable id of this engine installation (used in `engine-store` locators). */
	get engineId(): string {
		return this.index.engineId;
	}

	get(mediaKey: string): MediaRecord | null {
		return this.index.items[mediaKey] ?? null;
	}

	async put(record: MediaRecord): Promise<void> {
		this.index.items[record.mediaKey] = record;
		await this.flush();
	}

	/** Forgets a record (M3: a discarded, never-committed upload). */
	async remove(mediaKey: string): Promise<void> {
		if (!this.index.items[mediaKey]) return;
		delete this.index.items[mediaKey];
		await this.flush();
	}

	private flush(): Promise<void> {
		return this.mutex.run('index', () => atomicWriteJson(this.file, this.index));
	}

	/** `online` when the file exists with the recorded size and mtime (S04:AS-010). */
	async availability(mediaKey: string): Promise<Availability> {
		const r = this.get(mediaKey);
		return r && (await fileMatches(r)) ? 'online' : 'missing';
	}

	/** Engine-local path of an online media file, or null (offline or unknown key). */
	async resolvePath(mediaKey: string): Promise<string | null> {
		return (await this.availability(mediaKey)) === 'online' ? this.get(mediaKey)!.storage.path : null;
	}

	/** Wire shape returned by register/upload routes (ARCHITECTURE §9.2). */
	toRegistered(r: MediaRecord, opts: { exposePath: boolean }): RegisteredMedia {
		const locators: MediaLocator[] = [{ type: 'engine-store', engineId: this.engineId, key: r.mediaKey }];
		if (opts.exposePath && r.storage.type === 'path') {
			locators.push({ type: 'path', path: r.storage.path, relativeToProject: null });
		}
		return {
			mediaKey: r.mediaKey,
			fingerprint: r.fingerprint,
			originalName: r.originalName,
			sizeBytes: r.sizeBytes,
			container: r.container,
			kind: r.kind,
			probe: r.probe,
			locators,
			browserPlayable: r.browserPlayable,
			...(r.lut ? { lut: r.lut } : {}),
			...(r.mgBundle ? { mgBundle: r.mgBundle } : {}),
			...(r.colorConfig ? { colorConfig: r.colorConfig } : {}),
			...(r.vector ? { vector: r.vector } : {}),
			...(r.lottie ? { lottie: r.lottie } : {}),
			...(r.layered ? { layered: r.layered } : {}),
			...(r.imageSequence ? { imageSequence: r.imageSequence } : {}),
		};
	}
}
