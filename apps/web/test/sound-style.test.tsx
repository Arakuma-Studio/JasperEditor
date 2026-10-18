// The sound design style in the editor (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"): Auto Sound Pass… and Suggest
// Cues… show the cue grammar (personality with its one-line description, runs, typing, music carries the cuts, duck
// under typing), start from the sequence's style, and send / store what the user chose; a personality sets its default
// density. Preferences ▸ Sound Library ▸ Sound design style edits the sequence's style as one undo step. Fill With keeps
// the variation policy (keys and the click voice at speed 1, no gain jitter for the click). Variation cycling of a take
// walks its sibling takes.
import type { SoundDesignPlanRequest, SoundEntry } from '@jasper/api';
import type { AudioClip, ClipSfx } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { AutoSoundPassDialog } from '../src/sound/AutoSoundPassDialog.tsx';
import { cuesOf } from '../src/sound/cues/model.ts';
import { SuggestCuesDialog } from '../src/sound/cues/SuggestCuesDialog.tsx';
import { variationList } from '../src/sound/design-model.ts';
import { fillCueWithSound } from '../src/sound/fill.ts';
import { StylePreference } from '../src/sound/PreferencesPage.tsx';
import { fakePlanEngine, planResult, storeProposal } from './review-helpers.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => cleanup());

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

function edit(style?: Record<string, unknown>) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 1, 0, 1] },
			{ type: 'clip.addSolid', at: 120, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
			...(style ? [{ type: 'soundDesign.setSettings', style }] : []),
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, seqId };
}

function autoPass(style?: Record<string, unknown>) {
	const { session, seqId } = edit(style);
	const proposals = new FakeEngine(() => session);
	proposalsFor(session, { engine: proposals });
	const sounds = fakeSoundEngine([soundEntry({ title: 'Crunch' })]);
	const plan = fakePlanEngine(session, (req) => {
		const id = storeProposal(proposals, seqId, 'Sound design: Seq', [60]).id;
		return planResult({ proposalId: id, projectId: req.projectId, sequenceId: seqId, placed: 1 });
	});
	const closed: unknown[] = [];
	render(
		<SessionProvider session={session}>
			<AutoSoundPassDialog
				session={session}
				engine={{ ...sounds.client, ...plan } as never}
				sequenceId={seqId}
				close={(x) => closed.push(x)}
			/>
		</SessionProvider>,
	);
	return { session, seqId, plan, closed };
}

describe('Auto Sound Pass… sound design style', () => {
	it('a personality shows its description and sets its density; the grammar choices go into the plan', async () => {
		const t = autoPass();
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await settle();
		const style = within(dialog).getByTestId('auto-pass-style');
		expect(within(style).getByTestId('sound-style-personality-description').textContent).toBe(
			'Sounds are ranked by fit alone; the density is yours.',
		);
		await chooseOption(within(style).getByRole('combobox', { name: 'Personality' }), 'Calm');
		expect(within(style).getByTestId('sound-style-personality-description').textContent).toBe(
			'Soft, dark and sparse: no booms or hits, gentle attacks, wood and paper.',
		);
		// calm brings the sparse density
		expect(within(dialog).getByRole('combobox', { name: 'Density' }).textContent).toMatch(/^Sparse/);
		await chooseOption(within(style).getByRole('combobox', { name: 'Typing sounds' }), 'One key per word');
		await chooseOption(within(style).getByRole('combobox', { name: 'Runs of staggered cues' }), /^Flat/);
		fireEvent.click(within(style).getByRole('checkbox', { name: /Music carries the cuts/ }));
		fireEvent.click(within(style).getByRole('checkbox', { name: /Duck the music 6 dB under typing/ }));
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(() => expect(t.plan.requests).toHaveLength(1), { timeout: 5000 });
		const req = t.plan.requests[0] as SoundDesignPlanRequest;
		expect(req.style).toMatchObject({
			density: 'sparse',
			personality: 'calm',
			runs: 'flat',
			typing: 'words',
			musicCarriesCuts: false,
			duckUnderTyping: true,
		});
	});

	it('starts from the sequence’s style; "No personality" sends null (none, whatever the sequence says)', async () => {
		const t = autoPass({ personality: 'warm', runs: 'flat' });
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await settle();
		const style = within(dialog).getByTestId('auto-pass-style');
		expect(within(style).getByRole('combobox', { name: 'Personality' }).textContent).toBe('Warm');
		expect(within(style).getByRole('combobox', { name: 'Runs of staggered cues' }).textContent).toMatch(
			/^Flat/,
		);
		await chooseOption(within(style).getByRole('combobox', { name: 'Personality' }), 'No personality');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(() => expect(t.plan.requests).toHaveLength(1), { timeout: 5000 });
		expect(t.plan.requests[0]!.style).toMatchObject({ personality: null, runs: 'flat', typing: 'auto' });
	});
});

describe('Suggest Cues… sound design style', () => {
	it('a personality leaves its excluded types out of the suggestions; what changed is stored in the same step', async () => {
		const { session, seqId } = edit();
		render(
			<SessionProvider session={session}>
				<SuggestCuesDialog session={session} sequenceId={seqId} close={() => {}} />
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('suggest-cues-dialog');
		await settle();
		const style = within(dialog).getByTestId('suggest-cues-style');
		// only personality, typing and music carries the cuts here
		expect(within(style).queryByRole('combobox', { name: 'Runs of staggered cues' })).toBeNull();
		await chooseOption(within(style).getByRole('combobox', { name: 'Personality' }), 'Calm');
		const before = session.getState().history.entries.length;
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: /^Suggest/ }));
		});
		const seq = session.getCommitted().sequences[seqId]!;
		const cuts = cuesOf(seq).filter((c) => c.kind === 'cut');
		expect(cuts.length).toBeGreaterThan(0);
		for (const c of cuts) expect(c.types).not.toContain('hit');
		const settings = (seq.soundDesign as { settings?: { density?: string; style?: unknown } }).settings;
		expect(settings?.density).toBe('sparse');
		expect(settings?.style).toEqual({ personality: 'calm' });
		// one undo step
		expect(session.getState().history.entries.length).toBe(before + 1);
	});
});

describe('Preferences ▸ Sound design style', () => {
	it('edits the active sequence’s style, one undo step per change', async () => {
		const { session, seqId } = edit();
		render(
			<SessionProvider session={session}>
				<StylePreference />
			</SessionProvider>,
		);
		const group = await screen.findByTestId('prefs-sound-style');
		await chooseOption(within(group).getByRole('combobox', { name: 'Personality' }), 'Mechanical');
		const style = () =>
			(session.getCommitted().sequences[seqId]!.soundDesign as { settings?: { style?: unknown } } | undefined)
				?.settings?.style;
		expect(style()).toEqual({ personality: 'mechanical' });
		fireEvent.click(within(group).getByRole('checkbox', { name: /Duck the music 6 dB under typing/ }));
		expect(style()).toEqual({ personality: 'mechanical', duckUnderTyping: true });
		expect(session.getState().history.entries.at(-1)?.label).toBe('Sound Design Style');
		session.undo();
		expect(style()).toEqual({ personality: 'mechanical' });
	});
});

describe('Fill With keeps the variation policy', () => {
	function fill(types: string[], cueTypes: string[]) {
		const entries = [soundEntry({ title: `A ${types[0]}`, types })];
		const engine = fakeSoundEngine(entries);
		const { session, seqId } = makeSession();
		const r = session.apply({
			label: 'cue',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'soundCue.add',
					cues: [{ frame: 90, kind: 'appear', weight: 'support', types: cueTypes, source: 'user' }],
				},
			] as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const cueId = (r.results[0] as { cueIds: string[] }).cueIds[0]!;
		return { session, seqId, entries, engine, cueId };
	}
	const placed = async (types: string[], cueTypes: string[]) => {
		const s = fill(types, cueTypes);
		const out = await fillCueWithSound(s.session, s.engine.client as never, s.entries[0]!, {
			sequenceId: s.seqId,
			cueId: s.cueId,
		});
		return s.session.getCommitted().sequences[s.seqId]!.clips[out.clipId] as AudioClip & { sfx: ClipSfx };
	};

	it('a click is the voice (speed 1, no gain offset); a key varies its level only; a hit varies both', async () => {
		const click = await placed(['click'], ['click']);
		expect(click.speed.rate).toBe(1);
		expect((click.sfx.level as { offsetDb?: number } | undefined)?.offsetDb ?? 0).toBe(0);
		const key = await placed(['key'], ['key', 'tick']);
		expect(key.speed.rate).toBe(1);
		const hit = await placed(['hit'], ['hit']);
		expect(Math.abs(hit.speed.rate - 1)).toBeLessThanOrEqual(0.02);
	});
});

describe('variation cycling of a take', () => {
	it('walks the recording’s other clean takes after the ring, before the family', () => {
		const rec: SoundEntry = soundEntry({ title: 'Typing', types: ['key'] });
		const t1 = `${rec.id}~t1`;
		const list = variationList(
			t1,
			[t1, 'snd_00000000000000ab'],
			['snd_00000000000000cd'],
			['snd_00000000000000ef'],
			[`${rec.id}~t2`, `${rec.id}~t3`],
		);
		expect(list).toEqual([
			t1,
			'snd_00000000000000ab',
			`${rec.id}~t2`,
			`${rec.id}~t3`,
			'snd_00000000000000cd',
			'snd_00000000000000ef',
		]);
	});
});
