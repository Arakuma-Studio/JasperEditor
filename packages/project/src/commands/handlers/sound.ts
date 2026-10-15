// Sound design command handlers (spec 12 §2.9). Phase 1: `media.setLibraryInfo`.
import type { Draft } from 'immer';
import type { MediaAsset } from '../../schema/media.ts';
import type { LibraryProvenance } from '../../sound/provenance.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { HandlerMap } from './util.ts';

export const SOUND_DESIGN_OWNER = 'sound-design' as const;

/** Media kinds that can be a library sound (it is audio, or a video file whose audio is the sound). */
const SOUND_MEDIA_KINDS: ReadonlySet<string> = new Set(['audio', 'video']);
/** Descriptor times may exceed the stated duration by this much (rounding of separately quantised values). */
const DESCRIPTOR_SLACK_SEC = 0.001;

/** The problem with a provenance's descriptors (points past the end of the sound), or null. Pure. */
export function libraryDescriptorIssue(library: LibraryProvenance): string | null {
	const d = library.descriptors;
	if (!d) return null;
	for (const key of ['peakSec', 'onsetSec', 'headQuietSec'] as const)
		if (d[key] > d.durationSec + DESCRIPTOR_SLACK_SEC)
			return `descriptors.${key} (${d[key]} s) is past the end of the sound (${d.durationSec} s)`;
	return null;
}

function setLibraryInfo(doc: DDoc, cmd: CommandOf<'media.setLibraryInfo'>, h: HandlerContext) {
	const asset = doc.media[cmd.mediaId] as Draft<MediaAsset> | undefined;
	if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`);
	if (cmd.library === null) {
		if (asset.library !== undefined) delete asset.library;
		return { mediaId: asset.id, library: null };
	}
	if (!SOUND_MEDIA_KINDS.has(asset.kind))
		h.fail('E_INVALID_PARAM', `Library provenance applies to audio media, not ${asset.kind} (${asset.id})`, {
			path: ['mediaId'],
		});
	const library = JSON.parse(JSON.stringify(cmd.library)) as LibraryProvenance;
	const bad = libraryDescriptorIssue(library);
	if (bad) h.fail('E_INVALID_PARAM', bad, { path: ['library', 'descriptors'] });
	asset.library = library as Draft<LibraryProvenance>;
	return { mediaId: asset.id, library };
}

export const soundHandlers = {
	'media.setLibraryInfo': setLibraryInfo,
} satisfies HandlerMap;
