// Session-level colour actions (S06:CGU-004/005, LUT-002/005): the grade clipboard, Paste Grade, applying a LUT
// as the Look, importing a LUT from the pickers ("Browse…") and the preview-only before/after bypass.
import type { Clip, TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSyncExternalStore } from 'react';
import { pickFilesInBrowser } from '../import/desktop.ts';
import type { EngineImportService } from '../import/service.ts';
import { getImportService } from '../state/services.ts';
import { type CopiedColorEffect, copyGrade, planApplyLook, planPasteGrade } from './model.ts';

// ---------------------------------------------------------------- tiny external store

function createStore<T>(initial: T) {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set(next: T) {
			state = next;
			for (const l of [...listeners]) l();
		},
		subscribe(l: () => void) {
			listeners.add(l);
			return () => {
				listeners.delete(l);
			};
		},
	};
}

// ---------------------------------------------------------------- grade clipboard (CGU-004)

const clipboard = createStore<{ effects: CopiedColorEffect[]; from: string } | null>(null);

export const gradeClipboard = {
	get: clipboard.get,
	subscribe: clipboard.subscribe,
	clear: () => clipboard.set(null),
};

/** Copies every colour effect of the clip; false when it has none. */
export function copyGradeFrom(session: EditorSession, clip: Clip): boolean {
	const effects = copyGrade(clip, session.ctx.registries.effects);
	if (effects.length === 0) return false;
	clipboard.set({ effects, from: clip.id });
	return true;
}

/** Pastes the copied grade onto the clips (one undo step). */
export function pasteGradeTo(session: EditorSession, clipIds: readonly string[]): TransactionResult | null {
	const grade = clipboard.get();
	if (!grade) return null;
	const commands = planPasteGrade(
		session.getCommitted(),
		grade.effects,
		clipIds,
		session.ctx.registries.effects,
	);
	if (commands.length === 0) return null;
	const n = new Set(clipIds).size;
	return session.apply({
		label: n > 1 ? `Paste Grade (${n} clips)` : 'Paste Grade',
		origin: 'user',
		commands,
	});
}

// ---------------------------------------------------------------- LUT as Look (LUT-002)

export function applyLookToClips(
	session: EditorSession,
	mediaId: string,
	clipIds: readonly string[],
): TransactionResult | null {
	const commands = planApplyLook(session.getCommitted(), mediaId, clipIds);
	if (commands.length === 0) return null;
	return session.apply({
		label: commands.length > 1 ? `Apply Look (${commands.length} clips)` : 'Apply Look',
		origin: 'user',
		commands,
	});
}

/**
 * Project items dropped on the timeline: when they are all LUTs, the first one applies as the Look of the clip
 * under the pointer (nothing happens off a clip) and the drop is handled (true).
 */
export function dropLutItems(
	session: EditorSession,
	itemIds: readonly string[],
	clipId: string | null,
): boolean {
	const doc = session.getCommitted();
	const media = itemIds
		.map((id) => doc.items[id])
		.map((it) => (it?.kind === 'media' ? doc.media[it.mediaId] : undefined));
	if (media.length === 0 || media.some((m) => m?.kind !== 'lut')) return false;
	if (clipId) applyLookToClips(session, media[0]!.id, [clipId]);
	return true;
}

// ---------------------------------------------------------------- Browse… (LUT-005)

/**
 * Imports `.cube` files through the normal import path (desktop dialog or browser picker) and resolves with the
 * media id of the first LUT imported (or already in the project), or null when cancelled / failed.
 */
export async function browseForLut(session: EditorSession): Promise<string | null> {
	const service = getImportService() as EngineImportService | null;
	if (!service) return null;
	const paths = service.isDesktop ? await service.pickDesktopPaths() : null;
	const files = paths ? null : await pickFilesInBrowser();
	if (!paths?.length && !files?.length) return null;
	const result = await service.importFiles(
		{ files: files ?? undefined, paths: paths ?? undefined },
		{ kind: 'bin', binId: null },
	);
	const doc = session.getCommitted();
	const imported = result.mediaIds.find((id) => doc.media[id]?.kind === 'lut');
	if (imported) return imported;
	// Duplicates reuse the existing asset (same fingerprint).
	for (const reg of result.registered) {
		const fp = (reg as { fingerprint?: string }).fingerprint;
		const hit = Object.values(doc.media).find((m) => m.kind === 'lut' && fp && m.fingerprint === fp);
		if (hit) return hit.id;
	}
	return null;
}

// ---------------------------------------------------------------- before/after (CGU-005)

const bypass = createStore<readonly string[]>([]);

/** Clip ids whose colour effects the Program monitor bypasses (preview only). */
export const colorBypass = {
	get: bypass.get,
	subscribe: bypass.subscribe,
	isBypassed: (clipId: string) => bypass.get().includes(clipId),
	toggle(clipId: string) {
		const cur = bypass.get();
		bypass.set(cur.includes(clipId) ? cur.filter((c) => c !== clipId) : [...cur, clipId]);
	},
	clear: () => bypass.set([]),
};

export function useColorBypass(): readonly string[] {
	return useSyncExternalStore(bypass.subscribe, bypass.get, bypass.get);
}

export function useGradeClipboard() {
	return useSyncExternalStore(clipboard.subscribe, clipboard.get, clipboard.get);
}
