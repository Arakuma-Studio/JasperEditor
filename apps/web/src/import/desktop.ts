// The Electron preload bridge as seen from the SPA (ARCHITECTURE §12). Only `pickMedia` matters for import:
// it returns absolute paths that are registered in place through `POST /api/media/register`.
export type DesktopBridge = {
	runtime: 'desktop';
	pickMedia(): Promise<string[]>;
	revealInFolder?(path: string): void;
};

export function getDesktopBridge(): DesktopBridge | null {
	if (typeof window === 'undefined') return null;
	const b = (window as { jasperDesktop?: DesktopBridge }).jasperDesktop;
	return b && typeof b.pickMedia === 'function' ? b : null;
}

/** File extensions accepted by the web file picker (S01:LIFE-011, S04:IN-001). */
const IMPORT_ACCEPT = [
	'video/*',
	'audio/*',
	'image/*',
	'.mp4',
	'.mov',
	'.m4v',
	'.mkv',
	'.webm',
	'.avi',
	'.mxf',
	'.ts',
	'.m2ts',
	'.wav',
	'.aif',
	'.aiff',
	'.mp3',
	'.aac',
	'.m4a',
	'.flac',
	// M2: LUTs register as kind 'lut' (wp-m2-color adds the engine prober).
	'.cube',
	'.ogg',
	'.opus',
	'.png',
	'.jpg',
	'.jpeg',
	'.webp',
	'.avif',
	'.gif',
	'.heic',
	'.bmp',
	'.tif',
	'.tiff',
	'.svg',
	// M3 (S07:PRC-019): a source-range sidecar picked together with a rendered video.
	'.json',
	// wp captions: caption files import onto caption tracks.
	'.srt',
	'.vtt',
	'.scc',
	'.mcc',
	'.stl',
	'.ttml',
	'.dfxp',
	'.xml',
	// wp interchange: timeline documents.
	'.fcpxml',
	'.otio',
	'.edl',
	'.aaf',
	'.omf',
	'.ale',
].join(',');

/** Opens the browser file picker (web) and resolves with the chosen files (empty when cancelled). */
export function pickFilesInBrowser(doc: Document = document): Promise<File[]> {
	return new Promise((resolve) => {
		const input = doc.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = IMPORT_ACCEPT;
		input.style.display = 'none';
		const done = () => {
			resolve(Array.from(input.files ?? []));
			input.remove();
		};
		input.addEventListener('change', done, { once: true });
		input.addEventListener('cancel', () => {
			resolve([]);
			input.remove();
		});
		doc.body.appendChild(input);
		input.click();
	});
}

export function baseName(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}
