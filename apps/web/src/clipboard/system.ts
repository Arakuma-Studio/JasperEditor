// Clipboard transport (S01:CLB-002): every copy keeps an in-memory copy (same-tab pastes never depend on
// clipboard permissions) and writes the system clipboard: `text/html` with the payload embedded in a marked
// element plus `text/plain`, through a copy event (no permission needed inside a user gesture), and on desktop
// the custom `application/x-jasper-clipboard` format through the Electron clipboard. Pastes read the data the
// browser hands to a paste event, else the Electron clipboard, else the async Clipboard API (may prompt), and
// fall back to the in-memory copy. Foreign content (S01:CLB-010) comes back as `external`: files and image data
// (File objects taken from the paste event while it is dispatched, image types of the async API, desktop file
// paths) and plain text.
import {
	type ClipboardPayload,
	clipboardText,
	decodeClipboardHtml,
	encodeClipboardHtml,
	parseClipboardPayload,
} from '@jasper/project';
import { getDesktopBridge } from '../runtime/platform.ts';

/** What a paste found on the system clipboard (any field may be missing). */
export type ClipboardData = {
	html: string | null;
	text: string | null;
	json?: string | null;
	/** How many files the clipboard holds. */
	files: number;
	/** CLB-010: the files and image data themselves (only present when there are some). */
	blobs?: File[];
	/** CLB-010, desktop: absolute paths of files copied in the OS file manager (registered in place). */
	paths?: string[];
};

export type StoredClipboard = {
	payload: ClipboardPayload;
	json: string;
	text: string;
	/** The system clipboard got the payload (else a later paste trusts the in-memory copy over it). */
	systemWritten: boolean;
	at: number;
};

/** Desktop: the absolute path of a pasted File (Electron `webUtils.getPathForFile`), else null. */
export function desktopPathOf(f: File): string | null {
	try {
		return getDesktopBridge()?.filePath?.(f) || null;
	} catch {
		return null;
	}
}

let memory: StoredClipboard | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of [...listeners]) l();
};

/** The in-memory copy (same tab, CLB-002). */
export const clipboardMemory = {
	get: (): StoredClipboard | null => memory,
	clear(): void {
		memory = null;
		emit();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function readClipboardEvent(e: ClipboardEvent): ClipboardData {
	const d = e.clipboardData;
	const get = (type: string) => {
		try {
			return d?.getData(type) || null;
		} catch {
			return null;
		}
	};
	// File objects must be taken while the event is dispatched: the DataTransfer is emptied afterwards.
	const blobs: File[] = [];
	try {
		for (const f of Array.from(d?.files ?? [])) blobs.push(f);
		if (!blobs.length)
			for (const it of Array.from(d?.items ?? [])) {
				const f = it.kind === 'file' ? it.getAsFile() : null;
				if (f) blobs.push(f);
			}
	} catch {
		// no readable files
	}
	return {
		html: get('text/html'),
		text: get('text/plain'),
		files: Math.max(d?.files?.length ?? 0, blobs.length),
		...(blobs.length ? { blobs } : {}),
	};
}

/** Writes through a synchronous copy event; false when the browser refused (no user gesture). */
function writeViaCopyEvent(doc: Document, html: string, text: string): boolean {
	let wrote = false;
	const onCopy = (e: ClipboardEvent) => {
		if (!e.clipboardData) return;
		e.clipboardData.setData('text/html', html);
		e.clipboardData.setData('text/plain', text);
		e.preventDefault();
		e.stopImmediatePropagation();
		wrote = true;
	};
	doc.addEventListener('copy', onCopy, true);
	try {
		const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
		return ok && wrote;
	} catch {
		return false;
	} finally {
		doc.removeEventListener('copy', onCopy, true);
	}
}

async function writeViaAsyncApi(html: string, text: string): Promise<boolean> {
	try {
		const nav = navigator as Navigator & { clipboard?: Clipboard };
		if (!nav.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
		await nav.clipboard.write([
			new ClipboardItem({
				'text/html': new Blob([html], { type: 'text/html' }),
				'text/plain': new Blob([text], { type: 'text/plain' }),
			}),
		]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copies a payload: the in-memory copy at once, then the system clipboard (on the given copy/cut event, else a
 * synchronous copy event, else the async Clipboard API) and, on desktop, the Electron clipboard.
 */
export function writeClipboard(
	payload: ClipboardPayload,
	opts: { event?: ClipboardEvent } = {},
): StoredClipboard {
	const json = JSON.stringify(payload);
	const text = clipboardText(payload);
	const html = encodeClipboardHtml(json, text);
	const stored: StoredClipboard = { payload, json, text, systemWritten: false, at: Date.now() };
	memory = stored;
	if (opts.event?.clipboardData) {
		opts.event.clipboardData.setData('text/html', html);
		opts.event.clipboardData.setData('text/plain', text);
		opts.event.preventDefault();
		stored.systemWritten = true;
	} else if (typeof document !== 'undefined' && writeViaCopyEvent(document, html, text)) {
		stored.systemWritten = true;
	} else if (typeof navigator !== 'undefined') {
		void writeViaAsyncApi(html, text).then((ok) => {
			if (ok && memory === stored) stored.systemWritten = true;
		});
	}
	const desktop = getDesktopBridge()?.clipboard;
	if (desktop)
		void desktop
			.write({ json, html, text })
			.then((ok) => {
				if (ok && memory === stored) stored.systemWritten = true;
			})
			.catch(() => undefined);
	emit();
	return stored;
}

/** Image types the async Clipboard API may expose (browsers sanitize to `image/png`; others pass unsanitized). */
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)$/;

/** File extension for pasted image data of a MIME type. */
export function imageExtension(type: string): string {
	const sub = type.replace(/^image\//, '').toLowerCase();
	if (sub === 'jpeg') return 'jpg';
	if (sub === 'svg+xml') return 'svg';
	return /^[a-z0-9]+$/.test(sub) ? sub : 'png';
}

/**
 * Reads the system clipboard without a paste event (Edit ▸ Paste): Electron's custom format, else the async
 * Clipboard API (HTML, text and image data) plus, on desktop, the paths of files copied in the file manager.
 */
export async function readSystemClipboard(): Promise<ClipboardData | null> {
	const desktop = getDesktopBridge()?.clipboard;
	let paths: string[] = [];
	if (desktop) {
		try {
			const json = await desktop.read();
			if (json) return { html: null, text: null, json, files: 0 };
		} catch {
			// fall through to the web API
		}
		try {
			paths = (await desktop.readFiles?.()) ?? [];
		} catch {
			paths = [];
		}
	}
	const withPaths = (d: ClipboardData): ClipboardData =>
		paths.length ? { ...d, files: d.files + paths.length, paths } : d;
	const onlyPaths = () => (paths.length ? withPaths({ html: null, text: null, files: 0 }) : null);
	try {
		const nav = navigator as Navigator & { clipboard?: Clipboard };
		if (!nav.clipboard?.read) return onlyPaths();
		const items = await nav.clipboard.read();
		let html: string | null = null;
		let text: string | null = null;
		const blobs: File[] = [];
		for (const it of items) {
			if (!html && it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
			if (!text && it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
			const image = it.types.find((t) => IMAGE_TYPES.test(t));
			if (image) {
				const blob = await it.getType(image);
				blobs.push(new File([blob], `image.${imageExtension(image)}`, { type: image }));
			}
		}
		return withPaths({ html, text, files: blobs.length, ...(blobs.length ? { blobs } : {}) });
	} catch {
		// Permission denied or not focused: the in-memory copy is used.
		return onlyPaths();
	}
}

/** Foreign clipboard content (S01:CLB-010). */
export type ExternalContent = {
	/** Files to import under their own names. */
	files: File[];
	/** Desktop: absolute paths to register in place (no upload, S04:IN-003). */
	paths: string[];
	/** Image data (a copied bitmap, not a file): imported as "Pasted image <time>". */
	images: File[];
	/** Plain text, only when there are no files or images. */
	text: string | null;
};

/** The name browsers give image data pasted as a file (`image.png`). */
const IMAGE_DATA_NAME = /^image\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/**
 * Splits foreign clipboard data into files, image data and text (CLB-010). A pasted File is image data when it is
 * an image with the browser's generic name (`image.png`) or none, and no file path (desktop `pathOf`).
 */
export function externalContentOf(
	data: ClipboardData | null | undefined,
	pathOf: (f: File) => string | null = desktopPathOf,
): ExternalContent {
	const files: File[] = [];
	const images: File[] = [];
	const paths = [...(data?.paths ?? [])];
	for (const f of data?.blobs ?? []) {
		const path = pathOf(f);
		if (path) {
			if (!paths.includes(path)) paths.push(path);
		} else if (f.type.startsWith('image/') && (!f.name || IMAGE_DATA_NAME.test(f.name))) images.push(f);
		else files.push(f);
	}
	const hasFiles = files.length + images.length + paths.length > 0;
	const text = !hasFiles && data?.text?.trim() ? data.text : null;
	return { files, paths, images, text };
}

export type PasteSource =
	| { kind: 'payload'; payload: ClipboardPayload; from: 'system' | 'memory' }
	| { kind: 'error'; message: string }
	/** The system clipboard holds something else (text, files, images) copied after our last copy (CLB-010). */
	| { kind: 'external'; content: ExternalContent }
	| { kind: 'empty' };

/**
 * What to paste (CLB-002/009/010): JasperEditor content on the system clipboard wins (other tabs, other
 * projects); when the system clipboard holds other content, the in-memory copy is used only if our last copy
 * never reached the system clipboard. Everything is validated.
 */
export function pasteSourceOf(
	data: ClipboardData | null | undefined,
	pathOf: (f: File) => string | null = desktopPathOf,
): PasteSource {
	const json = data?.json ?? (data?.html ? decodeClipboardHtml(data.html) : null);
	if (json) {
		const r = parseClipboardPayload(json);
		return r.ok
			? { kind: 'payload', payload: r.payload, from: 'system' }
			: { kind: 'error', message: r.message };
	}
	const mem = memory;
	const hasFiles = !!data && (data.files > 0 || !!data.blobs?.length || !!data.paths?.length);
	const foreign = !!data && (!!data.html || !!data.text || hasFiles) && (hasFiles || data.text !== mem?.text);
	if (foreign && (!mem || mem.systemWritten))
		return { kind: 'external', content: externalContentOf(data, pathOf) };
	if (!mem) return { kind: 'empty' };
	return { kind: 'payload', payload: mem.payload, from: 'memory' };
}
