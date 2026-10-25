// WP3.3b review UI on a real session with the fake proposals engine (spec 12 §2.7 "Review", P3-R6): the Review panel
// (rows by role, a row click selects the ghost / moves the playhead / shows the why-line, the Review keymap scope in the
// list, the note editor, alternates, Accept all / Reject all, the tab badge), Apply (refused untrusted — also Ctrl+Enter
// by an agent —, ONE History entry, its toast "Applied n of m sounds from <agent>" with Undo and Reopen review, Reopen
// keeps the decisions), the destructive confirmation, the review bar (◀ ▶, A/B, Discard with its confirmation, Exit),
// the proposal cards (agent only, sentence, waiting line, Review / Dismiss) and the agents-may-apply preference.
import type { Sequence } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentUiTxGuard, runAgentInput, trackUserInput } from '../src/agent-bridge/agent-input.ts';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { DEFAULT_KEYMAP, resolveBindings, scopeChain } from '../src/commands/keymap-defaults.ts';
import { ReviewBadge } from '../src/panels/review/badge.tsx';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { applyReview, reviewAnnouncer } from '../src/proposals/actions.ts';
import { dismissedProposals, ProposalCards } from '../src/proposals/ProposalCards.tsx';
import { ReviewBar } from '../src/proposals/ReviewBar.tsx';
import { AgentApplyPreference } from '../src/sound/PreferencesPage.tsx';
import { proposalFixture } from './proposal-helpers.ts';

beforeAll(() => registerAllCommands());
const realNow = performance.now.bind(performance);
let inputClockOffset = 0;
beforeEach(() => {
	// Expire previous input through the production clock while preserving elapsed time for React scheduling.
	inputClockOffset += 10_000;
	vi.spyOn(performance, 'now').mockImplementation(() => realNow() + inputClockOffset);
});
function trustedUserInput() {
	trackUserInput();
	const event = new KeyboardEvent('keydown', { key: 'Control' });
	Object.defineProperty(event, 'isTrusted', { value: true });
	window.dispatchEvent(event);
}
afterEach(() => {
	cleanup();
	closeAllDialogs();
	toasts.dismissAll();
	vi.restoreAllMocks();
	dismissedProposals.setState({ ids: {} });
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function setup() {
	const f = await proposalFixture();
	const ctx = createCommandContext({
		engine: f.engine as never,
		session: f.session,
		focus: { panel: 'review', instanceId: 'r1' },
		capabilities: ['engine'],
	});
	render(
		<SessionProvider session={f.session}>
			<ReviewBadge />
			<ReviewPanel instanceId="r1" visible />
			<ReviewBar session={f.session} reveal={() => {}} />
			<DialogHost />
		</SessionProvider>,
	);
	await settle();
	const row = (id: string) => document.querySelector(`[data-review-row="${id}"]`) as HTMLElement;
	const list = () => screen.getByTestId('review-list');
	const labels = () => f.session.getState().history.entries.map((e) => e.label);
	const state = (id: string) => f.c.getState().items.find((i) => i.id === id)!.state;
	const key = async (k: string, init: Partial<KeyboardEventInit> = {}) => {
		await act(async () => {
			fireEvent.keyDown(list(), {
				key: k,
				code: k === ' ' ? 'Space' : k.length === 1 ? `Key${k.toUpperCase()}` : k,
				...init,
			});
		});
		f.flush();
		await settle();
	};
	return { ...f, ctx, row, list, labels, state, key };
}

describe('Review panel', () => {
	it('lists every item as an option with its state; a row click selects the ghost, seeks to the anchor and shows the why-line', async () => {
		const t = await setup();
		const options = within(t.list()).getAllByRole('option');
		expect(options).toHaveLength(5);
		expect(options.every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
		expect(screen.getByTestId('review-counts').textContent).toContain('5 items');
		// the tab badge: 5 left to review
		expect(screen.getByTestId('review-tab-badge').getAttribute('data-count')).toBe('5');
		expect(screen.getByTestId('review-tab-badge').getAttribute('title')).toBe('5 items to review');
		await act(async () => {
			fireEvent.pointerDown(t.row('hit'), { button: 0 });
		});
		expect(t.c.getState().selection).toEqual(['hit']);
		expect(t.session.transport.getState().frame).toBe(30);
		expect(screen.getByTestId('review-details').textContent).toContain('Cut from Shot A to Shot B');
		expect(t.row('hit').getAttribute('aria-label')).toMatch(/^Hit on the cut, Pending, at 00:00:01:00/);
		t.c.exit();
		await settle();
		// out of review: the proposals with items to review, in the singular for one
		expect(screen.getByTestId('review-tab-badge').getAttribute('title')).toBe('1 proposal to review');
	});

	it('keyboard in the list (Review scope): Down moves, Enter accepts (with what it requires), Backspace rejects, U clears, A toggles A/B', async () => {
		const t = await setup();
		await act(async () => {
			t.list().focus();
		});
		await settle();
		const first = t.c.getState().selection.at(-1)!;
		expect(first).toBeTruthy();
		await t.key('ArrowDown');
		const second = t.c.getState().selection.at(-1)!;
		expect(second).not.toBe(first);
		// go to "hit" and accept it: its track comes along
		await act(async () => {
			fireEvent.pointerDown(t.row('hit'), { button: 0 });
		});
		await t.key('Enter');
		expect(t.state('hit')).toBe('accepted');
		expect(t.state('trk')).toBe('accepted');
		await t.key('Backspace');
		expect(t.state('hit')).toBe('rejected');
		expect(t.engine.calls.some((c) => c.startsWith('reject ["hit"]'))).toBe(true);
		await t.key('u');
		expect(t.state('hit')).toBe('pending');
		expect(t.c.getState().hear).toBe(false);
		await t.key('a');
		expect(t.c.getState().hear).toBe(true);
		await t.key('a');
		expect(t.c.getState().hear).toBe(false);
		// nothing applied by any of it
		expect(t.labels()).toEqual(['setup']);
		expect(reviewAnnouncer.getState().message).toMatch(/Hit on the cut: Pending/);
		t.c.exit();
	});

	it('alternates and the note editor (stored by the engine for the agent)', async () => {
		const t = await setup();
		await act(async () => {
			fireEvent.pointerDown(t.row('hit'), { button: 0 });
		});
		const details = screen.getByTestId('review-details');
		expect(details.textContent).toContain('Alternate 1/2');
		await act(async () => {
			fireEvent.click(within(details).getByRole('button', { name: 'Next alternate' }));
		});
		await settle();
		expect(t.engine.proposals.get(t.p.id)!.items.find((i) => i.id === 'hit')!.selectedAlternative).toBe(1);
		expect(screen.getByTestId('review-details').textContent).toContain('Alternate 2/2: Hit later');
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-details').querySelector('[data-review-detail="note"]')!);
		});
		const input = screen.getByLabelText('Note for the agent') as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: 'a bit softer' } });
		await act(async () => {
			fireEvent.click(
				screen.getByTestId('review-details').querySelector('[data-review-detail="save-note"]')!,
			);
		});
		await settle();
		expect(t.engine.proposals.get(t.p.id)!.items.find((i) => i.id === 'hit')!.note).toBe('a bit softer');
		expect(t.row('hit').getAttribute('aria-label')).toContain('note: a bit softer');
		t.c.exit();
	});

	it('Accept all / Reject all (rejected items stay rejected on Accept all)', async () => {
		const t = await setup();
		await t.c.setItemDecision(['boom'], 'reject');
		t.flush();
		await settle();
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-accept-all'));
		});
		t.flush();
		await settle();
		expect(['trk', 'hit', 'move', 'cue'].map(t.state)).toEqual([
			'accepted',
			'accepted',
			'accepted',
			'accepted',
		]);
		expect(t.state('boom')).toBe('rejected');
		expect(screen.getByTestId('review-apply').textContent).toBe('Apply 4 of 5');
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-reject-all'));
		});
		t.flush();
		await settle();
		expect(t.c.getState().items.every((i) => i.state === 'rejected')).toBe(true);
		expect(screen.queryByTestId('review-tab-badge')).toBeNull();
		t.c.exit();
	});
});

describe('Apply', () => {
	it('is refused untrusted: a synthetic click and an agent’s Ctrl+Enter; nothing changes', async () => {
		const t = await setup();
		await t.c.setItemDecision(['hit'], 'accept');
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-apply'));
		});
		await settle();
		expect(reviewAnnouncer.getState().message).toMatch(/^Only you can apply/);
		// Ctrl+Enter while an agent's live-UI input runs (its ui_key / ui_command)
		await runAgentInput(async () => {
			await runCommand('proposals.apply', t.ctx);
		});
		await settle();
		expect(t.engine.calls.some((c) => c.startsWith('accept'))).toBe(false);
		expect(t.labels()).toEqual(['setup']);
		t.c.exit();
	});

	it('Ctrl+Enter by the user = ONE History entry; the toast says "Applied n of m sounds from <agent>"; Reopen review undoes it and keeps the decisions', async () => {
		const t = await setup();
		await t.c.setItemDecision(['hit'], 'accept');
		await t.c.setItemDecision(['boom'], 'reject');
		t.flush();
		await settle();
		await act(async () => {
			t.list().focus();
		});
		trustedUserInput();
		await t.key('Enter', { ctrlKey: true });
		await waitFor(() => expect(t.labels()).toHaveLength(2));
		expect(t.labels()[1]).toMatch(/^Accept Sound pass \(2 of 5\)$/);
		expect(t.state('hit')).toBe('applied');
		const toast = toasts.getState().toasts.find((x) => x.title.startsWith('Applied'))!;
		expect(toast.title).toBe('Applied 2 of 5 sounds from sound-agent');
		expect(toast.actions?.map((a) => a.label)).toEqual(['Undo', 'Reopen review']);
		expect(reviewAnnouncer.getState().message).toBe('Applied 2 of 5 sounds from sound-agent');
		// still under review: pending items are left
		expect(t.c.getState().activeId).toBe(t.p.id);
		t.c.exit();
		expect(t.c.getState().activeId).toBeNull();
		// Reopen review: undoes the apply, the proposal is back in review with its decisions intact
		await act(async () => {
			toast.actions![1]!.run!();
		});
		await waitFor(() => expect(t.c.getState().activeId).toBe(t.p.id));
		t.flush();
		await waitFor(() => expect(t.state('hit')).toBe('accepted'));
		expect(t.session.getState().history.index).toBe(1);
		expect(t.state('trk')).toBe('accepted');
		expect(t.state('boom')).toBe('rejected');
		expect(t.engine.calls.some((c) => c.startsWith('reopen'))).toBe(true);
		t.c.exit();
	});

	it('names the user’s clips an item removes in a confirmation; Cancel applies nothing, confirming is the approval', async () => {
		const t = await setup();
		const p = t.engine.create({
			feature: 'sound-design',
			title: 'Clean up',
			sequenceId: t.seqId,
			items: [{ id: 'cut', label: 'Remove the bed', commands: [{ type: 'clip.lift', clipIds: [t.bed.id] }] }],
		});
		await t.c.setActive(p.id);
		t.flush();
		await settle();
		await t.c.setItemDecision(['cut'], 'accept');
		t.flush();
		const asked: string[] = [];
		const no = await applyReview(t.session, {
			trusted: true,
			confirm: async (o) => {
				asked.push(`${o.title} ${String(o.body)}`);
				return false;
			},
		});
		expect(no).toMatchObject({ ok: false, code: 'E_CANCELLED' });
		expect(asked[0]).toMatch(/^Apply 1 of 1\? Also removes 1 of your clips: “/);
		expect(t.seq().clips[t.bed.id]).toBeTruthy();
		const yes = await applyReview(t.session, { trusted: true, confirm: async () => true });
		expect(yes).toMatchObject({ ok: true, applied: 1, total: 1 });
		expect((t.session.getCommitted().sequences[t.seqId] as Sequence).clips[t.bed.id]).toBeUndefined();
		// the review stays until the user exits it
		expect(t.c.getState().activeId).toBe(p.id);
		t.c.exit();
	});

	it('names what an agent could not do without asking (destructive commands, force, granting itself the right to apply) before Apply', async () => {
		const t = await setup();
		const a2 = (t.seq().audioTracks[1] ?? t.seq().audioTracks[0])!.id;
		const p = t.engine.create({
			feature: 'sound-design',
			title: 'Sneaky pass',
			sequenceId: t.seqId,
			items: [
				{ id: 'hit', label: 'Hit on the cut', commands: [{ type: 'marker.add', frame: 12, name: 'hit' }] },
				{
					id: 'grant',
					label: 'Tidy settings',
					requires: ['hit'],
					commands: [{ type: 'soundDesign.setSettings', agentsMayApply: true }],
				},
				{
					id: 'drop',
					label: 'Clean up',
					commands: [{ type: 'track.remove', trackIds: [a2], force: true }],
				},
			],
		});
		await t.c.setActive(p.id);
		t.flush();
		await settle();
		// the harmless item alone needs no confirmation of that kind
		const asked: string[] = [];
		const confirm = async (o: { title: string; body?: unknown }) => {
			asked.push(`${o.title} ${String(o.body)}`);
			return false;
		};
		await t.c.setItemDecision(['grant', 'drop'], 'accept');
		t.flush();
		const no = await applyReview(t.session, { trusted: true, confirm });
		expect(no).toMatchObject({ ok: false, code: 'E_CANCELLED' });
		expect(asked[0]).toContain('Also runs what needs your approval:');
		expect(asked[0]).toContain(
			'Also allows agents to apply sound proposals in this sequence without your review',
		);
		// nothing applied, the setting still off
		expect(t.seq().soundDesign?.settings?.agentsMayApply).not.toBe(true);
		expect(t.seq().audioTracks.some((tr) => tr.id === a2)).toBe(true);
		expect(t.engine.calls.some((c) => c.startsWith('accept'))).toBe(false);
		t.c.exit();
	});
});

describe('review bar', () => {
	it('◀ ▶ walk the items in time order (selection + playhead), A/B toggles, Exit leaves', async () => {
		const t = await setup();
		const bar = screen.getByTestId('review-bar');
		expect(screen.getByTestId('review-bar-title').textContent).toBe(
			'Reviewing: sound-agent · Sound pass · 5 items',
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-bar-next'));
		});
		const a = t.c.getState().selection.at(-1);
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-bar-next'));
		});
		const b = t.c.getState().selection.at(-1);
		expect(a).toBeTruthy();
		expect(b).not.toBe(a);
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-bar-prev'));
		});
		expect(t.c.getState().selection.at(-1)).toBe(a);
		await act(async () => {
			fireEvent.click(within(bar).getByTestId('review-bar-ab'));
		});
		expect(t.c.getState().hear).toBe(true);
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-bar-exit'));
		});
		expect(t.c.getState().activeId).toBeNull();
	});

	it('Discard asks first, then deletes the proposal (nothing in the sequence changes)', async () => {
		const t = await setup();
		await act(async () => {
			fireEvent.click(screen.getByTestId('review-bar-discard'));
		});
		const dialog = await screen.findByTestId('confirm-dialog');
		expect(dialog.textContent).toContain('Discard “Sound pass”?');
		expect(dialog.textContent).toContain('sound-agent is told it was discarded');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
		});
		await waitFor(() => expect(t.engine.proposals.has(t.p.id)).toBe(false));
		expect(t.c.getState().activeId).toBeNull();
		expect(t.labels()).toEqual(['setup']);
	});
});

describe('proposal cards', () => {
	it('an agent’s proposal under no review gets a card with counts and the waiting line; Review opens it; Dismiss hides it; the user’s own get none', async () => {
		const f = await proposalFixture();
		f.c.exit();
		f.engine.create(
			{
				feature: 'sound-design',
				title: 'Mine',
				sequenceId: f.seqId,
				items: [{ id: 'm', label: 'M', commands: [{ type: 'marker.add', frame: 5 }] }],
			},
			'user',
		);
		await f.c.load();
		// the engine says the agent is waiting (wait_for_proposal polling)
		f.c.store.setState({
			list: f.c
				.getState()
				.list.map((p) =>
					p.id === f.p.id
						? { ...p, waiting: { agent: 'sound-agent', since: '2026-10-16T10:00:00.000Z' } }
						: p,
				),
		});
		render(
			<SessionProvider session={f.session}>
				<ul>
					<ProposalCards session={f.session} />
				</ul>
			</SessionProvider>,
		);
		const cards = await screen.findAllByTestId('proposal-card');
		expect(cards).toHaveLength(1);
		expect(cards[0]!.getAttribute('data-proposal-id')).toBe(f.p.id);
		await waitFor(() =>
			expect(screen.getByTestId('proposal-card-text').textContent).toBe(
				'sound-agent proposes Sound pass: 2 sounds on 1 new track',
			),
		);
		expect(screen.getByTestId('proposal-card-waiting').textContent).toBe(
			'sound-agent is waiting for your review',
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('proposal-card-review'));
		});
		await waitFor(() => expect(f.c.getState().activeId).toBe(f.p.id));
		// under review: no card
		expect(screen.queryByTestId('proposal-card')).toBeNull();
		f.c.exit();
		await settle();
		expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
		await act(async () => {
			fireEvent.click(screen.getByTestId('proposal-card-dismiss'));
		});
		expect(screen.queryByTestId('proposal-card')).toBeNull();
		expect(f.engine.proposals.has(f.p.id)).toBe(true);
	});
});

describe('Review keymap scope', () => {
	it('binds Enter, Backspace / Delete, U, A, Space, Shift+Space, Ctrl+Enter, Esc, Up / Down in the review scope only', () => {
		const want: [string, string][] = [
			['Enter', 'proposals.acceptItem'],
			['Backspace', 'proposals.rejectItem'],
			['Delete', 'proposals.rejectItem'],
			['KeyU', 'proposals.clearItem'],
			['KeyA', 'proposals.toggleHear'],
			['Space', 'proposals.playItem'],
			['Shift+Space', 'proposals.playRange'],
			['Ctrl+Enter', 'proposals.apply'],
			['Escape', 'proposals.exitReview'],
			['ArrowUp', 'proposals.prevItem'],
			['ArrowDown', 'proposals.nextItem'],
		];
		for (const platform of ['win', 'linux', 'mac'] as const)
			for (const [chord, command] of want) {
				const k = platform === 'mac' ? chord.replace(/^Ctrl\+/, 'Cmd+') : chord;
				const first = resolveBindings(k, scopeChain('review'), { platform, runtime: 'web' })[0];
				expect(first?.command, `${platform} ${k}`).toBe(command);
			}
		// nowhere else: the Timeline's Enter / Space / arrows are untouched
		for (const b of DEFAULT_KEYMAP.filter((x) => x.command.startsWith('proposals.')))
			expect(b.scope, b.command).toBe('review');
		expect(
			resolveBindings('Space', scopeChain('timeline'), { platform: 'linux', runtime: 'web' })[0]?.command,
		).toBe('transport.playStop');
	});
});

describe('Preferences ▸ Sound Library ▸ Proposals', () => {
	it('"Allow agents to apply sound proposals" writes the sequence setting as the user’s undoable edit', async () => {
		const f = await proposalFixture();
		f.c.exit();
		render(
			<SessionProvider session={f.session}>
				<AgentApplyPreference />
			</SessionProvider>,
		);
		const box = screen.getByRole('checkbox');
		expect(box.getAttribute('aria-checked')).toBe('false');
		await act(async () => {
			fireEvent.click(box);
		});
		const settings = () =>
			(
				f.session.getCommitted().sequences[f.seqId] as {
					soundDesign?: { settings?: { agentsMayApply?: boolean } };
				}
			).soundDesign?.settings;
		expect(settings()?.agentsMayApply).toBe(true);
		const h = f.session.getState().history;
		expect(h.entries.at(-1)).toMatchObject({
			label: 'Allow Agents to Apply Sound Proposals',
			origin: 'user',
		});
		expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
		f.session.undo();
		expect(settings()?.agentsMayApply).not.toBe(true);
		void proposalsFor;
	});

	it('an agent clicking the checkbox through the live UI (ui_click) cannot grant itself the right', async () => {
		const f = await proposalFixture();
		f.c.exit();
		// the guard every editor session has (agent bridge; security review AGT-1)
		const off = f.session.addTxGuard(agentUiTxGuard);
		render(
			<SessionProvider session={f.session}>
				<AgentApplyPreference />
			</SessionProvider>,
		);
		const before = f.session.getState().history.entries.length;
		await act(async () => {
			await runAgentInput(async () => {
				fireEvent.click(screen.getByRole('checkbox'));
			});
		});
		const settings = (
			f.session.getCommitted().sequences[f.seqId] as {
				soundDesign?: { settings?: { agentsMayApply?: boolean } };
			}
		).soundDesign?.settings;
		expect(settings?.agentsMayApply).not.toBe(true);
		expect(f.session.getState().history.entries.length).toBe(before);
		expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
		off();
	});
});
