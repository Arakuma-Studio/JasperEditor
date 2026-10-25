// Sound Check tools (spec 12 §2.6, §2.10, P5-R2; wp-note "Phase 5 → WP5.1"):
//   sound_check          runs the engine's `sound-check` job (the delivered mix and its stems measured) → the verdict,
//                        the findings with their machine-actionable fixes, the five listen-here timecodes, the per-event
//                        table and, optionally, a PNG strip of the worst moments; `store: true` also writes the summary
//                        into the sequence (one undo step "Sound Check Result").
//   get_sound_check      the sequence's last full report as the engine keeps it (across restarts), current or stale.
//   acknowledge_sound_issue  marks a finding of the last report as a deliberate exception with a reason (spec 12 §4
//                        P6-E4; warnings and infos only for an agent: an error is the user's call), or takes it back.
//   sound_check {proposalId} checks a proposal before review (P6-E5): what it fixes and introduces, per item.
//   (view_sound_timeline, the PNG of a range, is in ./sound-timeline.ts; sound_check's pictures use its drawing.)
import {
	type SoundCheckDeltaFinding,
	type SoundCheckExportAudio,
	type SoundCheckIssue,
	SoundCheckLastResponseSchema,
	type SoundCheckProposal,
	type SoundCheckReport,
	SoundCheckResultSchema,
	SoundVisualResponseSchema,
} from '@jasper/api';
import {
	applySoundAcknowledgements,
	DELIVERY_PRESETS,
	type ProjectDocument,
	type Sequence,
	SOUND_CHECK_TARGET_LIMITS,
	SOUND_DELIVERIES,
	type SoundDelivery,
	sequenceDuration,
	sequenceTimecode,
	soundCheckFixCandidates,
	soundCheckFixOrder,
	soundCheckHumanVerdicts,
	soundDesignSettingsOf,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS, TimeArgSchema } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { buildExportSettings, EXPORT_PRESETS, findExportPreset } from '../export-presets.ts';
import { pickSequence } from '../format.ts';
import { composeGrid, encodePng } from '../png.ts';
import { drawSoundTimeline } from '../sound-timeline.ts';
import { ProfileIdArg, referenceSection } from './sound-profile.ts';

/** Seconds either side of a worst moment in sound_check's pictures. */
const STRIP_PAD_SEC = 2;
const MAX_STRIPS = 3;

const RangeArg = z
	.object({ start: TimeArgSchema, end: TimeArgSchema })
	.describe(`Sequence range [start, end). ${TIME_FORMATS}`);

const SOUND_CHECK_HINTS: Record<string, string> = {
	RANGE_EMPTY: 'The range is outside the sequence: check get_timeline for its length.',
	RANGE_TOO_LONG: 'Ask for a shorter range (sound_check: ≤ 4 h; view_sound_timeline: ≤ 120 s).',
	JOB_NOT_FOUND: 'checkJobId must be a sound_check job of this project (its jobId).',
	SOUND_CHECK_NOT_FOUND: 'No report is kept for this sequence: run sound_check.',
	RENDER_FAILED:
		'The mix could not be rendered: check that the media is online (list_offline_media), then try again.',
};

function toolError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code && SOUND_CHECK_HINTS[err.code])
		throw new ToolError(err.code, err.message ?? err.code, SOUND_CHECK_HINTS[err.code]!);
	throw e;
}

/** Who acknowledged a finding, in words. */
const ackBy = (a: NonNullable<SoundCheckIssue['acknowledged']>) =>
	a.by === 'user' ? 'the user' : `agent ${a.agent ?? '?'}`;

/** One line per finding for the agent: severity, code, key, where, what, the fix (why it is not safe), its acknowledgement. */
function issueLine(i: SoundCheckIssue): string {
	const f = i.fix;
	const why =
		f && !f.safe && f.why
			? ` — ${f.why}${f.conflictsWith?.length ? ` (with the fixes of ${f.conflictsWith.join(', ')})` : ''}`
			: '';
	const fix = f ? ` → fix (${f.safe ? 'safe' : 'needs the user'}): ${f.label.text} [${f.tool}]${why}` : '';
	const advice = i.advice?.length ? ` → what to do: ${i.advice.map((x) => x.text).join(' ')}` : '';
	const a = i.acknowledged;
	const ack = !a
		? ''
		: a.active
			? ` [acknowledged by ${ackBy(a)}: "${a.reason}"]`
			: a.why === 'changed'
				? ` [acknowledged before the change by ${ackBy(a)} ("${a.reason}"): what it is about changed since, so it counts again]`
				: a.why === 'worse'
					? ` [acknowledged by ${ackBy(a)} as a lesser finding ("${a.reason}"): it is worse now, so it counts again]`
					: ` [agent ${a.agent ?? '?'} acknowledged it ("${a.reason}"), but only the user can acknowledge an error]`;
	return `${i.severity.toUpperCase()} ${i.code}${i.timecode ? ` @ ${i.timecode}` : ''} (${i.id}): ${i.message.text}${fix}${advice}${ack}`;
}

/** The findings that count (not acknowledged, or acknowledged before a change). */
const openIssues = (r: Pick<SoundCheckReport, 'issues'>) => r.issues.filter((i) => !i.acknowledged?.active);

/** What the report says about acknowledged findings: the ones left out and the acknowledgements nothing matched. */
function acknowledgedOf(r: SoundCheckReport) {
	const left = r.issues.filter((i) => i.acknowledged?.active);
	const unmatched = r.acknowledgements?.unmatched ?? [];
	if (!left.length && !unmatched.length) return {};
	return {
		acknowledged: {
			count: left.length,
			findings: left.map(issueLine),
			...(unmatched.length
				? {
						notFound: unmatched.map(
							(u) =>
								`${u.key}: "${u.reason}" (by ${u.by === 'user' ? 'the user' : `agent ${u.agent ?? '?'}`}) — not reported by this check (fixed since, or outside the range)${u.message ? `: ${u.message}` : ''}`,
						),
					}
				: {}),
		},
	};
}

/**
 * The safe fixes in the order to apply them (document commands, then sound swaps, then engine jobs; a fix two findings
 * share once): the engine judged each one safe on its own AND after the ones before it in this order. Acknowledged
 * findings have none: they are deliberate.
 */
function safeFixesOf(r: SoundCheckReport) {
	const byId = new Map(r.issues.map((i) => [i.id, i]));
	return soundCheckFixOrder(soundCheckFixCandidates(openIssues(r), { safeOnly: true })).map((c) => {
		const fix = byId.get(c.issueIds[0]!)!.fix!;
		return { issueIds: c.issueIds, tool: fix.tool, args: fix.args };
	});
}

/**
 * The user's listen-here verdicts (spec 12 §2.7: "Sounds right" / "Flag" + note, stored by the editor's Sound Check
 * panel as `comment` markers): each with its timecode, the listen slot and clip / cue it judged (verdicts written
 * before the Phase 5 verification carry only a frame: their slot comes from this report's moment at that frame), and
 * whether it is still current — `stale` (null: cannot be told for such an older verdict) with `staleReasons`: `moment`
 * (what plays in the listened ±2 s changed since), `moved` / `gone` (its clip or cue).
 */
function humanVerdictsOf(doc: ProjectDocument, seq: Sequence, r: Pick<SoundCheckReport, 'listen'>) {
	return soundCheckHumanVerdicts(seq, { doc }).map((v) => {
		const at = r.listen.find((l) => l.frame === v.frame);
		const slot = v.slot ?? at?.slot;
		return {
			timecode: sequenceTimecode(seq, v.frame),
			frame: v.frame,
			verdict: v.verdict === 'ok' ? 'sounds right' : 'flagged',
			note: v.note,
			markerId: v.markerId,
			...(slot ? { slot } : {}),
			...(v.clipId ? { clipId: v.clipId } : {}),
			...(v.cueId ? { cueId: v.cueId } : {}),
			stale: v.stale ?? null,
			...(v.staleReasons?.length ? { staleReasons: v.staleReasons } : {}),
			...(v.mixChanged !== undefined && v.mixChanged !== null ? { mixChangedSince: v.mixChanged } : {}),
		};
	});
}

/** The per-event table as text (one row per sound effect). */
function eventTable(r: SoundCheckReport): string {
	return [
		'clip | timecode | sound | track | role | cue | offset ms (tol frames) | lift dB (min) | over bed LU | status | codes',
		...r.events.map(
			(e) =>
				`${e.clipId} | ${e.timecode} | ${e.title} | ${e.track} | ${e.role ?? e.weight} | ${e.cueKind ?? '—'} | ${e.offsetMs === null ? e.located : `${e.offsetMs > 0 ? '+' : ''}${e.offsetMs}`}${e.toleranceFrames !== null ? ` (±${e.toleranceFrames})` : ''} | ${e.liftDb === null ? '—' : e.liftDb}${e.minLiftDb !== null ? ` (${e.minLiftDb})` : ''} | ${e.peakOverBedLu ?? '—'} | ${e.status} | ${e.codes.join(', ') || '—'}`,
		),
	].join('\n');
}

/** What to do next with a report (the same advice for a fresh and a kept one). */
function nextOf(r: SoundCheckReport, listen: string[]): string {
	const safe = openIssues(r).filter((i) => i.fix?.safe);
	const fixes = safeFixesOf(r).length;
	return r.verdict === 'pass'
		? `No warnings or errors. Give the user these moments to listen to, verbatim: ${listen.join(' | ') || '(none)'}. Do not say it sounds good: say what was measured.`
		: `${safe.length} finding(s) have a safe fix (${fixes} fix(es) in safeFixes): apply exactly those, in the order of safeFixes (each tool + args once — they were judged together in that order), then run sound_check again. Leave the others to the user and tell them what each says (a fix that is not safe says why). Give the user the listen-here moments verbatim: ${listen.join(' | ') || '(none)'}.`;
}

/** The frames of up to `n` worst moments (errors first, then warnings, then the listen-here worst). */
function worstFrames(r: SoundCheckReport, n: number): number[] {
	const rank = { error: 0, warning: 1, info: 2 } as const;
	const frames: number[] = [];
	for (const i of [...openIssues(r)].sort((a, b) => rank[a.severity] - rank[b.severity])) {
		if (i.severity === 'info') break;
		const f = i.frame ?? i.range?.start;
		if (f === undefined) continue;
		if (frames.some((x) => Math.abs(x - f) < 3 * STRIP_PAD_SEC * (r.fps.num / r.fps.den))) continue;
		frames.push(f);
		if (frames.length >= n) break;
	}
	if (frames.length === 0)
		for (const l of r.listen) {
			if (frames.some((x) => Math.abs(x - l.frame) < 2 * STRIP_PAD_SEC * (r.fps.num / r.fps.den))) continue;
			frames.push(l.frame);
			if (frames.length >= Math.min(n, 2)) break;
		}
	return frames;
}

/** One line per finding a proposal fixes or introduces, with the item it is about. */
function deltaLine(f: SoundCheckDeltaFinding): string {
	const item = f.itemId ? ` — item ${f.itemIds.join(', ')}` : ' — no item in particular (the whole mix)';
	return `${f.severity.toUpperCase()} ${f.code}${f.timecode ? ` @ ${f.timecode}` : ''} (${f.key}): ${f.message.text}${item}`;
}

/**
 * The agent's view of a proposal check (`SoundCheckResult.proposal`, or the summary the engine keeps on the proposal as
 * `report.check`): "fixes n · introduces m", the verdict before → after, one line per finding, per item.
 */
export function proposalCheckSummary(p: SoundCheckProposal & { jobId?: string; at?: string }) {
	const d = p.delta;
	const errors = d.introduced.filter((f) => f.severity === 'error').length;
	return {
		summary: `Sound Check of this proposal: fixes ${d.fixedCount} · introduces ${d.introducedCount}${errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}`,
		verdict: `${d.verdict.before} → ${d.verdict.after}`,
		base: p.base === 'kept' ? 'the current document’s kept report' : 'a fresh check of the current document',
		checkedItems: p.itemIds,
		...(p.skipped.length ? { skipped: p.skipped.map((x) => `${x.itemId} (${x.state}): ${x.reason}`) } : {}),
		fixes: d.fixed.map(deltaLine),
		introduces: d.introduced.map(deltaLine),
		...(d.fixedCount > d.fixed.length || d.introducedCount > d.introduced.length
			? { listed: `the first ${d.fixed.length} fixed and ${d.introduced.length} introduced are listed` }
			: {}),
		perItem: d.items,
		counts: d.counts,
		...(p.jobId ? { jobId: p.jobId } : {}),
		...(p.at ? { at: p.at } : {}),
	};
}

/** What to do after a proposal check (the "one writer" rule, P6-E5). */
export function proposalCheckNext(p: SoundCheckProposal): string {
	const d = p.delta;
	const errors = d.introduced.filter((f) => f.severity === 'error');
	if (d.introducedCount === 0)
		return `It introduces nothing. Tell the user it fixes ${d.fixedCount} finding(s), ask them to review it in the Review panel, then wait_for_proposal.`;
	return `It introduces ${d.introducedCount} finding(s)${errors.length ? `, ${errors.length} of them error(s)` : ''}. Fix them in the proposal first (reject the items named and propose them again, or merge a better alternative into one new proposal), or hand it over saying exactly what it introduces and why — never hand over a proposal that introduces errors without saying so. Then ask the user to review it in the Review panel and wait_for_proposal.`;
}

/** The audio encoding a start_export preset delivers for a sequence (its ExportSettings.audio). */
export function exportAudioOfPreset(
	seq: Sequence,
	p: NonNullable<ReturnType<typeof findExportPreset>>,
): SoundCheckExportAudio {
	const audio = buildExportSettings(seq, p, { range: { type: 'entire' }, engine: 'auto' }).audio!;
	return {
		codec: audio.codec,
		...(audio.codec !== 'pcm' && audio.bitrateKbps ? { bitrateKbps: audio.bitrateKbps } : {}),
		sampleRate: audio.sampleRate,
	};
}

/**
 * The encoding Sound Check delivers through when the caller names none: the delivery preset's typical one
 * (`DELIVERY_PRESETS[…].typicalAudio`; the request's preset, else the sequence's); undefined for PCM (the master).
 */
export function typicalCheckAudio(seq: Sequence, preset?: SoundDelivery): SoundCheckExportAudio | undefined {
	const id = preset ?? (soundDesignSettingsOf(seq).delivery as SoundDelivery);
	const a = (DELIVERY_PRESETS[id] ?? DELIVERY_PRESETS.web).typicalAudio;
	return a.codec === 'pcm'
		? undefined
		: { codec: a.codec, ...(a.bitrateKbps ? { bitrateKbps: a.bitrateKbps } : {}) };
}

export function registerSoundCheckTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'sound_check',
		{
			title: 'Sound Check (measured QA of the mix)',
			description: `Measures a sequence's sound the way it will be delivered and returns what to fix and where to listen. You cannot hear: this is how you check your sound design. The engine renders the mix (with the Mix's loudness normalisation and true-peak limiter, exactly as an export) and its stems — sound effects, dialogue, music, ambience, bed — in one pass, finds speech (transcript + voice activity) and checks: LOUDNESS (integrated vs the delivery preset ±1 LU; under 400 ms of audible audio it is "not measurable", never a pass), TRUE_PEAK (over the preset's ceiling), OUT_OF_SYNC (each placed sound located in the sound-effects mix by cross-correlation within ±3 frames of its cue: cut ±1, land ±2, move ±3, appear ±1 frame; offset in ms; or "cut": its clip ends at its peak; an end-aligned riser or reverse may end 250 ms before to 30 ms after its cue), TRUNCATED (a placed sound's clip ends before the sound has faded to −60 dB: older copies without trailing silence; the safe fix is swap_sound to the same sound, which re-registers it, or soundDesign.swap on its own media), INEXACT (information: a library sound used as it is, not as a sample-exact copy — over 1 h, its copy over the size cap, or no free disk space when it was added — so its placement is exact to a frame, not to the sample; import_sounds / insert_sound said so then), MASKED (dominant-band lift over the bed under 1.5 dB support / 3 dB hero, the masking solver's own definition), OVERLOAD (a sound over the bed cap, the export limiter pulling > 3 dB, clipping without normalisation), MUSIC_OVER_VOICE (music not 8 LU under the voice during speech), SILENCE (< −60 dBFS in every channel for ≥ 0.5 s outside silence cues), DIP (short-term drop > 10 LU with no stop-before, cut, silence cue, Volume keyframes lowering the level there; only the bed under the voice and effects dropping counts), STALE_CUE (the cue's anchor moved), NO_PICTURE_EVENT (a derived cue with nothing on screen), DENSITY (heroes too close, too many cues per second), REPEAT (the same file back to back), LICENSE (non-commercial, no-derivatives, unknown or undeclared licences: error / warning; a CC BY-SA sound: a ShareAlike warning — the video must then be shared under CC BY-SA), CREDITS (CC-BY sounds without a credits file), and the edit / tone / director lenses: CLICK (a click within 2 ms of a clip edge, remix joint or transition edge: error, a 1-frame fade fixes it; inside a clip: info), EDGE (a clip whose head starts mid-sound, a decay chopped at its Out point, music chopped at a joint: warning, a fade or a 100 ms crossfade fixes it), HARSH (a placed sound more than 6 dB over the music's — else the dialogue's — loudest 2–6 kHz 5 ms level: warning, lowered by the excess when it stays unmasked; a bright sound, centroid > 6.5 kHz: info), LAYER_INAUDIBLE (a layer of a multi-layer cue adding < 1 dB in every 1/3-octave band: info), COVERAGE (some cues of a class of action — same kind and anchor, by clip or track — filled and others not: warning, fill them or mute them, the user's call), ENDING (the mix ends mid-sound: last 50 ms over −45 dBFS RMS or last 10 ms over −60 dBFS peak; a Mix fade-out, the user's call), HEAD (the first 5 ms over −40 dBFS: info) and ARC (the loudest 3 s hold no hero, or sit in the last 15 % without one: info). Each finding has a severity, a timecode, a message and, where one exists, a fix: {kind: commands → apply_commands args | job → rebalance_sfx / apply_delivery args | swap → swap_sound args, safe}. Apply ONLY the fixes marked safe, in the order of safeFixes (each one undo step, each once), then run sound_check again; leave the others to the user. The safe fixes are judged together: each is safe on its own and after the safe fixes before it in safeFixes — a fix that would undo or overload what another one does (a hero's gain and its demotion), or with loudness normalisation off push the mix's true peak over the ceiling, is not safe and says why (fix.why; fix.conflictsWith names the findings it conflicts with: run sound_check again after the others). A mono Mix is checked in mono (loudness.layout). listen: up to five "listen here" moments (worst finding, biggest hero, loudest moment, busiest moment, a cue that passes) — give them to the user VERBATIM and never say the result "sounds good". verdict: pass | warn | fail. images (default true) adds ONE PNG of up to three of the worst moments (±2 s each: loudness curves, waveform, cue ticks, findings). store: true writes the summary into the sequence (one undo step "Sound Check Result"; the editor shows whether it is still current). target: {integratedLufs, truePeakDb} checks a custom delivery target instead of the preset's numbers. humanVerdicts: what the user said after listening in the editor's Sound Check panel — "sounds right" or "flagged" with their note, at a timecode, with the listen slot and the clip / cue it judged; stale: true (staleReasons moment / moved / gone) when what plays there changed since they listened, so the verdict no longer covers it (null for older verdicts that cannot tell); they are the user's comment markers: read them, fix what is flagged, ask the user to listen again to stale ones, and never add or change them yourself. get_sound_check returns the last report without running the check. Acknowledged findings (acknowledge_sound_issue, or the user in the Sound Check panel): a deliberate exception with a reason — left out of the verdict and of safeFixes, counted in counts.acknowledged and listed under acknowledged (findings lists the ones that count); a finding acknowledged before its clips / cue / moment changed counts again ("acknowledged before the change"). proposalId (+ itemIds, default every item left to review) checks a PROPOSAL before review instead: the engine runs the check on the proposal's preview document (nothing is applied, the revision does not change, store is refused) and returns proposal: "fixes n · introduces m", the verdict before → after, each finding fixed / introduced with the item whose clips it names, per item, and the items skipped (stale, invalid); the result is kept on the proposal (get_proposal shows it, so does the Review panel). Run it on every proposal before asking the user to review it. profileId (default the sequence's, set_sound_profile; null: none) compares the delivered mix with a reference profile the user built from their own media (build_sound_profile): reference.rows — one per metric, the value against the references' min–max widened by a tolerance, ok / low / high, with what to do and the timecodes (the cuts with no sound, the gaps, the dead end) — and findings of code REFERENCE (warnings for major rows, infos for minor ones; never errors: a style, not a defect; LOUDNESS and TRUE_PEAK keep following the delivery target). A sequence that is one of the profile's references is judged against the others (leave-one-out). exportPreset (a start_export preset id) or exportAudio {codec, bitrateKbps} checks the mix as that export delivers it: with the Mix's loudness normalisation the limiter runs under the codec's headroom (loudness.normalization.limiterCeilingDb, codecHeadroomDb), the encoded audio is decoded and turned down locally where it still overshoots, and LOUDNESS / TRUE_PEAK judge the decoded audio (loudness.delivered {codec, integratedLufs, truePeakDb, truePeakMet}); for the PCM master ({codec: "pcm"}) they judge the PCM mix, and a lossy export checks itself again when it is written (start_export result.audioLoudness). loudness.normalization.ceilingLimited: the limiter cannot make the mix louder under its ceiling (the target is out of reach: lower the loudest moments). Run it with the preset you will export with (the default is the delivery preset's typical encoding: Web AAC 256 kb/s, Podcast AAC 128 kb/s, broadcast PCM — pass exportAudio {codec: "pcm"} for the PCM master); the stored summary records the encoding it was checked for (summary.exportAudio, get_sound_check). Waits for the job (timeoutSeconds, default 300).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				preset: z
					.enum(SOUND_DELIVERIES)
					.optional()
					.describe('Delivery preset to check against (default the sequence’s: web −14 LUFS / −1 dBTP…)'),
				target: z
					.object({
						integratedLufs: z
							.number()
							.min(SOUND_CHECK_TARGET_LIMITS.integratedLufs.min)
							.max(SOUND_CHECK_TARGET_LIMITS.integratedLufs.max),
						truePeakDb: z
							.number()
							.min(SOUND_CHECK_TARGET_LIMITS.truePeakDb.min)
							.max(SOUND_CHECK_TARGET_LIMITS.truePeakDb.max),
					})
					.optional()
					.describe(
						'A custom delivery target (integrated LUFS, true-peak ceiling dBTP) checked instead of the preset’s numbers; the preset still sets the default sound-effect levels',
					),
				range: RangeArg.optional(),
				store: z
					.boolean()
					.optional()
					.describe('Store the summary in the sequence (default false; not with proposalId)'),
				images: z
					.boolean()
					.optional()
					.describe('Add a PNG of the worst moments (default true; none for a proposal check)'),
				proposalId: z
					.string()
					.optional()
					.describe(
						'Check this proposal before review: the check runs on its preview (nothing applied) and returns what it fixes and introduces, per item',
					),
				itemIds: z
					.array(z.string())
					.min(1)
					.max(2000)
					.optional()
					.describe('With proposalId: the items to check (default every item left to review)'),
				profileId: ProfileIdArg.nullable()
					.optional()
					.describe(
						'Compare with this reference profile (default the sequence’s, set_sound_profile; null: no comparison)',
					),
				exportPreset: z
					.string()
					.optional()
					.describe(
						'Check the mix as this start_export preset delivers it (list_export_presets: its audio codec and bit rate — AAC in MP4, Opus in WebM, PCM in MOV): with the Mix’s loudness normalisation, LOUDNESS and TRUE_PEAK judge the encoded audio decoded (loudness.delivered), with the codec’s limiter headroom (loudness.normalization.limiterCeilingDb)',
					),
				exportAudio: z
					.strictObject({
						codec: z.enum(['aac', 'opus', 'pcm']),
						bitrateKbps: z.number().int().min(16).max(1536).optional(),
						sampleRate: z.union([z.literal(44100), z.literal(48000), z.literal(96000)]).optional(),
					})
					.optional()
					.describe(
						'Instead of exportPreset: the export’s audio encoding (start_export’s audio settings; bit rate default 192 kb/s); {codec: "pcm"} checks the PCM master. Default (neither given): the delivery preset’s typical encoding — Web AAC 256 kb/s, Podcast AAC 128 kb/s, broadcast PCM — as the editor’s Sound Check panel does until the sequence is exported',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the job (default 300)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.proposalId && a.store)
				throw new ToolError(
					'E_INVALID_PARAM',
					'A proposal check never stores its summary (it is kept on the proposal): leave out store',
					'Call sound_check {proposalId} without store.',
				);
			if (a.itemIds && !a.proposalId)
				throw new ToolError(
					'E_INVALID_PARAM',
					'itemIds needs proposalId',
					'Pass the proposal the items are of.',
				);
			if (a.exportPreset && a.exportAudio)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Pass exportPreset or exportAudio, not both',
					'exportPreset names a start_export preset; exportAudio gives the codec and bit rate yourself.',
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let exportAudio = a.exportAudio;
			if (a.exportPreset) {
				const p = findExportPreset(a.exportPreset);
				if (!p)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Unknown export preset "${a.exportPreset}"`,
						`Use one of: ${EXPORT_PRESETS.map((x) => x.id).join(', ')} (list_export_presets).`,
					);
				exportAudio = exportAudioOfPreset(seq, p);
			}
			// neither given: the delivery preset's typical encoding (the panel's "Check for" default before an export)
			if (!a.exportPreset && !a.exportAudio) exportAudio = typicalCheckAudio(seq, a.preset);
			// the PCM master: no encoding to deliver through
			if (exportAudio?.codec === 'pcm' && !exportAudio.sampleRate) exportAudio = undefined;
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (range.end <= range.start)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range.end (${range.end}) must be after range.start (${range.start})`,
						TIME_FORMATS,
					);
			}
			const job = await ctx
				.engine((c) =>
					c.soundCheck(
						{
							projectId: a.projectId,
							sequenceId: seq.id,
							...(a.preset ? { preset: a.preset } : {}),
							...(a.target ? { target: a.target } : {}),
							...(range ? { range } : {}),
							...(a.store ? { store: true } : {}),
							...(a.proposalId ? { proposalId: a.proposalId } : {}),
							...(a.itemIds ? { itemIds: a.itemIds } : {}),
							...(a.profileId !== undefined ? { profileId: a.profileId } : {}),
							...(exportAudio ? { exportAudio } : {}),
						},
						extra.signal,
					),
				)
				.catch(toolError);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `The check is still running: wait_for_job {jobId: "${done.id}"}, then call sound_check again (or read the job's result).`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The sound check ${done.state}`,
					SOUND_CHECK_HINTS[done.error?.code ?? ''] ??
						'Check that the media is online (list_offline_media) and the arguments, then try again.',
				);
			const result = SoundCheckResultSchema.parse(done.result);
			const r = result.report;
			const listen = r.listen.map((l) => `${l.timecode} — ${l.why.text}`);
			const table = eventTable(r);
			const content: { type: 'image'; data: string; mimeType: string }[] = [];
			const pictures: { frame: number; range: { start: number; end: number } }[] = [];
			// a proposal check's pictures would show the current document, not the proposal: none
			if (a.images !== false && !result.proposal) {
				const fps = r.fps.num / r.fps.den;
				const pad = Math.round(STRIP_PAD_SEC * fps);
				const duration = Math.max(1, Math.ceil(sequenceDuration(seq)));
				const strips = [];
				for (const f of worstFrames(r, MAX_STRIPS)) {
					const pr = { start: Math.max(0, f - pad), end: Math.min(duration, f + pad + 1) };
					if (pr.end <= pr.start) continue;
					const v = SoundVisualResponseSchema.parse(
						await ctx
							.engine((c) =>
								c.soundVisual(
									{ projectId: a.projectId, sequenceId: seq.id, range: pr, checkJobId: done.id },
									extra.signal,
								),
							)
							.catch(toolError),
					);
					strips.push(
						drawSoundTimeline(v, { width: 960, title: `Around ${sequenceTimecode(seq, f)}` }).image,
					);
					pictures.push({ frame: f, range: pr });
				}
				if (strips.length) {
					const sheet = composeGrid(strips, 1, 4);
					content.push({ type: 'image', data: encodePng(sheet).toString('base64'), mimeType: 'image/png' });
				}
			}
			return jsonResult(
				{
					jobId: done.id,
					verdict: r.verdict,
					preset: r.preset,
					range: { ...r.range, timecodes: r.rangeTimecode, wholeSequence: r.wholeSequence },
					counts: r.counts,
					loudness: r.loudness,
					...(result.proposal
						? {
								proposal: proposalCheckSummary(result.proposal),
								what: 'The verdict, counts, findings and issues below are of the proposal’s preview (the current document with the checked items applied), not of the current document.',
							}
						: {}),
					listen,
					humanVerdicts: humanVerdictsOf(doc, seq, r),
					findings: openIssues(r).map(issueLine),
					...acknowledgedOf(r),
					...(r.reference ? { reference: referenceSection(r.reference) } : {}),
					issues: r.issues,
					safeFixes: result.proposal ? [] : safeFixesOf(r),
					table,
					speech: r.speech,
					stems: r.stems,
					...(r.warnings.length ? { warnings: r.warnings } : {}),
					stored: result.stored,
					...(result.stored ? { revision: result.revision } : {}),
					...(pictures.length
						? {
								pictures: {
									what: 'One strip per worst moment, top to bottom: momentary loudness of the mix (white), bed (blue), sound effects (orange), music (purple), dialogue (green); waveform; sound effect clips with their aligned point; cue ticks; motion; findings as flags.',
									strips: pictures,
								},
							}
						: {}),
					next: result.proposal ? proposalCheckNext(result.proposal) : nextOf(r, listen),
				},
				content,
			);
		},
	);

	defineTool(
		ctx,
		'get_sound_check',
		{
			title: 'Get the last Sound Check report',
			description:
				"The last full Sound Check report of a sequence without running the check again: the engine keeps each sequence's last report (findings with their fixes, listen-here moments, the per-event table) across restarts. state: current | stale with reasons — mix (the mix changed since: `mixFingerprint`) or inputs (cues, loudness settings, credits or the target changed); a stale report's fixes may no longer apply: run sound_check again before applying any. Also returns humanVerdicts (the user's listen-here verdicts, each with stale / staleReasons). The verdict, counts and acknowledged list follow the sequence's acknowledgements as they are now. Error SOUND_CHECK_NOT_FOUND when the sequence was never checked (or its report was not kept).",
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const kept = SoundCheckLastResponseSchema.parse(
				await ctx
					.engine((c) => c.lastSoundCheck({ projectId: a.projectId, sequenceId: seq.id }, extra.signal))
					.catch(toolError),
			);
			// acknowledgements as the document says now (they may have changed since the report)
			const acked = applySoundAcknowledgements(doc, seq.id, kept.result.report.issues);
			const r: SoundCheckReport = {
				...kept.result.report,
				issues: acked.issues as SoundCheckIssue[],
				verdict: acked.verdict,
				counts: acked.counts,
				acknowledgements: { count: acked.acknowledged, unmatched: acked.unmatched },
			};
			const listen = r.listen.map((l) => `${l.timecode} — ${l.why.text}`);
			return jsonResult({
				jobId: kept.jobId,
				savedAt: kept.savedAt,
				state: kept.state,
				...(kept.reasons.length ? { reasons: kept.reasons } : {}),
				verdict: r.verdict,
				preset: r.preset,
				range: { ...r.range, timecodes: r.rangeTimecode, wholeSequence: r.wholeSequence },
				counts: r.counts,
				loudness: r.loudness,
				listen,
				humanVerdicts: humanVerdictsOf(doc, seq, r),
				findings: openIssues(r).map(issueLine),
				...acknowledgedOf(r),
				...(r.reference ? { reference: referenceSection(r.reference) } : {}),
				issues: r.issues,
				safeFixes: kept.state === 'stale' ? [] : safeFixesOf(r),
				table: eventTable(r),
				next:
					kept.state === 'stale'
						? `This report is stale (${kept.reasons.join(', ')} changed since it was made): run sound_check again before applying any fix.`
						: nextOf(r, listen),
			});
		},
	);

	defineTool(
		ctx,
		'acknowledge_sound_issue',
		{
			title: 'Acknowledge a Sound Check finding (deliberate exception)',
			description:
				'Marks a finding of the sequence\'s last Sound Check (get_sound_check / sound_check: its key is the issue id, e.g. "ENDING:end", "EDGE:clp_…:end") as a deliberate exception, with a reason (1–300 characters): the next sound_check leaves it out of the verdict and of safeFixes, counts it (counts.acknowledged) and lists it under acknowledged, until what it is about changes (its clips, its cue, or what plays around its frame): then it counts again, "acknowledged before the change". Use it for choices the user made on purpose — a hard cut to black, a sound under the voice they want there, a riser that ends early — so you stop "fixing" them; say why in the reason, and never acknowledge something to make the verdict pass. You may acknowledge warnings and infos only: an error is the user\'s call (E_APPROVAL_REQUIRED: ask the user to acknowledge it in the Sound Check panel, or fix it). unacknowledge: true takes an acknowledgement back (the finding counts again). One undo step ("Acknowledge Sound Check Finding"). The finding is looked up in the last report the engine keeps: run sound_check first.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				key: z
					.string()
					.min(3)
					.max(256)
					.describe("The finding's key: its issue id in the last Sound Check report"),
				reason: z
					.string()
					.min(1)
					.max(300)
					.optional()
					.describe('Why it is deliberate (required unless unacknowledge)'),
				unacknowledge: z
					.boolean()
					.optional()
					.describe('Take the acknowledgement back instead (default false)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			if (a.unacknowledge) {
				const res = await transact(
					ctx,
					a.projectId,
					{
						label: 'Unacknowledge Sound Check Finding',
						sequenceId: seq.id,
						commands: [{ type: 'soundDesign.unacknowledgeIssue', sequenceId: seq.id, key: a.key }],
					},
					extra,
				);
				return jsonResult({
					...txBody(res, requireOk(res)),
					key: a.key,
					next: 'It counts again from the next sound_check.',
				});
			}
			if (!a.reason?.trim())
				throw new ToolError(
					'E_INVALID_PARAM',
					'reason is required: say why the finding is deliberate',
					'Pass reason (1–300 characters), e.g. "the cut to black is the punchline".',
				);
			const kept = SoundCheckLastResponseSchema.parse(
				await ctx
					.engine((c) => c.lastSoundCheck({ projectId: a.projectId, sequenceId: seq.id }, extra.signal))
					.catch(toolError),
			);
			const issue = kept.result.report.issues.find((i) => i.id === a.key);
			if (!issue)
				throw new ToolError(
					'E_NOT_FOUND',
					`The last Sound Check of ${seq.id} has no finding ${a.key}`,
					"Run sound_check and use a finding's id from its issues (or acknowledged list).",
					{ keys: kept.result.report.issues.slice(0, 50).map((i) => i.id) },
				);
			if (issue.severity === 'error')
				throw new ToolError(
					'E_APPROVAL_REQUIRED',
					`${a.key} is an error: only the user can acknowledge it`,
					'Fix it (its fix, or another edit), or ask the user to acknowledge it in the Sound Check panel ("Acknowledge…" on its row) if it is deliberate. Do not retry.',
				);
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: 'Acknowledge Sound Check Finding',
					sequenceId: seq.id,
					commands: [
						{
							type: 'soundDesign.acknowledgeIssue',
							sequenceId: seq.id,
							key: issue.id,
							code: issue.code,
							severity: issue.severity,
							reason: a.reason.trim(),
							target: {
								...(issue.clipIds?.length ? { clipIds: issue.clipIds.slice(0, 16) } : {}),
								...(issue.cueId ? { cueId: issue.cueId } : {}),
								...(!issue.clipIds?.length &&
								!issue.cueId &&
								(issue.frame ?? issue.range?.start) !== undefined
									? { frame: issue.frame ?? issue.range!.start }
									: {}),
							},
							message: issue.message.text.slice(0, 500),
						},
					],
				},
				extra,
			);
			return jsonResult({
				...txBody(res, requireOk(res)),
				key: issue.id,
				finding: issueLine(issue),
				...(kept.state === 'stale'
					? {
							warning: `The kept report is stale (${kept.reasons.join(', ')} changed since): run sound_check to see the finding as it is now.`,
						}
					: {}),
				next: 'The next sound_check leaves it out of the verdict and lists it under acknowledged, until what it is about changes.',
			});
		},
	);
}
