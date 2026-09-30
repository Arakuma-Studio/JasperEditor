// S10 §8 test 4 (component, happy-dom): transitions drawn in the Timeline panel (translateX / width),
// select + Delete (one history entry), no re-render per playhead frame (TUI-004), the Effects panel bins
// (TUI-020) and the Transition section of Effect Controls / Properties (TUI-040).
import { EngineClient } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { transitionDefaults } from '../src/panels/effects/transition-prefs.ts';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

/** A centred 12-frame cross dissolve at frame 120 and a 15-frame fade-out at the tail of B (240). */
function scene() {
	const { session, seqId } = makeSession();
	session.setView(seqId, { pxPerFrame: 2, scrollFrame: 0 });
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
	const p = apply([
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
	const vb = (p.results[1] as { clipIds: string[] }).clipIds[0]!;
	const r = apply([
		{
			type: 'transition.add',
			trackId: 'V1',
			at: 120,
			effectId: 'jasper.cross-dissolve',
			duration: 12,
			ref: '$x',
		},
		{
			type: 'transition.add',
			clipId: vb,
			edge: 'out',
			effectId: 'jasper.cross-dissolve',
			duration: 15,
			ref: '$f',
		},
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	return { session, seqId, dissolve: r.refs.$x!, fade: r.refs.$f!, seq };
}

const rectOf = (id: string) =>
	document.querySelector<HTMLElement>(`[data-testid="timeline-track-area"] [data-transition-id="${id}"]`);

describe('Timeline panel: transitions (S10 §8 test 4)', () => {
	it('draws a centred dissolve and a fade-out at the right translateX / width', () => {
		const { session, dissolve, fade } = scene();
		render(
			<SessionProvider session={session}>
				<TimelinePanel instanceId="tl-tr-1" visible />
			</SessionProvider>,
		);
		const x = rectOf(dissolve)!;
		const f = rectOf(fade)!;
		expect(x.style.transform).toBe('translateX(228px)'); // (114 − 0) × 2
		expect(x.style.width).toBe('24px');
		expect(f.style.transform).toBe('translateX(450px)'); // 225 × 2
		expect(f.style.width).toBe('30px');
		expect(x.getAttribute('title')).toMatch(
			/Cross Dissolve\nDuration 00:00:00:12 \(12 frames\)\nCenter at Cut/,
		);
		expect(f.getAttribute('title')).toMatch(/Fade out at the clip tail/);
		expect(x.querySelectorAll('path')).toHaveLength(2); // both ramps
		expect(f.querySelectorAll('path')).toHaveLength(1);
	});

	it('selecting a transition and pressing Delete removes it (one entry); the playhead never re-renders it', async () => {
		const { session, dissolve, fade, seq } = scene();
		let commits = 0;
		render(
			<SessionProvider session={session}>
				<Profiler id="tl" onRender={() => commits++}>
					<TimelinePanel instanceId="tl-tr-2" visible />
				</Profiler>
			</SessionProvider>,
		);
		const before = commits;
		await act(async () => {
			for (let i = 1; i <= 60; i++) session.transport.seek(i * 4);
		});
		expect(commits).toBe(before);
		act(() => session.select('transitions', [dissolve], 'replace'));
		expect(rectOf(dissolve)!.dataset.selected).toBe('true');
		const n = session.getState().history.entries.length;
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		await act(async () => {
			await runCommand('timeline.clear', ctx);
		});
		expect(seq().transitions[dissolve]).toBeUndefined();
		expect(seq().transitions[fade]).toBeDefined();
		expect(
			session
				.getState()
				.history.entries.slice(n)
				.map((e) => e.label),
		).toEqual(['Clear Transition']);
		expect(rectOf(dissolve)).toBeNull();
		act(() => session.undo());
		expect(rectOf(dissolve)).not.toBeNull();
	});
});

describe('Effects panel transition bins (TUI-020, TUI-031)', () => {
	it('lists Video Transitions ▸ Dissolve and Audio Transitions ▸ Crossfade with the default badge and drag payload', () => {
		const { session } = scene();
		render(
			<SessionProvider session={session}>
				<EffectsPanel instanceId="fx" visible />
			</SessionProvider>,
		);
		const ids = [...document.querySelectorAll('[data-transition-effect-id]')].map((e) =>
			e.getAttribute('data-transition-effect-id'),
		);
		expect(ids).toEqual([
			'jasper.cross-dissolve',
			'jasper.dip-to-black',
			'jasper.constant-gain',
			'jasper.constant-power',
		]);
		expect(screen.getByText('Video Transitions')).toBeTruthy();
		expect(screen.getByText('Dissolve')).toBeTruthy();
		expect(screen.getByText('Crossfade')).toBeTruthy();
		const defaults = [...document.querySelectorAll('[data-default-badge]')];
		expect(defaults).toHaveLength(2);
		// Drag payload.
		const data: Record<string, string> = {};
		const dt = {
			setData: (k: string, v: string) => {
				data[k] = v;
			},
			effectAllowed: '',
		};
		fireEvent.dragStart(document.querySelector('[data-transition-effect-id="jasper.dip-to-black"]')!, {
			dataTransfer: dt,
		});
		expect(JSON.parse(data['application/x-jasper-transition']!)).toEqual({
			type: 'jasper/transition',
			effectId: 'jasper.dip-to-black',
		});
		expect(data['text/plain']).toBe('jasper-transition:jasper.dip-to-black');
		// Context menu: Set Selected as Default Transition.
		fireEvent.contextMenu(document.querySelector('[data-transition-effect-id="jasper.dip-to-black"]')!);
		fireEvent.click(screen.getByText('Set Selected as Default Transition'));
		expect(transitionDefaults().getState().video).toBe('jasper.dip-to-black');
		expect(
			document.querySelector('[data-transition-effect-id="jasper.dip-to-black"] [data-default-badge]'),
		).toBeTruthy();
		// Search filters the bins.
		fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'power' } });
		expect([...document.querySelectorAll('[data-transition-effect-id]')].map((e) => e.textContent)).toEqual([
			'Constant PowerN',
		]);
	});
});

describe('Transition section (TUI-040/041)', () => {
	it('Effect Controls: type, duration, alignment and the A/B diagram, each change one entry', () => {
		const { session, dissolve, seq } = scene();
		act(() => session.select('transitions', [dissolve], 'replace'));
		render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="ec-tr" visible />
			</SessionProvider>,
		);
		const section = screen.getByTestId('transition-section');
		expect(section.textContent).toMatch(/Transition· Cross Dissolve/);
		expect(screen.getByTestId('transition-diagram')).toBeTruthy();
		expect(screen.getByTestId('transition-handle-a')).toBeTruthy();
		expect(screen.getByTestId('transition-handle-b')).toBeTruthy();
		expect(screen.getByTestId('transition-edge-start')).toBeTruthy();
		const n = session.getState().history.entries.length;
		act(() => {
			fireEvent.change(screen.getByTestId('transition-type'), { target: { value: 'jasper.dip-to-black' } });
		});
		expect(seq().transitions[dissolve]!.effectId).toBe('jasper.dip-to-black');
		act(() => {
			fireEvent.change(screen.getByTestId('transition-alignment'), { target: { value: 'start-at-cut' } });
		});
		expect(seq().transitions[dissolve]!.alignment).toBe('start-at-cut');
		// Duration: timecode entry.
		act(() => {
			fireEvent.click(screen.getByTestId('transition-duration').querySelector('button')!);
		});
		const input = screen.getByTestId('timecode-input');
		act(() => {
			fireEvent.change(input, { target: { value: '+8' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(seq().transitions[dissolve]!.duration).toBe(20);
		expect(
			session
				.getState()
				.history.entries.slice(n)
				.map((e) => e.label),
		).toEqual(['Replace Transition', 'Transition Alignment', 'Transition Duration']);
		// At-cut transitions only resize on the edge away from the cut.
		expect(screen.queryByTestId('transition-edge-start')).toBeNull();
		expect(screen.getByTestId('transition-edge-end')).toBeTruthy();
	});

	it('Properties shows the section for a selected fade; alignment is disabled for one-sided fades', () => {
		const { session, fade } = scene();
		act(() => session.select('transitions', [fade], 'replace'));
		render(
			<SessionProvider session={session}>
				<PropertiesPanel instanceId="props-tr" visible />
			</SessionProvider>,
		);
		expect(screen.getByTestId('transition-section').dataset.host).toBe('properties');
		expect((screen.getByTestId('transition-alignment') as HTMLSelectElement).disabled).toBe(true);
		expect(screen.queryByTestId('transition-handle-b')).toBeNull();
	});
});
