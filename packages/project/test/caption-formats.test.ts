// Caption file readers/writers: FilmCraft's unit tests (crates/captions/src/*.rs) and property round trips
// (crates/captions/tests/roundtrip.rs), ported to vitest + fast-check, plus corruption tests (never a throw).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildCdp,
	CAPTION_FILE_FORMATS,
	type CaptionDocument,
	type CaptionFileFormat,
	type Cue,
	captionFormatFromName,
	ccTriplets,
	decodeCaptionText,
	decodePac,
	detectCaptionFormat,
	emptyCaptionDocument,
	encode6937,
	encodeChar,
	encodePac,
	FLICKS_PER_MS,
	formatClock,
	formatSccTimecode,
	frameAt,
	mccCompress,
	mccExpand,
	normalizeCaptionDocument,
	parseCaptionFile,
	parseClock,
	parseSccTimecode,
	parseTtmlTime,
	plainCaptionText,
	RATE_23_976,
	RATE_25,
	RATE_29_97,
	RATE_59_94,
	SCC_RATE,
	sccFrameOf,
	snapCaptionDocument,
	splitVoice,
	tickOf,
	withParity,
	wrapSccRows,
	writeCaptionFile,
	writeCaptionFileBytes,
	writeMcc,
	writeStl,
	writeTtml,
} from '../src/captions/formats/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const MS = FLICKS_PER_MS;
const enc = (s: string) => new TextEncoder().encode(s);
const parse = (input: Uint8Array | string, f: CaptionFileFormat): CaptionDocument => {
	const r = parseCaptionFile(input, f);
	if (!r.ok) throw new Error(r.error);
	return r.doc;
};
/** Cues compared without undefined/null optional fields. */
const norm = (cues: Cue[]) =>
	cues.map((c) => ({
		start: c.start,
		end: c.end,
		text: c.text,
		...(c.speaker ? { speaker: c.speaker } : {}),
		...(c.id ? { id: c.id } : {}),
		...(c.settings ? { settings: c.settings } : {}),
	}));
const doc = (cues: Cue[], blocks: string[] = []): CaptionDocument => ({ cues, blocks, warnings: [] });
const asText = (x: string | Uint8Array) => (typeof x === 'string' ? x : new TextDecoder().decode(x));

describe('core', () => {
	it('parses and formats clock times', () => {
		expect(parseClock('00:00:01,500')).toBe((FLICKS_PER_SECOND * 3) / 2);
		expect(parseClock('01:02.25')).toBe(FLICKS_PER_SECOND * 62 + FLICKS_PER_SECOND / 4);
		expect(parseClock('100:00:00.000')).toBe(FLICKS_PER_SECOND * 360_000);
		expect(parseClock('00:61:00,000')).toBeNull();
		expect(parseClock('aa:00:00,000')).toBeNull();
		expect(formatClock(FLICKS_PER_SECOND * 3723 + MS * 45, ',')).toBe('01:02:03,045');
	});
	it('decodes BOM, UTF-16 and Windows-1252, normalising line endings', () => {
		expect(decodeCaptionText(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('a\r\nb\rc')]))).toBe('a\nb\nc');
		expect(decodeCaptionText(Uint8Array.from([0xff, 0xfe, 0x68, 0, 0x69, 0]))).toBe('hi');
		expect(decodeCaptionText(Uint8Array.from([0xfe, 0xff, 0, 0x68, 0, 0x69]))).toBe('hi');
		expect(decodeCaptionText(Uint8Array.from([...enc('caf'), 0xe9, 0x20, 0x93, 0x78, 0x94]))).toBe(
			'café “x”',
		);
	});
	it('detects formats by content and extension', () => {
		expect(detectCaptionFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n', 'vtt')).toBe('vtt');
		expect(detectCaptionFormat('1\n00:00:01,000 --> 00:00:02,000\nhi\n', 'srt')).toBe('srt');
		expect(detectCaptionFormat('Scenarist_SCC V1.0\n\n00:00:00;00\t9420\n', 'scc')).toBe('scc');
		expect(detectCaptionFormat('hello', 'srt')).toBeNull();
		expect(detectCaptionFormat('<xml/>', null)).toBeNull();
		expect(detectCaptionFormat('File Format=MacCaption_MCC V1.0\n', 'mcc')).toBe('mcc');
		const ttml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>';
		expect(detectCaptionFormat(ttml, 'ttml')).toBe('ttml');
		expect(detectCaptionFormat(ttml, 'dfxp')).toBe('dfxp');
		expect(detectCaptionFormat('<tt xmlns="http://www.w3.org/2006/10/ttaf1"></tt>', 'xml')).toBe('dfxp');
		expect(detectCaptionFormat(writeStl(emptyCaptionDocument(), null), 'stl')).toBe('stl');
		for (const f of CAPTION_FILE_FORMATS) expect(captionFormatFromName(f)).toBe(f);
	});
	it('normalize cuts overlaps', () => {
		const c = (s: number, e: number): Cue => ({ start: s, end: e, text: 'x' });
		const d = normalizeCaptionDocument(doc([c(10, 20), c(0, 15), c(10, 12)]));
		expect(d.cues.map((x) => [x.start, x.end])).toEqual([
			[0, 10],
			[10, 12],
			[12, 20],
		]);
	});
	it('plain text strips markup', () => {
		expect(plainCaptionText('<i>Hello</i> &amp; <b>bye</b>')).toBe('Hello & bye');
		expect(plainCaptionText('{\\an8}Top')).toBe('Top');
		expect(plainCaptionText('a < b')).toBe('a < b');
		expect(plainCaptionText('<v Bob>Hi</v>')).toBe('Hi');
	});
});

describe('SRT', () => {
	it('reads and writes the basic form', () => {
		const d = parse(
			'1\n00:00:01,000 --> 00:00:02,500\nHello\n<i>World</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
			'srt',
		);
		expect(d.cues).toHaveLength(2);
		expect(d.cues[0]!.start).toBe(1000 * MS);
		expect(d.cues[0]!.end).toBe(2500 * MS);
		expect(d.cues[0]!.text).toBe('Hello\n<i>World</i>');
		expect(writeCaptionFile(d, 'srt')).toBe(
			'1\n00:00:01,000 --> 00:00:02,500\nHello\n<i>World</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n\n',
		);
	});
	it('accepts sloppy files', () => {
		// no indexes, period ms, short fractions, no hours, coordinates, no blank line between cues
		const src =
			'00:00:01.5 --> 00:00:02.25 X1:10 X2:20 Y1:1 Y2:2\nA\n7\n00:03,000 --> 00:04,000\nB\n00:00:05,000-->00:00:06,000\n42\n\n\n';
		const d = parse(src, 'srt');
		expect(d.cues.map((c) => [c.start / MS, c.end / MS, c.text])).toEqual([
			[1500, 2250, 'A'],
			[3000, 4000, 'B'],
			[5000, 6000, '42'],
		]);
	});
	it('rejects garbage and skips inverted cues', () => {
		expect(parseCaptionFile('hello world\nthis is not srt', 'srt').ok).toBe(false);
		expect(parse('', 'srt').cues).toEqual([]);
		const d = parse('1\n00:00:05,000 --> 00:00:04,000\nX\n\n2\n00:00:06,000 --> 00:00:07,000\nY\n', 'srt');
		expect(d.cues).toHaveLength(1);
		expect(d.warnings).toHaveLength(1);
	});
});

describe('WebVTT', () => {
	const SAMPLE =
		'WEBVTT - with header\nKind: captions\n\nSTYLE\n::cue { color: yellow }\n\nNOTE a comment\nspanning lines\n\nintro\n00:01.000 --> 00:00:03.500 line:90% align:start\n<v.loud Ann Smith>Hello there\nsecond line\n\n00:00:04.000 --> 00:00:05.000\n<i>plain</i> &amp; tags\n';
	it('keeps ids, settings, voices and blocks', () => {
		const d = parse(SAMPLE, 'vtt');
		expect(d.blocks).toEqual(['STYLE\n::cue { color: yellow }', 'NOTE a comment\nspanning lines']);
		expect(d.cues).toHaveLength(2);
		const c = d.cues[0]!;
		expect(c.id).toBe('intro');
		expect([c.start, c.end]).toEqual([1000 * MS, 3500 * MS]);
		expect(c.settings).toBe('line:90% align:start');
		expect(c.speaker).toBe('Ann Smith');
		expect(c.text).toBe('Hello there\nsecond line');
		expect(d.cues[1]!.text).toBe('<i>plain</i> &amp; tags');
		const w = writeCaptionFile(d, 'vtt') as string;
		expect(
			w.startsWith(
				'WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\nNOTE a comment\nspanning lines\n\nintro\n00:00:01.000 --> 00:00:03.500 line:90% align:start\n<v Ann Smith>Hello there\n',
			),
		).toBe(true);
		expect(norm(parse(w, 'vtt').cues)).toEqual(norm(d.cues));
	});
	it('splits voices', () => {
		expect(splitVoice('<v Bob>hi</v>')).toEqual({ speaker: 'Bob', text: 'hi' });
		expect(splitVoice('<v Bob>hi</v> <v Ann>yo</v>')).toEqual({
			speaker: null,
			text: '<v Bob>hi</v> <v Ann>yo</v>',
		});
		expect(splitVoice('<vx>hi')).toEqual({ speaker: null, text: '<vx>hi' });
	});
	it('tolerates a missing signature', () => {
		expect(parse('00:00:01.000 --> 00:00:02.000\nx\n', 'vtt').cues).toHaveLength(1);
		expect(parseCaptionFile('just text', 'vtt').ok).toBe(false);
	});
});

describe('CEA-608 and SCC', () => {
	it('parity', () => {
		expect(withParity(0x14)).toBe(0x94);
		expect(withParity(0x2c)).toBe(0x2c);
		expect(withParity(0x20)).toBe(0x20);
		expect(withParity(0x2f)).toBe(0x2f);
		expect(withParity(0x2e)).toBe(0xae);
		for (let b = 0; b < 128; b++) {
			let ones = 0;
			for (let x = withParity(b); x; x >>= 1) ones += x & 1;
			expect(ones % 2).toBe(1);
		}
	});
	it('PAC round trip', () => {
		for (let row = 1; row <= 15; row++)
			for (let indent = 0; indent < 32; indent += 4) {
				const [b1, b2] = encodePac(row, indent);
				expect(decodePac(b1, b2)).toEqual({ row, indent });
			}
	});
	it('characters', () => {
		expect(encodeChar('A')).toEqual({ kind: 'basic', b: 0x41 });
		expect(encodeChar('é')).toEqual({ kind: 'basic', b: 0x5c });
		expect(encodeChar('♪')).toEqual({ kind: 'pair', b1: 0x11, b2: 0x37, fallback: null });
		expect(encodeChar('{')).toMatchObject({ kind: 'pair', b1: 0x13, b2: 0x29 });
		expect(encodeChar('*')).toMatchObject({ kind: 'pair', b1: 0x12, b2: 0x28 });
		expect(encodeChar('漢')).toBeNull();
	});
	it('timecodes', () => {
		expect(parseSccTimecode('00:01:00;02')).toBe(1800);
		expect(parseSccTimecode('00:01:00:00')).toBe(1800);
		expect(formatSccTimecode(1800, true)).toBe('00:01:00;02');
		expect(formatSccTimecode(1800, false)).toBe('00:01:00:00');
		expect(parseSccTimecode('00:10:00;00')).toBe(17982);
	});
	it('decodes a known pop-on stream', () => {
		// "HELLO" on row 15 at 00:00:01;00, cleared at 00:00:03;00
		const scc =
			'Scenarist_SCC V1.0\n\n00:00:00;20\t9420 9420 94ae 94ae 94d0 94d0 c845 4c4c 4f80 942f 942f\n\n00:00:03;00\t942c 942c\n';
		const d = parse(scc, 'scc');
		expect(d.cues).toHaveLength(1);
		expect(d.cues[0]!.text).toBe('HELLO');
		expect(frameAt(d.cues[0]!.start, SCC_RATE)).toBe(29);
		expect(frameAt(d.cues[0]!.end, SCC_RATE)).toBe(90);
	});
	it('decodes roll-up', () => {
		const scc =
			'Scenarist_SCC V1.0\n\n00:00:00:00\t9425 9425 94ad 94ad c1c2 94ad 94ad 4344\n\n00:00:02:00\t942c 942c\n';
		expect(parse(scc, 'scc').cues.map((c) => c.text)).toEqual(['AB', 'AB\nCD']);
	});
	it('decodes paint-on', () => {
		// RDC, PAC row 15, "HI" (shown as typed), EDM 1 s later
		const scc = 'Scenarist_SCC V1.0\n\n00:00:01:00\t9429 9429 94d0 94d0 c849\n\n00:00:02:00\t942c 942c\n';
		const d = parse(scc, 'scc');
		expect(d.cues.map((c) => [frameAt(c.start, SCC_RATE), frameAt(c.end, SCC_RATE), c.text])).toEqual([
			[34, 60, 'HI'],
		]);
	});
	it('writes then reads pop-on captions frame-exactly', () => {
		const cue = (s: number, e: number, text: string): Cue => ({
			start: tickOf(s, SCC_RATE),
			end: tickOf(e, SCC_RATE),
			text,
		});
		const d = doc([
			cue(60, 120, 'Hello, world!'),
			cue(120, 200, 'Second caption\nwith two lines'),
			cue(260, 300, 'Ñandú ♪ {x} * café “q”'),
		]);
		const s = writeCaptionFile(d, 'scc') as string;
		expect(s.startsWith('Scenarist_SCC V1.0\n\n')).toBe(true);
		const back = parse(s, 'scc');
		expect(back.cues.map((c) => [frameAt(c.start, SCC_RATE), frameAt(c.end, SCC_RATE), c.text])).toEqual([
			[60, 120, 'Hello, world!'],
			[120, 200, 'Second caption\nwith two lines'],
			[260, 300, 'Ñandú ♪ {x} * café “q”'],
		]);
	});
	it('wraps long lines at 32 columns', () => {
		const rows = wrapSccRows('the quick brown fox jumps over the lazy dog and keeps running far away');
		expect(rows.every((r) => r.length <= 32)).toBe(true);
		expect(rows.join(' ')).toBe('the quick brown fox jumps over the lazy dog and keeps running far away');
	});
	it('a cue at zero is delayed, not lost', () => {
		const d = doc([{ start: 0, end: tickOf(60, SCC_RATE), text: 'Start' }]);
		const back = parse(writeCaptionFile(d, 'scc', { dropFrame: false }), 'scc');
		expect(back.cues).toHaveLength(1);
		expect(back.cues[0]!.text).toBe('Start');
		expect(frameAt(back.cues[0]!.end, SCC_RATE)).toBe(60);
	});
});

describe('MCC', () => {
	it('abbreviations round trip', () => {
		const b = [
			0x61, 0x01, 0x49, 0x96, 0x69, 0xfa, 0, 0, 0xfa, 0, 0, 0xfc, 0x80, 0x80, 0x00, 0x12, 0xe1, 0, 0, 0, 0xfb,
			0x80, 0x80, 0xfd, 0x80, 0x80,
		];
		const s = mccCompress(b);
		expect(s).toBe('T49SHQZ12UPR');
		expect(mccExpand(s)).toEqual(b);
		expect(mccExpand('T52S5')).toBeNull();
	});
	it('CDP structure and checksum', () => {
		const b = buildCdp(7, {
			f1: [0x14, 0x20],
			dtvcc: [
				[true, 0x02, 0x21],
				[false, 0x89, 0x01],
			],
		});
		expect(b.slice(0, 3)).toEqual([0x61, 0x01, 73]);
		const cdp = b.slice(3);
		expect(cdp).toHaveLength(73);
		expect(cdp.slice(0, 9)).toEqual([0x96, 0x69, 73, 0x4f, 0x43, 0, 7, 0x72, 0xf4]);
		expect(cdp.reduce((a, x) => a + x, 0) % 256).toBe(0);
		const t = ccTriplets(b)!;
		expect(t).toHaveLength(20);
		expect(t[0]).toEqual([0xfc, 0x94, 0x20]);
		expect(t[2]).toEqual([0xff, 0x02, 0x21]);
		expect(t[19]).toEqual([0xfa, 0, 0]);
	});
	it('writes and reads CEA-608 and CEA-708', () => {
		const cue = (s: number, e: number, text: string): Cue => ({
			start: tickOf(s, SCC_RATE),
			end: tickOf(e, SCC_RATE),
			text,
		});
		const d = doc([
			cue(60, 120, 'Hello, world!'),
			cue(120, 200, 'Second caption\nwith two lines'),
			cue(260, 300, 'Café “q” ♪'),
		]);
		const want = [
			[60, 120, 'Hello, world!'],
			[120, 200, 'Second caption\nwith two lines'],
			[260, 300, 'Café “q” ♪'],
		];
		const s = writeCaptionFile(d, 'mcc') as string;
		expect(s.startsWith('File Format=MacCaption_MCC V1.0\n')).toBe(true);
		expect(s).toContain('Time Code Rate=30DF');
		const frames = (x: CaptionDocument) =>
			x.cues.map((c) => [frameAt(c.start, SCC_RATE), frameAt(c.end, SCC_RATE), c.text]);
		expect(frames(parse(s, 'mcc'))).toEqual(want);
		expect(frames(parse(writeMcc(d, false, { cea608: false }), 'mcc'))).toEqual(want);
		expect(parseCaptionFile('garbage', 'mcc').ok).toBe(false);
	});
});

describe('EBU STL', () => {
	it('ISO 6937 round trip', () => {
		for (const c of 'Ñandú café Škoda Łódź Ærø ß £ ½ ♪ « » ‘q’ “q”') {
			const b = encode6937(c);
			expect(b, c).not.toBeNull();
			const stl = writeStl(doc([{ start: 0, end: tickOf(25, RATE_25), text: c === ' ' ? '_' : c }]), RATE_25);
			if (c !== ' ') expect(parse(stl, 'stl').cues[0]!.text).toBe(c);
		}
		expect(encode6937('€')).toBeNull();
	});
	it('writes GSI and extension blocks', () => {
		const long = 'x'.repeat(150);
		const d = doc([
			{ start: tickOf(25, RATE_25), end: tickOf(75, RATE_25), text: '<i>Hello</i>\nWörld' },
			{ start: tickOf(100, RATE_25), end: tickOf(150, RATE_25), text: long },
		]);
		const b = writeStl(d, RATE_25);
		const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
		expect(ascii(3, 11)).toBe('STL25.01');
		expect(b.length).toBe(1024 + 3 * 128);
		expect(ascii(238, 243)).toBe('00003');
		expect(ascii(243, 248)).toBe('00002');
		const tti0 = b.subarray(1024, 1152);
		expect([...tti0.subarray(5, 9)]).toEqual([0, 0, 1, 0]);
		expect([...tti0.subarray(9, 13)]).toEqual([0, 0, 3, 0]);
		expect(tti0[3]).toBe(0xff);
		expect([...tti0.subarray(16, 24)]).toEqual([0x80, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x81, 0x8a]);
		expect(b[1024 + 128 + 3]).toBe(0);
		expect(b[1024 + 256 + 3]).toBe(0xff);
		const back = parse(b, 'stl');
		expect(back.cues).toHaveLength(2);
		expect(back.cues[0]!.text).toBe('<i>Hello</i>\nWörld');
		expect(back.cues[1]!.text).toBe(long);
		expect(back.cues[1]!.start).toBe(tickOf(100, RATE_25));
		expect(parseCaptionFile(b.subarray(0, 500), 'stl').ok).toBe(false);
	});
	it('subtracts the start of programme', () => {
		const b = writeStl(doc([{ start: tickOf(250, RATE_25), end: tickOf(300, RATE_25), text: 'A' }]), null);
		b.set(new TextEncoder().encode('10000000'), 256);
		b[1024 + 5] = 10;
		b[1024 + 9] = 10;
		expect(parse(b, 'stl').cues[0]!.start).toBe(tickOf(250, RATE_25));
	});
});

describe('TTML', () => {
	const xmlWith = (params: string, begin: string, end: string) =>
		`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ${params}><body><div><p begin="${begin}" end="${end}">Hello</p></div></body></tt>`;
	it('rejects invalid timing parameters', () => {
		for (const params of [
			'ttp:frameRate="0"',
			'ttp:frameRate="-25"',
			'ttp:frameRate=""',
			'ttp:subFrameRate="0"',
			'ttp:tickRate="-1"',
			'ttp:frameRateMultiplier="1 0"',
			'ttp:frameRateMultiplier="1"',
			'ttp:frameRateMultiplier="1 2 3"',
		])
			expect(parseCaptionFile(xmlWith(params, '1s', '2s'), 'ttml').ok, params).toBe(false);
	});
	it('keeps defaults for missing timing parameters', () => {
		for (const [params, begin, end] of [
			['', '1s', '2s'],
			['ttp:frameRate="25"', '25f', '50f'],
			['ttp:frameRate="30" ttp:subFrameRate="2"', '60t', '120t'],
			['ttp:frameRate="30" ttp:subFrameRate="2" ttp:tickRate="10"', '10t', '20t'],
			['ttp:frameRate="25" ttp:frameRateMultiplier="2 1"', '50f', '100f'],
		] as const) {
			const d = parse(xmlWith(params, begin, end), 'ttml');
			expect(d.cues, params).toHaveLength(1);
			expect([d.cues[0]!.start, d.cues[0]!.end]).toEqual([FLICKS_PER_SECOND, 2 * FLICKS_PER_SECOND]);
		}
	});
	it('time expressions', () => {
		const t = { rate: RATE_25, subFrameRate: 1, tickRate: 1 };
		const s = (v: number) => Math.round(v * FLICKS_PER_SECOND);
		expect(parseTtmlTime('00:00:01.500', t)).toBe(s(1.5));
		expect(parseTtmlTime('01:00:00', t)).toBe(s(3600));
		expect(parseTtmlTime('00:00:02:12', t)).toBe(s(2.48));
		expect(parseTtmlTime('2.5s', t)).toBe(s(2.5));
		expect(parseTtmlTime('1500ms', t)).toBe(s(1.5));
		expect(parseTtmlTime('0.5m', t)).toBe(s(30));
		expect(parseTtmlTime('50f', t)).toBe(s(2));
		expect(parseTtmlTime('30f', { ...t, rate: RATE_29_97 })).toBe(tickOf(30, RATE_29_97));
		expect(parseTtmlTime('15000000t', { ...t, tickRate: 10_000_000 })).toBe(s(1.5));
		expect(parseTtmlTime('bogus', t)).toBeNull();
		expect(parseTtmlTime('1:2', t)).toBeNull();
	});
	it('reads styles, spans and nesting', () => {
		const x = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/2006/10/ttaf1" xmlns:tts="http://www.w3.org/2006/10/ttaf1#styling" xmlns:ttp="http://www.w3.org/2006/10/ttaf1#parameter" ttp:frameRate="25">
 <head><styling><style xml:id="it" tts:fontStyle="italic"/></styling></head>
 <body>
  <div begin="10s">
   <p begin="00:00:01.000" end="00:00:02.000">Hello
      <span style="it">big</span>   world<br/>
      second   line</p>
   <p begin="3s" dur="1s"><span tts:fontWeight="bold">Bold</span> &amp; plain</p>
  </div>
  <div><p><span begin="20s" end="21s">span timed</span></p></div>
 </body>
</tt>`;
		const d = parse(x, 'ttml');
		expect(d.cues.map((c) => [c.start / FLICKS_PER_SECOND, c.end / FLICKS_PER_SECOND, c.text])).toEqual([
			[11, 12, 'Hello <i>big</i> world\nsecond line'],
			[13, 14, '<b>Bold</b> & plain'],
			[20, 21, 'span timed'],
		]);
		expect(parseCaptionFile('<html/>', 'ttml').ok).toBe(false);
		expect(parseCaptionFile('not xml', 'ttml').ok).toBe(false);
	});
	it('writes IMSC1 with frames and spans', () => {
		const r = RATE_29_97;
		const d = doc([
			{
				start: tickOf(30, r),
				end: tickOf(75, r),
				text: 'A <i>tilted</i> line\nand <b>more</b> & "quotes"',
				speaker: 'Ann Lee',
			},
		]);
		const x = writeTtml(d, 'imsc1', r, 'en');
		expect(x).toContain('http://www.w3.org/ns/ttml/profile/imsc1/text');
		expect(x).toContain('ttp:frameRate="30"');
		expect(x).toContain('ttp:frameRateMultiplier="1000 1001"');
		expect(x).toContain('begin="30f" end="75f"');
		expect(x).toContain('<span tts:fontStyle="italic">tilted</span>');
		const back = parse(x, 'ttml');
		expect(back.cues).toHaveLength(1);
		expect([back.cues[0]!.start, back.cues[0]!.end]).toEqual([tickOf(30, r), tickOf(75, r)]);
		expect(back.cues[0]!.text).toBe(d.cues[0]!.text);
		expect(back.cues[0]!.speaker).toBe('Ann Lee');
		const dfxp = writeTtml(d, 'dfxp', r, 'en');
		expect(dfxp).toContain('http://www.w3.org/ns/ttml/profile/dfxp-presentation');
		expect(dfxp).toContain('begin="00:00:01.001"');
	});
});

const word = fc.stringMatching(/^[A-Za-z0-9éñü,.!?'"()&%-]{1,10}$/);
const line = fc.array(word, { minLength: 1, maxLength: 5 }).map((w) => w.join(' '));
const text = fc.array(line, { minLength: 1, maxLength: 3 }).map((l) => l.join('\n'));
const msCues = (max: number) =>
	fc
		.array(fc.tuple(fc.integer({ min: 0, max: 4999 }), fc.integer({ min: 1, max: 7999 }), text), {
			maxLength: max,
		})
		.map((v) => {
			let t = 0;
			return v.map(([gap, dur, tx]): Cue => {
				const start = t + gap;
				t = start + dur;
				return { start: start * MS, end: t * MS, text: tx };
			});
		});
const frameCues = (
	rate: { num: number; den: number },
	gapMin: number,
	gapMax: number,
	durMin: number,
	durMax: number,
	words: fc.Arbitrary<string>,
	max: number,
) =>
	fc
		.array(
			fc.tuple(fc.integer({ min: gapMin, max: gapMax }), fc.integer({ min: durMin, max: durMax }), words),
			{ minLength: 1, maxLength: max },
		)
		.map((v) => {
			let f = 0;
			return v.map(([gap, dur, tx]): Cue => {
				const start = f + gap;
				f = start + dur;
				return { start: tickOf(start, rate), end: tickOf(f, rate), text: tx };
			});
		});
const sccWords = fc
	.array(fc.stringMatching(/^[A-Za-z0-9,.!?'()é-]{1,8}$/), { minLength: 1, maxLength: 3 })
	.map((w) => w.join(' '));
const RUNS = { numRuns: 64 };

describe('round trips (property)', () => {
	it('SRT', () => {
		fc.assert(
			fc.property(msCues(12), (cues) => {
				const bytes = writeCaptionFileBytes(doc(cues), 'srt');
				const back = parse(bytes, 'srt');
				expect(norm(back.cues)).toEqual(norm(cues));
				expect(writeCaptionFile(back, 'srt')).toBe(asText(bytes));
			}),
			RUNS,
		);
	});
	it('WebVTT with ids, speakers, settings and STYLE blocks', () => {
		const id = fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { nil: null });
		const speaker = fc.option(fc.stringMatching(/^[A-Z][a-z]{1,6}( [A-Z][a-z]{1,6})?$/), { nil: null });
		const settings = fc.constantFrom('', 'line:90%', 'align:start position:10%');
		fc.assert(
			fc.property(
				msCues(12),
				fc.array(fc.tuple(id, speaker, settings), { minLength: 12, maxLength: 12 }),
				(cues, extra) => {
					const withExtra = cues.map((c, i) => ({
						...c,
						id: extra[i]![0],
						speaker: extra[i]![1],
						settings: extra[i]![2],
					}));
					const d = doc(withExtra, ['STYLE\n::cue { color: #ff0 }']);
					const bytes = writeCaptionFileBytes(d, 'vtt');
					const back = parse(bytes, 'vtt');
					expect(norm(back.cues)).toEqual(norm(withExtra));
					expect(back.blocks).toEqual(d.blocks);
					expect(writeCaptionFile(back, 'vtt')).toBe(asText(bytes));
				},
			),
			RUNS,
		);
	});
	it('SCC frame-exact (drop and non-drop)', () => {
		fc.assert(
			fc.property(frameCues(SCC_RATE, 60, 399, 3, 299, sccWords, 7), fc.boolean(), (cues, dropFrame) => {
				const bytes = writeCaptionFile(doc(cues), 'scc', { dropFrame }) as string;
				const back = parse(bytes, 'scc');
				expect(norm(back.cues)).toEqual(norm(cues));
				expect(writeCaptionFile(back, 'scc', { dropFrame })).toBe(bytes);
			}),
			RUNS,
		);
	});
	it('SCC back-to-back captions', () => {
		const t = fc.stringMatching(/^[A-Z][a-z]{1,8}( [a-z]{1,8}){0,2}$/);
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 45, max: 199 }), t), { minLength: 1, maxLength: 5 }),
				(v) => {
					let f = 90;
					const cues = v.map(([dur, tx]): Cue => {
						const start = f;
						f += dur;
						return { start: tickOf(start, SCC_RATE), end: tickOf(f, SCC_RATE), text: tx };
					});
					expect(norm(parse(writeCaptionFile(doc(cues), 'scc'), 'scc').cues)).toEqual(norm(cues));
				},
			),
			RUNS,
		);
	});
	it('MCC frame-exact (CEA-608 path)', () => {
		fc.assert(
			fc.property(frameCues(SCC_RATE, 60, 399, 3, 299, sccWords, 5), fc.boolean(), (cues, dropFrame) => {
				const bytes = writeCaptionFile(doc(cues), 'mcc', { dropFrame }) as string;
				const back = parse(bytes, 'mcc');
				expect(norm(back.cues)).toEqual(norm(cues));
				expect(writeCaptionFile(back, 'mcc', { dropFrame })).toBe(bytes);
			}),
			RUNS,
		);
	});
	it('MCC CEA-708 path alone', () => {
		fc.assert(
			fc.property(frameCues(SCC_RATE, 60, 399, 3, 299, sccWords, 5), (cues) => {
				expect(norm(parse(writeMcc(doc(cues), true, { cea608: false }), 'mcc').cues)).toEqual(norm(cues));
			}),
			RUNS,
		);
	});
	it('EBU STL at 25 and 29.97 fps', () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.array(fc.tuple(fc.integer({ min: 0, max: 199 }), fc.integer({ min: 1, max: 299 }), text), {
					maxLength: 9,
				}),
				(ntsc, v) => {
					const rate = ntsc ? RATE_29_97 : RATE_25;
					let f = 0;
					const cues = v.map(([gap, dur, tx]): Cue => {
						const start = f + gap;
						f = start + dur;
						return { start: tickOf(start, rate), end: tickOf(f, rate), text: tx };
					});
					const bytes = writeCaptionFile(doc(cues), 'stl', { rate }) as Uint8Array;
					const back = parse(bytes, 'stl');
					expect(norm(back.cues)).toEqual(norm(cues));
					expect([...(writeCaptionFile(back, 'stl', { rate }) as Uint8Array)]).toEqual([...bytes]);
				},
			),
			RUNS,
		);
	});
	it('TTML (IMSC1) frame-exact with ids and speakers', () => {
		const speaker = fc.option(fc.stringMatching(/^[A-Z][a-z]{1,6}( [A-Z][a-z]{1,6})?$/), { nil: null });
		fc.assert(
			fc.property(
				fc.constantFrom(RATE_23_976, RATE_25, RATE_29_97, RATE_59_94),
				fc.array(
					fc.tuple(fc.integer({ min: 0, max: 199 }), fc.integer({ min: 1, max: 299 }), text, speaker),
					{ maxLength: 9 },
				),
				(rate, v) => {
					let f = 0;
					const cues = v.map(([gap, dur, tx, sp], i): Cue => {
						const start = f + gap;
						f = start + dur;
						return {
							start: tickOf(start, rate),
							end: tickOf(f, rate),
							text: tx,
							speaker: sp,
							id: `c${i + 1}`,
						};
					});
					const bytes = writeCaptionFile(doc(cues), 'ttml', { rate }) as string;
					const back = parse(bytes, 'ttml');
					expect(norm(back.cues)).toEqual(norm(cues));
					expect(writeCaptionFile(back, 'ttml', { rate })).toBe(bytes);
				},
			),
			RUNS,
		);
	});
	it('DFXP frame-exact after snapping', () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.array(fc.tuple(fc.integer({ min: 0, max: 199 }), fc.integer({ min: 1, max: 299 }), text), {
					maxLength: 9,
				}),
				(ntsc, v) => {
					const rate = ntsc ? RATE_29_97 : RATE_25;
					let f = 0;
					const cues = v.map(([gap, dur, tx], i): Cue => {
						const start = f + gap;
						f = start + dur;
						return { start: tickOf(start, rate), end: tickOf(f, rate), text: tx, id: `c${i + 1}` };
					});
					const back = parse(writeCaptionFile(doc(cues), 'dfxp', { rate }), 'dfxp');
					snapCaptionDocument(back, rate);
					expect(norm(back.cues)).toEqual(norm(cues));
				},
			),
			RUNS,
		);
	});
});

describe('cross-format', () => {
	it('SRT → VTT → SCC keeps text and frames', () => {
		const srt = enc(
			'1\r\n00:00:02,002 --> 00:00:04,004\r\nHello there\r\n\r\n2\r\n00:00:05,005 --> 00:00:07,007\r\n<i>General</i> Kenobi\r\n',
		);
		const d = parse(srt, 'srt');
		snapCaptionDocument(d, SCC_RATE);
		const d2 = parse(writeCaptionFile(d, 'vtt'), 'vtt');
		const d3 = parse(writeCaptionFile(d2, 'scc'), 'scc');
		expect(d3.cues.map((c) => c.text)).toEqual(['Hello there', 'General Kenobi']);
		expect(sccFrameOf(d3.cues[0]!.start)).toBe(60);
		expect(sccFrameOf(d3.cues[1]!.end)).toBe(210);
	});
});
