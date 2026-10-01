// Clipboard transport (S01:CLB-002): every copy keeps an in-memory copy (same-tab pastes never depend on
// clipboard permissions) and writes the system clipboard: `text/html` with the payload embedded in a marked
// element plus `text/plain`, through a copy event (no permission needed inside a user gesture), and on desktop
// the custom `application/x-jasper-clipboard` format through the Electron clipboard. Pastes read the data the
// browser hands to a paste event, else the Electron clipboard, else the async Clipboard API (may prompt), and
// fall back to the in-memory copy.
import {
	type ClipboardPayload,
	clipboardText,
	decodeClipboardHtml,
	encodeClipboardHtml,
	parseClipboardPayload,
} from '@jasper/project';
import { getDesktopBridge } from '../runtime/platform.ts';

/** What a paste found on the system clipboard (any field may be missing). */
export type ClipboardData = { html: string | null; text: string | null; json?: string | null; files: number };

export type StoredClipboard = {
	payload: ClipboardPayload;
	json: string;
	text: string;
	/** The system clipboard got the payload (else a later paste trusts the in-memory copy over it). */
	systemWritten: boolean;
	at: number;
};

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
	return { html: get('text/html'), text: get('text/plain'), files: d?.files?.length ?? 0 };
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

/** Reads the system clipboard without a paste event: Electron's custom format, else the async Clipboard API. */
export async function readSystemClipboard(): Promise<ClipboardData | null> {
	const desktop = getDesktopBridge()?.clipboard;
	if (desktop) {
		try {
			const json = await desktop.read();
			if (json) return { html: null, text: null, json, files: 0 };
		} catch {
			// fall through to the web API
		}
	}
	try {
		const nav = navigator as Navigator & { clipboard?: Clipboard };
		if (!nav.clipboard?.read) return null;
		const items = await nav.clipboard.read();
		let html: string | null = null;
		let text: string | null = null;
		for (const it of items) {
			if (!html && it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
			if (!text && it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
		}
		return { html, text, files: 0 };
	} catch {
		// Permission denied or not focused: the in-memory copy is used.
		return null;
	}
}

export type PasteSource =
	| { kind: 'payload'; payload: ClipboardPayload; from: 'system' | 'memory' }
	| { kind: 'error'; message: string }
	/** The system clipboard holds something else (text, files) copied after our last copy. */
	| { kind: 'external' }
	| { kind: 'empty' };

/**
 * What to paste (CLB-002/009): JasperEditor content on the system clipboard wins (other tabs, other projects);
 * when the system clipboard holds other content, the in-memory copy is used only if our last copy never reached
 * the system clipboard. Everything is validated.
 */
export function pasteSourceOf(data: ClipboardData | null | undefined): PasteSource {
	const json = data?.json ?? (data?.html ? decodeClipboardHtml(data.html) : null);
	if (json) {
		const r = parseClipboardPayload(json);
		return r.ok
			? { kind: 'payload', payload: r.payload, from: 'system' }
			: { kind: 'error', message: r.message };
	}
	const mem = memory;
	const foreign = !!data && (!!data.html || !!data.text || data.files > 0) && data.text !== mem?.text;
	if (foreign && (!mem || mem.systemWritten)) return { kind: 'external' };
	if (!mem) return { kind: 'empty' };
	return { kind: 'payload', payload: mem.payload, from: 'memory' };
}
