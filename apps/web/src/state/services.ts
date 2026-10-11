// Import service and drag payload contracts (S01:LIFE-010/012, S02:TL-492).
import type { RegisteredMedia } from '@jasper/api';

/** In-app drag of Project panel items onto the timeline/monitors. */
export type ProjectItemsDragPayload = { type: 'jasper/project-items'; itemIds: string[] };
/** OS files dropped from the desktop (web: File objects; Electron: paths via the preload bridge). */
type OsFilesDragPayload = { type: 'os-files'; files: File[]; paths?: string[] };
export type DragPayload = ProjectItemsDragPayload | OsFilesDragPayload;

/** MIME type used on DataTransfer for in-app item drags. */
export const PROJECT_ITEMS_MIME = 'application/x-jasper-project-items';

/** polish (Media Browser): files on the engine host dragged onto the Project panel or the Timeline. */
export const HOST_PATHS_MIME = 'application/x-jasper-host-paths';

/** Writes the Media Browser drag payload: absolute paths on the engine host (registered in place on drop). */
export function writeHostPathsDrag(dt: DataTransfer, paths: string[]): void {
	dt.setData(HOST_PATHS_MIME, JSON.stringify({ paths }));
	dt.setData('text/plain', paths.join('\n'));
	dt.effectAllowed = 'copy';
}

/** The paths of a Media Browser drag, or null when the DataTransfer carries none. */
export function readHostPathsDrag(dt: DataTransfer): string[] | null {
	if (!Array.from(dt.types ?? []).includes(HOST_PATHS_MIME)) return null;
	try {
		const raw = JSON.parse(dt.getData(HOST_PATHS_MIME)) as { paths?: unknown };
		const paths = Array.isArray(raw.paths)
			? raw.paths.filter((x): x is string => typeof x === 'string' && x.length > 0)
			: [];
		return paths.length ? paths : null;
	} catch {
		return null;
	}
}

export type ImportTarget =
	| { kind: 'bin'; binId: string | null }
	| {
			kind: 'timeline';
			sequenceId: string;
			at: number;
			trackId: string;
			mode: 'overwrite' | 'insert';
			/** wp-clipboard-2 (CLB-010): audio goes here when `trackId` is a video track (default: mirrored index). */
			audioTrackId?: string;
	  }
	| { kind: 'program'; sequenceId: string };

export type ImportProgress = {
	fileName: string;
	phase: 'uploading' | 'registering' | 'probing' | 'done' | 'failed';
	loaded: number;
	total: number;
	error?: string;
};

export type ImportResult = {
	/** One "Import N files" transaction was committed with these media and clips (S01:LIFE-010 step 6). */
	mediaIds: string[];
	clipIds: string[];
	failed: { name: string; code: string; message: string }[];
	registered: RegisteredMedia[];
};

export interface ImportService {
	/** Imports OS files (upload on web, path registration on desktop) and commits one transaction. */
	importFiles(
		input: {
			files?: File[];
			paths?: string[];
			/** wp-clipboard-2 (CLB-010): project item names for `files` (same order; default the file name). */
			names?: (string | undefined)[];
		},
		target: ImportTarget,
		onProgress?: (p: ImportProgress) => void,
	): Promise<ImportResult>;
	/** Places existing project items (drag from the Project panel). */
	placeItems(
		payload: ProjectItemsDragPayload,
		target: Extract<ImportTarget, { kind: 'timeline' | 'program' }>,
	): Promise<{ clipIds: string[] }>;
}

// The editor registers the ImportService implementation while a project is open (apps/web/src/home/
// ProjectLifecycle.tsx); timeline/monitor drop handlers look it up here and tolerate `null`.

let currentImportService: ImportService | null = null;

/** Registers the active ImportService; returns the unregister function. */
export function registerImportService(service: ImportService): () => void {
	currentImportService = service;
	return () => {
		if (currentImportService !== service) return;
		currentImportService = null;
	};
}

/** The active ImportService, or null when no project is open. */
export function getImportService(): ImportService | null {
	return currentImportService;
}
