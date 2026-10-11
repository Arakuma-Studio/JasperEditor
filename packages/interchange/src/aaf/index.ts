// AAF (Advanced Authoring Format) import and export, following the AAF Edit Protocol.
//
// Written from the public AMWA specifications: AAF Object Specification v1.1, AAF Low-Level Container Specification
// v1.0.1 (structured storage mapping, `store.ts`) and AAF Edit Protocol v1.0; the container is Microsoft's Compound
// File Binary format (`../cfb.ts`).
//
// The exported file holds one top-level CompositionMob (Edit Protocol usage code "top level") with a timecode slot
// (sequence start timecode, rounded rate, drop frame); one timeline slot per video track (picture) and per audio track
// (sound; one per channel when broken out to mono), each a Sequence of Fillers, SourceClips and Transitions (Cross
// Dissolve → VideoDissolve_2, Dip to Black → VideoFadeToBlack, wipes → SMPTE Video Wipe, audio crossfades →
// MonoAudioDissolve; the JasperEditor transition id is kept in a tagged value); clip volume as a MonoAudioGain
// OperationGroup with an Amplitude ConstantValue or VaryingValue (keyframes as control points); sequence markers as
// CommentMarkers in an event slot. Every media item has a MasterMob, a file SourceMob per essence (a CDCI or PCM
// descriptor with a network locator to the file, or EssenceData holding embedded PCM) and a tape SourceMob carrying
// its start timecode. Clip and media markers become comment markers on the master mob.
//
// Port of FilmCraft `crates/interchange/src/aaf/mod.rs` (MIT OR Apache-2.0).
import { CfbError, CompoundFile, sniffCfb } from '../cfb.ts';
import { fromProject, toProject } from '../comp.ts';
import type { IProject } from '../model.ts';
import { DEFAULT_MEDIA_OPTIONS, type ExportOptions, type ImportOptions } from '../options.ts';
import { InterchangeError, parseError, type Report } from '../report.ts';
import { ROOT } from './ids.ts';
import { readAaf } from './read.ts';
import { auidEq, readStore, StoreError } from './store.ts';
import { writeAaf } from './write.ts';

/** Whether `bytes` look like an AAF file (a compound file whose root has the AAF root class or a `Header-2` storage). */
export function sniffAaf(bytes: Uint8Array): boolean {
	if (!sniffCfb(bytes)) return false;
	try {
		const cf = CompoundFile.open(bytes);
		return auidEq(cf.root().clsid, ROOT) || cf.child(0, 'Header-2') !== null;
	} catch {
		return false;
	}
}

export function importAaf(bytes: Uint8Array, opts: ImportOptions, report: Report): IProject {
	let root: ReturnType<typeof readStore>;
	try {
		root = readStore(bytes);
	} catch (e) {
		if (e instanceof CfbError || e instanceof StoreError) throw parseError('AAF', e.message);
		// A file that makes the reader run out of stack or address space is a damaged file, not an engine fault.
		if (e instanceof RangeError) throw parseError('AAF', 'the file is damaged');
		throw e;
	}
	const doc = readAaf(root, report);
	return toProject(doc, opts, report);
}

export function exportAaf(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): Uint8Array {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const media = { ...DEFAULT_MEDIA_OPTIONS, ...opts.media };
	const doc = fromProject(p, sequenceId, opts.name ?? s.name, media, report);
	if (s.captions?.length)
		report.warn(`the captions of "${s.name}" are not carried by AAF`, {
			instead: 'nothing (export a sidecar file)',
		});
	return writeAaf(doc, opts.aafSmallSectors ? 3 : 4, report);
}
