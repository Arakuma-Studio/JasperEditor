// AF-SEC-001 (spec 18 §2.1): every FFmpeg / ffprobe input of a media file is restricted to local protocols, and
// every place that starts the binaries directly applies the restriction (a source scan, so a new spawn site cannot
// forget it). The network refusal end to end is local-inputs-network.test.ts.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import {
	blockedReference,
	LOCAL_PROTOCOLS,
	NETWORK_DEMUXERS,
	parseDemuxers,
	probeFormatWhitelist,
	restrictInputs,
	restrictProbeArgs,
} from '../src/tools/protocols.ts';
import { ROOT } from './fixtures.ts';

const LOCAL = [...LOCAL_PROTOCOLS];

describe('restrictInputs (ffmpeg argument lists)', () => {
	it('puts the local whitelist right before every file input, after that input’s own options', () => {
		expect(
			restrictInputs(['-ss', '1.5', '-i', '/m/a.mp4', '-i', '/m/b.wav', '-map', '0:v', 'out.mp4']),
		).toEqual([
			'-ss',
			'1.5',
			...LOCAL,
			'-i',
			'/m/a.mp4',
			...LOCAL,
			'-i',
			'/m/b.wav',
			'-map',
			'0:v',
			'out.mp4',
		]);
	});

	it('pipes may use the pipe protocols only (`-` opens fd: in FFmpeg 6.1+); lavfi sources open no protocol and are left alone', () => {
		expect(
			restrictInputs([
				...['-f', 'rawvideo', '-s', '2x2', '-i', 'pipe:3'],
				...['-f', 'f32le', '-i', '-'],
				...['-f', 'lavfi', '-i', 'color=c=black:s=2x2'],
				'pipe:1',
			]),
		).toEqual([
			...['-f', 'rawvideo', '-s', '2x2', '-protocol_whitelist', 'pipe,fd', '-i', 'pipe:3'],
			...['-f', 'f32le', '-protocol_whitelist', 'pipe,fd', '-i', '-'],
			...['-f', 'lavfi', '-i', 'color=c=black:s=2x2'],
			'pipe:1',
		]);
	});

	it('keeps a whitelist the caller chose for that input, and only for that input', () => {
		expect(restrictInputs([...LOCAL, '-i', '/a.mov', '-i', '/b.mov'])).toEqual([
			...LOCAL,
			'-i',
			'/a.mov',
			...LOCAL,
			'-i',
			'/b.mov',
		]);
	});

	it('leaves argument lists without inputs unchanged (-filters, -version, -buildconf)', () => {
		expect(restrictInputs(['-filters'])).toEqual(['-filters']);
		expect(restrictInputs(['-buildconf'])).toEqual(['-buildconf']);
	});

	it('property: every -i of the result has a whitelist in its own option group; nothing else changes', () => {
		const input = fc.oneof(
			fc.constant(['-i', '/media/x.mp4']),
			fc.constant(['-ss', '2', '-i', '/media/y.mov']),
			fc.constant(['-f', 'lavfi', '-i', 'anullsrc']),
			fc.constant(['-f', 'rawvideo', '-i', 'pipe:0']),
			fc.constant(['-f', 'f32le', '-i', '-']),
			fc.constant([...LOCAL, '-i', '/media/z.wav']),
		);
		fc.assert(
			fc.property(fc.array(input, { maxLength: 8 }), (groups) => {
				const args = [...groups.flat(), '-map', '0', 'out.mkv'];
				const out = restrictInputs(args);
				let group: string[] = [];
				for (let i = 0; i < out.length; i++) {
					if (out[i] === '-i') {
						const src = out[i + 1]!;
						const f = group[group.lastIndexOf('-f') + 1];
						if (group.includes('-f') && f === 'lavfi') expect(group).not.toContain('-protocol_whitelist');
						else expect(group).toContain('-protocol_whitelist');
						const wl = group[group.lastIndexOf('-protocol_whitelist') + 1];
						if (src.startsWith('pipe:') || src === '-') expect(wl).toBe('pipe,fd');
						else if (f !== 'lavfi') expect(wl).toBe('file,crypto,data');
						group = [];
						i++;
					} else group.push(out[i]!);
				}
				const stripped: string[] = [];
				for (let i = 0; i < out.length; i++) {
					if (out[i] === '-protocol_whitelist') {
						i++;
						continue;
					}
					stripped.push(out[i]!);
				}
				const original = args.filter(
					(_, i) => args[i] !== '-protocol_whitelist' && args[i - 1] !== '-protocol_whitelist',
				);
				expect(stripped).toEqual(original);
			}),
		);
	});
});

describe('restrictInputs with a demuxer whitelist', () => {
	it('adds -format_whitelist to file inputs only (pipes and lavfi keep their forced formats)', () => {
		expect(
			restrictInputs(
				['-ss', '1', '-i', '/m/a.mp4', '-f', 'rawvideo', '-i', 'pipe:3', '-f', 'lavfi', '-i', 'anullsrc'],
				'mov,wav',
			),
		).toEqual([
			...['-ss', '1', ...LOCAL, '-format_whitelist', 'mov,wav', '-i', '/m/a.mp4'],
			...['-f', 'rawvideo', '-protocol_whitelist', 'pipe,fd', '-i', 'pipe:3'],
			...['-f', 'lavfi', '-i', 'anullsrc'],
		]);
	});
});

/** A fake ffmpeg that lists two demuxers and records the arguments of every other run. */
function fakeFfmpeg(): { bin: string; calls: () => string[][] } {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-fakeff-'));
	const bin = join(dir, 'ffmpeg');
	const log = join(dir, 'calls.jsonl');
	writeFileSync(
		bin,
		`#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes('-demuxers')) { process.stdout.write(${JSON.stringify(DEMUXERS_71)}); process.exit(0); }\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');\n`,
	);
	chmodSync(bin, 0o755);
	return {
		bin,
		calls: () =>
			existsSync(log)
				? readFileSync(log, 'utf8')
						.trim()
						.split('\n')
						.map((l) => JSON.parse(l) as string[])
				: [],
	};
}

describe('Ffmpeg.run passes the demuxer whitelist to runs with few file inputs', () => {
	it('a single-file run (a Media Browser thumbnail, an import) gets -format_whitelist without network demuxers', async () => {
		if (process.platform === 'win32') return;
		const fake = fakeFfmpeg();
		const ff = new Ffmpeg({ ffmpeg: fake.bin, ffprobe: fake.bin });
		await ff.run(['-i', '/m/x.mp4', '-frames:v', '1', '/tmp/out.jpg']);
		const [args] = fake.calls();
		const k = args!.indexOf('-format_whitelist');
		expect(k).toBeGreaterThan(-1);
		expect(args![k + 1]).toBe('aac,alsa,matroska,webm,wav');
		expect(args!.indexOf('-format_whitelist')).toBeLessThan(args!.indexOf('/m/x.mp4'));
		// Many inputs (an export composite): the protocol whitelist only, the command line stays short.
		await ff.run([...Array.from({ length: 5 }, (_, i) => ['-i', `/m/${i}.mp4`]).flat(), 'out.mp4']);
		const many = fake.calls()[1]!;
		expect(many).not.toContain('-format_whitelist');
		expect(many.filter((a) => a === '-protocol_whitelist')).toHaveLength(5);
	});
});

describe('restrictProbeArgs (ffprobe argument lists)', () => {
	it('adds the local whitelist and, when known, the demuxer whitelist in front', () => {
		expect(restrictProbeArgs(['-show_format', '/m/a.mp4'])).toEqual([...LOCAL, '-show_format', '/m/a.mp4']);
		expect(restrictProbeArgs(['-show_format', '/m/a.mp4'], 'mov,mp4,m4a,3gp,3g2,mj2,wav')).toEqual([
			...LOCAL,
			'-format_whitelist',
			'mov,mp4,m4a,3gp,3g2,mj2,wav',
			'-show_format',
			'/m/a.mp4',
		]);
	});
	it('keeps a caller’s whitelist', () => {
		expect(restrictProbeArgs([...LOCAL, '-show_streams', '/a.wav'])).toEqual([
			...LOCAL,
			'-show_streams',
			'/a.wav',
		]);
	});
});

const DEMUXERS_61 = `File formats:
 D. = Demuxing supported
 .E = Muxing supported
 --
 D  3dostr          3DO STR
 D  dash            Dynamic Adaptive Streaming over HTTP
 D  hls             Apple HTTP Live Streaming
 D  lavfi           Libavfilter virtual input device
 D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
 D  rtp             RTP input
 D  rtsp            RTSP input
 D  sap             SAP input
 D  sdp             SDP
`;
const DEMUXERS_71 = `Demuxers:
 D. = Demuxing supported
 .E = Muxing supported
 ..d = Is a device
 ---
 D   aac             raw ADTS AAC (Advanced Audio Coding)
 D d alsa            ALSA audio output
 D   dash            Dynamic Adaptive Streaming over HTTP
 D   matroska,webm   Matroska / WebM
 D   wav             WAV / WAVE (Waveform Audio)
`;

describe('demuxer whitelist for probes', () => {
	it('parses FFmpeg 6.1 and 7.1 listings', () => {
		expect(parseDemuxers(DEMUXERS_61)).toEqual([
			'3dostr',
			'dash',
			'hls',
			'lavfi',
			'mov,mp4,m4a,3gp,3g2,mj2',
			'rtp',
			'rtsp',
			'sap',
			'sdp',
		]);
		expect(parseDemuxers(DEMUXERS_71)).toEqual(['aac', 'alsa', 'dash', 'matroska,webm', 'wav']);
	});

	it('drops the demuxers that open network resources themselves (DASH ignores -protocol_whitelist)', () => {
		expect(NETWORK_DEMUXERS).toEqual(expect.arrayContaining(['dash', 'rtsp', 'rtp', 'sdp', 'sap']));
		expect(probeFormatWhitelist(DEMUXERS_61)).toBe('3dostr,hls,lavfi,mov,mp4,m4a,3gp,3g2,mj2');
		expect(probeFormatWhitelist(DEMUXERS_71)).toBe('aac,alsa,matroska,webm,wav');
	});

	it('an empty or unreadable listing gives no whitelist (the protocol whitelist still applies)', () => {
		expect(probeFormatWhitelist('')).toBeNull();
		expect(probeFormatWhitelist('garbage\n')).toBeNull();
	});
});

describe('blockedReference (stderr → what was refused)', () => {
	it('names the refused protocol or demuxer', () => {
		expect(
			blockedReference(
				"[http @ 0x55c8] Protocol 'http' not on whitelist 'file,crypto,data'!\n[hls @ 0x55c8] Error when loading first segment",
			),
		).toEqual({ kind: 'protocol', name: 'http' });
		expect(
			blockedReference("[dash @ 0x5d67] Format not on whitelist '3dostr,4xm'\nd.mpd: Invalid argument"),
		).toEqual({ kind: 'format', name: 'dash' });
		expect(blockedReference('clip.mp4: Invalid data found when processing input')).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Source scan: the Ffmpeg class (tools/ffmpeg.ts) restricts every run/spawnRaw/probe; code that starts a binary
// itself must either apply restrictInputs / restrictProbeArgs or be listed here as not running FFmpeg.

const ENGINE_SRC = join(ROOT, 'apps', 'engine', 'src');

/** Files that start processes but never FFmpeg / ffprobe, with what they start. */
const NOT_FFMPEG: Record<string, string> = {
	'tools/process.ts': 'the generic spawner (FFmpeg goes through tools/ffmpeg.ts or a guarded caller)',
	'speech/cuda.ts': 'ldconfig / nvidia-smi',
	'speech/service.ts': 'the jasper-speech worker and sysctl / nvidia-smi (the worker guards its own ffmpeg)',
	'roto/service.ts': 'the jasper-roto worker (roto/worker/frames.ts guards its ffmpeg)',
	'camtrack/service.ts': 'the jasper-camtrack worker (decodes through roto/worker/frames.ts)',
	'sounds/semantic/runtime.ts': 'the jasper-clap worker (sounds/semantic/worker/cli.ts guards its ffmpeg)',
	'mg/binary.ts': 'jasper-mg',
	'mg-bundles/scaffold.ts': 'the package manager',
	'mg-bundles/project.ts': 'the bundler',
	'mg-bundles/schemas.ts': 'node',
	'processing/remote.ts': 'ssh / scp / rsync (the remote side runs jasper-proc, which guards its ffmpeg)',
	'processing/proc/dejudder/pool.ts': 'worker threads',
	'routes/gaps.ts': 'the OS file opener',
};

/** Files that start ffmpeg / ffprobe themselves. */
const GUARDED = [
	'tools/ffmpeg.ts',
	'tools/encoders.ts',
	'speech/worker/run.ts',
	'speech/worker/audio.ts',
	'roto/worker/frames.ts',
	'sounds/semantic/worker/cli.ts',
	'mg/render.ts',
	'processing/service.ts',
	'processing/proc/ffio.ts',
	'processing/proc/probe.ts',
	'processing/proc/dejudder/validate.ts',
];

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...sources(p));
		else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
	}
	return out;
}

const SPAWNS = /\b(spawn|spawnSync|execFile|execFileSync|runTool|spawnTool)\(/;

describe('every FFmpeg spawn site restricts its inputs (source scan)', () => {
	const files = sources(ENGINE_SRC).map((p) => ({
		rel: relative(ENGINE_SRC, p).split('\\').join('/'),
		text: readFileSync(p, 'utf8'),
	}));

	it('each file that starts processes is classified', () => {
		const spawning = files
			.filter(
				(f) =>
					/^import\s+(?!type\b)[^;]*from 'node:child_process'/m.test(f.text) ||
					/import\('node:child_process'\)(?!\.)/.test(f.text) ||
					/\b(runTool|spawnTool)\(/.test(f.text),
			)
			.map((f) => f.rel);
		const unclassified = spawning.filter((f) => !GUARDED.includes(f) && !(f in NOT_FFMPEG));
		expect(unclassified, 'classify these in local-inputs.test.ts (GUARDED or NOT_FFMPEG)').toEqual([]);
	});

	it('the guarded files apply the restriction', () => {
		for (const rel of GUARDED) {
			const f = files.find((x) => x.rel === rel);
			expect(f, rel).toBeDefined();
			expect(SPAWNS.test(f!.text), `${rel} starts a process`).toBe(true);
			expect(
				/\brestrict(Inputs|ProbeArgs)\(/.test(f!.text),
				`${rel} applies restrictInputs / restrictProbeArgs`,
			).toBe(true);
		}
	});

	it('no engine source names a protocol beyond file, crypto, data, pipe and fd in a whitelist', () => {
		for (const f of files) {
			for (const m of f.text.matchAll(/protocol_whitelist['"`,\s]+['"`]([^'"`]+)['"`]/g)) {
				expect(
					m[1]!.split(',').every((p) => ['file', 'crypto', 'data', 'pipe', 'fd'].includes(p)),
					`${f.rel}: ${m[1]}`,
				).toBe(true);
			}
		}
	});
});
