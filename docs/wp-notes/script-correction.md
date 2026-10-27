# Script-guided transcript correction (spec 17)

## Personal glossary

Work package `scglossary` (spec 17 SC-070, SC-071 helpers, SC-072, SC-091 glossary tools). The user's own list of
names and words the speech recogniser gets wrong: a right spelling (`to`) with the spellings Whisper writes for it
(`from`), optionally for one language, and how often the user taught it (`count`).

### Storage (`apps/engine/src/speech/glossary.ts`)

- One file per app dir: `<appdir>/speech/glossary.json` (`paths.speechGlossaryFile`), shared by every project,
  editor window and agent; app state, not the project (no schema change). Format
  `{format: "jasper-speech-glossary", version: 1, revision, entries: [{id, from, to, lang?, count, createdAt,
  updatedAt}], invalid?}`.
- Writes are serialised and atomic (`atomicWriteJson`: temp file, fsync, rename, directory fsync); the in-memory state
  moves only after the write, so a failed write (disk full) changes nothing. Every change bumps `revision` and
  publishes `glossary.changed {revision}`; a save that changes nothing writes nothing.
- Opening repairs conservatively and reports each repair in `GET /api/speech/glossary` `repairs` (shown in
  Preferences): an unreadable file (not JSON, not an object, another `format`, no valid version) is renamed
  `glossary.json.corrupt-<time>` and an empty glossary starts; entries that no longer validate, duplicate ids,
  duplicate target + language pairs and entries beyond 2,000 are kept aside in `invalid` and written back, never
  dropped.
- A file with `version > 1` is listed (known fields only) with `readOnly: true` and never rewritten; every write is
  refused with 409 `GLOSSARY_READ_ONLY` (MCP `E_READ_ONLY`).

### Rules (`packages/project/src/glossary/schema.ts`, pure)

- Texts are cleaned (NFC, control characters and line breaks as spaces, single spaces, trimmed) and must be 1–64
  code points with a letter or digit. ≤ 20 spellings per entry, ≤ 2,000 entries (`GLOSSARY_LIMITS`).
- Spellings are compared without case (the recogniser's casing is not a spelling) and never equal the target; the
  target is exact and case-sensitive ("NovaPlay" and "Novaplay" are different spellings). Assumption (not in the
  spec): an entry is keyed by target + language; an entry without `lang` and one with `lang: "es"` are separate.
- Save = add, or merge the new spellings into the entry with the same key (idempotent). Remember = the same and
  `count + 1` (a new entry starts at 1, a saved one at 0). A spelling may belong to several entries: deciding between
  targets is the audio check's job (SC-073), so nothing is silently moved between entries.
- Edit replaces fields; a key another entry has is refused (`GLOSSARY_DUPLICATE`). Import (`parseGlossaryImport`)
  reads an exported file or a bare list `[{from, to, lang?}]` leniently (`from` may be one string; ids, unknown keys
  and bad dates ignored), skips unusable entries with a reason and their position in the file, refuses another format
  or a newer version as a whole, reads at most 10,000 entries; merging is additive (new spellings up to 20, the larger
  count, the earlier creation date; the rest reported).

### Routes, client, events

| Route | Client method | Notes |
|---|---|---|
| `GET /api/speech/glossary` | `listGlossary()` | `{revision, readOnly, repairs, limits, entries}` |
| `GET /api/speech/glossary/export` | `exportGlossary()` | the importable file (entries kept aside are not exported) |
| `GET /api/speech/glossary/:entryId` | `getGlossaryEntry(id)` | 404 `GLOSSARY_NOT_FOUND` |
| `POST /api/speech/glossary` | `saveGlossaryEntry({from, to, lang?})` | 201 created / 200 merged; `{revision, created, changed, entry}` |
| `POST /api/speech/glossary/remember` | `rememberGlossaryEntry({from, to, lang?})` | SC-071 Remember: same, `count + 1` |
| `PUT /api/speech/glossary/:entryId` | `updateGlossaryEntry(id, {from?, to?, lang?: string \| null})` | an agent dropping spellings or changing the target needs the user's approval |
| `DELETE /api/speech/glossary/:entryId` | `removeGlossaryEntry(id)` | an agent needs the user's approval (`requireUserApproval`, AGT-3) |
| `POST /api/speech/glossary/import` | `importGlossary(file)` | `{revision, added, merged, unchanged, skipped: [{index, reason}]}`; 400 `GLOSSARY_IMPORT_INVALID` |

Request bodies are zod-validated at the route (`packages/api/src/glossary.ts`; strict objects, bounded strings and
lists) and then cleaned and checked by the rules (400 `GLOSSARY_INVALID`, 409 `GLOSSARY_LIMIT`). Event:
`glossary.changed {revision}`.

### "Replace all N" finder (`packages/project/src/glossary/replace-all.ts`, SC-071)

`findReplaceAllInSequence(doc, sequenceId, {oldWords, newText, exclude?}) → {occurrences, commands, truncated}` (and
`findReplaceAll(transcripts, query)`, `sequenceMediaTranscripts(doc, sequenceId)`). It searches the media transcripts
of the sequence's audio clips for the same run of words compared with `normalizeWord` (markup and edge punctuation
removed, lower case, accents kept) and returns plain data in the `transcript.replaceWords` edit shape of SC-050:
`{start, end, expect, words: [{text, start, end, confidence: null}]}` per occurrence and one
`{type: 'transcript.replaceWords', transcriptId, edits}` per transcript, edits sorted by time and disjoint. Each
occurrence keeps its own leading ¿ ¡ « “ ( and trailing . , ; : ! ? … » ” ) (the correction's own edge punctuation is
dropped), gets a capital first letter where the recogniser capitalised the first old word (as SC-031 does for
readings; the user's casing is kept otherwise — an assumption), and its span is split among the new words by
character count (like `transcript.editText` and SC-042). Left out: the edited span (`exclude`), occurrences that
would not change, spans shorter than the word count, and empty corrections (deleting everywhere is not a spelling
fix). Bounds: ≤ 20 query words, ≤ 1,000 characters, ≤ 5,000 occurrences (the rest counted in `truncated`). The
command itself is the `scapply` package's; the offer in the Transcript tab is `scweb`'s.

### MCP (`apps/mcp/src/tools/glossary.ts`)

`list_glossary {query?, lang?}` (read-only), `save_glossary_entry {to, from, lang?}` (idempotent edit),
`remove_glossary_entry {entryId}` (destructive, idempotent; the engine asks the user in an open editor window).
Strict schemas and the four annotation hints (`conventions.test.ts`); refusals map to `E_READ_ONLY`, `E_LIMIT`,
`E_INVALID_PARAM`, `E_NOT_FOUND`, `E_APPROVAL_DENIED`. `GLOSSARY_GUIDE` is part of the `jasper://guide` resource.

### UI (`apps/web/src/speech/GlossaryPage.tsx`)

Edit ▸ Preferences ▸ Transcription ▸ Glossary (a sub-page: the Preferences registry gained `parent`, listed indented
and titled "Transcription ▸ Glossary"), also Edit ▸ Preferences ▸ Speech Glossary… (command `speech.glossary`, no
default shortcut). List sorted by target with language and count, search over targets and spellings, New Entry and
Edit… inline (spellings one per line or comma-separated, language "Any language" or a Whisper language), Delete after
a confirmation (no undo), Import… (summary with skipped reasons) and Export… (`glossary.json`), the read-only banner
(editing disabled, export kept), the repair notice, load failures and the engine's refusals shown on the page. Design
tokens only; English and Spanish strings.

### Validation (build VM, 2026-10-27)

- `packages/project/test/glossary.test.ts` (rules, caps, import parser with a fast-check property: never throws, only
  storable entries, bounded, idempotent re-import), `glossary-replace-all.test.ts` (finder, fast-check property:
  sorted, disjoint, inside the span, `expect` equals the transcript words, deterministic).
- `apps/engine/test/speech-glossary.test.ts` (atomic write and restart, a failed write changes nothing, corrupt file
  moved aside and reported, invalid / duplicate / over-the-cap entries kept aside, newer version read-only, route zod
  refusals, merge, Remember, edit, export → import round trip, approval for an agent's delete and lossy edit).
- `packages/engine-client/test/glossary.test.ts`, `apps/mcp/test/glossary.test.ts`, `apps/mcp/test/conventions.test.ts`,
  `apps/web/test/glossary-preferences.test.tsx`.
- Exercised in the VM dev stack (engine 47944, vite 5214): a corrupt file reported, add, merge, Remember counts,
  duplicate-target refusal shown in the form, delete after confirmation, import with a skipped entry, export download,
  read-only file, Spanish UI.

### Limitations

- The "Replace all N" / "Remember" offers after a manual edit are `scweb`'s; glossary candidates (SC-073) are
  `scalign`'s; glossary prompting (SC-074) is `scscore`'s. Until they land the glossary is maintained in Preferences
  and through MCP only.
- Repair messages come from the engine in English (as for the font library).
