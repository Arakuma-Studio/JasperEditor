// A small, schema-valid Sound Check report for tests that fake the engine (the MCP `sound_check` humanVerdicts test, the
// web Sound Check panel tests): two sync findings with command fixes, a silence finding, a loudness finding, listen-here
// moments. Real reports come from `apps/engine/src/sound-design/check.ts` (its own tests use the real engine).
import {
	type SoundCheckIssue,
	type SoundCheckReport,
	SoundCheckReportSchema,
	type SoundCheckResult,
} from '@jasper/api';
import { soundCheckCounts, soundCheckMessage, soundCheckVerdict } from '@jasper/project';

const tc = (f: number) => {
	const s = Math.floor(f / 30);
	return `00:00:${String(s).padStart(2, '0')}:${String(f % 30).padStart(2, '0')}`;
};

export type ReportFixtureOptions = {
	projectId: string;
	sequenceId: string;
	/** Clip ids the sync findings are about (a nudged hit, a cut click). */
	clipA?: string;
	clipB?: string;
	cueA?: string;
	mixHash?: string;
	inputsHash?: string;
	/** Leave out these issue codes (a re-check after fixes). */
	without?: readonly SoundCheckIssue['code'][];
};

export function reportFixture(o: ReportFixtureOptions): SoundCheckReport {
	const clipA = o.clipA ?? 'clp_a';
	const clipB = o.clipB ?? 'clp_b';
	const cueA = o.cueA ?? 'cue_a';
	const all: SoundCheckIssue[] = [
		{
			id: `OUT_OF_SYNC:${clipA}`,
			code: 'OUT_OF_SYNC',
			severity: 'error',
			category: 'sync',
			frame: 90,
			timecode: tc(90),
			clipIds: [clipA],
			cueId: cueA,
			message: soundCheckMessage('syncLate', 'Impact', 66.7, 'cut', tc(90), 1),
			measured: { offsetMs: 66.7, measuredIn: 'mix' },
			fix: {
				kind: 'commands',
				label: soundCheckMessage('fixAlign'),
				safe: true,
				tool: 'align_peak',
				args: { projectId: o.projectId, clipIds: [clipA], to: 'cue' },
				commands: [{ type: 'clip.move', clipIds: [clipA], deltaFrames: -2 }],
			},
		},
		{
			id: `TRUNCATED:${clipB}`,
			code: 'TRUNCATED',
			severity: 'warning',
			category: 'sync',
			frame: 150,
			timecode: tc(150),
			clipIds: [clipB],
			message: soundCheckMessage('truncated', 'Click', tc(151), 12.5),
			fix: {
				kind: 'swap',
				label: soundCheckMessage('fixRepad', 'Click'),
				safe: true,
				tool: 'swap_sound',
				args: { projectId: o.projectId, clipId: clipB, to: 'snd_00000000000000b1' },
				swap: { clipId: clipB, soundId: 'snd_00000000000000b1' },
			},
		},
		{
			id: 'SILENCE:210',
			code: 'SILENCE',
			severity: 'warning',
			category: 'mix',
			frame: 210,
			timecode: tc(210),
			range: { start: 210, end: 234 },
			message: soundCheckMessage('silence', 0.8, tc(210), tc(234)),
			fix: {
				kind: 'commands',
				label: soundCheckMessage('fixSilenceCue'),
				safe: false,
				why: 'Only if the silence is intended',
				tool: 'apply_commands',
				args: {},
				commands: [
					{
						type: 'soundCue.add',
						cues: [{ frame: 210, kind: 'silence', weight: 'ambient', source: 'user' }],
					},
				],
			},
		},
		{
			id: 'LOUDNESS:mix',
			code: 'LOUDNESS',
			severity: 'warning',
			category: 'loudness',
			range: { start: 0, end: 300 },
			message: soundCheckMessage('loudnessOff', -17.2, -3.2, 'Web / streaming (−14 LUFS)', -14),
			fix: {
				kind: 'commands',
				label: soundCheckMessage('fixLoudness', -14, -1),
				safe: true,
				tool: 'apply_commands',
				args: {},
				commands: [{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 }],
			},
		},
		{
			id: 'MUSIC_OVER_VOICE:0',
			code: 'MUSIC_OVER_VOICE',
			severity: 'warning',
			category: 'mix',
			frame: 120,
			timecode: tc(120),
			range: { start: 120, end: 200 },
			message: soundCheckMessage('musicOverVoice', tc(120), tc(200), 3.1, 8),
			fix: {
				kind: 'job',
				label: soundCheckMessage('fixDuck'),
				safe: true,
				tool: 'apply_delivery',
				args: {},
				job: {
					route: 'delivery',
					body: {
						projectId: o.projectId,
						sequenceId: o.sequenceId,
						mode: 'apply',
						delivery: 'web',
						loudness: false,
						autoMatch: false,
						rebalance: false,
					},
				},
			},
		},
	];
	const issues = all.filter((i) => !o.without?.includes(i.code));
	const report: SoundCheckReport = {
		version: 1,
		projectId: o.projectId,
		sequenceId: o.sequenceId,
		revision: 1,
		mixHash: o.mixHash ?? 'mix',
		inputsHash: o.inputsHash ?? 'inputs',
		preset: {
			id: 'web',
			label: 'Web / streaming (−14 LUFS)',
			integratedLufs: -14,
			truePeakDb: -1,
			source: 'x',
		},
		range: { start: 0, end: 300 },
		rangeTimecode: { start: tc(0), end: tc(300) },
		wholeSequence: true,
		fps: { num: 30, den: 1 },
		durationSec: 10,
		verdict: soundCheckVerdict(issues),
		counts: soundCheckCounts(issues),
		issues,
		events: [
			{
				clipId: clipA,
				cueId: cueA,
				title: 'Impact',
				track: 'A3',
				role: 'hero',
				weight: 'hero',
				soundId: 'snd_00000000000000a1',
				license: 'CC0-1.0',
				frame: 90,
				timecode: tc(90),
				cueKind: 'cut',
				align: 'peak',
				toleranceFrames: 1,
				offsetMs: issues.some((i) => i.code === 'OUT_OF_SYNC') ? 66.7 : 0.4,
				located: 'found',
				correlation: 0.97,
				gainDb: -6,
				liftDb: 6,
				minLiftDb: 3,
				targetLiftDb: 5,
				peakOverBedLu: 8,
				bedCapLu: 10,
				speech: false,
				status: issues.some((i) => i.code === 'OUT_OF_SYNC') ? 'fail' : 'pass',
				codes: issues.some((i) => i.code === 'OUT_OF_SYNC') ? ['OUT_OF_SYNC'] : [],
			},
		],
		listen: [
			...(issues.some((i) => i.severity !== 'info')
				? [
						{
							slot: 'worst' as const,
							frame: 90,
							timecode: tc(90),
							seconds: 3,
							why: soundCheckMessage('listenWorst', 'Impact plays 66.7 ms late'),
							issueId: `OUT_OF_SYNC:${clipA}`,
							clipId: clipA,
						},
					]
				: []),
			{
				slot: 'hero',
				frame: 91,
				timecode: tc(91),
				seconds: 3.03,
				why: soundCheckMessage('listenHero', 'Impact', -9.5),
				clipId: clipA,
			},
			{
				slot: 'loudest',
				frame: 120,
				timecode: tc(120),
				seconds: 4,
				why: soundCheckMessage('listenLoudest', -8.1),
			},
			{
				slot: 'densest',
				frame: 150,
				timecode: tc(150),
				seconds: 5,
				why: soundCheckMessage('listenDensest', 3),
			},
			{
				slot: 'passing',
				frame: 270,
				timecode: tc(270),
				seconds: 9,
				why: soundCheckMessage('listenPassing', 'Whoosh (00:00:09:00)'),
			},
		],
		loudness: {
			integratedLufs: -17.2,
			truePeakDb: -2.1,
			samplePeakDb: -2.4,
			lra: 6.3,
			maxMomentaryLufs: -8.1,
			maxShortTermLufs: -12,
			measurable: true,
			normalization: { enabled: false, targetLufs: null, truePeakDb: null, gainDb: null },
			limiterMaxGrDb: null,
			before: { integratedLufs: -17.2, truePeakDb: -2.1, samplePeakDb: -2.4 },
		},
		curves: {
			hopSec: 0.1,
			startSec: 0,
			points: 100,
			window: 'momentary',
			mix: Array.from({ length: 100 }, (_, i) => -20 + 5 * Math.sin(i / 5)),
			bed: Array.from({ length: 100 }, () => -24),
			sfx: Array.from({ length: 100 }, (_, i) => (i % 30 === 0 ? -10 : -60)),
			music: Array.from({ length: 100 }, () => -26),
			dialogue: Array.from({ length: 100 }, (_, i) => (i > 40 && i < 70 ? -18 : -70)),
			ambience: Array.from({ length: 100 }, () => -120),
			limiterGrDb: [],
		},
		speech: { seconds: 3, segments: [[4, 7]] },
		stems: { mix: 4, sfx: 2, dialogue: 1, music: 1, ambience: 0, bed: 2 },
		warnings: [],
		timings: { total: 1000 },
	};
	return SoundCheckReportSchema.parse(report);
}

export function resultFixture(o: ReportFixtureOptions & { stored?: boolean }): SoundCheckResult {
	return {
		projectId: o.projectId,
		sequenceId: o.sequenceId,
		stored: o.stored ?? false,
		revision: 2,
		report: reportFixture(o),
	};
}
