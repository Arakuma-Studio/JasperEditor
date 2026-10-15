// Phase 2 verification (spec 12 §2.7 "Variation cycling", P2-R7): presses of one run are ONE history entry whose
// count and position follow only the steps that happened (a failed step neither advances the cycle nor counts); a
// run is closed by another edit, another selection, undo; one undo restores the original exactly. The commands are
// only enabled where they can act (project audio with a detected peak has no variation to cycle).
import type { SoundEntry } from '@jasper/api';
import type { AudioClip, ClipSfx, Sequence } from '@jasper/project';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	getCommand,
	isCommandEnabled,
	registerAllCommands,
	type ToastRequest,
} from '../src/commands/index.ts';
import { cancelLibraryMode, requestCueFill } from '../src/sound/controller.ts';
import { fillCueWithSound } from '../src/sound/fill.ts';
import { stopInContext } from '../src/sound/in-context.ts';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { cycleVariation, resetVariationRun, type VariationStep } from '../src/sound/swap.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	stopInContext({ returnToAnchor: false });
	cancelLibraryMode();
	requestCueFill(null);
	resetVariationRun();
	soundLibraryPrefs.set({ auditionOnSwap: true });
});

type SfxClip = AudioClip & { sfx?: ClipSfx };

function entries(): SoundEntry[] {
	return [
		soundEntry({ title: 'Crunch', peakSec: 0.25, durationSec: 1 }),
		soundEntry({ title: 'Thud', peakSec: 0.2, durationSec: 0.8 }),
		soundEntry({ title: 'Smack', peakSec: 0.3, durationSec: 1.1 }),
		soundEntry({ title: 'Clap', peakSec: 0.15, durationSec: 0.6 }),
		soundEntry({ title: 'Knock', peakSec: 0.1, durationSec: 0.5 }),
	];
}

async function filled() {
	soundLibraryPrefs.set({ auditionOnSwap: false });
	const list = entries();
	const { session, seqId } = makeSession();
	const fake = fakeSoundEngine(list);
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine: fake.client as never,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		capabilities: ['engine'],
		toast: (r) => toasts.push(r),
	});
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const cueId = (
		apply([
			{
				type: 'soundCue.add',
				cues: [{ frame: 90, kind: 'land', weight: 'hero', types: ['hit'], source: 'user' }],
			},
		]).results[0] as { cueIds: string[] }
	).cueIds[0]!;
	const r = await fillCueWithSound(session, fake.client as never, list[0]!, {
		sequenceId: seqId,
		cueId,
		alternatives: list.slice(1).map((e) => e.id),
	});
	session.select('timeline', [r.clipId], 'replace');
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const soundOf = () => (seq().clips[r.clipId] as SfxClip).sfx!.soundId;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const press = async (dir: 1 | -1 = 1) => {
		const steps: VariationStep[] = [];
		await cycleVariation(session, fake.client as never, dir, (s) => steps.push(s));
		return steps;
	};
	return { list, session, seqId, fake, ctx, toasts, apply, clipId: r.clipId, seq, soundOf, labels, press };
}

describe('Variation cycling runs', () => {
	it('a step that fails (the engine cannot register the sound) neither advances the cycle nor counts', async () => {
		const h = await filled();
		const original = h.session.getCommitted();
		const n = h.labels().length;
		expect((await h.press())[0]).toMatchObject({ ok: true });
		expect(h.soundOf()).toBe(h.list[1]!.id);
		// the engine is offline for the next press
		const register = h.fake.client.registerSound;
		h.fake.client.registerSound = async () => {
			throw new Error('engine offline');
		};
		expect((await h.press())[0]).toMatchObject({ ok: false });
		expect(h.soundOf()).toBe(h.list[1]!.id);
		h.fake.client.registerSound = register;
		// the next press goes to the variation the failed one could not reach, and counts two swaps
		expect((await h.press())[0]).toMatchObject({ ok: true, steps: 2 });
		expect(h.soundOf()).toBe(h.list[2]!.id);
		expect(h.labels()).toHaveLength(n + 1);
		expect(h.labels().at(-1)).toBe('Swap Sound ×2');
		h.session.undo();
		expect(h.session.getCommitted().sequences[h.seqId]).toEqual(original.sequences[h.seqId]);
	});

	it('another selection closes the run, even when the same clip is selected again', async () => {
		const h = await filled();
		const n = h.labels().length;
		await h.press();
		await h.press();
		expect(h.labels()).toHaveLength(n + 1);
		h.session.select('timeline', [], 'replace');
		h.session.select('timeline', [h.clipId], 'replace');
		await h.press();
		expect(h.labels()).toHaveLength(n + 2);
		expect(h.labels().at(-1)).toBe('Swap Sound');
	});

	it('undo closes the run: the next press is a new entry, and one more undo restores the first run', async () => {
		const h = await filled();
		const n = h.labels().length;
		await h.press();
		await h.press();
		await h.press();
		h.session.undo();
		expect(h.soundOf()).toBe(h.list[0]!.id);
		await h.press();
		expect(h.labels()).toHaveLength(n + 1);
		expect(h.labels().at(-1)).toBe('Swap Sound');
	});
});

describe('Variation commands are enabled only where they can act', () => {
	it('project audio with a detected peak (sfx, no library sound): Next / Previous Variation disabled', async () => {
		const h = await filled();
		h.apply([{ type: 'media.register', asset: { ...videoAsset(4), id: 'med_0000000000000ABC' } }]);
		h.apply([
			{ type: 'clip.place', source: { mediaId: 'med_0000000000000ABC' }, at: 300, tracks: { audio: 'A1' } },
		]);
		const a = Object.values(h.seq().clips).find(
			(c) => c.kind === 'audio' && (c as AudioClip).mediaId === 'med_0000000000000ABC',
		)!;
		h.apply([{ type: 'soundDesign.setPeak', clipId: a.id, peakFlicks: 705_600_000 / 2 }]);
		expect((h.seq().clips[a.id] as SfxClip).sfx).toBeTruthy();
		h.session.select('timeline', [a.id], 'replace', { linked: false });
		for (const id of ['sound.nextVariation', 'sound.prevVariation'])
			expect(isCommandEnabled(getCommand(id)!, h.ctx), id).toBe(false);
		// the library clip still cycles
		h.session.select('timeline', [h.clipId], 'replace', { linked: false });
		expect(isCommandEnabled(getCommand('sound.nextVariation')!, h.ctx)).toBe(true);
	});
});
