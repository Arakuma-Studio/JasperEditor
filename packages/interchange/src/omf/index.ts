// OMF Interchange 2.0 export (and import of the same structures) for audio post.
//
// Written from the public "OMF Interchange Specification Version 2.0" (Avid Technology, 1995/97) and Apple's "Bento
// Specification" revision 1.0d5 for the container (`bento.ts`).
//
// The file holds a composition mob (CMOB) with a timecode slot and one sound slot per audio track (one per channel when
// broken out to mono): sequences (SEQU) of fillers (FILL), source clips (SCLP) and transitions (TRAN with a
// SimpleMonoAudioDissolve effect); clip volume is a MonoAudioGain effect (EFFE) whose slot −1 is the clip and slot 1
// the amplitude (CVAL constant or VVAL keyframes). Every media item has a master mob (MMOB), a file source mob (SMOB
// with a WAVD / AIFD descriptor: embedded essence in a WAVE media data object, or locators to a separate file) and a
// tape source mob carrying its timecode. Sound slots use the sample rate as edit rate, so edits are sample-exact.
// Like Premiere's OMF export, the file carries audio only: video tracks, markers and captions are reported.
//
// Port of FilmCraft `crates/interchange/src/omf/mod.rs` (MIT OR Apache-2.0).
import { fromProject, toProject } from '../comp.ts';
import type { IProject } from '../model.ts';
import { DEFAULT_MEDIA_OPTIONS, type ExportOptions, type ImportOptions } from '../options.ts';
import { InterchangeError, parseError, type Report } from '../report.ts';
import { BentoContainer, BentoError, sniffBento } from './bento.ts';
import { readOmf } from './read.ts';
import { writeOmf } from './write.ts';

/** Whether `bytes` end with a Bento container label (OMF 2.0 files do). */
export function sniffOmf(bytes: Uint8Array): boolean {
	return sniffBento(bytes);
}

export function importOmf(bytes: Uint8Array, opts: ImportOptions, report: Report): IProject {
	try {
		const c: BentoContainer = BentoContainer.open(bytes);
		return toProject(readOmf(c, report), opts, report);
	} catch (e) {
		// The reader charges its work against the container's allowance while it walks the objects.
		if (e instanceof BentoError) throw parseError('OMF', e.message);
		if (e instanceof RangeError) throw parseError('OMF', 'the file is damaged');
		throw e;
	}
}

export function exportOmf(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): Uint8Array {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const media = { ...DEFAULT_MEDIA_OPTIONS, ...opts.media, audioOnly: true, mixdownVideo: null };
	const videoClips = s.video.reduce((n, t) => n + t.clips.length, 0);
	if (videoClips)
		report.info(`OMF carries audio only: the ${videoClips} clip(s) on the video tracks are not written`, {
			instead: 'nothing (export an AAF or a video file for picture)',
		});
	const doc = fromProject(p, sequenceId, opts.name ?? s.name, media, report, 'OMF');
	if (s.markers.length)
		report.warn(`the ${s.markers.length} sequence marker(s) of "${s.name}" are not written to OMF`, {
			instead: 'nothing',
		});
	if (s.captions?.length)
		report.warn(`the captions of "${s.name}" are not carried by OMF`, {
			instead: 'nothing (export a sidecar file)',
		});
	return writeOmf(doc, report);
}
