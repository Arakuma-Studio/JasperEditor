// S10 §8 test 4 (component, happy-dom): clearing a selected transition (one history entry),
// Effects panel actions (TUI-020/031), and Transition controls in Effect Controls / Properties (TUI-040).
import { EngineClient } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
	return { session, dissolve: r.refs.$x!, fade: r.refs.$f!, seq };
}

const rectOf = (id: string) =>
	document.querySelector<HTMLElement>(`[data-testid="timeline-track-area"] [data-transition-id="${id}"]`);

describe('Timeline panel: transitions (S10 §8 test 4)', () => {
	it('clearing a selected transition removes it in one undoable entry', async () => {
		const { session, dissolve, fade, seq } = scene();
		render(
			<SessionProvider session={session}>
				<TimelinePanel instanceId="tl-tr-2" visible />
			</SessionProvider>,
		);
		act(() => session.select('transitions', [dissolve], 'replace'));
		expect(rectOf(dissolve)!.dataset.selected).toBe('true');
		const n = session.getState().history.entries.length;
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		await act(async () => {
			await runCommand('timeline.clear', ctx);
		});
		expect(seq().transitions[dissolve]).toBeUndefined();
		expect(seq().transitions[fade]).toBeDefined();
		expect(session.getState().history.entries).toHaveLength(n + 1);
		expect(rectOf(dissolve)).toBeNull();
		act(() => session.undo());
		expect(rectOf(dissolve)).not.toBeNull();
	});
});

describe('Effects panel transition bins (TUI-020, TUI-031)', () => {
	it('offers transitions with drag data, default selection, and search', () => {
		const { session } = scene();
		render(
			<SessionProvider session={session}>
				<EffectsPanel instanceId="fx" visible />
			</SessionProvider>,
		);
		expect(screen.getByText('Video Transitions')).toBeTruthy();
		expect(screen.getByText('Crossfade')).toBeTruthy();
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
		// Search filters the bins.
		fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'power' } });
		expect(screen.getByText('Constant Power')).toBeTruthy();
		expect(document.querySelector('[data-transition-effect-id="jasper.dip-to-black"]')).toBeNull();
	});
});

describe('Transition section (TUI-040/041)', () => {
	it('Effect Controls edits transition type, duration and alignment', () => {
		const { session, dissolve, seq } = scene();
		act(() => session.select('transitions', [dissolve], 'replace'));
		render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="ec-tr" visible />
			</SessionProvider>,
		);
		expect(screen.getByTestId('transition-section')).toBeTruthy();
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
		expect(session.getState().history.entries).toHaveLength(n + 3);
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
