# Motion test audit and completed cleanup

Scope: `packages/motion/test/**`. The independent contracts are `docs/specs/11-animation.md` (ANM-002/003/007/009/013/014/015, TXA-002/003/004/010/011, ATP-001/003/004), `docs/ARCHITECTURE.md` §20.2, and the recorded clipping, callout pulse, and large-counter regressions in `docs/wp-notes/wp-m2-anime-templates.md` §Review fixes. Baseline test command: `pnpm --filter @jasper/motion test`; optional browser gate: `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/determinism-render.e2e.test.ts`.

Before editing, I identified these stronger owners: `determinism.test.tsx` for text build order; `packages/compositions/test/text-animation.test.tsx` for displayed text, caret, RTL, and animation windows; `packages/mg-templates/test/anime-templates.test.ts` for template timing and format; and the real `SequenceComposition` browser parity test for visible template/frame order. An initial composition style assertion for clipping was also present; the composition audit removed it because the assertion observed `overflow` rather than pixels. `e2e/anime-templates.spec.ts` now has a browser pixel regression for the specific out-of-bounds callout case, with Program PNG and exported MOV artifacts. The only external production imports of `@jasper/motion/templates` use `ANIME_TEMPLATE_IMPLS`, but the other builders and helpers are documented package exports, so their export surface remains. `orderRanks` is likewise documented through `@jasper/motion/text`. The deleted scene and harness fixtures had no production callers. Risk of pruning the duplicate unit assertions is a narrower diagnosis if a visible animation fails; the retained owners still detect those failures.

## Full bar for retained and rewritten tests

The rows below use these contract classes. Each class spells out the six required points in order: independent source; visible/caller failure; independent oracle; public or stable seam; refactor tolerance; lowest owner.

| Class | Six-point justification |
| --- | --- |
| R (runtime API) | (1) ARCHITECTURE §20.2 and S11 ANM-002/003/007 define the behavior; (2) wrong seek, time, seed, or ease produces wrong frames or a running engine; (3) fixed numerical examples, frame-order comparison with a fresh timeline, and unchanged values after a seek supply oracles independent of implementation; (4) the exported runtime functions/hooks are the seam; (5) their outputs survive internal timeline/cache refactors; (6) the runtime package owns this behavior below compositions. |
| U (Unicode and DOM leaf API) | (1) S11 TXA-010/011 and ARCHITECTURE §20.2 define segmentation, shaping fallback, line groups, and leaf cleanup; (2) broken output splits glyphs, changes line animation, or leaves attributes on a remount; (3) known Unicode strings, grouped offset-parent boxes, and pre/post mount styles supply oracles; (4) exported functions/hooks and DOM output are the seams; (5) a different segmentation/layout algorithm can pass; (6) these helpers are the lowest stable owner, while compositions owns final text paint. |
| C (catalogue) | (1) S11 TXA-002/003 requires every offered preset and ease to work; (2) missing entries fail when a user selects them; (3) project catalogue values are independent of motion's implementation table; (4) `textAnimationImpl` and the package's published ease names are public; (5) registry storage can change without changing resolution; (6) this is the boundary between project metadata and the motion runtime. |
| D (text determinism) | (1) S11 ANM-013 requires every registered text animator to be frame-order independent; (2) seeking or exporting in another order shows different text frames; (3) a fresh build at the same frame is the independent oracle; (4) the documented `TextAnimationImpl.build` result is the stable package seam; (5) tween implementation can change while returned frame values remain equal; (6) this package owns the build contract; browser parity owns the final pixels. |
| G (visible regressions) | (1) the review-fix table records real callout and counter defects; (2) the first callout frames show a ring or a large counter jumps in 25-unit steps; (3) invisible ring at frame 0/head handle and exact numerical endpoints plus intervening nonmultiples of 25 are independent expectations; (4) the rendered template DOM is the user-visible seam; (5) internal target/timeline design can change; (6) these tests sit at the lowest stable component seam and do not replay the browser parity comparison. |
| E (render parity) | (1) S11 ANM-014/015 specifies still, export, Player, order, concurrency, and 200-unit performance; (2) exports differ from preview or seek history changes pixels, or scrubbing slows; (3) independent renderer paths and fresh stills are compared, with an animated control frame; (4) the real `SequenceComposition` through Remotion and Player is the stable seam; (5) DOM structure and animation implementation can change while pixels still agree; (6) the browser render boundary is necessary for these cross-renderer contracts. The test emits decoded media and JSON reports under a printed artifact directory. |

## Disposition by original test

Names with a dynamic id represent each generated test case from the original loop. “REWRITE” means the original assertion was replaced by the retained test named in parentheses.

### `packages/motion/test/runtime.test.tsx`

| Original test | Disposition, detected failure or stronger owner | Bar |
| --- | --- | --- |
| pins anime.js 4.5.0 exactly | KEEP: an accidental dependency upgrade invalidates render keys; exact pin is S11 ANM-011. | R |
| never autoplays and never wakes the engine loop | REWRITE (`never autoplays when the caller requests autoplay`): retained paused timeline output; removed private `engine.reqId`. | R |
| a plain seek is history-dependent; the canonical seek is not | KEEP: regression for history-dependent gap tween. | R |
| any visit order gives the values of a fresh build | KEEP: arbitrary visit orders on the exported seek function. | R |
| frameToMs = frame * 1000 / fps | KEEP: frame-rate conversion, including fractional fps. | R |
| hash32 is FNV-1a over UTF-8 | REWRITE: replaced a self-equality of `é` with its independent known UTF-8 hash. | R |
| seededRandom is deterministic per seed and in [0, 1) | KEEP: seeded sequence and valid range used for repeatable random order. | R |
| is a closed list of anime ease names; steps resolves to a function | REWRITE (`resolves steps and falls back for an unknown ease`): removed registry self-comparison and all-ease smoke loop. | R |
| returns frozen copies of the seeked values | KEEP: hook snapshot values cannot mutate after a later seek. | R |
| gives identical values for shuffled frame orders | KEEP: the mounted hook's caller-visible values equal a fresh mount. | R |
| builds once ready, seeks per ms before paint and reverts on unmount | REWRITE: retained ready gate, DOM opacity, and cleanup; removed build-count assertions. | U |
| segments graphemes with whitespace as non-animated segments | DELETE: broader Unicode segmentation case below covers graphemes and whitespace. | U owner |
| segments words, keeps punctuation with its word and the text intact | DELETE: broader word round-trip/property case below. | U owner |
| needsShaping detects RTL and complex scripts | DELETE: broader script set below. | U owner |
| groupLines groups by layout boxes | DELETE: offset-parent line grouping case below covers this. | U owner |
| are keyed id@version and expose the rest values | DELETE: export inventory and declaration against itself; catalogue and determinism tests own useful behavior. | C/D owners |
| createPausedTimeline drops loop / frameRate / alternate | KEEP: prevents infinite/history-dependent timeline and preserves finite-frame seeking. | R |
| createPausedTimeline drops unsafe keys from defaults | REWRITE: retained output under inherited unsafe defaults and caller object integrity; removed private defaults-shape checks. | R |
| resolveEase steps: non-finite counts fall back to 8 | KEEP: malformed step option still gives a finite usable easing. | R |
| valuesAt frozen per-time results are cached | DELETE: cache identity is an implementation choice; hook frozen/order behavior remains. | R owner |
| values handed to React are rounded to 1e-6 | DELETE: private `valuesAt` probe; final rest equality is owned by compositions and counter precision has a visible regression. | G/compositions owners |
| useAnimeValues StrictMode and buildKey change | REWRITE: retained caller values after key/time changes; removed build count. | R |
| useAnimeDom StrictMode re-mount and added attributes | REWRITE: retained clean attribute state and output after remount; removed exact build counts. | U |
| segmentText keeps grapheme clusters: combining marks, ZWJ, flags, CRLF, NBSP | KEEP: these concrete graphemes remain intact with correct unit indices. | U |
| segmentText words: CJK/Thai, emoji, tabs, round-trip | KEEP: text is neither dropped nor split into invalid words, with property round-trip. | U |
| segmentText without Intl.Segmenter approximates clusters | KEEP: browser fallback remains usable. | U |
| needsShaping newer RTL scripts, controls, complex scripts and joiners | KEEP: shaping fallback chooses word units for affected scripts. | U |
| groupLines through offset parents | KEEP: nested positioned wrappers still group units into the correct lines. | U |

### `packages/motion/test/text.test.ts`

| Original test | Disposition, detected failure or stronger owner | Bar |
| --- | --- | --- |
| has exactly one implementation per catalogue entry | REWRITE (`every offered preset resolves and an unknown version does not`): tests actual lookup at the project/motion boundary; removed key and default declaration checks. | C |
| catalogue ease list is runtime EASES list | REWRITE (`every offered ease has a runtime implementation`): checks supported project choices resolve; removed exact two-list equality. | C |
| each preset id: in/reverse/shuffle/fresh, In and Out | DELETE for every id: `determinism.test.tsx` runs broader build cases. | D owner |
| every preset ends at rest and starts away | DELETE: determinism harness and composition rest rendering own it. | D/compositions owners |
| start values per preset follow params | DELETE: asserts internal target geometry; compositions owns visible movement. | compositions owner |
| pop overshoots and keeps window length | DELETE: private tween duration/scale; rendered animation is the stable owner. | compositions owner |
| stagger spreads starts in chosen order | DELETE: private unit opacity sequence; composition animation and determinism own visible result. | compositions/D owners |
| typewriter reveals one unit per slot | DELETE: private unit values and caret flags; composition text test owns displayed typing. | compositions owner |
| typewriter@1 output unchanged | DELETE: compares implementation builds; composition test owns versioned displayed behavior. | compositions owner |
| types within typing after delay | DELETE: private schedule; composition test owns typed output. | compositions owner |
| In solid/blinks/rest; In delay; idle between keystrokes; Out mirrored | DELETE each: exact per-frame caret tracks are a private callback rendering of visible behavior already owned by composition tests. | compositions owner |
| caretBlink false, blinkRate, caret false | DELETE: direct private `caretVisible` checks duplicate rendered caret cases. | compositions owner |
| caret order independent | DELETE: determinism harness and browser parity cover order. | D/E owners |
| orderRanks forward/backward/center/edges/random | DELETE: private rank arrays; documented public export preserved, but test expected implementation-shaped ordering. | compositions owner |
| In forward, Out mirrored, rest between | DELETE: `TextLayer` composition test owns the visible window behavior. | compositions owner |
| transition handles clamp and missing sides rest | DELETE: composition test owns handle/rest behavior. | compositions owner |
| char units fall back for RTL/complex | DELETE: composition test owns visible text shaping fallback. | compositions owner |

### `packages/motion/test/templates.test.tsx` (file deleted)

| Original test | Disposition, detected failure or stronger owner |
| --- | --- |
| catalogue/implementation inventory and ease subset | DELETE: exact export inventory; `determinism-render.e2e.test.ts` renders installed entries and `mg-templates` owns metadata. |
| each template key: value determinism | DELETE for every key: internal target comparisons duplicate browser render order proof. |
| each template id/version: markup determinism | DELETE for every id/version: serialized markup changes on harmless DOM refactors; browser pixels own parity. |
| each template id/version: responsive time | DELETE for every id/version: raw markup equality; `mg-templates` owns intro/outro timing. |
| title-reveal hold/underline/random; counter text/formatter; callout drawable/geometry; lower-third wipe | DELETE each: private DOM attributes, style strings, and geometry. Counter formatting is in `mg-templates`; render parity and component regressions remain. |

### `packages/motion/test/templates-review.test.tsx`

| Original test | Disposition, detected failure or stronger owner | Bar |
| --- | --- | --- |
| each template id/version content root clips | DELETE for each: tests `overflow` implementation; `e2e/anime-templates.spec.ts` now tests the recorded out-of-bounds callout through Program and export pixels. | E2E owner |
| callout/lower-third parts inside each canvas | DELETE for 16:9, 9:16 and 1:1: geometry/appearance estimates; browser render comparison owns painted output. | E owner |
| title-reveal/counter text fits each canvas | DELETE for each canvas: estimated text widths can disagree with real glyphs and do not prove clipping. | E owner |
| ring build starts invisible, pulses, ends | DELETE: private target values; component ring test below owns the visible defect. | G owner |
| renders no ring in first frames | REWRITE (`callout pulse is hidden at clip start and head handle`): kept rendered opacity at the two defect frames; removed redundant hold. | G |
| 0 → 25,000,000 count not quantized | REWRITE (`large counter advances at frame precision and reaches both endpoints`): kept displayed endpoints and nonmultiples of 25; reduced setup and loop. | G |
| progress exact at ends/un-rounded in between | DELETE: private progress helpers and a self-equality; displayed counter above owns precision. | G owner |

### `packages/motion/test/determinism.test.tsx`

| Original test | Disposition, detected failure or stronger owner | Bar |
| --- | --- | --- |
| visit order generator, correct text fixture, param variants, broken text fixtures, caret fixture, correct template fixture, parity scene fixture, broken template fixtures | DELETE each: tests of test-only harness/fixtures, not production behavior; registered animator test remains and the browser parity path exercises real compositions. | D/E owners |
| table keyed by implementation key; table keyed id@version | DELETE each: declaration and export-shape inventories. | C owner |
| each registered text animator key order independent/rest/build contract | KEEP for every key: order-dependent target state, malformed documented build values, or wrong rest state fails. | D |
| each registered anime template key renders same DOM in any order | DELETE for every key: canonicalized raw HTML is a change detector; browser pixel parity includes each installed template. | E owner |

### `packages/motion/test/determinism-render.e2e.test.ts`

| Original test | Disposition, detected failure or stronger owner | Bar |
| --- | --- | --- |
| parity document expected shape | DELETE: asserts the test fixture against itself. | E owner |
| AnimeScene still/frames c1/c4/reversed/shuffled | DELETE: synthetic scene duplicates the stronger real Sequence path. | E owner |
| Sequence still/frames c1/c4/reversed/shuffled | KEEP: byte-different frame render or history-dependent seek fails. | E |
| renderMedia ProRes 4444 concurrency 1/4 | REWRITE: real Sequence only; media bytes and decoded frame size catch export concurrency drift. | E |
| AnimeScene Player vs still | DELETE: synthetic scene duplicates real Sequence comparison. | E owner |
| Sequence Player vs still | KEEP: preview/export pixel mismatch fails, with a control frame proving sensitivity. | E |
| AnimeScene Player revisits | DELETE: synthetic scene duplicates real Sequence revisit test. | E owner |
| Sequence Player revisits | KEEP: non-repeatable paused Player paint fails. | E |
| 200-unit title cost | REWRITE: benchmark a shipped `blur@1` animator instead of fixture `fourProps`/`riseImpl`; median first visit and revisit bounds remain. | E |

Deleted test-only support: `determinism-fixtures.tsx`, `determinism-render/scene.tsx`, and the fixture validation portion of `determinism.test.tsx`; removed unused template-DOM checker functions from `determinism-harness.tsx`. Public package exports were retained after checking documentation. Validation: `pnpm --filter @jasper/motion test` (38 passed, 5 skipped), `pnpm --filter @jasper/motion typecheck`, `pnpm exec biome check packages/motion`, and `git diff --check` all passed. `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/determinism-render.e2e.test.ts` passed 5/5; its Sequence ProRes videos, Player comparison report, and benchmark report are in `/var/lib/orquester/tmp/jasper-anm014-QF2Ne4`. Repo-wide gates are coordinated by the root agent.

## Exact-title crosswalk from the original files

This appendix repeats each original static title verbatim. Dynamic `${id}` rows expand to AnimeScene and Sequence; the two identical `${def.id}@${def.version}` labels in `templates.test.tsx` were separate markup and responsive-time loops (the value loop was titled `key`). The action and reasons above govern every generated id in a loop.

| Original path | Exact original title | Action and reason/class |
| --- | --- | --- |
| packages/motion/test/determinism-render.e2e.test.ts | the parity document has the expected shape (installed animators, templates, a keyframed shape) | DELETE: fixture asserted against itself; rendering tests exercise it (E). |
| packages/motion/test/determinism-render.e2e.test.ts | ${id}: renderStill per frame = renderFrames c1 = c4 = reversed = shuffled (byte-identical PNGs) | AnimeScene DELETE: synthetic duplicate. Sequence KEEP: real render or Player parity (E). |
| packages/motion/test/determinism-render.e2e.test.ts | renderMedia (ProRes 4444) at concurrency 1 and 4 decodes to identical frames | REWRITE: Sequence media comparison retained; synthetic AnimeScene branch removed (E). |
| packages/motion/test/determinism-render.e2e.test.ts | ${id}: the Player frame matches renderStill (≤ 3/255 on ≥ 99.5 % of the pixels) | AnimeScene DELETE: synthetic duplicate. Sequence KEEP: real render or Player parity (E). |
| packages/motion/test/determinism-render.e2e.test.ts | ${id}: a paused Player revisiting frames in any order shows byte-identical pixels | AnimeScene DELETE: synthetic duplicate. Sequence KEEP: real render or Player parity (E). |
| packages/motion/test/determinism-render.e2e.test.ts | ANM-015: a 200-unit title computes its values in ≤ 2 ms per frame (median, first visits) | REWRITE: Measures shipped blur@1 at the real value-engine seam, not a fixture animator (E). |
| packages/motion/test/determinism.test.tsx | visit orders: in order, reversed, shuffled and revisits, the same every run (fixed seeds) | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | accepts a correct text animator (both sides, several unit counts, 30 and 24 fps) | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | param variants come from the preset schema (defaults, then each enum value) | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | rejects unseeded randomness, shared targets, a wrong rest state and a too long timeline | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | checks a blinking caret: rejects one driven by the wall clock or by the visit history | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | accepts a correct anime template (value engine + DOM leaf), mounted once or fresh, StrictMode | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | accepts the render-parity scene (title in/out, template with a DOM leaf, shape) | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | rejects a template driven by a plain seek, and one using Math.random | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | the table is keyed by implementation key | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | ${key} is order-independent, rests outside its window and keeps the build contract | KEEP: registered text build order/rest contract (D). |
| packages/motion/test/determinism.test.tsx | the table is keyed id@version | DELETE: harness-only fixture/self-check or export inventory; retained registered text/Chrome tests own production behavior (D/E). |
| packages/motion/test/determinism.test.tsx | ${key} renders the same DOM whatever the frame order | DELETE: canonical raw HTML changes under a behavior-preserving refactor; Chrome pixel parity owns this (E). |
| packages/motion/test/runtime.test.tsx | a plain seek is history-dependent; the canonical seek is not (seek 1000 then 500 = fresh 500) | KEEP: documented runtime output; R six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | any visit order gives the values of a fresh build (fast-check, fixed seed) | KEEP: documented runtime output; R six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | hash32 is FNV-1a over UTF-8 (parts joined with U+001F) | REWRITE: Replaced self-equality for é with independently computed UTF-8 hash (R). |
| packages/motion/test/runtime.test.tsx | gives identical values for shuffled frame orders (one mounted instance) | KEEP: documented runtime output; R six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | groupLines groups by layout boxes (offsetTop/offsetHeight) | DELETE: Broader offset-parent line grouping test remains (U). |
| packages/motion/test/runtime.test.tsx | createPausedTimeline drops loop / frameRate / alternate (seek-only driving) | KEEP: documented runtime output; R six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | createPausedTimeline drops the unsafe keys from defaults too (children inherit them) | REWRITE: Retained output/caller-object assertions; removed private defaults-shape assertions (R). |
| packages/motion/test/runtime.test.tsx | valuesAt: frozen per-time results are cached and never affected by later seeks | DELETE: Cache identity is private; hook output tests remain (R). |
| packages/motion/test/runtime.test.tsx | values handed to React are rounded to 1e-6: exact rest values, no -0, no exponent notation | DELETE: Private valuesAt probe; displayed rest and counter precision have stable owners (G/compositions). |
| packages/motion/test/runtime.test.tsx | useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build | REWRITE: Retained caller-visible values after key/time changes; removed build count (R). |
| packages/motion/test/runtime.test.tsx | useAnimeDom: StrictMode re-mount rebuilds on pristine targets; build-added attributes are removed | REWRITE: Retained pristine attribute state and DOM output; removed build counts (U). |
| packages/motion/test/runtime.test.tsx | segmentText keeps grapheme clusters: combining marks, ZWJ emoji, flags, CRLF, NBSP | KEEP: documented runtime output; U six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | segmentText words: CJK/Thai dictionary words, emoji-only words, tabs; text always round-trips | KEEP: documented runtime output; U six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | needsShaping: RTL (incl. newer RTL scripts and bidi controls), complex scripts and joiners | KEEP: documented runtime output; U six-bar rationale above. |
| packages/motion/test/runtime.test.tsx | groupLines measures through offset parents (positioned wrappers) in the container space | KEEP: documented runtime output; U six-bar rationale above. |
| packages/motion/test/templates-review.test.tsx | ${d.id}@${d.version}: the content root clips (overflow hidden) | DELETE: overflow-style assertion fails refactor bar; e2e/anime-templates.spec.ts owns browser pixel coverage of the out-of-bounds callout defect. |
| packages/motion/test/templates-review.test.tsx | callout and lower-third-anim parts stay inside ${tag} | DELETE: geometric/estimated fit assertion fails visual and stable-seam bars; browser parity covers ordinary rendered frames (E). |
| packages/motion/test/templates-review.test.tsx | title-reveal and counter text fits ${tag} (estimated) | DELETE: geometric/estimated fit assertion fails visual and stable-seam bars; browser parity covers ordinary rendered frames (E). |
| packages/motion/test/templates-review.test.tsx | is invisible before it starts (first frame, head handles), visible during the pulse, gone at rest | DELETE: Private target values; rendered ring regression remains (G). |
| packages/motion/test/templates-review.test.tsx | renders no ring in the first frames of the clip | REWRITE: Retained rendered opacity at clip start and head handle (G). |
| packages/motion/test/templates-review.test.tsx | a 0 → 25,000,000 count is not quantised by the 1e-6 value rounding | REWRITE: Retained displayed endpoints and nonmultiple-of-25 progress (G). |
| packages/motion/test/templates-review.test.tsx | the progress is exact at the ends and un-rounded in between; the value is exactly from / to at rest | DELETE: Private helper and self-equality; displayed large counter remains (G). |
| packages/motion/test/templates.test.tsx | every anime catalogue entry has an implementation and vice versa | DELETE: export inventory/config duplicate; installed templates render in real Sequence (E). |
| packages/motion/test/templates.test.tsx | template eases are a subset of the runtime eases | DELETE: export inventory/config duplicate; installed templates render in real Sequence (E). |
| packages/motion/test/templates.test.tsx | ${def.id}@${def.version} | DELETE: generated raw-markup determinism comparison; Chrome pixels own parity (E). |
| packages/motion/test/templates.test.tsx | ${def.id}@${def.version} | DELETE: generated responsive-time raw-markup comparison; mg-templates owns timing. |
| packages/motion/test/templates.test.tsx | title-reveal: every char visible and the underline drawn at the hold; seeded random order | DELETE: private target/markup/style/geometry assertion; visible rendering or metadata has a stronger owner (E/mg-templates). |
| packages/motion/test/templates.test.tsx | callout: the leader line is drawn by the drawable at the hold; the motion-path box sits at the line end | DELETE: private target/markup/style/geometry assertion; visible rendering or metadata has a stronger owner (E/mg-templates). |
| packages/motion/test/templates.test.tsx | lower-third-anim: the panel is fully revealed at the hold and wiped at the start | DELETE: private target/markup/style/geometry assertion; visible rendering or metadata has a stronger owner (E/mg-templates). |
| packages/motion/test/text.test.ts | has exactly one implementation per catalogue entry, keyed id@version | REWRITE: Retained catalogue lookup and missing-version behavior; removed key inventory (C). |
| packages/motion/test/text.test.ts | the catalogue ease list is the runtime EASES list | REWRITE: Retained supported ease resolution; removed exact list equality (C). |
| packages/motion/test/text.test.ts | ${spec.id}: in order = reversed = shuffled = a fresh build per frame, In and mirrored Out | DELETE: broader registered-text determinism harness owns this (D). |
| packages/motion/test/text.test.ts | every preset ends exactly at rest and starts away from it | DELETE: private tween/target/rank shape; compositions owns visible animation. |
| packages/motion/test/text.test.ts | start values per preset follow the params | DELETE: private tween/target/rank shape; compositions owns visible animation. |
| packages/motion/test/text.test.ts | pop overshoots (spring ease) while keeping the window length | DELETE: private tween/target/rank shape; compositions owns visible animation. |
| packages/motion/test/text.test.ts | stagger spreads unit starts over the window in the chosen order | DELETE: private tween/target/rank shape; compositions owns visible animation. |
| packages/motion/test/text.test.ts | typewriter reveals one unit per slot from the start of the window | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | @1 output is unchanged: same reveal timing, caret always lit (no caretVisible) | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | In: solid while typing, blinks after typing finishes, never at rest | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | In with a delay: blinks before the first unit, lit when typing starts | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | blinks between keystrokes further apart than half a period (idle between units) | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | Out (mirrored): blinks first, then deletes backwards with a solid caret, rest before the window | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | caretBlink false keeps it solid; blinkRate sets the period; caret false hides it | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | is order-independent (shuffled frame visits give the same caret as in order) | DELETE: broader registered-text determinism harness owns this (D). |
| packages/motion/test/text.test.ts | forward, backward, center, edges and a seeded random permutation | DELETE: private tween/target/rank shape; compositions owns visible animation. |
| packages/motion/test/text.test.ts | In plays forward from the first frame, Out mirrored to the last; rest between | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | transition handles clamp to the start/end states; missing sides are rest | DELETE: compositions test owns displayed text, caret, or window behavior. |
| packages/motion/test/text.test.ts | char units fall back to words for RTL and complex scripts | DELETE: compositions test owns displayed text, caret, or window behavior. |
