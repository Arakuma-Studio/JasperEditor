// A library sound registered as it is, not as a sample-exact copy (WP6.5b `RegisterSoundResponse.inexact`; final
// carry-over cleanup, item 3): its provenance records why (`LibraryProvenance.inexact`), so the editor can say so in
// Properties ▸ Sound and Sound Check can report it (INEXACT, information) long after the insert.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	LIBRARY_INEXACT_REASONS,
	LibraryProvenanceSchema,
	type ProjectDocument,
	readLibraryProvenance,
	repairDocument,
	SOUND_CHECK_CATEGORY,
	SOUND_CHECK_CODES,
	SOUND_CHECK_MESSAGES,
	soundCheckMessage,
	unknownCommandKeyIssues,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('LibraryProvenance.inexact', () => {
	it('the schema carries the reason; the strict agent path accepts what the engine returns', () => {
		for (const reason of LIBRARY_INEXACT_REASONS) {
			const library = { ...LIB, inexact: { reason } };
			expect(LibraryProvenanceSchema.safeParse(library).success).toBe(true);
			const cmd = { type: 'media.register', asset: { ...videoAsset({ kind: 'audio' }), library } };
			expect(unknownCommandKeyIssues([cmd])).toEqual([]);
			const h = new Harness();
			const r = h.ok([cmd]);
			const id = (r.results[0] as { mediaId: string }).mediaId;
			expect(h.doc.media[id]!.library!.inexact).toEqual({ reason });
			expect(readLibraryProvenance(h.doc.media[id]!.library)!.inexact).toEqual({ reason });
			expect(checkInvariants(h.doc)).toEqual([]);
		}
		expect(LibraryProvenanceSchema.safeParse({ ...LIB, inexact: { reason: 'tired' } }).success).toBe(false);
		expect(LibraryProvenanceSchema.safeParse({ ...LIB, inexact: 'too-long' }).success).toBe(false);
	});

	it('an unreadable one is dropped by the lenient read and by repair, the rest of the provenance kept', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		const doc = clone(h.doc) as ProjectDocument;
		(doc.media[m] as Record<string, unknown>).library = { ...LIB, inexact: { reason: 7 } };
		expect(readLibraryProvenance(doc.media[m]!.library)).toEqual(LIB);
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-LIBRARY')).toBe(true);
		const { document, report } = repairDocument(doc, h.ids);
		expect(report).toContainEqual(expect.objectContaining({ action: 'repair-library', entity: m }));
		expect(document.media[m]!.library).toEqual(LIB);
		expect(checkInvariants(document)).toEqual([]);
		// a newer build's extra fields inside it are kept
		const newer = { ...LIB, inexact: { reason: 'too-large', bytes: 5 } };
		expect(readLibraryProvenance(newer)!.inexact).toEqual({ reason: 'too-large', bytes: 5 });
	});

	it('Sound Check has the INEXACT information in the sync group, with a message per reason', () => {
		expect(SOUND_CHECK_CODES).toContain('INEXACT');
		expect(SOUND_CHECK_CATEGORY.INEXACT).toBe('sync');
		expect(soundCheckMessage('inexactTooLong', 'Rain', '00:00:01:00', 60).text).toBe(
			'Rain at 00:00:01:00 is not sample-exact: sounds over 60 min are used as they are (placement exact to a frame)',
		);
		for (const k of ['inexactTooLong', 'inexactTooLarge', 'inexactDiskSpace'] as const)
			expect(SOUND_CHECK_MESSAGES[k]).toMatch(/^\{0\} at \{1\} is not sample-exact/);
	});
});
