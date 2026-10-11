// requests to the Text panel from commands (open a tab, reveal a caption) and the user's filler
// word list (configurable, kept in local storage).
import { DEFAULT_FILLERS } from '@jasper/project';

type Listener = () => void;
export type TranscriptTool = 'fillers' | 'pauses' | 'captions' | 'import';
export type TextPanelRequest = {
	tab: 'transcript' | 'captions';
	clipId?: string;
	tool?: TranscriptTool;
	seq: number;
};

let request: TextPanelRequest = { tab: 'transcript', seq: 0 };
const listeners = new Set<Listener>();

export const textPanelRequests = {
	get: (): TextPanelRequest => request,
	open(tab: TextPanelRequest['tab'], clipId?: string, tool?: TranscriptTool): void {
		request = { tab, ...(clipId ? { clipId } : {}), ...(tool ? { tool } : {}), seq: request.seq + 1 };
		for (const l of listeners) l();
	},
	subscribe(l: Listener): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

const FILLERS_KEY = 'jasper:transcript-fillers';

/** The filler words and phrases used by Remove Fillers (default: FilmCraft's list). */
export function loadFillers(): string[] {
	try {
		const raw = globalThis.localStorage?.getItem(FILLERS_KEY);
		const v = raw ? (JSON.parse(raw) as unknown) : null;
		if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
	} catch {
		/* storage unavailable or malformed: defaults */
	}
	return [...DEFAULT_FILLERS];
}

export function saveFillers(list: readonly string[]): void {
	try {
		globalThis.localStorage?.setItem(FILLERS_KEY, JSON.stringify(list));
	} catch {
		/* storage unavailable */
	}
}

/** Base64 of bytes (file import into commands). */
export function bytesToBase64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** Offers bytes as a file download. */
export function downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
