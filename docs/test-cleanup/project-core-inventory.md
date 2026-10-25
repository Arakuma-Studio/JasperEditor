# Current project-core disposition inventory

This maps every named declaration and parser-fuzz target in the current project-core ownership partition at `8b4c8936` to a disposition. It includes 838 named declarations in 78 files plus 35 generated parser-fuzz target families. Dynamic parameter inputs are families, not invented runtime case counts. The two deleted files and eight deleted declarations remain in the map. Other project partitions own audio*/sound*, fx/effect/transition and animation/vector/3D clusters.

[Project-core follow-up](project-core.md) contains the fresh detailed decisions and overrides. Existing [project1](project1.md), [project2](project2.md), [project3](project3.md), and [project4](project4.md) contain the original full six-bar records. Historical evidence is explicitly labelled; source inventory and assertion seams were checked against it, without claiming that the old prose is a newly written audit. Renamed/newer cases without an exact historical name use the file-specific sources and independent assertion shown here.

For each retained row: (1) the named file source independently specifies the contract; (2) violating its named result is the recognizable caller-visible failure; (3) the quoted fixed-data/property oracle can disagree with production; (4) it observes the public/format/command/render/invariant seam identified by its source; (5) output-based assertions tolerate behavior-preserving helper and algorithm changes; (6) the row owns its named input/transition/format edge, while other rows own different inputs or boundaries. Fresh detailed rows make additional ownership/deletion reasoning explicit. A source/contract inventory is separate from execution: validation and measurements appear in project-core.md and the root report.

Disposition families: DELETE 8, REWRITE 13, OPTIMIZE 1, CONSOLIDATE 5, KEEP 846.

## packages/project/test/agent-mcp-cli.test.ts

S01 §21 agent queries/strict command protocol. Caller-visible keys, values, error codes, property evaluation and frame clamping are the stable boundary.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 13: flags top-level and nested unknown keys with the accepted keys | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(issues[0]).toMatchObject({ commandIndex: 0, code: 'E_SCHEMA' })` |
| 28: passes valid commands | KEEP | [Historical six-bar row](project1.md); `expect( unknownCommandKeyIssues([ { type: 'marker.add', frame: 3, name: 'A' }, { type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'a' }, ref: '$t' }, ]), ).toEqual([])` |
| 37: walks unions, arrays and records; open records accept any key | KEEP | [Historical six-bar row](project1.md); `expect( findUnknownKeys(s, { r: { from: 1, to: 2, by: 1 }, list: [{ a: 1, b: 2 }], bag: { x: 1 } }), ).toEqual([ { path: 'r', keys: ['by'], accepted: ['from', 'to'] }, { path: 'list[0]', keys: ['b'], ac…` |
| 52: an unknown temp ref names the refs declared so far | KEEP | [Historical six-bar row](project1.md); `expect(r.errors[0]!.message).toContain('$b')` |
| 89: lists every property with value, evaluated, keyframes in sequence frames and the param.set target | KEEP | [Historical six-bar row](project1.md); `expect(op.value).toBeCloseTo(50, 0)` |
| 121: reports bypassed effects and frames outside a clip | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(r.property).toMatchObject({ value: 6, rendered: false })` |
| 140: accepts seconds and rejects unknown ids and property paths | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(() => runAgentQuery(env, 'clip.properties', { clipId: 'clp_nope' })).toThrow( expect.objectContaining({ code: 'E_NOT_FOUND', message: expect.stringContaining('clp_nope') }), )` |

## packages/project/test/agent.test.ts

S01 §21 agent queries/strict command protocol. Caller-visible keys, values, error codes, property evaluation and frame clamping are the stable boundary.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 24: sequence.summary reports tracks, markers and timecodes | KEEP | [Historical six-bar row](project4.md); `expect(r.markers[0]).toMatchObject({ name: 'Intro', timecode: '00:00:00:15' })` |
| 40: sequence.clipsInRange filters by range and track labels, with source seconds | KEEP | [Historical six-bar row](project4.md); `expect(r.clips.map((c) => c.track).sort()).toEqual(['A1', 'V1'])` |
| 54: sequence.at evaluates the stack at a frame (bottom → top) | KEEP | [Historical six-bar row](project4.md); `expect(r.video.map((v) => v.track)).toEqual(['V1', 'V2'])` |
| 67: doc.get supports paths and field projection; session-only queries need a session | KEEP | [Historical six-bar row](project4.md); `expect(runAgentQuery(env, 'doc.get', { path: ['sequences', h.seqId], fields: ['id'] })).toEqual({ id: h.seqId, })` |
| 85: resolves mediaByName, clipAt and markerByName | KEEP | [Historical six-bar row](project4.md); `expect((r.commands[0] as { source: unknown }).source).toEqual({ mediaId })` |
| 101: fails with E_AMBIGUOUS / E_NOT_FOUND and the command index | KEEP | [Historical six-bar row](project4.md); `expect(r.errors[0]).toMatchObject({ commandIndex: 1, code: 'E_AMBIGUOUS' })` |
| 120: flags destructive commands and force | KEEP | [Historical six-bar row](project4.md); `expect(approvalReasons({ commands: [{ type: 'marker.add' }] })).toEqual([])` |
| 129: enforces limits and normalizes origins | KEEP | [Historical six-bar row](project4.md); `expect(n.origin).toEqual({ agent: 'curl' })` |

## packages/project/test/ambience-bed.test.ts

S03 Essential Sound; S12 §2.1 / §4 / P6-R3 / P6-E12; sound-design Phase 0 and Phase 6→WP6.3 notes; public audio commands, validated saved settings, bed layout and dialogue extraction.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 54: a cut to other footage starts a scene; a cut inside one media does not; markers and shot changes do | KEEP | [Fresh six-bar decision](project-core.md); `expect(sc.map((s) => [s.start, s.end, s.reason])).toEqual([ [0, 200, 'start'], [200, 400, 'edit'], [400, 600, 'edit'], ])` |
| 105: never throws on hostile documents | KEEP | [Fresh six-bar decision](project-core.md); `expect(bedScenes(h.doc, h.seq)).toEqual([])` |
| 122: 3 scenes over 20 s of a 4 s loop: pieces of the loop, 1.5 s crossfades at the loop joints, 0.5 s at scene changes | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.layout.shortened).toEqual([])` |
| 148: property: every piece and every handle stays in its loop; every loop joint is the matched one; crossfades fit | KEEP | [Fresh six-bar decision](project-core.md); `expect(Math.floor((loopLen * S) / F30 + 1e-9)).toBeLessThan(4)` |
| 216: refuses overlapping shots, too-short shots and loops | KEEP | [Fresh six-bar decision](project-core.md); `expect(planBedLayout([shotIn(0, 100, [0, 4]), shotIn(50, 150, [0, 4])], o)).toMatchObject({ ok: false })` |
| 231: lays the 3-scene bed: Ambience track, crossfades, fades, Essential ambience, grouped; undo / redo | REWRITE | [Fresh six-bar decision](project-core.md); `expect(r.warnings.filter((w) => w.code === 'W_TRANSITION_SHORTENED')).toEqual([])` |
| 288: range, replace, a second bed on another track, a per-shot bed, equal-gain loop joints | KEEP | [Fresh six-bar decision](project-core.md); `expect(r3.beds.map((b) => b.mediaId)).toEqual([amb, amb2])` |
| 337: ducks under the dialogue with Volume keyframes (−10 dB) | KEEP | [Fresh six-bar decision](project-core.md); `expect(evaluate(piece.volumeDb, at(195))).toBeCloseTo(-10, 1)` |
| 365: refusals change nothing | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.ok, JSON.stringify(c)).toBe(false)` |
| 411: never throws on hostile arguments (property): a refusal or a valid document | REWRITE | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 453: dialogue regions, the gaps between dialogue clips, the padded fill, the level | KEEP | [Fresh six-bar decision](project-core.md); `expect(regions.map((r) => [r.start, r.end])).toEqual([ [0, 210], [600, 660], ])` |
| 513: a malformed bed or one on another kind of clip is reported and dropped by repair | KEEP | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(repaired.document)).toEqual([])` |

## packages/project/test/caption-formats.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 72: parses and formats clock times | KEEP | [Historical six-bar row](project2.md); `expect(parseClock('00:00:01,500')).toBe((FLICKS_PER_SECOND * 3) / 2)` |
| 80: decodes BOM, UTF-16 and Windows-1252, normalising line endings | KEEP | [Historical six-bar row](project2.md); `expect(decodeCaptionText(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('a\r\nb\rc')]))).toBe('a\nb\nc')` |
| 88: detects formats by content and extension | KEEP | [Historical six-bar row](project2.md); `expect(detectCaptionFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n', 'vtt')).toBe('vtt')` |
| 102: normalize cuts overlaps | KEEP | [Historical six-bar row](project2.md); `expect(d.cues.map((x) => [x.start, x.end])).toEqual([ [0, 10], [10, 12], [12, 20], ])` |
| 111: plain text strips markup | KEEP | [Historical six-bar row](project2.md); `expect(plainCaptionText('<i>Hello</i> &amp; <b>bye</b>')).toBe('Hello & bye')` |
| 120: reads and writes the basic form | KEEP | [Historical six-bar row](project2.md); `expect(d.cues).toHaveLength(2)` |
| 133: accepts sloppy files | KEEP | [Historical six-bar row](project2.md); `expect(d.cues.map((c) => [c.start / MS, c.end / MS, c.text])).toEqual([ [1500, 2250, 'A'], [3000, 4000, 'B'], [5000, 6000, '42'], ])` |
| 144: rejects garbage and skips inverted cues | KEEP | [Historical six-bar row](project2.md); `expect(parse('', 'srt').cues).toEqual([])` |
| 156: keeps ids, settings, voices and blocks | KEEP | [Historical six-bar row](project2.md); `expect(d.blocks).toEqual(['STYLE\n::cue { color: yellow }', 'NOTE a comment\nspanning lines'])` |
| 175: splits voices | KEEP | [Historical six-bar row](project2.md); `expect(splitVoice('<v Bob>hi</v>')).toEqual({ speaker: 'Bob', text: 'hi' })` |
| 183: tolerates a missing signature | KEEP | [Historical six-bar row](project2.md); `expect(parse('00:00:01.000 --> 00:00:02.000\nx\n', 'vtt').cues).toHaveLength(1)` |
| 190: parity | KEEP | [Historical six-bar row](project2.md); `expect(withParity(0x14)).toBe(0x94)` |
| 202: PAC round trip | KEEP | [Historical six-bar row](project2.md); `expect(decodePac(b1, b2)).toEqual({ row, indent })` |
| 209: characters | KEEP | [Historical six-bar row](project2.md); `expect(encodeChar('A')).toEqual({ kind: 'basic', b: 0x41 })` |
| 217: timecodes | KEEP | [Historical six-bar row](project2.md); `expect(parseSccTimecode('00:01:00;02')).toBe(1800)` |
| 224: decodes a known pop-on stream | KEEP | [Historical six-bar row](project2.md); `expect(d.cues).toHaveLength(1)` |
| 234: decodes roll-up | KEEP | [Historical six-bar row](project2.md); `expect(parse(scc, 'scc').cues.map((c) => c.text)).toEqual(['AB', 'AB\nCD'])` |
| 239: decodes paint-on | KEEP | [Historical six-bar row](project2.md); `expect(d.cues.map((c) => [frameAt(c.start, SCC_RATE), frameAt(c.end, SCC_RATE), c.text])).toEqual([ [34, 60, 'HI'], ])` |
| 247: writes then reads pop-on captions frame-exactly | KEEP | [Historical six-bar row](project2.md); `expect(back.cues.map((c) => [frameAt(c.start, SCC_RATE), frameAt(c.end, SCC_RATE), c.text])).toEqual([ [60, 120, 'Hello, world!'], [120, 200, 'Second caption\nwith two lines'], [260, 300, 'Ñandú ♪ {x} *…` |
| 267: wraps long lines at 32 columns | KEEP | [Historical six-bar row](project2.md); `expect(rows.every((r) => r.length <= 32)).toBe(true)` |
| 272: a cue at zero is delayed, not lost | KEEP | [Historical six-bar row](project2.md); `expect(back.cues).toHaveLength(1)` |
| 282: abbreviations round trip | KEEP | [Historical six-bar row](project2.md); `expect(mccExpand(s)).toEqual(b)` |
| 292: CDP structure and checksum | KEEP | [Historical six-bar row](project2.md); `expect(b.slice(0, 3)).toEqual([0x61, 0x01, 73])` |
| 311: writes and reads CEA-608 and CEA-708 | KEEP | [Historical six-bar row](project2.md); `expect(s).toContain('Time Code Rate=30DF')` |
| 339: ISO 6937 round trip | KEEP | [Historical six-bar row](project2.md); `expect(b, c).not.toBeNull()` |
| 348: writes GSI and extension blocks | KEEP | [Historical six-bar row](project2.md); `expect([...tti0.subarray(5, 9)]).toEqual([0, 0, 1, 0])` |
| 374: subtracts the start of programme | KEEP | [Historical six-bar row](project2.md); `expect(parse(b, 'stl').cues[0]!.start).toBe(tickOf(250, RATE_25))` |
| 386: rejects invalid timing parameters | KEEP | [Historical six-bar row](project2.md); `expect(parseCaptionFile(xmlWith(params, '1s', '2s'), 'ttml').ok, params).toBe(false)` |
| 399: keeps defaults for missing timing parameters | KEEP | [Historical six-bar row](project2.md); `expect([d.cues[0]!.start, d.cues[0]!.end]).toEqual([FLICKS_PER_SECOND, 2 * FLICKS_PER_SECOND])` |
| 412: time expressions | KEEP | [Historical six-bar row](project2.md); `expect(parseTtmlTime('00:00:01.500', t)).toBe(s(1.5))` |
| 427: reads styles, spans and nesting | KEEP | [Historical six-bar row](project2.md); `expect(d.cues.map((c) => [c.start / FLICKS_PER_SECOND, c.end / FLICKS_PER_SECOND, c.text])).toEqual([ [11, 12, 'Hello <i>big</i> world\nsecond line'], [13, 14, '<b>Bold</b> & plain'], [20, 21, 'span tim…` |
| 450: writes IMSC1 with frames and spans | KEEP | [Historical six-bar row](project2.md); `expect(x).toContain('http://www.w3.org/ns/ttml/profile/imsc1/text')` |
| 521: SRT | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 532: WebVTT with ids, speakers, settings and STYLE blocks | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(withExtra))` |
| 558: SCC frame-exact (drop and non-drop) | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 569: SCC back-to-back captions | KEEP | [Historical six-bar row](project2.md); `expect(norm(parse(writeCaptionFile(doc(cues), 'scc'), 'scc').cues)).toEqual(norm(cues))` |
| 587: MCC frame-exact (CEA-608 path) | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 598: MCC CEA-708 path alone | KEEP | [Historical six-bar row](project2.md); `expect(norm(parse(writeMcc(doc(cues), true, { cea608: false }), 'mcc').cues)).toEqual(norm(cues))` |
| 606: EBU STL at 25 and 29.97 fps | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 630: TTML (IMSC1) frame-exact with ids and speakers | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 661: DFXP frame-exact after snapping | KEEP | [Historical six-bar row](project2.md); `expect(norm(back.cues)).toEqual(norm(cues))` |
| 687: SRT → VTT → SCC keeps text and frames | KEEP | [Historical six-bar row](project2.md); `expect(d3.cues.map((c) => c.text)).toEqual(['Hello there', 'General Kenobi'])` |

## packages/project/test/captions-commands.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 72: adds a caption track (active), then a caption at the playhead clamped to the next one | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [40, 100, 'Hello <i>world</i>\nsecond line'], [100, 150, 'b'], ])` |
| 95: creates a caption track when none exists | KEEP | [Historical six-bar row](project1.md); `expect(H.seq.captionTracks).toHaveLength(1)` |
| 114: splits by word time and merges back with a line break | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [0, 60, 'hello there'], [60, 100, 'friend'], [100, 150, 'world'], ])` |
| 137: a split with no word boundary keeps the text on both halves (FilmCraft) | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [0, 40, 'hello'], [40, 100, 'hello'], ])` |
| 147: trims and moves like clips, limited by neighbours | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)[1]).toEqual([100, 300, 'b'])` |
| 165: ripple deletes a caption and the later ones close the gap | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [0, 100, 'a'], [150, 200, 'c'], ])` |
| 178: caption.delete ripples only its caption track | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [0, 100, 'a'], [150, 200, 'c'], ])` |
| 196: locked caption tracks refuse edits | KEEP | [Historical six-bar row](project1.md); `expect(H.tx([{ type: 'caption.setText', clipId: id, text: 'x' }]).ok).toBe(false)` |
| 205: duplicates and pastes get their own words | KEEP | [Historical six-bar row](project1.md); `expect(spans(H).map((x) => x[2])).toEqual(['one two', 'three'])` |
| 219: sync-locked caption tracks follow insert and extract edits | KEEP | [Historical six-bar row](project1.md); `expect(spans(H).map((x) => [x[0], x[1]])).toEqual([ [0, 50], [75, 125], ])` |
| 249: a caption cut by an extract stays one caption | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([[10, 90, 'one two three four']])` |
| 258: a caption track with sync lock off stays put | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([[0, 100, 'stay']])` |
| 277: editing a word keeps every other word timing (AC-CAP-2) | KEEP | [Historical six-bar row](project1.md); `expect(after.map((w) => w.text)).toEqual(['the', 'quick', 'red', 'fox'])` |
| 289: transcript.editText spreads new words over the replaced range by characters | KEEP | [Historical six-bar row](project1.md); `expect(w.slice(4, 6).map((x) => x.text)).toEqual(['Uh', 'huh,'])` |
| 303: a blank line in caption text starts a new page | KEEP | [Historical six-bar row](project1.md); `expect(pages.map((p) => [p.start, p.end])).toEqual([ [0, 48], [48, 120], ])` |
| 314: speaker of a caption | KEEP | [Historical six-bar row](project1.md); `expect(Object.values(t.speakers).map((x) => x.name)).toContain('Bob')` |
| 326: track style, per-caption overrides, reset and presets | KEEP | [Historical six-bar row](project1.md); `expect([st.sizePx, st.placement, st.fill, st.linePct]).toEqual([60, 'top', [1, 1, 0, 1], 20])` |
| 356: imports SRT onto a new caption track, frame-snapped, and exports it back | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([ [25, 62, 'Hello\n<i>World</i>'], [75, 100, 'Bye'], ])` |
| 377: keeps WebVTT ids, settings (as placement), speakers and STYLE blocks | KEEP | [Historical six-bar row](project1.md); `expect(c.cue).toEqual({ id: 'intro', settings: 'line:10% align:start' })` |
| 390: imports binary EBU STL from base64 and SCC as CEA-608 | KEEP | [Historical six-bar row](project1.md); `expect(H.seq.captionTracks[0]!.captionStandard).toBe('cea-608')` |
| 400: replaces the captions of a track | KEEP | [Historical six-bar row](project1.md); `expect(spans(H)).toEqual([[250, 275, 'New']])` |
| 417: imports transcripts from JSON and caption files | KEEP | [Historical six-bar row](project1.md); `expect(t.words.map((w) => w.text)).toEqual(['Hello', 'world!'])` |
| 453: imports a sequence-timed caption file through a clip | KEEP | [Historical six-bar row](project1.md); `expect(t.words[0]!.start).toBe(s(3))` |
| 480: select marks In/Out snapped outward; extract closes the gap | KEEP | [Historical six-bar row](project1.md); `expect([H.seq.inPoint, H.seq.outPoint]).toEqual([12, 43])` |
| 491: lift leaves a gap | KEEP | [Historical six-bar row](project1.md); `expect(w).toHaveLength(16)` |
| 498: removes pauses in one pass, keeping air | KEEP | [Historical six-bar row](project1.md); `expect(w2.map((x) => x.text)).toEqual(fixture.words.map((w) => w.text))` |
| 507: removes fillers (longest phrase first) without cutting into neighbours | KEEP | [Historical six-bar row](project1.md); `expect(sequenceWords(H2.doc, H2.seq).map((x) => x.text)).not.toContain('know.')` |
| 519: renames speakers across transcripts and sets a word range speaker | KEEP | [Historical six-bar row](project1.md); `expect( sequenceWords(H.doc, H.seq) .slice(0, 3) .map((w) => w.speaker), ).toEqual(['Host', 'Host', 'Speaker 1'])` |
| 530: creates captions from the sequence transcript (FilmCraft caption blocks) | KEEP | [Historical six-bar row](project1.md); `expect(spans(H).map((x) => x[2])).toEqual([ 'Welcome to the show.', 'Um, today we talk about rivers.', 'Thanks for having me. I uh love rivers,\nyou know.', ])` |
| 547: clip.addCaptions aligned to a clip, one paged clip or one clip per block | KEEP | [Historical six-bar row](project1.md); `expect(captions(H)).toHaveLength(1)` |
| 570: inserts a text selection into another sequence | KEEP | [Historical six-bar row](project1.md); `expect(w.map((x) => x.text)).toEqual(['Thanks', 'for', 'having', 'me.'])` |
| 580: transcripts in use cannot be deleted; others can | KEEP | [Historical six-bar row](project1.md); `expect(H.doc.transcripts[trs]).toBeUndefined()` |
| 591: repairs a shared caption transcript, bad words and a dangling active track | KEEP | [Historical six-bar row](project1.md); `expect(issues.length).toBeGreaterThan(0)` |
| 614: add / split / merge / delete / move / trim / extract / text / import | KEEP | [Historical six-bar row](project1.md); `expect(r.errors[0]!.code).not.toMatch(/E_INVARIANT\|E_INTERNAL/)` |

## packages/project/test/clip-edit.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 142: .nam | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual(c.expectSpans)` |
| 151: media handles limit both sides and source stays glued to the picture | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 60], [60, 180], ])` |
| 181: linked partners roll together; Alt (linked: false) rolls one side only | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 100], [100, 180], ])` |
| 205: refuses on a locked track | KEEP | [Historical six-bar row](project3.md); `expect(r.ok).toBe(false)` |
| 218: AC-12b: a clip with 10 frames of head handle stops after 10 frames of rightward slip | KEEP | [Historical six-bar row](project3.md); `expect(r.results[0]).toMatchObject({ deltaFrames: 10 })` |
| 237: leftward slip shows later material and stops at the end of the media | KEEP | [Historical six-bar row](project3.md); `expect([c.start, c.duration]).toEqual([0, 90])` |
| 248: speed $speed reverse $reverse slips by delta × F × rate | KEEP | [Historical six-bar row](project3.md); `expect([after.start, after.duration]).toEqual([before.start, before.duration])` |
| 263: multi-clip slip moves in lockstep with the most restrictive handle | KEEP | [Historical six-bar row](project3.md); `expect(byId(h, a!).sourceIn).toBe(15 * F30)` |
| 272: refuses when none of the selected clips can slip | KEEP | [Historical six-bar row](project3.md); `expect(r.ok).toBe(false)` |
| 282: AC-12c: sliding B between A and C by +12 lengthens A, shortens C, keeps B source and length | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 102], [102, 162], [162, 240], ])` |
| 302: $name | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual(spans)` |
| 330: gap neighbours resize instead of clips; frame 0 bounds the slide | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [40, 50], [50, 60], ])` |
| 347: neighbour media limits stop the slide | KEEP | [Historical six-bar row](project3.md); `expect(byId(h, a!).duration).toBe(120)` |
| 357: linked partners slide with the clip | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('A1')).toEqual(h.spans('V1'))` |
| 370: AC-12d: stretching a 100-frame clip to 200 frames yields speed 0.5 and the same source range | KEEP | [Historical six-bar row](project3.md); `expect([c.sourceIn, sourceOut(c, RATES.r30)]).toEqual([c0.sourceIn, sourceOut(c0, RATES.r30)])` |
| 382: a rate derives the duration from the source span | KEEP | [Historical six-bar row](project3.md); `expect([byId(h, id!).duration, byId(h, id!).speed.rate]).toEqual([45, 2])` |
| 389: without ripple the duration is clamped to the next clip and the rate is kept | KEEP | [Historical six-bar row](project3.md); `expect([byId(h, id!).duration, byId(h, id!).speed.rate]).toEqual([120, 0.5])` |
| 398: with ripple later clips and sync-locked tracks shift | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 180], [210, 240], ])` |
| 410: linked V/A shift sync-locked followers only once | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([[0, 180]])` |
| 420: reverse flips the mapping without touching sourceIn or duration | KEEP | [Historical six-bar row](project3.md); `expect([c.sourceIn, c.duration]).toEqual([c0.sourceIn, c0.duration])` |
| 430: clips without speed (stills, text, solids) only change duration | KEEP | [Historical six-bar row](project3.md); `expect([byId(h, id).duration, byId(h, id).speed.rate]).toEqual([50, 1])` |
| 441: copies to the first free space to the right with new ids and a mirrored link group | KEEP | [Historical six-bar row](project3.md); `expect([cv.start, ca.start]).toEqual([70, 70])` |
| 456: deltaFrames and destination tracks place copies with overwrite semantics | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V2')).toEqual([ [0, 150], [150, 250], [250, 300], ])` |
| 469: copies keyframes with fresh ids | KEEP | [Historical six-bar row](project3.md); `expect(copy.opacity.keyframes).toHaveLength(1)` |
| 489: unlink dissolves the group; link re-creates one | KEEP | [Historical six-bar row](project3.md); `expect(byId(h, v!).linkId).toBeNull()` |
| 502: link refuses $name | KEEP | [Historical six-bar row](project3.md); `expect(r.ok).toBe(false)` |
| 515: linking moves a clip out of its previous group (dissolving it when it drops below two) | KEEP | [Historical six-bar row](project3.md); `expect(byId(h, a!).linkId).toBe(byId(h, s).linkId)` |
| 527: $mode on a $w×$h clip in 1080p | KEEP | [Historical six-bar row](project3.md); `expect(c.transform.scale.value).toBeCloseTo(scale, 6)` |
| 541: skips clips without a transform and refuses when none has one | KEEP | [Historical six-bar row](project3.md); `expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] })` |
| 550: AC-13d: extract In=100 Out=199 removes exactly 100 frames from targeted and sync-locked tracks | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 100], [100, 200], ])` |
| 573: tracks that are neither targeted nor sync-locked are untouched; locked tracks never shift | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 100], [100, 250], ])` |
| 589: lift leaves a gap and splits clips at In and Out with relinked right parts | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 100], [150, 300], ])` |
| 606: AC-16b: extracting 30 frames before a marker moves it 30 frames left (and keeps it with rippleMarkers false) | KEEP | [Historical six-bar row](project3.md); `expect(h.seq.markers[0]!.frame).toBe(170)` |
| 615: refuses an empty range and an explicitly locked track | KEEP | [Historical six-bar row](project3.md); `expect(h.tx([{ type: 'range.lift', from: 100, to: 100 }])).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }], })` |
| 630: closes the gap and ripples sync-locked tracks that are empty in the gap range | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 50], [50, 100], ])` |
| 647: refuses with E_SYNC_CONFLICT naming the blocking clip; sync lock off makes it succeed | KEEP | [Historical six-bar row](project3.md); `expect(r.errors[0]!.blocking).toContain(blocker)` |
| 666: the area after the last clip is not a gap | KEEP | [Historical six-bar row](project3.md); `expect(h.tx([{ type: 'gap.close', trackId: 'V1', at: 70 }])).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }], })` |
| 677: AC-11d: Q (ripple-remove [clipStart, playhead)) removes the head and closes the gap | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 100], [100, 170], ])` |
| 690: AC-13a: Add Edit on targeted V1/A1 splits only V1/A1 clips crossing 240 | KEEP | [Historical six-bar row](project3.md); `expect(h.spans('V1')).toEqual([ [0, 240], [240, 300], ])` |
| 834: every committed document passes INV-001…015; rejections leave the document unchanged | KEEP | [Historical six-bar row](project3.md); `expect(successes).toBeGreaterThan(0)` |

## packages/project/test/clipboard.test.ts

S01 clipboard / S03 EC-023; AGENTS §0 failure containment. Public paste command reports typed E_INTERNAL for an actual failed dependency and retains the document.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 91: round-trips through text/html with non-ASCII text, and rejects HTML without the marker | KEEP | [Historical six-bar row](project2.md); `expect(clipboardText(p)).toBe('Hello ünïcode ✓')` |
| 104: validates with zod: foreign data, other versions, oversize and malformed entities are refused | KEEP | [Historical six-bar row](project2.md); `expect(parseClipboardPayload('not json')).toMatchObject({ ok: false, code: 'E_SCHEMA' })` |
| 124: the paste commands refuse invalid and oversized payloads | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type: 'clip.paste', payload: big, at: 0 }])).toMatchObject({ ok: false, errors: [{ code: 'E_LIMIT' }], })` |
| 144: pastes at the playhead in overwrite mode with new ids, relative layout, links and transitions | KEEP | [Historical six-bar row](project2.md); `expect(pasted.map((c) => [c.kind, label(c), c.start])).toEqual([ ['video', 'V2', 200], ['audio', 'A1', 200], ['text', 'V3', 210], ['shape', 'V4', 220], ])` |
| 182: overwrites what is under the pasted clips, and Paste Insert ripples instead (TRK-006) | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([ [0, 40], [40, 60], [60, 100], ])` |
| 214: refuses locked destinations and kind mismatches | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type: 'clip.paste', payload: p, at: 0, tracks: { video: 'V2' } }])).toMatchObject({ ok: false, errors: [{ code: 'E_TRACK_LOCKED' }], })` |
| 228: keeps every M2 field: text animators, shape keyframes, anime template params and renderer stamp | KEEP | [Historical six-bar row](project2.md); `expect(mg.template).toEqual({ id: 'reveal', version: 1, renderer: 'anime' })` |
| 286: remaps trackers: a pasted target follows the pasted copy of its plate (S09) | KEEP | [Historical six-bar row](project2.md); `expect(newTarget.effects.map((e) => e.id)).toContain(newTarget.trackedBy.effectInstanceId)` |
| 342: converts starts, durations, transitions and animator windows to the target frame rate | KEEP | [Historical six-bar row](project2.md); `expect([pv.start, pv.duration]).toEqual([0, 50])` |
| 363: reuses media with the same fingerprint, adds missing assets with new ids and a project item | KEEP | [Historical six-bar row](project2.md); `expect(r1.createdMedia).toEqual([])` |
| 396: copies synthetics, transcripts and fonts with new ids (fonts with the same family are reused) | KEEP | [Historical six-bar row](project2.md); `expect(Object.keys(h.doc.synthetics)).not.toContain(solid.syntheticId)` |
| 424: resolves LUT media in effect params, composition bundles and derivation sources | KEEP | [Historical six-bar row](project2.md); `expect(p.media.map((m) => m.kind)).toEqual(['video', 'video', 'lut'])` |
| 504: applies the chosen attributes to every target in one transaction, keeping key offsets | KEEP | [Historical six-bar row](project2.md); `expect((r.results[0] as { clipIds: string[] }).clipIds).toEqual([b, c])` |
| 528: Scale Attribute Times stretches keys to the target duration | KEEP | [Historical six-bar row](project2.md); `expect(B.transform.scale.keyframes.map((k) => (k.time - B.sourceIn) / F30)).toEqual([0, 59])` |
| 545: pastes text animators, text style and shape style (M2) and refuses attributes that apply to nothing | KEEP | [Historical six-bar row](project2.md); `expect(Q.shape.fill?.value).toEqual([1, 0, 0, 1])` |
| 588: Remove Attributes resets intrinsics and removes effects by registry id | KEEP | [Historical six-bar row](project2.md); `expect(A.transform.scale).toEqual({ value: 100, keyframes: [] })` |
| 606: effect.paste appends copied effects (and copied intrinsics) to every selected clip (EC-032) | KEEP | [Historical six-bar row](project2.md); `expect((h.seq.clips[id] as { effects: { effectId: string }[] }).effects.map((e) => e.effectId)).toEqual( ['jasper.gaussian-blur'], )` |
| 634: reports unexpected property resolver errors (%s) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_INTERNAL', message: 'effect registry unavailable' }], })` |
| 669: reports a locked keyframe destination without disguising it as a missing property | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type: 'keyframe.paste', payload, clipId: v, at: { frames: 40 } }])).toMatchObject({ ok: false, errors: [{ code: 'E_TRACK_LOCKED' }], })` |
| 687: pastes keys at the playhead keeping relative timing, onto the same property path | KEEP | [Historical six-bar row](project2.md); `expect(p.keyframes!.tracks[0]!.address).toEqual({ effectId: 'jasper.gaussian-blur', occurrence: 0, param: 'radius', })` |
| 727: refuses a selected property of another value kind, and pastes shape size keys (M2) | KEEP | [Historical six-bar row](project2.md); `expect( h.tx([ { type: 'keyframe.paste', payload: p, clipId: text, at: { frames: 0 }, target: ['clip', text, 'opacity'], }, ]), ).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] })` |
| 774: deep-copies sequences with new ids and remapped references, into the chosen bin | KEEP | [Historical six-bar row](project2.md); `expect(h.doc.items[res.itemIds[0]!]).toMatchObject({ kind: 'sequence', name: seqItem.name })` |
| 795: pastes a multi-camera source with its cameras on the copied tracks | KEEP | [Historical six-bar row](project2.md); `expect(at(copy)).toEqual(at(orig))` |
| 820: pastes bins with their children into another project (media resolved, items added once) | KEEP | [Historical six-bar row](project2.md); `expect(newBin).toMatchObject({ kind: 'bin', name: 'Selects' })` |
| 840: payload data is never treated as addresses, temp refs or selections | KEEP | [Historical six-bar row](project2.md); `expect(resolved.ok && resolved.commands[0]).toEqual(cmd)` |

## packages/project/test/color-match.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 49: Oklab published white and red reference coordinates | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(Math.abs(w[0] - 1)).toBeLessThan(1e-3)` |
| 59: matching a frame to itself changes nothing | KEEP | [Historical six-bar row](project3.md); `expect(m.before).toBeLessThan(1e-4)` |
| 69: skin protection limits the skin hue shift to 8° | KEEP | [Historical six-bar row](project3.md); `expect(prot.skin).toBe('hue')` |
| 89: Face Detection with faces: the faces weigh more and the current face colour is matched to the reference face | KEEP | [Historical six-bar row](project3.md); `expect(faces.skin).toBe('faces')` |
| 114: the face model found no faces: the whole frame counts equally (same as off) | KEEP | [Historical six-bar row](project3.md); `expect(none.shadowsWheel).toEqual(off.shadowsWheel)` |
| 124: letterbox bars do not count (a pillarboxed copy of the frame matches the frame) | KEEP | [Historical six-bar row](project3.md); `expect([crop.w, crop.h]).toEqual([f.w, f.h])` |
| 153: brightens an under-exposed frame and stretches a flat one | KEEP | [Historical six-bar row](project3.md); `expect(dark.exposure).toBeGreaterThan(0.2)` |
| 171: leaves a well exposed frame nearly alone | KEEP | [Historical six-bar row](project3.md); `expect(Math.abs(ok.exposure)).toBeLessThan(0.6)` |
| 176: never throws on an empty or transparent frame | KEEP | [Historical six-bar row](project3.md); `expect(() => autoTone({ w: 0, h: 0, rgb: new Float32Array(0) })).not.toThrow()` |

## packages/project/test/color-mgmt-luts.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 74: matches the brute-force simplex reference for sizes 2–33 | OPTIMIZE | [Fresh six-bar decision](project-core.md); `expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(2e-6)` |
| 90: is exact on affine LUTs and at lattice nodes | CONSOLIDATE | [Fresh six-bar decision](project-core.md); `expect(at(w, [3 / 6, 5 / 6, 1 / 6])).toEqual(node(w, 3, 5, 1))` |
| 113: 1D shaper + 3D (Resolve layout): parse, apply, write, read back | KEEP | [Fresh six-bar decision](project-core.md); `expect(l.shaper?.domainMax).toEqual([4, 4, 4])` |
| 129: 1D only, with LUT_1D_INPUT_RANGE | KEEP | [Fresh six-bar decision](project-core.md); `expect(at(l, [1, 1, 1])).toEqual([0.5, 0.25, 0.125])` |
| 134: a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain | KEEP | [Fresh six-bar decision](project-core.md); `expect(l.domainMin).toEqual([-0.5, -0.5, -0.5])` |
| 141: refuses duplicate sizes and data before sizes | KEEP | [Fresh six-bar decision](project-core.md); `expect(() => parseCube('LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n')).toThrow(CubeParseError)` |
| 149: round-trips with blue-fastest orientation (a red↔blue swap shows any mistake) | KEEP | [Fresh six-bar decision](project-core.md); `expect(text.split('\n')[1]).toMatch(/^0 64 128 /)` |
| 168: reads a hand-written Lustre file (Mesh header, 12-bit output) | KEEP | [Fresh six-bar decision](project-core.md); `expect(v[k]).toBeCloseTo([0.2, 0.4, 0.6][k]!, 4)` |
| 175: a non-uniform input mesh becomes a 1D shaper | KEEP | [Fresh six-bar decision](project-core.md); `expect(at(l, [100 / 1023, 0, 1])[0]).toBeCloseTo(2047 / 4095, 3)` |
| 188: spi1d with From and one component | KEEP | [Fresh six-bar decision](project-core.md); `expect(at(l, [1, 1.5, 2])).toEqual([0.25, 0.625, 1])` |
| 194: spi3d rows with explicit indices | KEEP | [Fresh six-bar decision](project-core.md); `expect(at(l, [0.25, 0.5, 0.75])).toEqual([0.75, 0.5, 0.25])` |
| 202: csp 3D with non-uniform pre-LUTs | KEEP | [Fresh six-bar decision](project-core.md); `expect(l.shaper?.domainMax).toEqual([2, 2, 2])` |
| 214: dispatches by extension and sniffs unknown files | KEEP | [Fresh six-bar decision](project-core.md); `expect(lutFormatOf('a/Look.CUBE')).toBe('cube')` |
| 223: flattens shapers and 1D tables into a plain unit cube | KEEP | [Fresh six-bar decision](project-core.md); `expect(at(f, [0.25, 0.5, 0.75])).toEqual([0.125, 0.125, 0.09375])` |

## packages/project/test/color-mgmt-model.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 85: defaults to Rec. 709 and changes undoably, linear variants turn on Linearize | KEEP | [Historical six-bar row](project2.md); `expect(sequenceColorInfo(h.seq.settings)).toMatchObject({ space: 'rec709', linearize: false, blendLinear: false, autoToneMap: true, sdrWhiteNits: 203, })` |
| 117: refuses unknown spaces and out-of-range settings | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'aces' } }]).ok).toBe( false, )` |
| 129: a sequence made from HDR media works in its HDR space | KEEP | [Historical six-bar row](project2.md); `expect(h.doc.sequences[id]!.settings.workingColorSpace).toBe('rec2100-hlg')` |
| 141: sets, patches and clears the media interpretation; validates every reference | KEEP | [Historical six-bar row](project2.md); `expect(h.doc.media[mediaId]!.interpretation?.color).toEqual({ space: 'slog3-sgamut3cine', range: 'pc' })` |
| 171: EXR / Radiance stills (decoded with the sRGB transfer) are graphics-like sRGB, not scene-linear | KEEP | [Historical six-bar row](project2.md); `expect(resolveInputSpace(a as never, {}, 'rec709').space?.id).toBe('rec709')` |
| 180: refuses audio media and non-picture clips | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type: 'media.interpretColor', mediaIds: [a], color: { space: 'rec709' } }]).ok).toBe( false, )` |
| 194: adds nothing in a plain Rec. 709 sequence (existing projects render as before) | KEEP | [Historical six-bar row](project2.md); `expect(clip.effects.some((fx) => fx.effectId === COLOR_INPUT_ID)).toBe(false)` |
| 202: interprets S-Log3 into Rec. 709: 18 % grey lands at BT.2408 26/203 (≈ 42.5 %) | KEEP | [Historical six-bar row](project2.md); `expect(v).toBeCloseTo((26 / 203) ** (1 / 2.4), 2)` |
| 213: PQ media auto-detected in a PQ sequence is the identity; in Rec. 709 it is tone mapped | KEEP | [Historical six-bar row](project2.md); `expect(snapOf(h).videoTracks[0]!.clips[0]!.effects.some((fx) => fx.effectId === COLOR_INPUT_ID)).toBe( true, )` |
| 224: graphics and the background map SDR white to the HDR graphics white in PQ | KEEP | [Historical six-bar row](project2.md); `expect(snap.settings.backgroundColor[k]).toBeCloseTo(0.5806888810416078, 6)` |
| 241: the working settings enter the run key (a changed setting re-bakes) | KEEP | [Historical six-bar row](project2.md); `expect(workingKey(a)).not.toBe(workingKey(b))` |
| 265: HDR White / Specular are identity at their defaults | KEEP | [Historical six-bar row](project2.md); `expect(bakeColorRun(lum({}), defaultEffectRegistry, { lut: () => null, working: pq }, 33)).toBeNull()` |
| 268: HDR Specular pulls the highlights above HDR White down, leaves the rest | KEEP | [Historical six-bar row](project2.md); `expect(m[0]).toBeCloseTo(mid, 2)` |
| 281: repairs unknown working spaces, interpretations and stray internal effects | KEEP | [Historical six-bar row](project2.md); `expect(checkInvariants(document).filter((i) => i.invariant === 'INV-COLOR')).toEqual([])` |
| 315: effect.add refuses the render-only colour input effect | KEEP | [Historical six-bar row](project2.md); `expect(r.ok).toBe(false)` |

## packages/project/test/color-mgmt-ocio.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 87: block and flow collections, tags, quotes, sequences at the key indent | KEEP | [Historical six-bar row](project3.md); `expect(yNums(yGet(ySeq(yGet(y, 'b'))[1], 'k'))).toEqual([1, 2])` |
| 97: rejects deeply nested YAML before exhausting the stack | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(() => parseYaml(\`a: ${'['.repeat(1000)}\`)).toThrowError( expect.objectContaining({ name: 'RangeError', message: expect.stringMatching(/nest/i) }), )` |
| 106: parses spaces, roles, aliases and displays | KEEP | [Historical six-bar row](project3.md); `expect(c.spaceNames()).toEqual(['lin', 'gamma22', 'half', 'log2', 'affine', 'lut', 'raw', 'weird'])` |
| 114: converts through the reference with every transform and its inverse | KEEP | [Historical six-bar row](project3.md); `expect(run(c.convertFn('raw', 'gamma22'), [0.3, 0.3, 0.3])).toEqual([0.3, 0.3, 0.3])` |
| 134: refuses unsupported transforms and unknown names instead of passing colours through | KEEP | [Historical six-bar row](project3.md); `expect(c.unsupported()).toEqual(['ExposureContrastTransform style video'])` |
| 198: S-Log3 code 420 represents 18% gray in ACES2065-1 | KEEP | File-specific independent source above; named contract and literal/property result below; shared assertion helper verifies the named semantic property |
| 205: ACEScct round trip, CDL group, LogCamera, ColorSpaceTransform | KEEP | [Historical six-bar row](project3.md); shared assertion helper verifies the named semantic property |
| 215: scene → display goes through the default view transform | KEEP | [Historical six-bar row](project3.md); shared assertion helper verifies the named semantic property |
| 220: interchange roles relate config spaces to ACES2065-1 / XYZ | KEEP | [Historical six-bar row](project3.md); `expect(() => OcioConfig.parse(CONFIG, FILES).interchange('lin')).toThrow(/aces_interchange/)` |
| 227: the ACES output transform is refused, never passed through | KEEP | [Historical six-bar row](project3.md); `expect(c.unsupported()).toContain( 'BuiltinTransform "ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-VIDEO_1.0"', )` |
| 236: parses .ccc collections and inverts exactly inside the range | KEEP | [Historical six-bar row](project3.md); `expect(list.map((e) => e.id)).toEqual(['a', 'b'])` |

## packages/project/test/color-mgmt-science.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 60: BT.709 RGB→XYZ equals the published matrix (IEC 61966-2-1, 4 places) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 67: BT.2020 luma coefficients (BT.2020-2 Table 4) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 73: BT.709 → BT.2020 equals ITU-R BT.2087-0 eq. 4 | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 80: ACES AP0/AP1 NPMs and AP0→AP1 equal SMPTE ST 2065-1 / Academy S-2014-004 | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 103: Rec.709 → ACES2065-1 with Bradford equals the OCIO studio config matrix | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 113: Bradford D65 → D50 equals the published ICC/Lindbloom matrix | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 123: camera gamut NPMs equal the vendors’ published RGB→XYZ matrices | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 148: every gamut maps white to white, conversions invert, and nesting is detected | KEEP | [Historical six-bar row](project1.md); `expect(() => inv3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toThrow(RangeError)` |
| 166: PQ (SMPTE ST 2084) reference points | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 175: HLG (BT.2100) reference points and the 75 % ↔ 203 cd/m² relation (BT.2408) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 182: sRGB, BT.709 OETF, BT.1886, ACEScct reference points | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 192: every curve round-trips (property) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 208: code values of 0 %, 18 % and 90 % reflectance | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 238: every curve round-trips over −1 %…40× grey and is increasing | KEEP | [Historical six-bar row](project1.md); `expect(Math.abs(back - x), \`${id} ${x}\`).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(x)) + 1e-9)` |
| 255: domain conversion with the file range (limited code 420 = S-Log3 grey) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 266: BT.2390 EETF: identity below the knee, monotone, hits the target peak | KEEP | [Historical six-bar row](project1.md); `expect(y).toBeGreaterThanOrEqual(prev - 1e-3)` |
| 281: tone mapping keeps hue and maps the peak | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 290: ACES RGC leaves the inner gamut alone and brings colours to the limit inside | KEEP | [Historical six-bar row](project1.md); `expect(o).toEqual(c)` |
| 310: desaturation into a gamut keeps luminance | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 318: HDR peak from static metadata | KEEP | [Historical six-bar row](project1.md); `expect(hdrPeakNits(null)).toBeNull()` |
| 327: every space has a unique id and parses from its id and label | KEEP | [Historical six-bar row](project1.md); `expect(new Set(COLOR_SPACES.map((s) => s.id)).size).toBe(COLOR_SPACES.length)` |
| 337: auto-detection from stream tags | KEEP | [Historical six-bar row](project1.md); `expect(spaceFromStreamTags({ primaries: 'bt2020', transfer: 'smpte2084' }).id).toBe('rec2100-pq')` |
| 350: same space is the identity; Rec.709 into Rec.2020 is BT.2087 in linear light | KEEP | [Historical six-bar row](project1.md); `expect(inputTransformFn({ space: 'rec709' }, w709)).toBeNull()` |
| 360: SDR into PQ maps SDR white to the graphics white (203 cd/m² → PQ 58 %) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 370: SDR into HLG: SDR white at 203 cd/m² is the 75 % HLG signal (BT.2408) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 374: PQ and HLG convert into each other through display light | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 382: log into Rec.709: 18 % grey lands at 26/203 of SDR white (BT.2408 OOTF), neutral and in range | KEEP | [Historical six-bar row](project1.md); `expect(red.every((v) => v >= 0 && v <= 1)).toBe(true)` |
| 394: PQ into Rec.709 is tone mapped: 1000 cd/m² reaches SDR white, dark tones unchanged | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 403: output transforms: HDR working → SDR display is tone mapped, SDR working → its display keeps the curve | KEEP | [Historical six-bar row](project1.md); `expect(outputTransformFn(defaultWorkingSettings('rec709'), displaySpaceFor('rec709'))).toBeNull()` |
| 419: the grading signal of PQ/HLG (1 = HDR White) round-trips | KEEP | [Historical six-bar row](project1.md); `expect(g[2]).toBeGreaterThan(1)` |
| 436: nits scale of the scopes | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 442: every transform keeps outputs finite and in 0…1 (property) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |

## packages/project/test/color.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 39: CG-021: defaults are the identity (null function; bit-exact on lattice points) | KEEP | [Historical six-bar row](project2.md); `expect(lumetriFn(effectiveParams(LUMETRI_EFFECT, {}), NO_LUTS)).toBeNull()` |
| 51: CG-022: temperature warms (r > b), tint > 0 lowers green, exposure +1 doubles linear light, saturation 0 is grey | KEEP | [Historical six-bar row](project2.md); `expect(up[0] ** 2.4).toBeCloseTo(2 * Lin, 9)` |
| 73: white balance preserves the linear-light luminance of neutral grey | KEEP | [Historical six-bar row](project2.md); `expect(Y(out.map((v) => v ** 2.4) as Rgb)).toBeCloseTo(0.3 ** 2.4, 12)` |
| 85: contrast pivots around mid-grey; whites/blacks move the end points | KEEP | [Historical six-bar row](project2.md); `expect(run({ contrast: 50 }, [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5])` |
| 92: highlights act on bright tones, shadows on dark tones | KEEP | [Historical six-bar row](project2.md); `expect(run({ highlights: 100 }, dark)[0]).toBeCloseTo(0.1, 12)` |
| 103: vibrance boosts dull colours more than saturated ones | KEEP | [Historical six-bar row](project2.md); `expect(gd).toBeGreaterThan(gv)` |
| 113: wheels: a shadows wheel towards red raises r most in the darks; gamma/gain follow their levels | KEEP | [Historical six-bar row](project2.md); `expect(run({ midtonesLevel: 50 }, [0.25, 0.25, 0.25])[0]).toBeCloseTo(0.25 ** (1 / 1.25), 12)` |
| 130: applies the master curve before each channel curve | KEEP | [Historical six-bar row](project2.md); `expect(out[0]).toBeCloseTo(0.3, 12)` |
| 153: input LUT and look LUT with intensity (order of CG-020) | KEEP | [Historical six-bar row](project2.md); `expect(run({ inputLut: { mediaId: 'med_inv' } }, [0.25, 0.5, 1], ctx)).toEqual([0.75, 0.5, 0])` |
| 168: output is always clamped to 0..1 | KEEP | [Historical six-bar row](project2.md); shared assertion helper verifies the named semantic property |
| 182: passes through its points and is flat outside them | KEEP | [Historical six-bar row](project2.md); `expect(f(x!)).toBeCloseTo(y!, 12)` |
| 196: monotone data gives a monotone curve (property test) | KEEP | [Historical six-bar row](project2.md); shared assertion helper verifies the named semantic property |
| 218: a curve with a local peak stays bounded near the peak | KEEP | [Historical six-bar row](project2.md); `expect(f(x)).toBeGreaterThan(0)` |
| 231: the identity curve and collinear points are the identity | KEEP | [Historical six-bar row](project2.md); `expect( normalizeCurve([ [1, 2], [0, -1], [0.5, 0.5], ]), ).toEqual([ [0, 0], [0.5, 0.5], [1, 1], ])` |
| 267: Brightness & Contrast matches S03:FX-040 within 1e-6 | KEEP | [Historical six-bar row](project2.md); `expect(BRIGHTNESS_CONTRAST_OP.build({ brightness: 0, contrast: 0 }, NO_LUTS)).toBeNull()` |
| 287: Hue/Saturation matches fixed CSS colour-matrix reference pixels | KEEP | [Historical six-bar row](project2.md); `expect(rotated[0]).toBeCloseTo(1, 12)` |
| 299: Black & White is lerp(v, Y(v), amount) | KEEP | [Historical six-bar row](project2.md); `expect(BLACK_WHITE_OP.build({ amount: 0 }, NO_LUTS)).toBeNull()` |
| 320: fuses consecutive colour effects in order and ends the run at blur | KEEP | [Historical six-bar row](project2.md); `expect(runs.map((r) => r.kind)).toEqual(['color', 'other', 'color'])` |
| 339: the run key changes with params and with the content identity of referenced LUTs | KEEP | [Historical six-bar row](project2.md); `expect(new Set([k1, k2, k3]).size).toBe(3)` |
| 350: a 33³ bake of a full grade takes < 15 ms (S06:CG-043; reported, fails above 2×) | KEEP | [Historical six-bar row](project2.md); `expect(best).toBeLessThan(budgetMs(30))` |

## packages/project/test/composition.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 119: places a 90-frame composition clip with the composition size as canvas | KEEP | [Historical six-bar row](project2.md); `expect([c.start, c.duration, c.sourceIn]).toEqual([30, 90, 0])` |
| 134: fits a larger composition into a smaller sequence and keeps overrides | KEEP | [Historical six-bar row](project2.md); `expect(c.props).toEqual({ title: 'Hola' })` |
| 143: rejects unknown bundles, compositions and invalid props; clamps a too-long duration | KEEP | [Historical six-bar row](project2.md); `expect(long.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED')` |
| 185: an mg-bundle cannot be placed with clip.place | KEEP | [Historical six-bar row](project2.md); `expect(errCode(r)).toBe('E_INVALID_PARAM')` |
| 191: renders at the sequence rate: a 25 fps composition in a 30 fps sequence is scaled and warned about | KEEP | [Historical six-bar row](project2.md); `expect(r.warnings.map((w) => w.code)).toContain('MG_FPS_MISMATCH')` |
| 204: param.set props.title validates against the schema: a number is rejected | KEEP | [Historical six-bar row](project2.md); `expect(clipOf(h, id).props).toEqual({ title: 'Edited' })` |
| 228: clip.update {props} replaces the override object; {} resets to defaults | KEEP | [Historical six-bar row](project2.md); `expect(clipOf(h, id).props).toEqual({ accent: '#00ff00' })` |
| 245: writes into nested values: array elements keep their siblings (inferred Badge schema) | KEEP | [Historical six-bar row](project2.md); `expect(clipOf(h, id).props).toEqual({ tags: ['fixture', 'edited'] })` |
| 269: cannot be trimmed beyond the composition; transitions get handles inside it | KEEP | [Historical six-bar row](project2.md); `expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED')` |
| 282: split keeps the composition content time continuous | KEEP | [Historical six-bar row](project2.md); `expect([a!.start, a!.duration, b!.start, b!.duration]).toEqual([30, 30, 60, 60])` |
| 294: accepts the new header and fingerprint without force | KEEP | [Historical six-bar row](project2.md); `expect(a.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: \`mk_${'b'.repeat(24)}\` })` |
| 323: carries effective props, bundle identity and composition metadata into the render snapshot | KEEP | [Historical six-bar row](project2.md); `expect(src.props).toEqual({ title: 'Snap', accent: '#ff3366', delay: 6 })` |
| 343: a composition missing from the bundle has info null (rendered as a card, MGC-014) | KEEP | [Historical six-bar row](project2.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 363: builds one spec per leaf from the schema, with hints, defaults and ParamPaths | KEEP | [Historical six-bar row](project2.md); `expect(specs.map((s) => [s.key, s.kind, s.ui.control])).toEqual([ ['props.title', 'string', 'text'], ['props.accent', 'string', 'color'], ['props.delay', 'number', 'scrub'], ])` |
| 386: nested objects become dotted keys; arrays and free-form values are json | KEEP | [Historical six-bar row](project2.md); `expect(specs.map((s) => [s.key, s.kind])).toEqual([ ['props.layout.x', 'number'], ['props.layout.align', 'enum'], ['props.items', 'json'], ['props.meta', 'json'], ['props.maybe', 'string'], ['props.mode…` |
| 419: validates the common keywords | KEEP | [Historical six-bar row](project2.md); `expect(validateJsonSchema(TITLE_SCHEMA, { title: 'x', accent: '#aabbcc', delay: 3 })).toEqual([])` |
| 441: infers a form schema from defaultProps | KEEP | [Historical six-bar row](project2.md); `expect(schema).toMatchObject({ type: 'object', properties: { text: { type: 'string' }, n: { type: 'integer' }, f: { type: 'number' }, on: { type: 'boolean' }, list: { type: 'array', items: { type: 'inte…` |
| 485: merges objects, replaces arrays; set/unset paths | KEEP | [Historical six-bar row](project2.md); `expect(mergeProps({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({ a: { b: 1, c: 3 }, l: [9], })` |
| 496: maps content time to composition frames and render ranges with handles | KEEP | [Historical six-bar row](project2.md); `expect(range).toEqual({ startFrame: 5, durationFrames: 45, layerStart: 95 })` |

## packages/project/test/derive-draft-index.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 11: sees clips added after an earlier command read it | CONSOLIDATE | [Fresh six-bar decision](project-core.md); `expect(result.ok ? 'ok' : result.errors).toBe('ok')` |

## packages/project/test/derive-draft.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 6: alternating clip.place and transition.add on the clips just placed | DELETE | [Fresh six-bar decision](project-core.md); `expect(h.spans('V1')).toEqual([0, 1, 2, 3, 4].map((g) => [g * 90, g * 90 + 90]))` |

## packages/project/test/document.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 23: the v1 fixture always loads without repairs | DELETE | [Fresh six-bar decision](project-core.md); `expect(r.repairs).toEqual([])` |
| 31: v1 → v2 relabels default-labelled audio halves of A/V clips and nothing else | DELETE | [Fresh six-bar decision](project-core.md); `expect(m.report).toEqual({ fromVersion: 1, toVersion: CURRENT_SCHEMA_VERSION, steps: ['v1→v2', 'v2→v3', 'v3→v4', 'v4→v5', 'v5→v6', 'v6→v7'], })` |
| 56: v1 → v2 keeps labels the user chose on audio clips | DELETE | [Fresh six-bar decision](project-core.md); `expect(Object.values(m.document.sequences)[0]!.clips[audio.id]!.label).toBe('rose')` |
| 64: the v2 fixture loads unchanged (v2 → … → v6 change no data it holds) and newer versions open read-only | DELETE | [Fresh six-bar decision](project-core.md); `expect(m.report.steps).toEqual(['v2→v3', 'v3→v4', 'v4→v5', 'v5→v6', 'v6→v7'])` |
| 85: AC-24: unknown effect id and unknown clip kind load, are bypassed, and survive edits and saves | KEEP | [Fresh six-bar decision](project-core.md); `expect(loaded.repairs).toEqual([])` |
| 146: AC-20: overlapping clips open with a repair report; the later clip moves to a new track | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.repairs.map((x) => x.action)).toContain('move-overlap')` |
| 161: drops dangling references and dissolves broken link groups | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.issues).toEqual([])` |

## packages/project/test/edit-structure.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 72: moves linked clips into a new sequence and replaces them with linked nest clips | KEEP | [Historical six-bar row](project3.md); `expect([nv!.start, nv!.duration]).toEqual([30, 90])` |
| 102: names nests Nested Sequence 01, 02… and places them on a free track | KEEP | [Historical six-bar row](project3.md); `expect(it0?.name).toBe('Nested Sequence 01')` |
| 116: moves transitions between nested clips and refuses a nesting cycle | KEEP | [Historical six-bar row](project3.md); `expect(Object.keys(h.doc.sequences[nid]!.transitions)).toHaveLength(1)` |
| 155: places a sequence as linked nest clips (default) honouring its In/Out | KEEP | [Historical six-bar row](project3.md); `expect(v!.kind).toBe('nest-video')` |
| 169: places a sequence as individual clips (nest: false), links and tracks kept | KEEP | [Historical six-bar row](project3.md); `expect(kinds).toEqual(['audio', 'text', 'video'])` |
| 187: places from the project item (bin drag) and refuses an empty sequence | KEEP | [Historical six-bar row](project3.md); `expect((r.results[0] as { clipIds: string[] }).clipIds).toHaveLength(2)` |
| 197: bounds trims of nest clips by the nested duration | KEEP | [Historical six-bar row](project3.md); `expect((t.results[0] as { deltaFrames: number }).deltaFrames).toBe(0)` |
| 208: restores the nested clips at their places (round trip) | KEEP | [Historical six-bar row](project3.md); `expect([v.start, v.duration, v.sourceIn, v.trackId]).toEqual([ before.v.start, before.v.duration, before.v.sourceIn, before.v.trackId, ])` |
| 231: refuses nests with speed, Motion or panning changes | KEEP | [Historical six-bar row](project3.md); `expect(bad.ok).toBe(false)` |
| 242: refuses nests with masks (wp masks: layer-space geometry cannot move onto the nested clips) | KEEP | [Historical six-bar row](project3.md); `expect(bad.ok).toBe(false)` |
| 255: embeds the nested snapshot with a transparent background and flattens nested audio | KEEP | [Historical six-bar row](project3.md); `expect([p.start, p.duration]).toEqual([40, 40])` |
| 284: composes nest speed with the nested clips and conforms other frame rates | KEEP | [Historical six-bar row](project3.md); `expect(inner30.settings.fps).toEqual({ num: 30, den: 1 })` |
| 310: clip.addAdjustment makes an adjustment clip whose snapshot source is the composite below | KEEP | [Historical six-bar row](project3.md); `expect(layer.source).toEqual({ adjustment: true })` |
| 324: groups select, move, delete and trim together (outer edges only) | KEEP | [Historical six-bar row](project3.md); `expect([...h.seq.groups[gid]!.members].sort()).toEqual([a!, t].sort())` |
| 351: duplicates a sequence with new ids and deletes sequences (nest references need force) | KEEP | [Historical six-bar row](project3.md); `expect(item.name).toMatch(/Copy$/)` |
| 375: Remove Unused removes media and synthetic items no clip uses | KEEP | [Historical six-bar row](project3.md); `expect((r.results[0] as { removed: string[] }).removed).toHaveLength(2)` |
| 417: nest, duplicate and Make Subsequence read the matching track of the new sequence | KEEP | [Historical six-bar row](project3.md); `expect(matteOf(h.doc, copy.id, copyFill.id)).toBe(copy.videoTracks[1]!.id)` |
| 434: a key whose track does not come along is cleared (W_TRACK_MATTE_CLEARED) | KEEP | [Historical six-bar row](project3.md); `expect(matteOf(h.doc, nid, fill)).toBe(h.doc.sequences[nid]!.videoTracks[1]!.id)` |
| 459: creates every kind with defaults and places Bars and Tone as linked video + tone | KEEP | [Historical six-bar row](project3.md); `expect(bars).toMatchObject({ toneHz: 1000, toneDb: -20 })` |
| 492: validates and updates params | KEEP | [Historical six-bar row](project3.md); `expect(h.doc.synthetics[id]).toMatchObject({ color: [0, 1, 0, 1] })` |
| 517: draws SMPTE RP 219 bars | KEEP | [Historical six-bar row](project3.md); `expect(at(10, 10)).toEqual([102, 102, 102, 255])` |
| 534: counts the leader down 8 → 2 with blips, then black | KEEP | [Historical six-bar row](project3.md); `expect(leaderPhaseAt(0.5)).toEqual({ phase: 'lead-in' })` |
| 552: generates the 1 kHz tone at the level and one-frame blips | KEEP | [Historical six-bar row](project3.md); `expect(peak).toBeCloseTo(0.1, 3)` |
| 573: Add Frame Hold splits at the playhead and holds the frame there | KEEP | [Historical six-bar row](project3.md); `expect(c.frameHold).toEqual({ flicks: 70 * F30 })` |
| 589: Insert Frame Hold Segment inserts a 2-second hold and ripples | KEEP | [Historical six-bar row](project3.md); `expect([seg.start, seg.duration]).toEqual([30, 60])` |
| 610: Frame Hold Options holds on In / Out / source time, with Hold Filters | KEEP | [Historical six-bar row](project3.md); `expect(h.seq.clips[v!]!.frameHold).toEqual({ flicks: 129 * F30, holdFilters: true })` |
| 629: finds and joins through edits (speed and reverse included) | KEEP | [Historical six-bar row](project3.md); `expect([j.start, j.duration, j.sourceIn]).toEqual([orig.start, orig.duration, orig.sourceIn])` |
| 654: does not treat different sources or discontinuous content as through edits | KEEP | [Historical six-bar row](project3.md); `expect(throughEdits(h.seq)).toHaveLength(0)` |
| 664: navigates gaps in the sequence and in tracks | KEEP | [Historical six-bar row](project3.md); `expect(sequenceGaps(seq)).toEqual([ { start: 0, end: 10 }, { start: 30, end: 50 }, ])` |
| 681: makes a subsequence trimmed to In/Out with links and transitions | KEEP | [Historical six-bar row](project3.md); `expect(v.map((c) => [c.start, c.duration])).toEqual([ [0, 20], [20, 60], ])` |
| 708: keeps the duration with repeated frames and tells the renderers which handle frames freeze | KEEP | [Historical six-bar row](project3.md); `expect(r.warnings.map((w) => w.code)).toContain('W_TRANSITION_FREEZE_FRAMES')` |
| 744: flags frame holds on adjustment layers and repairs nesting cycles | KEEP | [Historical six-bar row](project3.md); `expect( issues.some((i) => (i as { invariant?: string }).invariant === 'INV-009'), JSON.stringify(issues), ).toBe(true)` |
| 771: nest content keys ignore names and change with content | KEEP | [Historical six-bar row](project3.md); `expect(nestContentKey(h.doc, nid)).toBe(k0)` |

## packages/project/test/edit-ux-edit-props.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 215: random overwrite/insert/razor/extract/trim/ripple/split-edit ops never overlap or break invariants | KEEP | [Historical six-bar row](project3.md); `expect(stats.get(k)?.ok ?? 0, \`${k}: ${JSON.stringify(stats.get(k))}\`).toBeGreaterThan(20)` |
| 284: inserting a clip and extracting the same range restores every track frame for frame | KEEP | [Historical six-bar row](project3.md); `expect(after).toEqual(before)` |

## packages/project/test/edit-ux-match-trim.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 41: finds the topmost clip and the source frame; reverse match returns the sequence frame | KEEP | [Historical six-bar row](project2.md); `expect([m.sourceIn, m.sourceOut]).toEqual([300 * F, 360 * F])` |
| 57: reverse speed clips map back exactly | KEEP | [Historical six-bar row](project2.md); `expect(back.frame).toBe(10)` |
| 68: nearest edit points per track, roll pairs and sides | KEEP | [Historical six-bar row](project2.md); `expect(pts[0]).toEqual({ clipId: a!.id, edge: 'out', mode: 'roll' })` |

## packages/project/test/edit-ux-source-edit.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 23: source In/Out at the playhead; the sequence In wins over the playhead | KEEP | [Historical six-bar row](project1.md); `expect(span(v)).toEqual([100, 160])` |
| 41: backtiming: a sequence Out alone ends the edit there | KEEP | [Historical six-bar row](project1.md); `expect([r.at, r.frames]).toEqual([440, 60])` |
| 51: source Out + sequence In/Out backtimes the source | KEEP | [Historical six-bar row](project1.md); `expect(span(v)).toEqual([100, 150])` |
| 62: source In + sequence In/Out takes the sequence duration; too little media is refused | KEEP | [Historical six-bar row](project1.md); `expect(r.frames).toBe(50)` |
| 75: insert ripples the sequence once; overwrite does not | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 50], [50, 60], [60, 110], ])` |
| 98: without a choice the edit is refused | KEEP | [Historical six-bar row](project1.md); `expect(r.errors[0]!.message).toMatch(/fit/)` |
| 104: change-speed fits the source range into the sequence range (200%) | KEEP | [Historical six-bar row](project1.md); `expect(span(v)).toEqual([100, 130])` |
| 115: ignore-source-in / ignore-source-out | KEEP | [Historical six-bar row](project1.md); `expect(span(v)).toEqual([100, 130])` |
| 131: ignore-sequence-in / ignore-sequence-out | KEEP | [Historical six-bar row](project1.md); `expect(span(clipsOf(h, r.clipIds)[0]!)).toEqual([70, 130])` |
| 146: video and audio take their own source ranges, offset by the In difference (J cut) | KEEP | [Historical six-bar row](project1.md); `expect(span(v)).toEqual([215, 275])` |
| 168: Mark Split marks can be cleared | KEEP | [Historical six-bar row](project1.md); `expect(item.marks.split?.videoOut).toEqual(fl(50))` |
| 178: patching sends source tracks to other tracks or turns them off | KEEP | [Historical six-bar row](project1.md); `expect(clipsOf(h, r.clipIds).map((c) => c.kind)).toEqual(['audio'])` |
| 229: as a nest: one linked nest-video / nest-audio pair over the marked range | KEEP | [Historical six-bar row](project1.md); `expect([nv.start, nv.duration, nv.sourceIn]).toEqual([5, 60, 10 * F])` |
| 247: as individual clips: trimmed copies with their links | KEEP | [Historical six-bar row](project1.md); `expect(v.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([ [100, 10, 30 * F], [110, 10, 100 * F], ])` |
| 274: make, edit in, restrict trims, update and delete | KEEP | [Historical six-bar row](project1.md); `expect(h.doc.items[sub]).toMatchObject({ kind: 'subclip', name: 'Take 2', parentItemId: itemId })` |
| 317: ripple edit points on V1 and A1 (unlinked selection) ripple as one edit | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 65], [65, 125], ])` |
| 339: roll and regular points move in lockstep (the tightest limit wins) | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 20], [20, 120], ])` |
| 369: roll points on a picture and its linked sound roll once (not once per point) | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 66], [66, 120], ])` |

## packages/project/test/edit-ux-split-edits.test.ts

S02 extraction/common-gap editing. Public extract command refuses when tracks have no common closable interval.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 63: ${frames > 0 ? 'lengthening' : 'shortening'} keeps the early sound with its picture | KEEP | [Historical six-bar row](project1.md); `expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(frames)` |
| 80: is refused when the early sound has no room (sequence start, or a clip right before it) | KEEP | [Historical six-bar row](project1.md); `expect(r.ok).toBe(false)` |
| 108: clampToSyncLock stops a gesture at the room the early sound has | KEEP | [Historical six-bar row](project1.md); `expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(-36)` |
| 128: an In-edge ripple trim of the clip before an early sound moves it along with its picture | KEEP | [Historical six-bar row](project1.md); `expect(range(h, c.sound)).toEqual([48, 90])` |
| 146: a linked clip that ends before the cut is not a split edit and stays | KEEP | [Historical six-bar row](project1.md); `expect(range(h, early.sound)).toEqual([0, 6])` |
| 164: a J-cut clip closes one gap and later clips move once | KEEP | [Historical six-bar row](project1.md); `expect([start(h, c2.picture), start(h, c2.sound)]).toEqual([48, 36])` |
| 188: an L-cut clip keeps the next clip in sync | KEEP | [Historical six-bar row](project1.md); `expect([range(h, c2.picture)[1], range(h, c2.sound)[1]]).toEqual([96, 108])` |
| 204: a straight cut is unchanged | KEEP | [Historical six-bar row](project1.md); `expect([range(h, c3.picture), range(h, c3.sound)]).toEqual([ [48, 96], [48, 96], ])` |
| 214: two neighbours with a split edit between them close the whole gap | KEEP | [Historical six-bar row](project1.md); `expect([range(h, c4.picture), range(h, c4.sound)]).toEqual([ [48, 96], [48, 96], ])` |
| 227: straight cuts with sounds on alternating tracks close the whole gap | KEEP | [Historical six-bar row](project1.md); `expect(range(h, p[3]!.picture)).toEqual([48, 96])` |
| 239: a sound shorter than its picture with its neighbour right up against it closes only the sound stretch | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([[14, 24]])` |
| 269: refuses extraction when no common gap can close | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(r.errors[0]).toMatchObject({ code: 'E_INVALID_PARAM', blocking: [x, y] })` |
| 305: straight cut: later clips move by the change on both tracks | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([picture, later])` |
| 317: split edit: later material moves by the largest change on every track | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 60], [72, 102], ])` |

## packages/project/test/edit.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 32: AC-11a: trimming the head of a 50% speed clip by 10 frames advances sourceIn by 5 frames | KEEP | [Historical six-bar row](project1.md); `expect([c.start, c.duration]).toEqual([10, 290])` |
| 53: regular trims clamp at neighbours and media bounds with W_DURATION_CLAMPED | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 150], [150, 180], ])` |
| 81: trims linked partners with coincident edges | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([[0, 200]])` |
| 93: AC-11c: ripple trim shifts later clips on the track and sync-locked tracks | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 80], [80, 180], ])` |
| 106: AC-11c: content on a sync-locked track refuses the command (E_SYNC_CONFLICT) or stops the gesture | KEEP | [Historical six-bar row](project1.md); `expect(r.errors[0]!.blocking).toContain(blocker)` |
| 135: ripple lengthening splits straddling clips on sync-locked tracks | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 120], [120, 170], ])` |
| 151: splits linked partners, relinks right parts and copies keyframes with new ids | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 100], [100, 300], ])` |
| 179: AC-06: split + head trim keeps on-screen values identical | KEEP | [Historical six-bar row](project1.md); `expect(valueAt(f)).toBeCloseTo(before[f]!, 9)` |
| 212: AC-12a: razor all unlocked tracks at 500 skips locked tracks | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 500], [500, 1000], ])` |
| 239: S02 AC-1a: 500 random splits at 37% speed (29.97) re-join exactly | KEEP | [Historical six-bar row](project1.md); `expect(Math.abs(p.sourceIn - ideal)).toBeLessThan(64)` |
| 289: lift leaves a gap; extract closes it on sync-locked tracks | KEEP | [Historical six-bar row](project1.md); `expect(h.spans('V1')).toEqual([ [0, 100], [200, 300], ])` |
| 303: AC-13b: ripple delete is refused when a sync-locked track has content in the range | KEEP | [Historical six-bar row](project1.md); `expect(r.errors[0]!.blocking).toEqual([h.clips('V2')[0]!.id])` |
| 324: AC-07: 30 → 25 fps keeps adjacency, keeps keyframes on the picture and collapses 1-frame clips | KEEP | [Historical six-bar row](project1.md); `expect(h.seq.settings.frameRate).toEqual({ num: 25, den: 1 })` |
| 358: frame size change keeps offset from center (S01:SEQ-007) | KEEP | [Historical six-bar row](project1.md); `expect(t.transform.position.value).toEqual([100 - 320, 100 - 180])` |

## packages/project/test/essential-autotag.test.ts

S03 Essential Sound; S12 §2.1 / §4 / P6-R3 / P6-E12; sound-design Phase 0 and Phase 6→WP6.3 notes; public audio commands, validated saved settings, bed layout and dialogue extraction.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 45: tags untyped clips "auto" with the type defaults; undo leaves the document; redo is identical | REWRITE | [Fresh six-bar decision](project-core.md); `expect(r.results[0]).toEqual({ tagged: [ { clipId: a, audioType: 'music', confidence: 0.91, from: null }, { clipId: b, audioType: 'dialogue', confidence: 0.83, from: null }, ], skipped: [], })` |
| 78: never replaces a type the user set, unless force; the same type is SAME | KEEP | [Fresh six-bar decision](project-core.md); `expect((r.results[0] as { skipped: { code: string }[] }).skipped.map((s) => s.code)).toEqual([ 'USER_TYPE', 'SAME', ])` |
| 101: re-tags an auto clip: another type resets to its defaults, the same type keeps the settings | KEEP | [Fresh six-bar decision](project-core.md); `expect(essentialAutoTag(clip(a).essential)?.confidence).toBe(0.83)` |
| 117: Confirm = setType with the same type: the mark goes, settings and effects stay | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.results[0]).toMatchObject({ confirmed: [a] })` |
| 138: minConfidence skips weak results (LOW_CONFIDENCE); presets keep the mark; Clear Audio Type removes it | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.results[0]).toMatchObject({ tagged: [{ clipId: b }], skipped: [{ clipId: a, code: 'LOW_CONFIDENCE' }], })` |
| 169: refusals: unknown clip, not audio, locked track, empty / malformed / oversized results | KEEP | [Fresh six-bar decision](project-core.md); `expect(code({ results: { nope: music } })).toBe('E_NOT_FOUND')` |
| 188: an unreadable mark is reported and dropped by repair (the type and settings stay) | KEEP | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(fixed.document)).toEqual([])` |
| 206: auto-tagged dialogue is dialogue for dialogueSpans (whole clip without voice activity) | KEEP | [Fresh six-bar decision](project-core.md); `expect(dialogueSpans(h.doc, h.seq)).toEqual([])` |

## packages/project/test/essential.test.ts

S03 Essential Sound; S12 §2.1 / §4 / P6-R3 / P6-E12; sound-design Phase 0 and Phase 6→WP6.3 notes; public audio commands, validated saved settings, bed layout and dialogue extraction.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 44: settings: get/set with validation, presets clear on manual change, keys enumerate | KEEP | [Historical six-bar row](project1.md); `expect(s.repair.noise).toEqual({ on: true, amount: 10 })` |
| 63: presets are valid, unique per type, "(Default)" first, and every effect they call for exists | KEEP | [Historical six-bar row](project1.md); `expect(ps2!.options).toContain(v)` |
| 91: setType / set insert, update and remove ordinary effects in order; keyframes survive unrelated changes | KEEP | [Historical six-bar row](project1.md); `expect(ids()).toEqual(['rumble', 'deess', 'reverb', 'jasper.audio.delay'])` |
| 155: gain (Auto-Match), Clip Volume and pan change by deltas and are undone by Clear Audio Type | KEEP | [Historical six-bar row](project1.md); `expect(clip().gainDb).toBeCloseTo(7, 9)` |
| 180: Auto-Match skips an unmeasurable clip shorter than 400 ms as too short, not as silent | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(skipped).toMatch(/400 ms/)` |
| 190: the SFX type keeps the clip's own pan; Pan on/off and Clear Audio Type restore it | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(clip().pan.value).toBe(-50)` |
| 207: Clip Volume on/off restores levels the fader range clamped while it was on | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(clip().volumeDb.keyframes.map((k) => k.value)).toEqual(before)` |
| 229: a split keeps the clamp residual of keyframes on both halves (phase 0 verification) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(clip().volumeDb.keyframes.map((k) => k.value)).toEqual([15, 15])` |
| 248: a level the user moved after the clamp does not get the stale residual back (phase 0 verification) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(clip().volumeDb.value).toBe(15)` |
| 267: residual is not a setting: refused by key and not listed (phase 0 verification) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(() => setEssentialValue(s, 'residual.pan.value', 5)).toThrow(/not a setting/)` |
| 283: a hostile stored residual is bounded by the range width (phase 0 verification) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(Number.isFinite(clip().volumeDb.value)).toBe(true)` |
| 297: one out-of-range stored field does not reset the other Essential Sound settings | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(r.volume).toEqual({ on: true, levelDb: -4 })` |
| 320: applyPreset refuses invalid explicit settings instead of applying the defaults | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(clip().effects.map((e) => e.essential)).toContain('noise')` |
| 347: the loudness target is limited to −60…0 LUFS (Auto-Match cannot jump to +96 dB) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(setEssentialValue(newEssentialSound('sfx'), 'loudness.targetLufs', 500).loudness.targetLufs).toBe( 0, )` |
| 364: presets: built-ins by name, user settings, keeping loudness/volume/mute; mute is a Mute effect | KEEP | [Historical six-bar row](project1.md); `expect(s.loudness.gainDb).toBeCloseTo(3, 9)` |
| 384: refuses video clips, clips without a type and unknown keys | KEEP | [Historical six-bar row](project1.md); `expect(h.tx([{ type: 'essentialSound.setType', clipIds: [video], audioType: 'music' }]).ok).toBe(false)` |
| 407: Auto-Match gives the pieces of one remix ONE gain (their joints do not jump); other clips match on their own | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(gains[0]).toBeCloseTo(-23 - mean, 9)` |
| 433: replaces the clip by grouped pieces with crossfades, exact jump offsets; revert restores | KEEP | [Historical six-bar row](project1.md); `expect(list.map((c) => [c.start, c.duration])).toEqual([ [0, 123], [123, 117], [240, 120], ])` |
| 471: rounding of a cut shifts the next source start by the same amount (jumps stay whole beats) | KEEP | [Historical six-bar row](project1.md); `expect(a!.duration).toBe(120)` |
| 491: refuses overlaps, speed changes and linked clips | KEEP | [Historical six-bar row](project1.md); `expect(h.tx([{ type: 'clip.remix', clipId: id, targetFrames: 800, pieces, bpm: 120 }]).ok).toBe(false)` |
| 509: flags and repairs unreadable settings, stray essential markers and remix counts | KEEP | [Historical six-bar row](project1.md); `expect(checkInvariants(r2.document)).toEqual([])` |
| 563: loading keeps keyframed pan as saved; switching Pan off afterwards does not shift every keyframe | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(keys(clip())).toEqual([-50, 20, 50])` |
| 582: a command on such a clip before any load reads it the same way | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(keys(clip())).toEqual([-50, 20, 50])` |
| 592: a static pan the old build set to the Pan value reads as that offset (off gives 0, as the old build did) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(loaded.repairs).toEqual([])` |
| 605: a static pan moved after the old build wrote it stays where the user put it | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(loaded.repairs.map((r) => r.action)).toEqual(['migrate-essential-pan'])` |
| 616: settings with the marker are never migrated; the marker is not a setting | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(checkInvariants(h.doc)).toEqual([])` |
| 629: property: loading any old SFX Pan state changes nothing audible and leaves no issue | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(loaded.issues).toEqual([])` |
| 665: copy/paste and Save/Apply Preset carry audio effects with their keys; Essential markers are dropped | KEEP | [Historical six-bar row](project1.md); `expect(pasted.map((e) => e.effectId).sort()).toEqual(['jasper.audio.amplify', 'jasper.audio.dehummer'])` |
| 729: a remix of a Music clip writes its target and settings into Duration on every piece | KEEP | [Historical six-bar row](project1.md); `expect(s.duration).toMatchObject({ method: 'remix', targetSeconds: 12, segments: 20, variations: 50 })` |

## packages/project/test/fuzz-regressions.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 26: a reference named like an Object.prototype member is a missing reference, not a crash | KEEP | [Historical six-bar row](project2.md); `expect(r.issues).toEqual([])` |
| 36: a project id equal to an item id is replaced in place; the item keeps its id (FUZZ=1, verify) | KEEP | [Historical six-bar row](project2.md); `expect(r.issues).toEqual([])` |
| 47: record keys that disagree with ids, malformed and duplicate ids are repaired | KEEP | [Historical six-bar row](project2.md); `expect(r.issues).toEqual([])` |
| 61: an id named like a document field ("media") is replaced only where ids live | KEEP | [Historical six-bar row](project2.md); `expect(r.issues).toEqual([])` |
| 75: impossible settings, wrong track kinds, out-of-range opacity and clips past their media are repaired | KEEP | [Historical six-bar row](project2.md); `expect(r.issues).toEqual([])` |
| 90: data that is not a project fails with ProjectLoadError | KEEP | [Historical six-bar row](project2.md); `expect(() => load(bad)).toThrow(ProjectLoadError)` |
| 105: a group transform inside a degenerate (skewed) matrix is baked instead of recursing forever | KEEP | [Historical six-bar row](project2.md); `expect(r.contents.length).toBeGreaterThan(0)` |
| 111: malformed SVG path data throws SvgPathError | KEEP | [Historical six-bar row](project2.md); `expect(() => parseSvgPath('1 2')).toThrow(SvgPathError)` |
| 117: invalid UTF-8 and broken JSON in models are ModelParseErrors | KEEP | [Historical six-bar row](project2.md); `expect(() => parseModel(glb, 'glb')).toThrow(ModelParseError)` |

## packages/project/test/fuzz.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 506: holds for ${RUNS} random runs | KEEP | [Historical six-bar row](project4.md); `expect(accepted).toBeGreaterThan(0)` |

## packages/project/test/gaps-audio-channels.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 20: matrix ⇄ routing round trip, with silent clip channels | KEEP | [Historical six-bar row](project4.md); `expect(sourceChannels(a).map((r) => r.label)).toEqual([ 'Channel 1', 'Channel 2', 'Channel 3', 'Channel 4', ])` |
| 41: clip.setAudioChannels routes linked clips (undoable) and refuses what the media lacks | KEEP | [Historical six-bar row](project4.md); `expect((h.clips('A1')[0] as { channels: unknown }).channels).toEqual({ streamIndex: 1, map: [2, 3] })` |
| 63: a routed Project item places one clip per routed clip | KEEP | [Historical six-bar row](project4.md); `expect(audio.map((c) => c.channels.map).sort()).toEqual([[0], [1], [2, 3]])` |
| 88: repairs routings outside the media | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(document).filter((i) => i.invariant === 'INV-CHANNELS')).toEqual([])` |

## packages/project/test/gaps-display-format.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 16: formats frames, feet + frames and timecode | KEEP | [Historical six-bar row](project3.md); `expect(formatTimeDisplay(95, r30)).toBe('00:00:03:05')` |
| 23: parses entries in the display format | KEEP | [Historical six-bar row](project3.md); `expect(parseTimeDisplayEntry('120', r30, { ...ctx, display: 'frames' })).toBe(120)` |
| 32: round-trips every format (property) | KEEP | [Historical six-bar row](project3.md); shared assertion helper verifies the named semantic property |
| 44: audio time units | KEEP | [Historical six-bar row](project3.md); `expect(formatAudioTime(15, r30, 48000, 'samples')).toBe('00:00:00:24000')` |
| 51: reads defaults and repairs unreadable settings | KEEP | [Historical six-bar row](project3.md); `expect(projectSettingsOf(h.doc)).toEqual({ display: { video: 'timecode', audio: 'samples' }, scratch: { media: null }, ingest: { enabled: false, action: 'proxies', preset: null, destination: null }, })` |
| 85: refuses invalid settings through the command | KEEP | [Historical six-bar row](project3.md); `expect(r.ok).toBe(false)` |

## packages/project/test/gaps-find.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 29: operators | KEEP | [Historical six-bar row](project4.md); `expect(matchesOperator('Interview Wide', 'contains', 'view')).toBe(true)` |
| 38: finds project items by name, label, type and frame size with all/any | KEEP | [Historical six-bar row](project4.md); `expect(byName).toEqual([items[0]!.id])` |
| 79: finds timeline clips and markers in frame order and steps with Find Next | KEEP | [Historical six-bar row](project4.md); `expect(hits.map((x) => x.kind)).toContain('marker')` |
| 104: never throws on arbitrary queries (property) | KEEP | [Historical six-bar row](project4.md); shared assertion helper verifies the named semantic property |

## packages/project/test/gaps-graphics.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 40: rejects a malformed template payload before importing project items | KEEP | [Historical six-bar row](project4.md); `expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_SCHEMA', path: ['payload'] }] })` |
| 60: refuses layer pins on caption clips without changing the project | KEEP | [Historical six-bar row](project4.md); `expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] })` |
| 81: align / distribute offsets | KEEP | [Historical six-bar row](project4.md); `expect(alignOffsets(rects, 'left', frame).map((o) => o[0])).toEqual([-10, -300, -150])` |
| 97: responsive time keeps the intro and the outro | KEEP | [Historical six-bar row](project4.md); `expect(responsiveGraphicTime(150, 300, 150, 15, 15)).toBeCloseTo(75, 6)` |
| 103: roll from below to above the frame with pre-roll and post-roll | KEEP | [Historical six-bar row](project4.md); `expect(at(0)[1]).toBeCloseTo(1080 + 1500, 6)` |
| 141: commands: make a graphic, add layers, align, pin, undo, refusals | KEEP | [Historical six-bar row](project4.md); `expect((g() as { graphic?: unknown }).graphic).toEqual({ intro: 15, outro: 15, roll: null })` |
| 180: roll keys on the nest; dangling pins are reported and repaired | KEEP | [Historical six-bar row](project4.md); `expect((evaluate(pos, 0) as [number, number])[1]).toBeCloseTo(1080 + 540, 3)` |
| 211: .jgt templates round-trip a graphic | KEEP | [Historical six-bar row](project4.md); `expect(imported.graphic).toMatchObject({ intro: 15, outro: 15 })` |

## packages/project/test/gaps-proxies.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 27: sizes keep the aspect and never upscale | KEEP | [Historical six-bar row](project2.md); `expect(proxySize(3840, 2160, p720)).toEqual({ width: 1280, height: 720 })` |
| 34: checks duration, rate and orientation | KEEP | [Historical six-bar row](project2.md); `expect(proxyMismatch(orig, proxyOf({ seconds: 11 }).probe)).toMatch(/long/)` |
| 46: attach / detach are undoable commands with refusals | KEEP | [Historical six-bar row](project2.md); `expect(proxyKeyOf(h.doc.media[m])).toMatch(/^mk_/)` |
| 63: repairs unreadable proxies by detaching them | KEEP | [Historical six-bar row](project2.md); `expect(checkInvariants(broken).some((i) => i.invariant === 'INV-PROXY')).toBe(true)` |

## packages/project/test/gaps-sequence-format.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 6: display width of storage widths | KEEP | [Historical six-bar row](project4.md); `expect(displayWidthOf(720, { num: 10, den: 11 })).toBe(654)` |
| 12: a pixel aspect ratio makes width the display width; square restores the storage width; undoable | KEEP | [Historical six-bar row](project4.md); `expect(sequenceFormatOf(h.seq.settings)).toMatchObject({ storageWidth: 1440, par: { num: 4, den: 3 } })` |
| 38: New Sequence From Clip matches an anamorphic interlaced clip | KEEP | [Historical six-bar row](project4.md); `expect(sequenceFormatOf(seq.settings)).toMatchObject({ storageWidth: 1440, fieldOrder: 'upper' })` |
| 53: repairs an inconsistent format to square pixels | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(document).filter((i) => i.invariant === 'INV-SEQUENCE-FORMAT')).toEqual([])` |

## packages/project/test/gaps-warp-stabilizer.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 53: least squares recovers a homography and a similarity | KEEP | [Historical six-bar row](project4.md); `expect(hMaxDiff(leastSquares('homography', src, dst)!, h)).toBeLessThan(1e-6)` |
| 72: Smooth Motion removes jitter for every method; No Motion locks the scene | KEEP | [Historical six-bar row](project4.md); `expect(jitter(after)).toBeLessThan(0.2 * jitter(before))` |
| 92: framing crops, auto-scales and respects Maximum Scale | KEEP | [Historical six-bar row](project4.md); `expect(crop.autoScale).toBe(1)` |
| 136: Preserve Scale removes the zoom of the correction | KEEP | [Historical six-bar row](project4.md); `expect(Math.max(...zoomy.map((h) => Math.abs(scaleOf(h) - 1)))).toBeGreaterThan(0.005)` |
| 155: meshes: identity, homography meshes are exact for affine maps, forward inverts sample | KEEP | [Historical six-bar row](project4.md); `expect(m.sample([37, 21])).toEqual([37, 21])` |
| 168: solveMesh bends for local motion (banded solve) | KEEP | [Historical six-bar row](project4.md); `expect(errMesh).toBeLessThan(0.35 * errH)` |
| 190: Subspace Warp beats Perspective on parallax trajectories | KEEP | [Historical six-bar row](project4.md); `expect(persp).toBeLessThan(0.8 * before)` |
| 275: maps clip frames to analysed frames through the clip in-point and speed | KEEP | [Historical six-bar row](project4.md); `expect(mediaTimeAtClipFrame(a, 3, 30, { sourceInSeconds: 0.5, speed: 1, reverse: false })).toBeCloseTo( 0.6, )` |
| 284: effect.setWarpAnalysis stores, clears, undoes and refuses | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(h.doc)).toEqual([])` |

## packages/project/test/imports-formats.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 25: groups numbered stills, keeps padding apart and lists gaps | KEEP | [Historical six-bar row](project3.md); `expect(shot).toMatchObject({ first: 1, last: 4, padding: 4, missing: [], label: 'shot_[0001-0004].exr', pattern: 'shot_####.exr', })` |
| 62: a padded counter that outgrows its width stays one sequence | KEEP | [Historical six-bar row](project3.md); `expect(g[0]).toMatchObject({ first: 997, last: 10001 })` |
| 69: gaps hold the previous frame | KEEP | [Historical six-bar row](project3.md); `expect(g.missing).toEqual([3, 4])` |
| 75: preserves every distinct input frame or singleton (fuzz) | KEEP | [Historical six-bar row](project3.md); `expect(new Set(output.map(frameId))).toEqual(new Set(names.map(frameId)))` |
| 132: validates and describes a document | KEEP | [Historical six-bar row](project3.md); `expect(info).toMatchObject({ fps: 30, inFrame: 0, outFrame: 60, width: 200, height: 100, version: '5.7.4', layers: 2, })` |
| 162: samples frames like footage (floor, clamped to the last frame) | KEEP | [Historical six-bar row](project3.md); `expect(lottieFrameAt(info, 0)).toBe(10)` |
| 172: rejects or accepts arbitrary JSON without crashing (fuzz) | KEEP | [Historical six-bar row](project3.md); `expect(e).toBeInstanceOf(LottieParseError)` |
| 266: exports shapes, text and solids, warns about what Lottie cannot carry | KEEP | [Historical six-bar row](project3.md); `expect(json).toMatchObject({ v: '5.12.0', fr: 30, ip: 0, w: 1920, h: 1080 })` |
| 281: Bézier eases reproduce the keyframe evaluation (oracle) | KEEP | [Historical six-bar row](project3.md); `expect(lottieValueAt(keys, f)).toBeCloseTo(ours, 2)` |
| 299: pages of one file are different media; the same page again is deduplicated | KEEP | [Historical six-bar row](project3.md); `expect(ids[0]).not.toBe(ids[1])` |
| 361: maps Photoshop blend modes to ours | KEEP | [Historical six-bar row](project3.md); `expect(layeredBlendMode('linear-dodge')).toBe('add')` |
| 367: Sequence: one track per layer, positions, opacity, blend, visibility, clipping, isolated groups nested | KEEP | [Historical six-bar row](project3.md); `expect(notes).toEqual([])` |
| 407: Individual Layers: only the chosen layers, no sequence | KEEP | [Historical six-bar row](project3.md); `expect( Object.values(h.doc.media) .filter((m) => m.layerSource) .map((m) => m.layerSource!.name), ).toEqual(['Background', 'Circle'])` |
| 429: a clipped layer with nothing below it is noted | KEEP | [Historical six-bar row](project3.md); `expect(notes.join(' ')).toMatch(/clipped to nothing/)` |

## packages/project/test/imports-interpret.test.ts

S04 media interpretation and persisted pixel-variant protocol. Literal keys, supported alpha/field values and bounded decoded fields are caller-visible.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 38: parses typed frame rates, NTSC as 1001 fractions | KEEP | [Historical six-bar row](project3.md); `expect(rationalFromFps(23.976)).toEqual({ num: 24000, den: 1001 })` |
| 49: an assumed frame rate scales the duration; a loop multiplies it | KEEP | [Historical six-bar row](project3.md); `expect(interpretedFrameRate(a)).toEqual({ num: 24, den: 1 })` |
| 64: display size follows the pixel aspect ratio and the rotation | KEEP | [Historical six-bar row](project3.md); `expect(mediaDisplaySize(dv)).toEqual({ width: 655, height: 480 })` |
| 81: maps ffprobe field orders and lets the interpretation override them | KEEP | [Historical six-bar row](project3.md); `expect(fileFieldOrder(a)).toBe(want)` |
| 98: pixel variant keys preserve interpretation and safely parse arbitrary text (properties) | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(back?.alpha?.matte).toEqual(p.alpha.matte)` |
| 141: builds LGPL-only ffmpeg filters for each pixel interpretation | KEEP | [Historical six-bar row](project3.md); `expect(all[0]).toEqual(['bwdif=mode=send_frame:parity=tff:deint=all'])` |
| 159: file time pieces cover a range exactly and agree with fileTimeOf (property) | KEEP | [Historical six-bar row](project3.md); `expect(p.fileTo - p.fileFrom).toBeCloseTo((p.to - p.from) * scale, 6)` |
| 187: says what a browser needs to show the asset | KEEP | [Historical six-bar row](project3.md); `expect(browserPictureNeed(exr)).toEqual({ loader: null, picture: 'display', variant: '' })` |
| 226: sets, resets and normalises sections; the previous document is untouched (undo) | KEEP | [Historical six-bar row](project3.md); `expect(h.doc.media[m]!.interpretation).toEqual({ frameRate: { num: 60, den: 1 }, pixelAspect: { num: 2, den: 1 }, })` |
| 257: a faster assumed rate shortens the media and trims the clip with a warning | KEEP | [Historical six-bar row](project3.md); `expect(r.warnings.map((w) => w.code)).toContain('W_CLIPS_TRIMMED')` |
| 273: refuses what the media cannot carry and clips past the new end | KEEP | [Historical six-bar row](project3.md); `expect(bad({ frameRate: { num: 24, den: 1 } }).ok).toBe(false)` |
| 295: repair drops interpretation sections the media cannot carry | KEEP | [Historical six-bar row](project3.md); `expect(checkInvariants(fixed.document)).toEqual([])` |
| 315: the render snapshot carries the time map, the retime and the interpreted handle | KEEP | [Historical six-bar row](project3.md); `expect(c1.mediaTime).toEqual({ scale: 0.5 })` |

## packages/project/test/invariants-incremental.test.ts

S01 INV-001/INV-006, load/repair safety and ARCHITECTURE §13. Public invariant results must remain correct when unchanged sequences share identity.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 343: equals the full check on ${RUNS} random chains of edits and corruptions | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(start, opts)).toEqual([])` |
| 389: keeps the id index exact over long chains (past the flattening depth) | KEEP | [Historical six-bar row](project4.md); `expect(added.map((m) => m.name)).toEqual(Array.from({ length: 150 }, (_, i) => \`m${i}\`))` |

## packages/project/test/invariants-memo.test.ts

S01 INV-001/INV-006, load/repair safety and ARCHITECTURE §13. Public invariant results must remain correct when unchanged sequences share identity.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 30: detects duplicate clip IDs and removed media after checking shared sequences | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(checkInvariants(h.doc, { effects })).toEqual([])` |

## packages/project/test/json-cache.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 16: equals JSON.stringify on arbitrary JSON values, frozen or not, cold and cached | KEEP | [Historical six-bar row](project4.md); `expect(stringifyJson(v)).toBe(JSON.stringify(v))` |
| 27: equals JSON.stringify on large containers (composed) with every special value | KEEP | [Historical six-bar row](project4.md); `expect(stringifyJson(big)).toBe(JSON.stringify(big))` |
| 56: throws like JSON.stringify on cycles and BigInt | KEEP | [Historical six-bar row](project4.md); `expect(() => stringifyJson(cyc)).toThrow(TypeError)` |
| 65: never caches objects that can still change | KEEP | [Historical six-bar row](project4.md); `expect(stringifyJson(doc)).toBe(JSON.stringify(doc))` |
| 79: follows Immer edits of a frozen tree | KEEP | [Historical six-bar row](project4.md); `expect(stringifyJson(state)).toBe(JSON.stringify(state))` |

## packages/project/test/lumetri-grade.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 42: Faded Film lifts black and compresses white | KEEP | [Historical six-bar row](project4.md); `expect(b[0]).toBeCloseTo(0.12, 6)` |
| 48: Creative Saturation 0 gives grey at the same luma; 200 doubles the chroma | KEEP | [Historical six-bar row](project4.md); `expect(Y(g)).toBeCloseTo(Y(c), 9)` |
| 56: Shadow Tint colours the shadows, Highlight Tint the highlights; Tint Balance moves the pivot | KEEP | [Historical six-bar row](project4.md); `expect(dark[0] - dark[1]).toBeGreaterThan(0.1)` |
| 70: built-in looks stay bounded and mix by intensity | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(half[k]).toBeCloseTo(Math.min(1, Math.max(0, (samples[1]![k]! + full[k]!) / 2)), 1)` |
| 88: a look LUT takes precedence over the built-in look | KEEP | [Historical six-bar row](project4.md); `expect(out).toEqual([0, 0, 0])` |
| 104: neutral curves are the identity; periodic curves are continuous across red | KEEP | [Historical six-bar row](project4.md); `expect(f(0)).toBeCloseTo(0.3, 6)` |
| 142: Hue vs Sat desaturates only the chosen hue; greys are untouched | KEEP | [Historical six-bar row](project4.md); `expect(blue).toEqual([0.2, 0.2, 0.8].map((v) => expect.closeTo(v, 6)))` |
| 159: Hue vs Hue rotates a hue; Hue vs Luma brightens it; Luma vs Sat and Sat vs Sat scale saturation | KEEP | [Historical six-bar row](project4.md); `expect(hsl[0]).toBeGreaterThan(0.38)` |
| 214: eyedroppers add a centre point and two anchors at the picked value | KEEP | [Historical six-bar row](project4.md); `expect(r.points.map((p) => p[0])).toEqual([0, 0.4167, 0.5, 0.5833])` |
| 239: a section switched off acts as its defaults | KEEP | [Historical six-bar row](project4.md); `expect(run({ exposure: 1, fadedFilm: 50, creativeOn: false }, c)).toEqual(run({ exposure: 1 }, c))` |
| 263: HSL round trips and the wheel direction inverts | KEEP | [Historical six-bar row](project4.md); shared assertion helper verifies the named semantic property |
| 343: outputs stay finite and in 0..1 for any input and any section switches | KEEP | [Historical six-bar row](project4.md); shared assertion helper verifies the named semantic property |
| 351: a 33³ bake of a full grade with every new step takes < 30 ms (best of several runs) | KEEP | [Historical six-bar row](project4.md); `expect(best).toBeLessThan(budgetMs(30))` |
| 392: a keyframed amount that leaves the default at some key needs the stage | KEEP | [Historical six-bar row](project4.md); `expect(lumetriUsesSpatial(fx)).toBe(true)` |
| 422: any values of any params: the colour fn and the spatial settings never throw and stay finite | KEEP | [Historical six-bar row](project4.md); shared assertion helper verifies the named semantic property |

## packages/project/test/m2-contracts.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 35: the v3 fixture with a LUT, an mg-bundle, a tracker and a corner pin loads without repairs | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.repairs).toEqual([])` |
| 61: accepts, sorts and clamps control points | KEEP | [Fresh six-bar decision](project-core.md); `expect(clip.effects[0]!.params.curveMaster!.value).toEqual({ curve: [ [0, 0], [0.5, 0.6], [1, 1], ], })` |
| 85: rejects duplicate x, too few points and junk | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM')` |
| 109: parses what it serializes (3D) and ignores comments / vendor keywords | KEEP | [Fresh six-bar decision](project-core.md); `expect(back.dimensions).toBe(3)` |
| 120: the identity LUT is exact at lattice points and between them (tetrahedral) | DELETE | [Fresh six-bar decision](project-core.md); `expect(c[k]).toBeCloseTo(p[k]!, 6)` |
| 134: a baked function is reproduced within LUT precision; intensity mixes linearly | KEEP | [Fresh six-bar decision](project-core.md); `expect(half[k]).toBeCloseTo((p[k]! + got[k]!) / 2, 6)` |
| 146: 1D LUTs and domains | KEEP | [Fresh six-bar decision](project-core.md); `expect(c).toEqual([0.5, 0.25, 0.25])` |
| 153: reports malformed files with a line number | KEEP | [Fresh six-bar decision](project-core.md); `expect(() => parseCube('0 0 0\n')).toThrow(CubeParseError)` |
| 170: maps the unit square / a box onto a quad and back | KEEP | [Fresh six-bar decision](project-core.md); `expect(applyMat3(m, [0, 0])).toEqual([100, 50])` |
| 192: detects convex quads and writes CSS matrix3d | KEEP | [Fresh six-bar decision](project-core.md); `expect(isConvexQuad(q)).toBe(true)` |
| 199: a corner pin makes the scene resolver emit a projective map and the pinned quad | KEEP | [Fresh six-bar decision](project-core.md); `expect(p.quad[0][0]).toBeCloseTo(192, 6)` |

## packages/project/test/masks-commands.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 42: adds ellipse / polygon / pen masks to Opacity and to an effect, with Premiere defaults and names | KEEP | [Historical six-bar row](project3.md); `expect((v[1]!.p[0] - 0.5) * 1920).toBeCloseTo((v[2]!.p[1] - 0.5) * 1080, 6)` |
| 75: update, reorder, duplicate (new ids) and remove (empty list dropped) | KEEP | [Historical six-bar row](project3.md); `expect([m.mode, m.inverted, m.name, m.featherFalloff, m.locked]).toEqual([ 'subtract', true, 'Hole', 'linear', true, ])` |
| 114: mask properties are ParamPaths: param.set, stopwatch, keyframes, evaluation | KEEP | [Historical six-bar row](project3.md); `expect(mid.path.vertices[0]!.p[0]).toBeCloseTo(mk.path.keyframes[0]!.value.vertices[0]!.p[0] + 0.05, 9)` |
| 148: editPath: topology edits apply to every key; shape edits at the time; pen workflow | KEEP | [Historical six-bar row](project3.md); `expect(mk.path.keyframes.map((k) => k.value.vertices.length)).toEqual([4, 4])` |
| 217: setPathKeys writes tracking keys in one step and replaces a span | KEEP | [Historical six-bar row](project3.md); `expect(evaluate(m.path, 4.5 * F).vertices[0]!.p[0]).toBeCloseTo(base.vertices[0]!.p[0] + 0.045, 9)` |
| 251: split and duplicate give masks fresh ids; the snapshot carries them; locked tracks refuse edits | KEEP | [Historical six-bar row](project3.md); `expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([])` |
| 272: invariants flag broken masks and repair removes them | KEEP | [Historical six-bar row](project3.md); `expect(checkInvariants(document, { effects: defaultEffectRegistry })).toEqual([])` |
| 286: track mattes: the hidden matte track stays in the snapshot; cycles and own tracks are refused; repair clears | KEEP | [Historical six-bar row](project3.md); `expect(snap.videoTracks.map((t) => t.trackId)).not.toContain(v2)` |

## packages/project/test/multicam.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 118: In, Out, clip marker (named) and timecode give offsets relative to the reference | KEEP | [Historical six-bar row](project1.md); `expect(syncOffsets([a, b], 0, { method: 'in' })).toEqual([0, SEC])` |
| 146: timecode labels: NDF and drop-frame hours | KEEP | [Historical six-bar row](project1.md); `expect(tc.flicks).toBe(Math.round(107_892 * flicksPerFrame({ num: 30000, den: 1001 })))` |
| 159: common placements start at 0 and keep sub-frame sync in the source In | KEEP | [Historical six-bar row](project1.md); `expect(p[1]).toEqual({ start: 0, sourceIn: 0, frames: 300 })` |
| 180: builds one video track per camera, audio per source, angles, names and sync by In | KEEP | [Historical six-bar row](project1.md); `expect(mc.angles.map((a) => a.name)).toEqual(['A Cam', 'B Cam', 'C Cam', 'Recorder'])` |
| 220: enumerates camera names, honours an explicit order, a preset and the Processed Clips bin | KEEP | [Historical six-bar row](project1.md); `expect(mc.angles.map((a) => a.name)).toEqual(['Camera 1', 'Camera 2', 'Camera 3'])` |
| 237: needs a camera; audio sync needs offsets | KEEP | [Historical six-bar row](project1.md); `expect(h.tx([{ type: 'multicam.create', itemIds: [a.itemId], method: 'in' }]).ok).toBe(false)` |
| 263: places linked multi-camera video and audio clips showing camera 1 | KEEP | [Historical six-bar row](project1.md); `expect(v).toMatchObject({ kind: 'nest-video', sequenceId, start: 10, multicam: { enabled: true, angle: mc.angles[0]!.id }, })` |
| 291: renders through the nest: only the active angle’s track, outer effects and Motion on top | KEEP | [Historical six-bar row](project1.md); `expect(layers.map((l) => l.clipId)).toEqual([video])` |
| 334: a disabled multi-camera clip renders the nested composite | KEEP | [Historical six-bar row](project1.md); `expect(nest.snapshot.videoTracks.flatMap((t) => t.clips)).toHaveLength(3)` |
| 348: audio follows the source’s audio mode: camera 1, all cameras, switch | KEEP | [Historical six-bar row](project1.md); `expect(played()).toEqual([mediaOfTrack(mc.angles[0]!.audioTrackIds[0]!)])` |
| 379: changes in the source sequence (adjusting sync) are reflected | KEEP | [Historical six-bar row](project1.md); `expect(after.contentTime).toBe(before.contentTime - 3 * F30)` |
| 413: at the playhead switches the whole clip (and its audio); a range adds edits; same angle heals | KEEP | [Historical six-bar row](project1.md); `expect(anglesOn(h, 'V1')).toEqual([[0, len, mc.angles[1]!.id]])` |
| 431: a recording pass applies all cuts as one transaction; pressing the shown angle adds no edit | KEEP | [Historical six-bar row](project1.md); `expect(anglesOn(h, 'V1')).toEqual([ [0, 10, mc.angles[0]!.id], [10, 40, mc.angles[1]!.id], [40, 90, mc.angles[2]!.id], [90, 120, mc.angles[1]!.id], [120, len, mc.angles[0]!.id], ])` |
| 464: camera numbers follow Edit Cameras: hidden angles are skipped, order and names change | KEEP | [Historical six-bar row](project1.md); `expect(next.angles.map((a) => a.name)).toEqual(['Camera 3', 'Wide', 'Camera 2'])` |
| 487: replaces multi-camera clips by the angle’s clips; every frame draws the same picture | KEEP | [Historical six-bar row](project1.md); `expect(audio(after)).toEqual(audio(before))` |
| 526: composes Motion with a scaled angle (a 4K camera fitted into a 1080 source), keyframes re-timed | KEEP | [Historical six-bar row](project1.md); `expect((inner4k as { transform: { scale: { value: number } } }).transform.scale.value).toBe(50)` |
| 556: flattens reversed and 2× clips exactly; refuses frame holds | KEEP | [Historical six-bar row](project1.md); `expect(r.warnings.some((w) => /frame hold/.test(w.message))).toBe(true)` |
| 583: composes an animated angle Motion by sampling (rotation + non-uniform outer scale warns about skew) | KEEP | [Historical six-bar row](project1.md); shared assertion helper verifies the named semantic property |
| 626: aligns clips by In, timecode, clip marker or audio offsets; linked clips move together | KEEP | [Historical six-bar row](project1.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 675: merges a video and external audio, removes the camera audio on request and places synced clips | KEEP | [Historical six-bar row](project1.md); `expect(h.doc.items[res.itemId]).toMatchObject({ name: 'Interview - Merged', kind: 'sequence' })` |
| 718: keeps the camera audio by default and takes up to 16 audio clips | KEEP | [Historical six-bar row](project1.md); `expect( h.tx([{ type: 'item.mergeClips', itemIds: [v.itemId, ...auds.map((a) => a.itemId)], method: 'in' }]).ok, ).toBe(false)` |
| 734: removing an angle’s tracks prunes the angle and re-points clips; repair fixes hand-broken data | KEEP | [Historical six-bar row](project1.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 766: source clip markers live on media items | KEEP | [Historical six-bar row](project1.md); `expect((h.doc.items[v.itemId] as { markers: { name: string; flicks: number }[] }).markers).toMatchObject([ { name: 'b', flicks: 2 * SEC }, ])` |

## packages/project/test/nest-shorten.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 20: lifting the last clip inside the nest is allowed; the nest clip keeps its length | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(document)).toEqual([])` |
| 56: deleting media used only inside the nest is allowed | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(h.doc)).toEqual([])` |

## packages/project/test/normalizers-delta.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 5: keep a synthetic its project item still uses when its last clip goes | KEEP | [Historical six-bar row](project3.md); `expect(h.doc.synthetics[(item as { syntheticId: string }).syntheticId]).toBeDefined()` |

## packages/project/test/perf-budgets.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 35: resolveSceneAt with 50 layers < 1 ms | KEEP | [Historical six-bar row](project1.md); `expect(resolveSceneAt(snap, 10)).toHaveLength(50)` |
| 62: render bar of a 1 000-clip sequence < 120 ms | KEEP | [Historical six-bar row](project1.md); `expect(ms).toBeLessThan(budgetMs(120))` |

## packages/project/test/place-move.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 14: AC-02: places linked V1/A1 clips from a 10 s stereo video | KEEP | [Historical six-bar row](project2.md); `expect([v!.sourceIn, v!.duration, a!.duration]).toEqual([0, 300, 300])` |
| 36: keeps the last frame of media whose probed duration is rounded to microseconds | KEEP | [Historical six-bar row](project2.md); `expect(h.seq.clips[whole.created[0]!]!.duration).toBe(58)` |
| 58: DT-021: linked A/V halves get the Movie label on video and the Audio label on audio | KEEP | [Historical six-bar row](project2.md); `expect(h.clips('V1').map((c) => c.label)).toEqual(['violet'])` |
| 77: DT-021: a label the user chose for the item applies to both halves | KEEP | [Historical six-bar row](project2.md); `expect(h.clips('V1').map((c) => c.label)).toEqual(['rose'])` |
| 88: AC-03: overwrite into the middle splits the linked clips around it | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([ [0, 120], [120, 180], [180, 300], ])` |
| 112: AC-04: insert shifts every sync-locked track and splits straddling clips | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([ [0, 60], [60, 120], [120, 360], ])` |
| 135: locked tracks are untouched by inserts (ARCHITECTURE §2.3) | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V2')).toEqual([[0, 100]])` |
| 143: video V2 places audio on A2 and creates missing tracks (S02 AC-10c) | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V4')).toEqual([[0, 60]])` |
| 153: refuses a locked destination and wrong track kinds | KEEP | [Historical six-bar row](project2.md); `expect(r.ok).toBe(false)` |
| 165: default scaling fits larger media and keeps smaller media at 100 (S01:FX-004) | KEEP | [Historical six-bar row](project2.md); `expect(b!.transform.anchor.value).toEqual([1920, 1080])` |
| 181: dedupes media by fingerprint (S01 media.register) | KEEP | [Historical six-bar row](project2.md); `expect(r2.warnings.map((w) => w.code)).toContain('W_DEDUPED')` |
| 215: AC-10a: overwrite move trims the clip underneath and leaves a gap at the origin | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([ [0, 150], [150, 250], [250, 300], ])` |
| 229: AC-10b: insert move shifts all sync-locked unlocked tracks and splits straddlers | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([ [0, 300], [300, 360], [360, 660], ])` |
| 259: moves linked clips as a block and refuses missing tracks without createTracks | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([[10, 70]])` |

## packages/project/test/polish-poster.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 20: sets the poster frame in content time (flicks, seconds or source frames), and clears it | KEEP | [Historical six-bar row](project1.md); `expect(poster(h, itemId)).toEqual({ flicks: 45 * F })` |
| 36: refuses a frame past the end of the media, other item kinds and unknown items | KEEP | [Historical six-bar row](project1.md); `expect( refused(h, [{ type: 'item.setPoster', itemId, time: { seconds: -1 } } as never]).errors[0]!.code, ).toMatch(/E_/)` |

## packages/project/test/previews.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 48: cut at every clip edge; gaps give no segment | KEEP | [Historical six-bar row](project4.md); `expect(s.map((x) => [x.startFrame, x.frames])).toEqual([ [0, 60], [60, 30], [120, 60], ])` |
| 64: an untouched clip at the sequence size and rate has no bar; Motion, effects and stacks do | KEEP | [Historical six-bar row](project4.md); `expect(byStart(s, 0).reasons).toEqual([])` |
| 80: an edit changes only the segments that show the edited clip; undo restores them | KEEP | [Historical six-bar row](project4.md); `expect(after.slice(0, 2).map((x) => x.hash)).toEqual(before.slice(0, 2).map((x) => x.hash))` |
| 91: names, labels and markers do not change pixels; renaming a clip with effects does (Clip Name burn-ins) | KEEP | [Historical six-bar row](project4.md); `expect(hashes(segs(h.doc, h.seqId))).toEqual(before)` |
| 105: identical plain clips share a hash anywhere; seeded clips (effects) keep their identity | KEEP | [Historical six-bar row](project4.md); `expect(s).toHaveLength(2)` |
| 121: a muted or hidden track, a new empty track and the audio mix leave the picture hashes alone | KEEP | [Historical six-bar row](project4.md); `expect(hashes(segs(h.doc, h.seqId))).toEqual(before)` |
| 131: media content counts, not URLs: another fingerprint invalidates | KEEP | [Historical six-bar row](project4.md); `expect(after[i]).not.toBe(before[i])` |
| 140: sequence settings count | KEEP | [Historical six-bar row](project4.md); `expect(hashes(segs(doc, h.seqId))[0]).not.toBe(before[0])` |
| 148: adjustment layers: an edit below the adjustment invalidates the segments it covers | KEEP | [Historical six-bar row](project4.md); `expect(before).toHaveLength(1)` |
| 161: nested sequences: edits inside the frames shown invalidate, edits outside them do not | KEEP | [Historical six-bar row](project4.md); `expect(before).toHaveLength(1)` |
| 181: expressions: a segment whose layers read time is absolute; other segments ignore expressions | KEEP | [Historical six-bar row](project4.md); `expect(byStart(s0, 130).absolute).toBe(true)` |
| 197: Track Matte Keys read a hidden track: editing the matte invalidates; moving everything keeps | KEEP | [Historical six-bar row](project4.md); `expect(before).toHaveLength(1)` |
| 222: captions are part of the picture: text edits invalidate, moving keeps | KEEP | [Historical six-bar row](project4.md); `expect(s0.map((x) => x.startFrame)).toEqual([0, 30, 60])` |
| 237: 3D: a camera edit invalidates the segments it is on | KEEP | [Historical six-bar row](project4.md); `expect(after[0]!.hash).not.toBe(before[0]!.hash)` |
| 250: time remapping changes the picture | KEEP | [Historical six-bar row](project4.md); `expect(after[0]!.hash).not.toBe(before[0]!.hash)` |
| 262: property: moving the whole timeline by any offset keeps the hashes; any param edit on one clip changes only its segments | KEEP | [Historical six-bar row](project4.md); `expect(hashes(moved)).toEqual(hashes(before))` |
| 291: cut at audio clip edges; ripple keeps hashes; a level change invalidates only that clip | KEEP | [Historical six-bar row](project4.md); `expect(moved.map((s) => s.hash)).toEqual(before.map((s) => s.hash))` |
| 311: sets format, size and quality in one undoable step; defaults apply at read time; bad values refuse | KEEP | [Historical six-bar row](project4.md); `expect(previewSettingsOf(h.seq)).toEqual({ format: 'h264-iframe', size: 'full', quality: 'standard' })` |
| 324: repair resets unreadable preview settings | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(document).filter((i) => i.invariant === 'INV-PREVIEWS')).toEqual([])` |

## packages/project/test/process-rescale.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 231: keeps the rendered framing identical (matrix, cropped quad, tracker points) for any size change | KEEP | [Historical six-bar row](project3.md); shared assertion helper verifies the named semantic property |

## packages/project/test/process.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 78: adds the asset and its item in a "Processed" bin next to the original bin, and swaps clips in one transaction | KEEP | [Historical six-bar row](project3.md); `expect(res.clipIds).toEqual([videoId])` |
| 144: is idempotent: the same file (or the same recipe of the same source) is reused, the swaps still happen | KEEP | [Historical six-bar row](project3.md); `expect(second).toMatchObject({ mediaId: first.mediaId, itemId: first.itemId, deduped: true })` |
| 192: puts the bin at the root when the original bin is at the root; binId overrides | KEEP | [Historical six-bar row](project3.md); `expect(mine.kind === 'bin' && mine.children).toEqual([res.itemId])` |
| 221: an original item at the project root gets a "Processed" bin at the root | KEEP | [Historical six-bar row](project3.md); `expect(h.doc.rootItems).toContain(res.binId)` |
| 237: refuses without an engine asset, for unknown or non-video sources, and rolls back failed swaps | KEEP | [Historical six-bar row](project3.md); `expect(codeOf(noAsset)).toBe('E_INVALID_PARAM')` |
| 290: follows derivation chains: every version of the same original is a valid target | KEEP | [Historical six-bar row](project3.md); `expect(mediaVersionsOf(h.doc, up)).toEqual([mediaId, up, up2])` |
| 296: keeps keyframes, markers and trackers (tracker geometry in media pixels follows the size) | KEEP | [Historical six-bar row](project3.md); `expect(c.transform.scale.keyframes.map((k) => k.value)).toEqual([50, 100])` |
| 367: is a no-op for the current media and refuses unrelated media, non-video clips, missing ids and locked tracks | KEEP | [Historical six-bar row](project3.md); `expect(same.results[0]).toMatchObject({ changed: false })` |

## packages/project/test/proposals-preview-batch.test.ts

S12 §2.5 / P3-R1 / P3-R4; ARCHITECTURE D-51; sound-design “Model” and preview notes. Public create/validate/compose/decide/preview and seeded-ID APIs.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 131: same document, items applied, failures and per-item ghosts (random proposals, invariant check on and off) | KEEP | [Fresh six-bar decision](project-core.md); `expect(got.applied).toEqual(ref.applied)` |
| 160: reuses the shared prefix of a preview of the same document (what Hear plays after a reject) | REWRITE | [Fresh six-bar decision](project-core.md); `expect(reused.r.applied).toEqual(fresh.r.applied)` |
| 184: an item naming a clip only as a key (applyGains gains) keeps its ghost when another item names it by value | KEEP | [Fresh six-bar decision](project-core.md); `expect(ref.items.gain!.changed).toContain(audio)` |
| 202: 120 items, two of which add a marker with one id: the later one fails with the issue, the rest apply | REWRITE | [Fresh six-bar decision](project-core.md); `expect(Object.keys(r.failed)).toEqual(['i101'])` |

## packages/project/test/proposals-preview-ids.test.ts

S12 §2.5 / P3-R1 / P3-R4; ARCHITECTURE D-51; sound-design “Model” and preview notes. Public create/validate/compose/decide/preview and seeded-ID APIs.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 21: gives the same well-formed ids for the same seed and different ones for another | REWRITE | [Fresh six-bar decision](project-core.md); `expect(ids1).toEqual(ids2)` |
| 37: does not repeat within a long stream | KEEP | [Fresh six-bar decision](project-core.md); `expect(seen.size).toBe(20_000)` |
| 68: keeps an item's created ids whatever other items are applied | KEEP | [Fresh six-bar decision](project-core.md); `expect(all.items.c!.created).toEqual(onlyC.items.c!.created)` |
| 79: uses ctx.ids (random by default) without idsFor | KEEP | [Fresh six-bar decision](project-core.md); `expect(x.items.a!.created).not.toEqual(y.items.a!.created)` |

## packages/project/test/proposals.test.ts

S12 §2.5 / P3-R1 / P3-R4; ARCHITECTURE D-51; sound-design “Model” and preview notes. Public create/validate/compose/decide/preview and seeded-ID APIs.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 92: validates every item by dry run, records anchors, the base revision and the document hash | KEEP | [Fresh six-bar decision](project-core.md); `expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending'])` |
| 116: marks an item whose commands fail invalid with the reason, and the items requiring it too | REWRITE | [Fresh six-bar decision](project-core.md); `expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'invalid'])` |
| 130: marks the later of two items that only conflict together invalid (one transaction must apply) | REWRITE | [Fresh six-bar decision](project-core.md); `expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'pending'])` |
| 140: resolves addressing forms against the document and stores ids | KEEP | [Fresh six-bar decision](project-core.md); `expect(p.items[0]!.state).toBe('pending')` |
| 161: refuses malformed drafts with typed issues and never throws | KEEP | [Fresh six-bar decision](project-core.md); `expect(codes({ items: [] })).toEqual(['E_SCHEMA'])` |
| 223: takes the dependency closure in proposal order as ONE transaction "Accept <title> (n of m)" | KEEP | [Fresh six-bar decision](project-core.md); `expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending'])` |
| 254: uses the refs an earlier accept defined, skips accepted items and applies the selected alternative | KEEP | [Fresh six-bar decision](project-core.md); `expect(p.items[0]!.applied).toEqual({ revision: h.revision, refs: { $sfx: trackId }, at: NOW })` |
| 287: refuses unknown and invalid items (also through requires) and more commands than one transaction | REWRITE | [Fresh six-bar decision](project-core.md); `expect(bad.ok ? [] : bad.errors.map((e) => e.code)).toEqual(['E_NOT_FOUND'])` |
| 311: an anchored item goes stale when its clip moves or is deleted, and pending again when it is back | REWRITE | [Fresh six-bar decision](project-core.md); `expect(moved.stale).toEqual([ { itemId: 'a', reason: expect.stringMatching(/^The clip( “[^”]*”)? at 00:00:00:00 moved to 00:00:00:12$/), problem: expect.objectContaining({ type: 'anchor', id: clipId, en…` |
| 353: an item whose commands stop applying goes stale, and so do the items requiring it | REWRITE | [Fresh six-bar decision](project-core.md); `expect(r.proposal.items.map((i) => i.state)).toEqual(['stale', 'stale'])` |
| 375: planAccept is all-or-nothing, or with partial applies the rest and reports the stale items | KEEP | [Fresh six-bar decision](project-core.md); `expect(strict.errors.map((e) => [e.itemId, e.code])).toEqual([ ['a', 'E_STALE'], ['c', 'E_STALE'], ])` |
| 404: an item that newly conflicts with the others is found by the dry run of the composed set | KEEP | [Fresh six-bar decision](project-core.md); `expect(partial.composed.itemIds).toEqual(['b'])` |
| 418: entities an accepted item changed are not anchors of the proposal's later items | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.proposal.items.map((i) => i.state)).toEqual(['accepted', 'pending'])` |
| 433: reject, note, select and reopen change the proposal only; an accepted item cannot be rejected | KEEP | [Fresh six-bar decision](project-core.md); `expect(rj.changed).toEqual(['b'])` |
| 480: proposalGhost lists created, changed and deleted entities, down to the effects inside a clip | KEEP | [Fresh six-bar decision](project-core.md); `expect(g.changed).toContain(clipId)` |
| 503: previewProposal applies items one by one on a copy, with per-item ghosts and failures | KEEP | [Fresh six-bar decision](project-core.md); `expect(pv.applied).toEqual(['t', 'm', 'k'])` |
| 575: accepting A then B equals accepting A ∪ B (A before B in proposal order) | KEEP | [Fresh six-bar decision](project-core.md); `expect(twoSteps.pp.items.map((i) => i.state)).toEqual(oneStep.pp.items.map((i) => i.state))` |
| 616: rejecting leaves the document identical; accepting the rest equals never having had the rejected items | KEEP | [Fresh six-bar decision](project-core.md); `expect(c.itemIds).toEqual(dependencyClosure(r.proposal, pending).map((i) => i.id))` |
| 640: compose is deterministic and the closure is minimal and closed | KEEP | [Fresh six-bar decision](project-core.md); `expect(closure).toContain(s)` |
| 696: never throws on fuzzed drafts and proposals; problems are typed | REWRITE | [Fresh six-bar decision](project-core.md); `expect(e.code).toMatch(/^E_[A-Z_]+$/)` |
| 765: an agent granting itself "Allow agents to apply sound proposals" needs the user\'s approval | REWRITE | [Fresh six-bar decision](project-core.md); `expect( approvalReasons({ commands: [{ type: 'soundDesign.setSettings', agentsMayApply: true }] }), ).toEqual([ 'agentsMayApply: true in soundDesign.setSettings (command 1) lets agents apply sound propo…` |

## packages/project/test/registry-validation.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 11: reports a thrown %s without throwing from the validator | KEEP | [Historical six-bar row](project2.md); `expect(validate(false)).toEqual([])` |

## packages/project/test/reidentify-children.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 21: splitting and duplicating an animated title gives its animators and selectors new ids | DELETE | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 37: splitting a clip with Puppet pins gives meshes and pins new ids; pins follow their mesh | DELETE | [Fresh six-bar decision](project-core.md); `expect(p.id).toMatch(/^ppn_/)` |

## packages/project/test/render.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 29: anchor lands on position | KEEP | [Historical six-bar row](project1.md); `expect(p[0]).toBeCloseTo(960, 9)` |
| 38: rotates clockwise on screen (y-down) | KEEP | [Historical six-bar row](project1.md); `expect(p[0]).toBeCloseTo(0, 9)` |
| 44: non-uniform scale: Scale is vertical, Scale Width horizontal (S01:FX-001) | KEEP | [Historical six-bar row](project1.md); `expect(applyMatrix(m, [10, 10])).toEqual([5, 20])` |
| 55: quad, bounds and inverse are consistent; crop hides without moving | KEEP | [Historical six-bar row](project1.md); `expect(back[0]).toBeCloseTo(200, 9)` |
| 76: builds tracks bottom→top, resolves mute/solo/output and evaluates layers per frame | KEEP | [Historical six-bar row](project1.md); `expect(snap.videoTracks.map((t) => t.clips.length)).toEqual([1, 1])` |
| 120: limits the snapshot to an export range | KEEP | [Historical six-bar row](project1.md); `expect(snap.videoTracks[0]!.clips).toHaveLength(1)` |
| 134: preserves track order, clip sorting and full duration for interleaved document clips | KEEP | [Historical six-bar row](project1.md); `expect(snap.videoTracks.map((t) => t.trackId)).toEqual(seq.videoTracks.map((t) => t.id))` |

## packages/project/test/reversed-paste.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 68: paste attributes: every frame matches the source at the same offset (frames exact, eases mirrored) | KEEP | [Historical six-bar row](project1.md); `expect(valueAt(h, dst, j)).toBeCloseTo(valueAt(h, src, j), 6)` |
| 85: keyframe.paste onto a reversed clip mirrors the eases too | KEEP | [Historical six-bar row](project1.md); `expect(valueAt(h, dst, j)).toBeCloseTo(valueAt(h, src, j), 6)` |

## packages/project/test/roto.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 53: roto.add with a stroke sets the base and the default span (the source frames the clip shows) | KEEP | [Historical six-bar row](project4.md); `expect(out.span).toEqual([30, 89])` |
| 85: points become one-point strokes; a box selects; background strokes do not set the base | KEEP | [Historical six-bar row](project4.md); `expect(roto.strokes[0]).toMatchObject({ kind: 'bg', radius: 11, points: [[10, 10]] })` |
| 100: refuses bad input: kinds, empty boxes, spans, frozen edits, unknown rotos | KEEP | [Historical six-bar row](project4.md); `expect(r.ok).toBe(false)` |
| 134: results go stale when inputs change and fresh again on undo-equivalent inputs | KEEP | [Historical six-bar row](project4.md); `expect(rotoIsStale(clip().rotos![0]!)).toBe(false)` |
| 158: roto.apply adds a bound Object Matte / Object Blur once; roto.remove removes them | KEEP | [Historical six-bar row](project4.md); `expect(again).toMatchObject({ effectInstanceId: a.effectInstanceId, created: false })` |
| 185: the snapshot carries every roto with its span; frame states | KEEP | [Historical six-bar row](project4.md); `expect(m0).toMatchObject({ key: null, url: null, span: [30, 89] })` |
| 219: split / duplicate copy rotos with new ids and rebind the copies’ effects | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([])` |
| 233: pasted effects naming a roto the target lacks are reset to none | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([])` |
| 256: invariants catch dangling references; repairs fix them | KEEP | [Historical six-bar row](project4.md); `expect(issues).toContain('INV-006')` |
| 272: roto.faceTracker turns a tracked face into a planar tracker and applies it as transform keys | KEEP | [Historical six-bar row](project4.md); `expect(roto).toMatchObject({ kind: 'faces', name: 'Faces 1', base: 30 })` |
| 312: fnv64 is stable | KEEP | [Historical six-bar row](project4.md); `expect(fnv64('')).toBe('cbf29ce484222325')` |
| 319: export checks the media frames the remapped picture shows, not the linear content frames | KEEP | [Historical six-bar row](project4.md); `expect(rotoExportIssues(snap())[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] })` |

## packages/project/test/scene-edit-frames.test.ts

S04 scene edit detection; S12 P6-R2 / WP6.5b item 9. Public clip.applySceneEdits and sceneCutCues must land at the shown-frame boundary, including microsecond-rounded source timestamps.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 104: ${mediaLabel} media in a ${seqLabel} sequence at ${speedLabel} | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(edits).toEqual(want)` |
| 136: counts a change from the renderers’ frame-time tolerance on | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(SHOT_TIME_EPS).toBe(2e-6)` |

## packages/project/test/scene-props.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 36: preserves animated %s across forward and backward seeks | KEEP | [Historical six-bar row](project3.md); `expect(props.opacity).toBeCloseTo(frame, 9)` |

## packages/project/test/schema-history.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 58: schema v${v} loads, migrates to v${CURRENT_SCHEMA_VERSION} and passes the invariants without repairs | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.migration.steps).toEqual(VERSIONS.slice(v - 1, -1).map((from) => \`v${from}→v${from + 1}\`))` |
| 72: step v${step.from}→v${step.to} makes exactly its documented changes (never edit a shipped migration) | KEEP | [Fresh six-bar decision](project-core.md); `expect(diff(b, c)).toEqual(STEP_CHANGES[\`${step.from}→${step.to}\`]!(before))` |
| 80: a bare document without an envelope or schemaVersion is read as v1 | KEEP | [Fresh six-bar decision](project-core.md); `expect(r.repairs).toEqual([])` |
| 87: a newer schema opens read-only and is never migrated down (S01:MIG-003) | CONSOLIDATE | [Fresh six-bar decision](project-core.md); `expect(r.migration).toEqual({ fromVersion: future, toVersion: future, steps: [] })` |

## packages/project/test/scopes.test.ts

S06 grading/colour-management and scope contracts, cited published reference coordinates/transfers, and public conversion/analysis output. No UI geometry assertions.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 82: a single colour lands in exact histogram bins | KEEP | [Historical six-bar row](project4.md); `expect([h.r[200], h.g[100], h.b[50]]).toEqual([n, n, n])` |
| 96: a ramp fills every bin and the waveform row equals the code value | KEEP | [Historical six-bar row](project4.md); `expect([h.r[k], h.g[k], h.b[k], h.y[k]]).toEqual([10, 10, 10, 10])` |
| 116: colour bars have exact RGB parade levels | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(rowsIn(t, x)).toEqual([bar[ch]])` |
| 132: vectorscope positions of primaries are known | KEEP | [Historical six-bar row](project4.md); `expect([pk.x, pk.y]).toEqual([103, 21])` |
| 150: the HLS vectorscope puts hue on the angle and saturation on the radius | KEEP | [Historical six-bar row](project4.md); `expect(Math.abs(pk.angleDeg - angle)).toBeLessThan(0.5)` |
| 173: the YC waveform draws chroma around luma; the YUV parade offsets chroma to mid scale | KEEP | [Historical six-bar row](project4.md); `expect([rowsIn(trace(w0, 'Y'), 0), rowsIn(trace(w0, 'C'), 0)]).toEqual([[128], [128]])` |
| 184: decimation keeps whole samples | KEEP | [Historical six-bar row](project4.md); `expect([s.w, s.h]).toEqual([480, 270])` |
| 202: Clamp Signal controls out-of-range values | KEEP | [Historical six-bar row](project4.md); `expect([h.r[255], h.above[0], h.b[0], h.below[2]]).toEqual([8, 8, 8, 8])` |
| 217: NaN (transparent) samples and empty signals do not throw | KEEP | [Historical six-bar row](project4.md); `expect(histogram(s).samples).toBe(6)` |
| 235: summaries report levels in percent | KEEP | [Historical six-bar row](project4.md); `expect([st.r.mean, st.g.mean, st.b.mean]).toEqual([78.43, 39.22, 19.61])` |
| 256: paint adds traces and leaves empty cells transparent | KEEP | [Historical six-bar row](project4.md); `expect([...p.image.slice(i, i + 4)]).toEqual([255, 255, 255, 255])` |
| 274: accepts public scope aliases | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(scopeKindFromName('vectorscope')).toBe('vectorscopeYuv')` |
| 285: Y′CbCr round-trips for every matrix | KEEP | [Historical six-bar row](project4.md); shared assertion helper verifies the named semantic property |
| 295: 100 % targets of BT.2020 sit further out than 75 %; scale labels follow the bit depth | KEEP | [Historical six-bar row](project4.md); `expect(scaleLabels('8bit').at(-1)).toEqual([1, '255'])` |
| 305: readScopes reports every scope as numbers | KEEP | [Historical six-bar row](project4.md); `expect(r.samples).toEqual([256, 16])` |
| 318: stays real time: every scope of a 1080p frame in well under a frame budget | KEEP | [Historical six-bar row](project4.md); `expect(t, name).toBeLessThan(limit)` |

## packages/project/test/sequence-transcript.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 100: maps words through the clip | KEEP | [Historical six-bar row](project4.md); `expect(texts(w)).toEqual(['Um,', 'today', 'we', 'talk', 'about', 'rivers.'])` |
| 111: keeps a cut word by its midpoint and clamps it | KEEP | [Historical six-bar row](project4.md); `expect(texts(w)).toEqual(['show.'])` |
| 118: scales word times by speed | KEEP | [Historical six-bar row](project4.md); `expect([w[3]!.start, w[3]!.end]).toEqual([s(0.6), s(0.85)])` |
| 123: reads duplicated tracks once; disabled or reversed clips are silent | KEEP | [Historical six-bar row](project4.md); `expect(sequenceWords(docT, q)).toEqual([])` |
| 135: repeats words of two clips of the same media in edit order | KEEP | [Historical six-bar row](project4.md); `expect(texts(w)).toEqual(['rivers.', 'rivers.'])` |
| 142: search, word at and paragraphs | KEEP | [Historical six-bar row](project4.md); `expect(searchWords(w, 'rivers')).toEqual([ [9, 10], [17, 18], ])` |
| 161: word ranges snap outward | KEEP | [Historical six-bar row](project4.md); `expect(wordRangeFrames(w, 3, 0, R)).toEqual([12, 43])` |
| 169: finds pauses with kept air, snapped inward | KEEP | [Historical six-bar row](project4.md); `expect(p).toEqual([[fr(1.8), fr(3.6)]])` |
| 177: finds fillers, longest phrase first, without cutting into neighbours | KEEP | [Historical six-bar row](project4.md); `expect(hits).toEqual([ [4, 5], [15, 16], ])` |
| 195: filler ranges never reach into the neighbouring words | KEEP | [Historical six-bar row](project4.md); `expect(a * F).toBeGreaterThanOrEqual(words[0]!.end)` |
| 206: merges ranges | KEEP | [Historical six-bar row](project4.md); `expect( mergeRanges([ [5, 6], [1, 2], [1.5, 3], [3, 4], ]), ).toEqual([ [1, 4], [5, 6], ])` |
| 234: follow line length, speaker and pause rules | KEEP | [Historical six-bar row](project4.md); `expect(b.map((x) => x.text)).toEqual([ 'Welcome to the show.', 'Um, today we talk about rivers.', 'Thanks for having me. I uh love rivers,\nyou know.', ])` |
| 258: never overlap with dense words | KEEP | [Historical six-bar row](project4.md); `expect(blocks.length).toBeGreaterThan(0)` |
| 270: a short caption extends into the silence but never over the next caption | KEEP | [Historical six-bar row](project4.md); `expect(b).toHaveLength(2)` |
| 280: breaks at maximum duration | KEEP | [Historical six-bar row](project4.md); `expect(b.length).toBeGreaterThan(1)` |

## packages/project/test/sim-warp-commands.test.ts

S07 Liquify/Mesh Warp/Puppet and S03 animated effect evaluation. Public commands and rendered deformation must preserve frozen regions, authored control points and resolution independence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 54: a warp stroke writes the Distortion Mesh; keyframes when animated; refusals | KEEP | [Historical six-bar row](project3.md); `expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([])` |
| 94: reconstruction reduces deformation and freeze protects the mesh | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(frozen).toEqual(empty)` |
| 133: a stored mesh survives a change from 1920 × 1080 to 640 × 360 | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(small).toEqual(big)` |
| 146: traces the opaque region under the seed; null for opaque images | KEEP | [Historical six-bar row](project3.md); `expect(a.length).toBeGreaterThanOrEqual(4)` |
| 171: animated pins are re-evaluated every frame (a clip with only pin keys is not static) | KEEP | [Historical six-bar row](project3.md); `expect(pinAt(0)).toEqual([0.2, 0.5])` |
| 195: updates vertices and tangents, refuses invalid edits and resets the regular grid | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(m.slice(o, o + 2)).toEqual([0.55, 0.45])` |
| 227: adds a mesh and pins, moves pins (keys when animated), records sketches, removes | KEEP | [Historical six-bar row](project3.md); `expect(pup.pins.map((p) => p.name)).toEqual(['Puppet Pin 1', 'Puppet Pin 2', 'Starch 1'])` |
| 279: a mesh from an outline; pins outside it start a new mesh | KEEP | [Historical six-bar row](project3.md); `expect(fx().puppet!.meshes).toHaveLength(2)` |
| 296: invariants flag broken puppet data; repair removes it | KEEP | [Historical six-bar row](project3.md); `expect( checkInvariants(bad, { effects: defaultEffectRegistry }).some((i) => i.message.includes('pin')), ).toBe(true)` |
| 323: ARAP: no pins = rest; a moved pin moves its side, the opposite pin holds; starch stiffens | KEEP | [Historical six-bar row](project3.md); `expect(solvePuppet(pup, w, ht, 2)[0]!.deformed).toEqual(g.verts.map((v) => [v[0], v[1]]))` |
| 372: triangulates an L outline into CCW triangles inside it; deform keeps fixed handles | KEEP | [Historical six-bar row](project3.md); `expect(d[0]).toEqual([g.verts[0]![0] + 5, g.verts[0]![1]])` |

## packages/project/test/simplify-doc.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 144: property: random dense corner-pin and Motion tracks stay within the tolerance at every frame | KEEP | [Historical six-bar row](project4.md); `expect(maxShift(after[f]!.quad, before[f]!.quad)).toBeLessThanOrEqual(tol + 1e-9)` |
| 207: simplifies only the selected keys, as one undoable transaction, and previews with a dry run | KEEP | [Historical six-bar row](project4.md); `expect(kept.slice(0, 11)).toEqual(ids.slice(0, 11))` |
| 246: simplifies opacity within the requested tolerance in percentage units | KEEP | [Historical six-bar row](project4.md); `expect(report.groups[0]!.kind).toBe('value')` |
| 272: tracker.apply {simplify} bakes and simplifies in one transaction; trackedOnly targets the tracked params | KEEP | [Historical six-bar row](project4.md); `expect(res.simplified.after).toBeLessThan(res.simplified.before)` |
| 311: refuses ambiguous selections and locked tracks | KEEP | [Historical six-bar row](project4.md); `expect(bad.ok ? null : bad.errors[0]!.code).toBe('E_INVALID_PARAM')` |

## packages/project/test/simplify.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 80: keeps every frame within the tolerance on random dense tracks (scalar and vec2) | KEEP | [Historical six-bar row](project4.md); `expect(k.value).toEqual(o.value)` |
| 122: honours mixed interpolations (bezier, auto-bezier, hold) at sub-frame samples, inside and outside a span | KEEP | [Historical six-bar row](project4.md); `expect(out.slice(0, a)).toEqual(keys.slice(0, a))` |
| 164: keeps locked (unselected) keys inside the span | KEEP | [Historical six-bar row](project4.md); `expect(r.keys[0]!.map((k) => k.id)).toEqual(['kf_0', 'kf_10', 'kf_20', 'kf_29'])` |
| 175: reduces a smooth per-frame curve to few keys and fits eases | KEEP | [Historical six-bar row](project4.md); `expect(out.length).toBeLessThan(keys.length)` |
| 188: solves channels with shared key times jointly and others with a share of the tolerance | KEEP | [Historical six-bar row](project4.md); `expect(e).toBeLessThanOrEqual(tol)` |

## packages/project/test/source-range.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 158: records the processed range as the version's sourceRange and names the item after it | KEEP | [Historical six-bar row](project4.md); `expect(m.sourceRange).toEqual({ mediaId, sourceName: 'crudo.mp4', firstFrame: 1090, frames: 130, frameRate: R30, origin: 'process', })` |
| 177: records the whole source for unranged versions, and refuses ranges that do not match the file | KEEP | [Historical six-bar row](project4.md); `expect(h.doc.media[v.id]!.sourceRange).toMatchObject({ firstFrame: 0, frames: 1800 })` |
| 204: swaps a clip onto a range with handles: same source frames, same timeline place, handles from the range | KEEP | [Historical six-bar row](project4.md); `expect(before.slice(0, 2)).toEqual([1100, 1101])` |
| 229: switches directly between two ranged versions of one original (and versions of versions) | KEEP | [Historical six-bar row](project4.md); `expect(rootFrameSpan(h.doc, c)).toMatchObject({ rootId: mediaId, start: 490, end: 600 })` |
| 261: the clip shows the same source frames at the same timeline frames, and swapping back restores it exactly | KEEP | [Historical six-bar row](project4.md); `expect(shownRootFrames(h, videoId)).toEqual(want)` |
| 329: keeps exactly the timeline frames whose content lies in the file | KEEP | [Historical six-bar row](project4.md); `expect(expected).toEqual([])` |
| 368: shifts nested keyframes and tracker times, dropping samples and markers before the file | KEEP | [Historical six-bar row](project4.md); `expect(shiftClipContentTime(clip, -4 * F30)).toEqual({ droppedMarkers: 0, droppedTrackerSamples: 0, })` |
| 419: refuses with source ranges in the diagnostic and leaves the document unchanged | KEEP | [Historical six-bar row](project4.md); `expect(message).toContain('1100–1139')` |
| 432: fit: "trim" trims the clip and its linked audio to the covered frames, still on the same source frames | KEEP | [Historical six-bar row](project4.md); `expect(r.results[0]).toMatchObject({ changed: true, trimmed: { head: 10, tail: 10 } })` |
| 445: fit: "trim" on a reverse clip trims the right ends | KEEP | [Historical six-bar row](project4.md); `expect([c.start, c.duration, c.sourceIn]).toEqual([50, 30, 0])` |
| 455: fit: "skip" leaves the clip with a warning; media.derive replaceInClips uses it per clip | KEEP | [Historical six-bar row](project4.md); `expect(r.results[0]).toMatchObject({ clipIds: [], skippedClipIds: [videoId] })` |
| 473: warns when a source swap shortens transition handles | KEEP | [Historical six-bar row](project4.md); `expect(r.warnings.map((w) => w.code)).toContain('W_TRANSITION_SHORTENED')` |
| 515: reads the trailer grade sidecar, jasper-proc sidecars and the generic shape | KEEP | [Historical six-bar row](project4.md); `expect(parseSourceSidecar(T02_SIDECAR, '/x/T02.json')).toEqual({ sidecar: 'T02.json', sourceName: 'crudo.mp4', firstFrame: 174, frames: 130, frameRate: R30, handles: [0, 8], })` |
| 551: binds an imported render sidecar to the source media by filename | KEEP | [Historical six-bar row](project4.md); `expect(range).toEqual({ mediaId, sourceName: 'crudo.mp4', firstFrame: 174, frames: 130, frameRate: R30, origin: 'sidecar', })` |
| 570: media.setSourceRange links, re-links and clears; refuses cycles and rate mismatches | KEEP | [Historical six-bar row](project4.md); `expect(originalMediaId(h.doc, o)).toBe(mediaId)` |
| 612: resolves two source ranges and refuses incompatible sources or frame rates | KEEP | [Historical six-bar row](project4.md); `expect( sourceTimingShift( { ...replacement(130), sourceRange: r(174) }, { ...replacement(140), sourceRange: r(170) }, ), ).toMatchObject({ shiftFrames: 4, basis: 'source-range' })` |
| 673: moves every clip, mark and marker of the media so the same source frames stay at the same place | KEEP | [Historical six-bar row](project4.md); `expect(r.results[0]).toMatchObject({ mediaId, shiftFrames: -174, basis: 'range-of-current' })` |
| 710: refuses (or trims) clips the new file does not hold, and without keep-timing keeps content time | KEEP | [Historical six-bar row](project4.md); `expect(trimmed.results[0]).toMatchObject({ trimmedClipIds: expect.arrayContaining([videoId]) })` |
| 738: refuses keep-source-timing without a source relation or timecodes | KEEP | [Historical six-bar row](project4.md); `expect(!none.ok && none.errors[0]!.code).toBe('E_INVALID_PARAM')` |
| 746: re-anchors versions of the media on the new file (or detaches those it no longer holds) | KEEP | [Historical six-bar row](project4.md); `expect(h.doc.media[kept]!.sourceRange).toMatchObject({ mediaId, firstFrame: 50, frames: 200 })` |
| 779: keeps source timing by timecode | KEEP | [Historical six-bar row](project4.md); `expect(vclip(h, videoId).sourceIn).toBe(30 * F30)` |
| 790: the v5 fixture (a ranged processed version in use, a sidecar-linked render) loads without repairs | KEEP | [Historical six-bar row](project4.md); `expect(r.migration.steps).toEqual(['v5→v6', 'v6→v7'])` |
| 809: records the whole-source range on M2 processed versions | KEEP | [Historical six-bar row](project4.md); `expect(m.report.steps).toEqual(['v4→v5', 'v5→v6', 'v6→v7'])` |

## packages/project/test/speech.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 42: creates the media transcript (words normalised, speakers named) and its clips read it back; undo removes it | KEEP | [Historical six-bar row](project2.md); `expect(t.words.map((x) => x.text)).toEqual(['Hello', 'world.'])` |
| 76: replace keeps the transcript id (references stay valid); keep leaves it; merge replaces only the coverage | KEEP | [Historical six-bar row](project2.md); `expect(kept).toMatchObject({ skipped: true, transcriptId: id })` |
| 124: refuses unknown media and words that end before they start | KEEP | [Historical six-bar row](project2.md); `expect(r1.ok).toBe(false)` |
| 135: maps words through clip offset and speed, top track first, and records the media ranges played | KEEP | [Historical six-bar row](project2.md); `expect(ma.words.map((x) => [x.text, x.start, x.end])).toEqual([['one', s(11), s(11.5)]])` |
| 186: merge keeps words outside the new coverage (property) | KEEP | [Historical six-bar row](project2.md); `expect(m.words.some((x) => x.text === o.text)).toBe(!inside(mid))` |
| 229: flags malformed coverage and repairDocument sorts and merges it | KEEP | [Historical six-bar row](project2.md); `expect( coverageProblem([ [0, 5], [5, 9], ]), ).toMatch(/sorted/)` |

## packages/project/test/split-children-ids.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 21: a text clip with an animator can be split and duplicated | CONSOLIDATE | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(h.doc)).toEqual([])` |
| 42: a clip with Puppet pins can be split; the copy’s pins point at the copy’s meshes | CONSOLIDATE | [Fresh six-bar decision](project-core.md); `expect(checkInvariants(h.doc)).toEqual([])` |

## packages/project/test/time-commands.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 40: enables with an identity curve and warns that the linked audio stays at 100 % | KEEP | [Historical six-bar row](project4.md); `expect(vid(h, v).timeRemap).toMatchObject({ enabled: true, keyframes: [] })` |
| 50: mutes or unlinks the linked audio on request | KEEP | [Historical six-bar row](project4.md); `expect(h.seq.clips[a]!.enabled).toBe(false)` |
| 63: refuses reversed clips and non-video clips | KEEP | [Historical six-bar row](project4.md); `expect(r.ok).toBe(false)` |
| 75: turning it off deletes the keyframes and trims a slowed clip to its media | KEEP | [Historical six-bar row](project4.md); `expect(vid(h, v).duration).toBe(240)` |
| 88: slowing the clip lengthens it until the next clip; ripple pushes instead | KEEP | [Historical six-bar row](project4.md); `expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED')` |
| 107: a ramp of keyframes: 100 % → 25 % → 400 % with a transition | KEEP | [Historical six-bar row](project4.md); `expect(k2frame).toBeCloseTo(150, 3)` |
| 134: motion keyframes stay at their timeline frames when the speed changes | KEEP | [Historical six-bar row](project4.md); `expect((vid(h, v).opacity.keyframes as { time: number }[]).map((k) => k.time)).toEqual(before)` |
| 152: freeze frame: holds and moves the rest later | KEEP | [Historical six-bar row](project4.md); `expect(clipMediaTimeAt(c, f, R)).toBeCloseTo(20 * F, 3)` |
| 166: palindrome reverse plays back and forward again | KEEP | [Historical six-bar row](project4.md); `expect(frames).toEqual([28, 30, 25, 20, 25, 30, 31])` |
| 183: moving a hold keyframe slips the held frame | KEEP | [Historical six-bar row](project4.md); `expect(clipMediaTimeAt(c, 30, R)).toBeCloseTo(26 * F, 3)` |
| 201: split, trim and undo keep the curve consistent; handles come from the remap | KEEP | [Historical six-bar row](project4.md); `expect(clipMediaTimeAt(rc, 60, R)).toBeCloseTo(30 * F, 3)` |
| 218: Reverse Speed is refused on a remapped clip | KEEP | [Historical six-bar row](project4.md); `expect(h.tx([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]).ok).toBe(false)` |
| 225: repair fixes malformed remaps | KEEP | [Historical six-bar row](project4.md); `expect(checkInvariants(fixed.document)).toEqual([])` |
| 246: sets the interpolation mode on video clips only | KEEP | [Historical six-bar row](project4.md); `expect(vid(h, v).timeInterpolation).toBe('optical-flow')` |
| 258: cuts the clip and its audio, adds markers and a bin of scene items in one step | KEEP | [Historical six-bar row](project4.md); `expect(res.cuts).toEqual([40, 85])` |
| 294: refuses trackers on remapped clips and remapping tracked clips | KEEP | [Historical six-bar row](project4.md); `expect( h.tx([{ type: 'tracker.add', clipId: v, kind: 'point', at: { frames: 0 }, point: [100, 100] }]).ok, ).toBe(false)` |
| 307: a content shift moves speed keyframes in content and media time | KEEP | [Historical six-bar row](project4.md); `expect(c.timeRemap!.keyframes.map((k) => [k.time, k.source])).toEqual( before.map(([a, b]) => [a! + 1000, b! + 1000]), )` |
| 322: pastes the speed profile onto another clip from its own first frame, and removes it | KEEP | [Historical six-bar row](project4.md); `expect((r.results[0] as { applied: Record<string, string[]> }).applied[b.v]).toEqual(['timeRemapping'])` |

## packages/project/test/time-flow.test.ts

S01 time remapping/frame blending and S04 optical-flow quality: independent translated/occluded synthetic frames provide the image oracle.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 83: finds a translation with sub-pixel accuracy | KEEP | [Historical six-bar row](project2.md); `expect(v[0]).toBeCloseTo(6.4, 0)` |
| 94: finds large motion through the pyramid | KEEP | [Historical six-bar row](project2.md); `expect(Math.abs(v[0] - 27)).toBeLessThan(0.5)` |
| 106: beats a frame mix by far on a translation | KEEP | [Historical six-bar row](project2.md); `expect(flow).toBeLessThan(mix * 0.25)` |
| 116: reconstructs an occluded moving square more accurately than a frame mix | KEEP | File-specific independent source above; named contract and literal/property result below; `expect(ours).toBeLessThan(mix * 0.25)` |
| 141: w = 0 and w = 1 reproduce the frames; 8-bit output is rounded | KEEP | [Historical six-bar row](project2.md); `expect(mae(interpolateFlow(a, b, 0, pair), a.data, 64, 48, 4)).toBeLessThan(1e-6)` |

## packages/project/test/time-remap.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 56: is the identity without keyframes | KEEP | [Historical six-bar row](project1.md); `expect(remapSlopes(r)).toEqual([1])` |
| 62: is piecewise linear through its keyframes with edge slopes | KEEP | [Historical six-bar row](project1.md); `expect(ev(0).m).toBeCloseTo(30 * F - 60 * F, 3)` |
| 75: speed transitions keep both keyframe anchors and are C1 | KEEP | [Historical six-bar row](project1.md); `expect(ev(24 * F).m).toBeCloseTo(24 * F, 1)` |
| 92: finds the zero-speed point inside a transition into reverse | KEEP | [Historical six-bar row](project1.md); `expect(max).toBeLessThan(30 * F)` |
| 104: property: media time is continuous and finite for random curves | KEEP | [Historical six-bar row](project1.md); `expect(Number.isFinite(v.m) && Number.isFinite(v.slope)).toBe(true)` |
| 141: maps frames through content time and reports timeline speed | KEEP | [Historical six-bar row](project1.md); `expect(clipMediaTimeAt(c, 110, R30)).toBeCloseTo(10 * F, 3)` |
| 156: ignores remaps on non-video clips and disabled remaps | KEEP | [Historical six-bar row](project1.md); `expect(clipMediaTimeAt({ ...clipWith(r), kind: 'audio' }, 120, R30)).toBe(20 * F)` |
| 166: slowing a middle segment keeps its frames and pushes everything after it | KEEP | [Historical six-bar row](project1.md); `expect(b!.time).toBeCloseTo(90 * F, 3)` |
| 179: the first segment is anchored at the clip start, the last at its end | KEEP | [Historical six-bar row](project1.md); `expect(head.remap.keyframes[0]!.time).toBeCloseTo(15 * F, 3)` |
| 190: changes a key-less remap by anchoring the first frame | KEEP | [Historical six-bar row](project1.md); `expect(e.shift(90 * F)).toBeCloseTo(360 * F, 2)` |
| 197: keeps reverse segments reverse and refuses to speed a freeze | KEEP | [Historical six-bar row](project1.md); `expect(e.remap.keyframes[1]!.time).toBeCloseTo(15 * F, 3)` |
| 206: adding a keyframe never changes the picture | KEEP | [Historical six-bar row](project1.md); `expect(remapSourceAt(e.remap, c)).toBeCloseTo(remapSourceAt(base, c), 4)` |
| 216: freeze and palindrome reverse insert segments and move what follows | KEEP | [Historical six-bar row](project1.md); `expect(hold.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([ [30, 30], [50, 30], ])` |
| 235: moving the first freeze keyframe slips the held frame; the second changes the hold length | KEEP | [Historical six-bar row](project1.md); `expect(slip.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([ [40, 40], [60, 40], ])` |
| 251: removing keyframes keeps the neighbours | KEEP | [Historical six-bar row](project1.md); `expect(remapSourceAt(e.remap, 30 * F)).toBeCloseTo(22.5 * F, 3)` |
| 266: room is limited by the media at both ends | KEEP | [Historical six-bar row](project1.md); `expect(remapRoom(c, R30, dur)).toEqual({ head: 0, tail: 180 })` |
| 276: picks the last frame at or before the media time | KEEP | [Historical six-bar row](project1.md); `expect(pickFrames(vfr, 0.2, 'frame-blending')).toEqual({ a: 3, b: 4, w: expect.closeTo(0.4444, 3) })` |
| 293: round-trips a remap with segments, a ramp, a freeze and a reverse | KEEP | [Historical six-bar row](project1.md); `expect(pts[0]).toMatchObject({ time: 0, value: 0 })` |

## packages/project/test/time-scenes.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 125: finds every hard cut exactly and nothing at dissolves, flashes, fast pans or lighting changes | KEEP | [Historical six-bar row](project3.md); `expect(found).toEqual(cuts)` |
| 130: sensitivity moves the threshold; minimum shot length merges close cuts | KEEP | [Historical six-bar row](project3.md); `expect(detectSceneCuts(s, { sensitivity: 50, minShotFrames: 1 })).toEqual([2, 4])` |
| 139: a dissolve onto a flat colour at a histogram bin edge does not end in a cut (soft bins) | KEEP | [Historical six-bar row](project3.md); `expect(detectSceneCuts(sc, { sensitivity: 50, minShotFrames: 2 }, s)).toEqual([])` |
| 164: the flash test: a one-frame flash is not a cut, a real cut is kept | KEEP | [Historical six-bar row](project3.md); `expect(detectSceneCuts(sceneScores(seq), { sensitivity: 50, minShotFrames: 1 }, seq)).toEqual([])` |

## packages/project/test/time.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 27: generates prefixed 16-char Crockford ids | KEEP | [Historical six-bar row](project3.md); `expect(id).toMatch(/^clp_[0-9A-HJKMNP-TV-Z]{16}$/)` |
| 39: F(r) is an integer for every allowed sequence rate | KEEP | [Historical six-bar row](project3.md); `expect(Number.isInteger(flicksPerFrame(r))).toBe(true)` |
| 44: converts frames, flicks and seconds | KEEP | [Historical six-bar row](project3.md); `expect(flicksToFrames(framesToFlicks(f, r), r)).toBe(f)` |
| 55: maps frames between rates monotonically (S01:SEQ-006) | KEEP | [Historical six-bar row](project3.md); `expect(mapFrameBetweenRates(30, RATES.r30, RATES.r25)).toBe(25)` |
| 65: rounds media rates to the nearest allowed rate | KEEP | [Historical six-bar row](project3.md); `expect(nearestAllowedRate(29.97)).toEqual(RATES.r29_97)` |
| 73: AC-01: new 1080p 29.97 project is drop-frame with V1–V3/A1–A3 and frame 1800 = 00;01;00;02 | KEEP | [Historical six-bar row](project3.md); `expect(seq.settings.frameRate).toEqual({ num: 30000, den: 1001 })` |
| 84: formats non-drop and drop-frame timecode | KEEP | [Historical six-bar row](project3.md); `expect(formatTimecode(0, RATES.r30)).toBe('00:00:00:00')` |
| 93: normalizes invalid drop-frame labels to the next valid frame | KEEP | [Historical six-bar row](project3.md); `expect(parseTimecode('00;01;00;00', RATES.r29_97, { dropFrame: true })).toBe(1800)` |
| 113: drop-frame round-trips over 24 h at 29.97 (${FUZZ ? 'every frame' : 'sampled'}) | KEEP | [Historical six-bar row](project3.md); generated case uses the named rate/version/property family and its assertion helper (not an assertion-free probe) |
| 115: drop-frame round-trips over 24 h at 59.94 (${FUZZ ? 'every frame' : 'sampled'}) | KEEP | [Historical six-bar row](project3.md); generated case uses the named rate/version/property family and its assertion helper (not an assertion-free probe) |
| 117: non-drop round-trips | KEEP | [Historical six-bar row](project3.md); `expect(parseTimecode(formatTimecode(f, r), r)).toBe(f)` |
| 122: parses partial entries (S02:TL-205, S05:TY-006) | KEEP | [Historical six-bar row](project3.md); `expect(p('115')).toBe(45)` |

## packages/project/test/tracker.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 109: adds planar and point trackers on video clips with media-px geometry and content time | KEEP | [Historical six-bar row](project3.md); `expect(a!.trackerId).toMatch(/^tkr_/)` |
| 142: updates, stores samples (replace / span merge) and removes trackers | KEEP | [Historical six-bar row](project3.md); `expect(clip(h, plate).trackers![0]!.name).toBe('Screen')` |
| 197: moving the reference carries the correction through the remaining perspective motion | KEEP | [Historical six-bar row](project3.md); `expect(actual[k]![0]).toBeCloseTo(expected[k]![0], 6)` |
| 247: split copies trackers to both halves with new ids; duplicate too; trackedBy follows the pin copy | KEEP | [Historical six-bar row](project3.md); `expect(right!.trackers![0]!.id).toMatch(/^tkr_/)` |
| 280: interpolates linearly between samples and holds outside the span | KEEP | [Historical six-bar row](project3.md); `expect(valuesAt(s, 5 * F + F / 2)!.values[0]).toBeCloseTo(701.5, 9)` |
| 286: smooths jitter with a centred average and holds the end samples | KEEP | [Historical six-bar row](project3.md); `expect(smoothed.data).toEqual([3, 6, 3, 6, 3, 6])` |
| 299: merges disjoint spans with lost samples in the gap | KEEP | [Historical six-bar row](project3.md); `expect(m.data).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 4, 4])` |
| 311: re-anchors point samples by translation | KEEP | [Historical six-bar row](project3.md); `expect(reanchorSamples(s, F, { point: [22, 16] }).data).toEqual([12, 11, 22, 16])` |
| 315: converts engine results (source frames) to samples (content flicks) | KEEP | [Historical six-bar row](project3.md); `expect(s.confidence).toEqual([1])` |
| 323: corner pin reproduces the tracked corners through plate Motion (200 %, 90°) and animated target Motion | KEEP | [Historical six-bar row](project3.md); `expect((t as { trackedBy?: unknown }).trackedBy).toEqual({ clipId: plate, trackerId: id, mode: 'corner-pin', effectInstanceId: res.effectInstanceId, })` |
| 368: transform mode: position follows the quad centre, scale/rotation relative to the reference | KEEP | [Historical six-bar row](project3.md); `expect(t.transform.position.keyframes[20]!.value[0]).toBeCloseTo(want[0], 4)` |
| 427: tracker.unlink drops the link and keeps the keyframes | KEEP | [Historical six-bar row](project3.md); `expect(r.results[0]).toEqual({ clipIds: [target] })` |
| 438: removing a tracker keeps the keyframes and drops the link | KEEP | [Historical six-bar row](project3.md); `expect((t as { trackedBy?: unknown }).trackedBy).toBeUndefined()` |
| 450: builds forward / both / from-here requests in source frames | KEEP | [Historical six-bar row](project3.md); `expect(both.request.range).toEqual({ startFrame: 0, endFrame: 60 })` |

## packages/project/test/transaction.test.ts

The file-specific independent source, oracle, stable seam and unique failure are in the linked historical disposition row; current named assertion shape has been checked against that evidence.

| Baseline line / test family | Disposition | Evidence / independent oracle |
| --- | --- | --- |
| 22: rejects non-string command types without serializing untrusted values | KEEP | [Historical six-bar row](project2.md); `expect(h.tx([{ type }])).toMatchObject({ ok: false, errors: [{ code: 'E_SCHEMA', commandIndex: 0 }], })` |
| 34: reports a throwing transaction getter without losing the project | KEEP | [Historical six-bar row](project2.md); `expect(outcome.result).toMatchObject({ ok: false, errors: [{ code: 'E_INTERNAL', commandIndex: -1, message: 'unreadable transaction' }], })` |
| 49: AC-09: a failing third command applies nothing and reports commandIndex 2 | KEEP | [Historical six-bar row](project2.md); `expect(result).toMatchObject({ ok: false, errors: [{ commandIndex: 2, code: 'E_NOT_FOUND' }], revision: 0, })` |
| 75: AC-10: temp refs create a text clip and target it in later commands | KEEP | [Historical six-bar row](project2.md); `expect(r.refs.$title).toMatch(/^clp_/)` |
| 114: AC-11: stale expectedRevision is refused when it touches a changed clip, fast-forwards otherwise | KEEP | [Historical six-bar row](project2.md); `expect(stale.errors[0]!.blocking).toContain(moved!.id)` |
| 137: dry runs return the result without changing the document | KEEP | [Historical six-bar row](project2.md); `expect(r.ok).toBe(true)` |
| 146: enforces the command limit and schemas | KEEP | [Historical six-bar row](project2.md); `expect(unknown).toMatchObject({ ok: false, errors: [{ code: 'E_SCHEMA' }] })` |
| 167: resolves $selection and $selection.primary | KEEP | [Historical six-bar row](project2.md); `expect(h.clips('V1').map((c) => c.id)).toEqual([ids[0]])` |
| 181: does not substitute $-strings in text content | KEEP | [Historical six-bar row](project2.md); `expect((h.seq.clips[id] as unknown as { content: { text: string } }).content.text).toBe('$5 off')` |
| 190: exports command and template argument constraints as JSON Schema (S01:AGT-002) | KEEP | [Historical six-bar row](project2.md); `expect(s.commands['clip.place'].schema).toMatchObject({ type: 'object', required: expect.arrayContaining(['type', 'source', 'at']), properties: { type: { const: 'clip.place' } }, })` |
| 223: bins, moves, cycles and deletes items; in-use media needs force | KEEP | [Historical six-bar row](project2.md); `expect(cyc.ok).toBe(false)` |
| 246: source marks drive clip.place ranges (S01:PRJ-005) | KEEP | [Historical six-bar row](project2.md); `expect(h.spans('V1')).toEqual([[0, 60]])` |
| 256: markers on sequences and clips; tracks add/remove/update | KEEP | [Historical six-bar row](project2.md); `expect(h.seq.markers.map((m) => m.name)).toEqual(['a', 'b'])` |
| 288: param.set validates, clamps and supports effects, tracks and master | KEEP | [Historical six-bar row](project2.md); `expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED')` |
| 333: clip.update edits text and motion-graphic params through the template registry | KEEP | [Historical six-bar row](project2.md); `expect((h.seq.clips[id] as unknown as { params: { title: string; accent: number[] } }).params).toEqual({ title: 'Ana', accent: [1, 0, 0, 1], })` |
| 379: sequence.create from media adopts its settings and places it | KEEP | [Historical six-bar row](project2.md); `expect([seq.settings.width, seq.settings.height, seq.settings.frameRate.num]).toEqual([1080, 1920, 60])` |

## packages/project/test/fuzz-parsers.test.ts

Source: AGENTS §0 and docs/testing.md §4: every parser/loader accepts valid input or reports its declared typed error/result; no internal exception, hang or invalid repaired document. The historical complete target records are in project3.md. The stable seam is each public parser or loader. Seeds, truncations, mutations and arbitrary input protect different grammar/boundary failures from valid round-trip cases. A legitimate typed error is the oracle, not a stubbed return value. Loader success also has an independent invariant check.

| Baseline line / generated target family | Disposition | Unique owner / oracle |
| --- | --- | --- |
| 86: SRT | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 87: WebVTT | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 88: SCC | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 89: MCC | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 90: TTML / DFXP | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 91: EBU STL | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 97: caption sniffing + readCaptionFile (result object) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 111: .cube | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 112: .3dl | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 113: .spi1d | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 114: .spi3d | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 115: .csp | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 116: LUT sniffing (parseLutFile) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 122: OCIO YAML subset | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 123: OCIO config: parse, list, convert | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 139: ASC CDL XML | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 143: SVG → shape layers | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 144: SVG path data | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 145: Lottie JSON text | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 146: Lottie document | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 148: glTF (JSON) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 154: glTF document (fields) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 160: glTF binary (GLB) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 161: OBJ | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 162: image-sequence grouping (one name per line) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 165: timecode entry | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 172: project load / migrate / repair | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 177: migrate only | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 178: effect preset (result object) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 179: effect preset file (result object) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 184: clipboard payload (result object) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 187: clipboard payload text (result object) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 190: source-range sidecar | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 195: transcript JSON (string on error) | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
| 198: essential-sound settings | KEEP | [Historical target-specific six-bar evidence](project3.md); typed error/result boundary for this grammar, plus declared successful-result checks. |
