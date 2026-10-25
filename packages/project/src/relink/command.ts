// Link Media commands (docs/wp-notes/link-media.md §4): the `media.relink` of a located file with Premiere's Align
// Timecode and Preserve Interpret Footage options, shared by the editor and the agent tools.
import { sourceTimingShift } from '../process/source-range.ts';
import type { MediaAsset, MediaLocator, MediaProbe } from '../schema/media.ts';

/** The fields of an engine-registered file (`RegisteredMedia` of @jasper/api) a relink needs. */
export type RelinkFile = {
	mediaKey: string;
	fingerprint: string;
	probe: unknown;
	sizeBytes: number;
	originalName: string;
	container: string;
	locators: readonly { type: string }[];
};

export type RelinkOptions = {
	/** The user confirmed a file whose content, kind or length differs. */
	force?: boolean;
	/**
	 * Align Timecode (Premiere's default): when the asset and the file both carry a start timecode and they differ,
	 * clips move in content time so they keep showing the same timecode (`keepSourceTiming`).
	 */
	alignTimecode?: boolean;
	/** Engine id of the `engine-store` locator (`local` for the editor's own engine). */
	engineId?: string;
};

export type RelinkCommand = {
	type: 'media.relink';
	mediaId: string;
	locator: MediaLocator;
	locators: MediaLocator[];
	probe: MediaProbe;
	fingerprint: string;
	sizeBytes: number;
	originalName: string;
	container: string;
	force?: true;
	keepSourceTiming?: true;
};

/**
 * True when Align Timecode changes anything for this file: both start timecodes are known, they differ, and both
 * files count frames at the same video rate (otherwise source frames cannot be kept one to one).
 */
export function timecodeAlignmentApplies(
	asset: MediaAsset,
	file: Pick<RelinkFile, 'probe' | 'originalName'>,
): boolean {
	const probe = file.probe as MediaProbe;
	if (!asset.probe.startTimecode || !probe?.startTimecode) return false;
	if (asset.probe.startTimecode === probe.startTimecode) return false;
	if (asset.sourceRange) return false;
	const t = sourceTimingShift(asset, { originalName: file.originalName, probe });
	return t.ok && t.basis === 'timecode' && t.shiftFrames !== 0;
}

/** The `media.relink` linking `asset` to a registered file. */
export function relinkMediaCommand(
	asset: MediaAsset,
	file: RelinkFile,
	opts: RelinkOptions = {},
): RelinkCommand {
	const store: MediaLocator = {
		type: 'engine-store',
		engineId: opts.engineId ?? 'local',
		key: file.mediaKey,
	};
	const paths = file.locators.filter((l): l is MediaLocator => l.type === 'path');
	return {
		type: 'media.relink',
		mediaId: asset.id,
		locator: store,
		locators: [store, ...paths],
		probe: file.probe as MediaProbe,
		fingerprint: file.fingerprint,
		sizeBytes: file.sizeBytes,
		originalName: file.originalName,
		container: file.container,
		...(opts.force ? { force: true as const } : {}),
		...(opts.alignTimecode && timecodeAlignmentApplies(asset, file)
			? { keepSourceTiming: true as const }
			: {}),
	};
}

/**
 * Preserve Interpret Footage off: the interpretation of relinked media goes back to the file's own values (one
 * `media.interpret` for every asset that has one).
 */
export function resetInterpretationCommand(assets: readonly MediaAsset[]) {
	const ids = assets.filter((a) => a.interpretation && Object.keys(a.interpretation).length).map((a) => a.id);
	if (!ids.length) return null;
	return {
		type: 'media.interpret' as const,
		mediaIds: ids,
		interpretation: { frameRate: null, pixelAspect: null, fieldOrder: null, alpha: null, loop: null },
	};
}

type ApplyResult = { ok: true } | { ok: false; errors: readonly { commandIndex: number; message: string }[] };

/**
 * Applies a Link Media transaction. A command whose timecode alignment the document refuses (a clip the new file does
 * not cover at the aligned time) is linked without alignment instead of failing every relink; each such fallback is
 * reported. Bounded: at most one retry per aligned command.
 */
export async function applyRelinkTransaction<
	C extends { keepSourceTiming?: true; mediaId?: string },
	R extends ApplyResult,
>(
	commands: readonly C[],
	apply: (commands: C[]) => R | Promise<R>,
): Promise<{ result: R; unaligned: { mediaId: string; reason: string }[] }> {
	let cmds = [...commands];
	const unaligned: { mediaId: string; reason: string }[] = [];
	for (let attempt = 0; ; attempt++) {
		const result = await apply(cmds);
		if (result.ok || attempt >= commands.length) return { result, unaligned };
		const err = result.errors.find((e) => e.commandIndex >= 0 && cmds[e.commandIndex]?.keepSourceTiming);
		if (!err) return { result, unaligned };
		const c = cmds[err.commandIndex]!;
		const { keepSourceTiming: _drop, ...rest } = c;
		cmds = cmds.map((x, i) => (i === err.commandIndex ? (rest as C) : x));
		unaligned.push({ mediaId: c.mediaId ?? '', reason: err.message });
	}
}
