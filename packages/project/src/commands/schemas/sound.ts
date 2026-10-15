// Sound design commands (spec 12 §2.9; owner `sound-design`). Phase 1: library provenance of media.
import { LibraryProvenanceSchema } from '../../sound/provenance.ts';
import { cmd, IdRefSchema } from './common.ts';

/**
 * Sets (or with `null` removes) the library provenance of a media asset: which Sound Library sound it is, its licence
 * and credit, and the descriptors placement uses (spec 12 §2.1). Audio and video media only. Result
 * `{mediaId, library}` (the stored value, or null).
 */
export const MediaSetLibraryInfoCmd = cmd('media.setLibraryInfo', {
	mediaId: IdRefSchema,
	library: LibraryProvenanceSchema.nullable(),
});

export const SOUND_COMMANDS = [MediaSetLibraryInfoCmd] as const;
