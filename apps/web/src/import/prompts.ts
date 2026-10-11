// Import prompts: duplicate detection (S04:IN-007), clip mismatch (S01:SEQ-005 / S04:IN-008) and the
// per-file failure summary (S01:LIFE-010 step 6). The service talks to this interface; the default
// implementation queues promise-based dialogs rendered by <ImportPromptHost/>.
import type { LayeredExtractResult } from '@jasper/api';
import type { Rational } from '@jasper/project';
import { openDialog } from '@jasper/ui';
import { useSyncExternalStore } from 'react';
import {
	IMAGE_SEQUENCE_DIALOG,
	type ImageSequenceChoice,
	type ImageSequenceGroupView,
	LAYERED_IMPORT_DIALOG,
	type LayeredChoice,
	PDF_PAGES_DIALOG,
	registerImportsDialogs,
} from '../imports/dialogs.tsx';
import type { DuplicateChoice } from './transaction.ts';

type MismatchInfo = {
	clipName: string;
	clip: { width: number; height: number; fps: string };
	sequence: { name: string; width: number; height: number; fps: string };
};

export type ImportFailure = { name: string; code: string; message: string };

export interface ImportPrompts {
	duplicates(info: { names: string[] }): Promise<DuplicateChoice>;
	clipMismatch(info: MismatchInfo): Promise<'change' | 'keep'>;
	failures(info: { failed: ImportFailure[]; committed: number }): void;
	// Without these prompts, numbered stills import individually, PSDs flattened, and PDFs on page 1.
	/** Numbered stills found among the files: import them as image sequences, and at which frame rate. */
	imageSequence?(info: {
		groups: ImageSequenceGroupView[];
		defaultRate: Rational;
	}): Promise<ImageSequenceChoice>;
	/** A layered document: how to import it (Premiere's Import Layered File). */
	layered?(info: { name: string; result: LayeredExtractResult }): Promise<LayeredChoice>;
	/** A PDF / Illustrator document with several pages: which pages to import. */
	pdfPages?(info: {
		name: string;
		pages: { page: number; width: number; height: number }[];
	}): Promise<number[]>;
}

export type PendingPrompt =
	| { id: number; kind: 'duplicates'; names: string[]; resolve(c: DuplicateChoice): void }
	| { id: number; kind: 'mismatch'; info: MismatchInfo; resolve(c: 'change' | 'keep'): void }
	| { id: number; kind: 'failures'; failed: ImportFailure[]; committed: number };

export class PromptQueue implements ImportPrompts {
	private queue: PendingPrompt[] = [];
	private readonly listeners = new Set<() => void>();
	private seq = 0;

	getQueue = () => this.queue;
	subscribe = (l: () => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	private push(p: PendingPrompt) {
		this.queue = [...this.queue, p];
		for (const l of [...this.listeners]) l();
	}
	/** Removes a prompt (the host calls this after resolving it). */
	settle(id: number) {
		this.queue = this.queue.filter((p) => p.id !== id);
		for (const l of [...this.listeners]) l();
	}

	duplicates(info: { names: string[] }): Promise<DuplicateChoice> {
		return new Promise((resolve) =>
			this.push({ id: ++this.seq, kind: 'duplicates', names: info.names, resolve }),
		);
	}
	clipMismatch(info: MismatchInfo): Promise<'change' | 'keep'> {
		return new Promise((resolve) => this.push({ id: ++this.seq, kind: 'mismatch', info, resolve }));
	}
	failures(info: { failed: ImportFailure[]; committed: number }): void {
		this.push({ id: ++this.seq, kind: 'failures', ...info });
	}
	async imageSequence(info: {
		groups: ImageSequenceGroupView[];
		defaultRate: Rational;
	}): Promise<ImageSequenceChoice> {
		registerImportsDialogs();
		return (
			(await openDialog<ImageSequenceChoice>(IMAGE_SEQUENCE_DIALOG, info)) ?? {
				asSequence: false,
				frameRate: info.defaultRate,
			}
		);
	}
	async layered(info: { name: string; result: LayeredExtractResult }): Promise<LayeredChoice> {
		registerImportsDialogs();
		return (
			(await openDialog<LayeredChoice>(LAYERED_IMPORT_DIALOG, info)) ?? { mode: 'merged-all', selected: [] }
		);
	}
	async pdfPages(info: {
		name: string;
		pages: { page: number; width: number; height: number }[];
	}): Promise<number[]> {
		registerImportsDialogs();
		return (await openDialog<number[]>(PDF_PAGES_DIALOG, info)) ?? [1];
	}
}

/** The app-wide prompt queue used by the import service. */
export const importPrompts = new PromptQueue();

export function usePromptQueue(q: PromptQueue = importPrompts): PendingPrompt[] {
	return useSyncExternalStore(q.subscribe, q.getQueue, q.getQueue);
}
