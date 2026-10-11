import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { transitionTree } from '../src/panels/effects/transitions.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

/** Two clips cut at 120 with a centred 20-frame Iris Round. */
function scene() {
	const { session, seqId } = makeSession();
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
	const reg = () =>
		(apply([{ type: 'media.register', asset: videoAsset(20, false) }]).results[0] as { mediaId: string })
			.mediaId;
	const a = reg();
	const b = reg();
	apply([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 120,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
	]);
	const r = apply([
		{
			type: 'transition.add',
			trackId: 'V1',
			at: 120,
			effectId: 'jasper.iris-round',
			duration: 20,
			ref: '$x',
		},
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	return { session, iris: r.refs.$x!, seq };
}

describe('Effects panel GPU transition bins', () => {
	it('groups transitions by bin and sub-bin, Sapphire after Premiere', () => {
		const video = transitionTree('').find((b) => b.appliesTo === 'video')!;
		const bins = video.categories.map((c) => c.category);
		expect(bins).toEqual(
			expect.arrayContaining(['Dissolve', 'Iris', 'Slide', 'Zoom', 'Sapphire Transitions']),
		);
		expect(bins[bins.length - 1]).toBe('Sapphire Transitions');
		const sapphire = video.categories.find((c) => c.category === 'Sapphire Transitions')!;
		expect(sapphire.transitions).toEqual([]);
		expect(sapphire.groups.find((g) => g.group === 'Dissolves')!.transitions.map((t) => t.label)).toContain(
			'S_DissolveLuma',
		);
		const hits = transitionTree('circle').flatMap((b) => b.categories.flatMap((c) => c.transitions));
		expect(hits.map((t) => t.id)).toContain('jasper.iris-round');
	});

	it('shows the GPU badge and filters by GPU', () => {
		const { session } = scene();
		render(
			<SessionProvider session={session}>
				<EffectsPanel instanceId="fx" visible />
			</SessionProvider>,
		);
		const iris = document.querySelector('[data-transition-effect-id="jasper.iris-round"]')!;
		expect(iris.querySelector('[data-badge="gpu"]')).toBeTruthy();
		expect(document.querySelector('[data-transition-effect-id="jasper.s.dissolve-luma"]')).toBeTruthy();
		fireEvent.click(screen.getByTitle('Show only GPU-accelerated effects'));
		expect(document.querySelector('[data-transition-effect-id="jasper.cross-dissolve"]')).toBeNull();
		expect(document.querySelector('[data-transition-effect-id="jasper.push"]')).toBeTruthy();
	});
});

describe('Transition section params', () => {
	it('edits a GPU transition param in one entry and keyframes it at the playhead', () => {
		const { session, iris, seq } = scene();
		act(() => session.select('transitions', [iris], 'replace'));
		render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="ec-gpu" visible />
			</SessionProvider>,
		);
		const rows = screen.getByTestId('transition-params');
		expect(
			[...rows.querySelectorAll('[data-transition-param]')].map((r) =>
				r.getAttribute('data-transition-param'),
			),
		).toEqual([
			'startPercent',
			'endPercent',
			'useCompletion',
			'completion',
			'borderWidth',
			'borderColor',
			'reverse',
			'antiAliasing',
			'center',
		]);
		const n = session.getState().history.entries.length;
		act(() => {
			fireEvent.change(screen.getByTestId('transition-param-antiAliasing'), { target: { value: 'high' } });
		});
		expect(seq().transitions[iris]!.params.antiAliasing!.value).toBe('high');
		expect(session.getState().history.entries).toHaveLength(n + 1);
		// Stopwatch at the playhead inside the span (115…124 → frame 4 of the span).
		act(() => session.transport.seek(119));
		act(() => {
			fireEvent.click(screen.getByTestId('transition-param-stopwatch-borderWidth'));
		});
		const keys = seq().transitions[iris]!.params.borderWidth!.keyframes;
		expect(keys).toHaveLength(1);
		expect(keys[0]!.time).toBe(9 * (705_600_000 / 30)); // span starts at 110 (centred, 20 frames)
	});
});
