// Sound Library ▸ Import to Project (final verification B, spec 12 §1 "every UI action has an MCP twin, and the reverse"):
// MCP `import_sounds` adds library sounds to the project's "Sound Effects" bin without placing them; the editor had no
// way to do that. `importLibrarySounds` is that action: ONE undo step with the same History label as the tool ("Import
// Sound <title>" / "Import n Sounds"), no sequence needed, nothing placed, sounds already in the project reused.
import { SOUND_EFFECTS_BIN } from '@jasper/api';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n/runtime.ts';
import { InsertSoundError, importLibrarySounds } from '../src/sound/insert.ts';
import { registered, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => setLanguage('en'));

describe('Import to Project', () => {
	it('adds the sound to the "Sound Effects" bin in one undo step, places nothing, and reuses it the second time', async () => {
		const { session, seqId } = makeSession();
		const e = soundEntry({ title: 'Wood Knock' });
		const engine = { registerSound: async () => registered(e) };
		const before = session.getCommitted();
		const r = await importLibrarySounds(session, engine, [e]);
		expect(r).toMatchObject({ imported: 1, reused: 0 });
		expect(r.message).toBe(`Imported Wood Knock into the “${SOUND_EFFECTS_BIN}” bin`);
		const doc = session.getCommitted();
		const media = Object.values(doc.media).filter((m) => m.library?.title === 'Wood Knock');
		expect(media).toHaveLength(1);
		expect(media[0]!.library!.soundId).toBe(e.id);
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === SOUND_EFFECTS_BIN);
		expect(bin).toBeDefined();
		// nothing placed
		expect(Object.keys(doc.sequences[seqId]!.clips)).toEqual(Object.keys(before.sequences[seqId]!.clips));
		// one History entry, the tool's label; undo takes media and bin back
		const labels = () => session.getState().history.entries.map((x) => x.label);
		expect(labels().at(-1)).toBe('Import Sound Wood Knock');
		session.undo();
		expect(Object.keys(session.getCommitted().media)).toEqual(Object.keys(before.media));
		session.redo();
		// already in the project: reused, no new entry
		const n = labels().length;
		const again = await importLibrarySounds(session, engine, [e]);
		expect(again).toMatchObject({ imported: 0, reused: 1, message: 'Wood Knock is already in the project' });
		expect(labels().length).toBe(n);
	});

	it('several sounds: one entry "Import n Sounds"', async () => {
		const { session } = makeSession();
		const a = soundEntry({ title: 'A' });
		const b = soundEntry({ title: 'B' });
		const engine = { registerSound: async (id: string) => registered(id === a.id ? a : b) };
		const r = await importLibrarySounds(session, engine, [a, b]);
		expect(r.imported).toBe(2);
		expect(session.getState().history.entries.at(-1)?.label).toBe('Import 2 Sounds');
	});

	it('says why a registration failed; the document is unchanged', async () => {
		const { session } = makeSession();
		const e = soundEntry({ title: 'C' });
		const before = session.getCommitted();
		await expect(
			importLibrarySounds(
				session,
				{ registerSound: async () => Promise.reject(new Error('SOUND_NOT_FOUND')) },
				[e],
			),
		).rejects.toBeInstanceOf(InsertSoundError);
		expect(session.getCommitted()).toBe(before);
	});
});
