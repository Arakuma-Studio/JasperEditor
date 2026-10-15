// Phase 2 verification (spec 12 §2.7 "Suggest Cues…", P2-R7): the dialog suggests the cues `deriveCues` finds with
// the same options the engine route (`POST /api/sound-design/cues`, MCP `suggest_sound_cues`) uses — motion graphics
// through the template registry, the sequence's density, respect dialogue, the range — and, like the route, on the
// document with its expressions bound (expression-driven motion moves as the renderer shows it).
import { loadExpressionEngine } from '@jasper/expressions';
import { mgRegistry } from '@jasper/mg-templates';
import type { Sequence } from '@jasper/project';
import { bindExpressions, deriveCues, PROJECT_CUE_SOURCES } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cuesOf } from '../src/sound/cues/model.ts';
import { SuggestCuesDialog } from '../src/sound/cues/SuggestCuesDialog.tsx';
import { planSuggestion } from '../src/sound/cues/suggest.ts';
import { makeSession } from './timeline-helpers.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});
afterEach(() => cleanup());

function expressionMotion() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 's',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0, 0, 0, 1], name: 'BG' },
			{
				type: 'clip.addText',
				at: 0,
				duration: 300,
				track: 'V2',
				content: { text: 'Hi' },
				name: 'T',
				ref: '$t',
			},
		] as never[],
	});
	const t = r.refs.$t!;
	// no keyframes: the title slides in for one second through an expression, then lands
	const e = session.apply({
		label: 'e',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'expression.set',
				target: ['clip', t, 'transform', 'position'],
				text: 'time < 1 ? [200 + time * 760, 540] : [960, 540]',
			},
		] as never[],
	});
	expect(e.ok).toBe(true);
	return { session, doc: session.getCommitted(), seqId };
}

describe('Suggest Cues… derives what the engine route derives', () => {
	it('expression-driven motion: the same cues as deriveCues on the bound document', () => {
		const { doc, seqId } = expressionMotion();
		const engine = deriveCues(bindExpressions(doc), seqId, {
			density: 'balanced',
			respectDialogue: true,
			mgTemplates: mgRegistry,
		});
		expect(engine.cues.length).toBeGreaterThan(0);
		const plan = planSuggestion(doc, seqId, {
			sources: new Set(PROJECT_CUE_SOURCES),
			range: 'sequence',
			density: 'balanced',
			respectDialogue: true,
			replace: true,
		});
		expect(plan.adds.map((c) => [c.kind, c.frame])).toEqual(engine.cues.map((c) => [c.kind, c.frame]));
		expect(plan.kept.keyframes).toBe(engine.stats.bySource.keyframes?.kept ?? 0);
	});
});

describe('Suggest Cues… dialog', () => {
	it('suggests the expression-driven move and land, in ONE undo step', async () => {
		const { session, seqId } = expressionMotion();
		const close = vi.fn();
		render(
			<SessionProvider session={session}>
				<SuggestCuesDialog session={session} sequenceId={seqId} close={close} />
			</SessionProvider>,
		);
		const button = await screen.findByRole('button', { name: 'Suggest 2 Cues' });
		const n = session.getState().history.entries.length;
		fireEvent.click(button);
		const seq = () => session.getCommitted().sequences[seqId] as Sequence;
		expect(cuesOf(seq()).map((c) => [c.kind, c.frame])).toEqual([
			['move', 14],
			['land', 30],
		]);
		expect(session.getState().history.entries).toHaveLength(n + 1);
		act(() => {
			session.undo();
		});
		expect(cuesOf(seq())).toHaveLength(0);
	});

	it('"Replace earlier unfilled suggestions": a second run replaces them and keeps the user\'s cue', () => {
		const { session, seqId, doc } = expressionMotion();
		const opts = {
			sources: new Set(PROJECT_CUE_SOURCES),
			range: 'sequence' as const,
			density: 'balanced' as const,
			respectDialogue: true,
			replace: true,
		};
		const first = planSuggestion(doc, seqId, opts);
		expect(
			session.apply({ label: 'a', origin: 'user', sequenceId: seqId, commands: first.commands }).ok,
		).toBe(true);
		// a cue of the user's on the derived land frame stays; the derived ones are replaced, not doubled
		session.apply({
			label: 'u',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'soundCue.add', cues: [{ frame: 200, kind: 'manual', weight: 'support', source: 'user' }] },
			] as never[],
		});
		const again = planSuggestion(session.getCommitted(), seqId, opts);
		expect(again.removes).toHaveLength(2);
		expect(again.adds).toHaveLength(2);
		expect(
			session.apply({ label: 'b', origin: 'user', sequenceId: seqId, commands: again.commands }).ok,
		).toBe(true);
		const cues = cuesOf(session.getCommitted().sequences[seqId] as Sequence);
		expect(cues.map((c) => [c.kind, c.frame, c.source])).toEqual([
			['move', 14, 'derived'],
			['land', 30, 'derived'],
			['manual', 200, 'user'],
		]);
		// without replace, the cues that stay make the derived ones duplicates: nothing to add
		const keep = planSuggestion(session.getCommitted(), seqId, { ...opts, replace: false });
		expect(keep.removes).toEqual([]);
		expect(keep.adds).toEqual([]);
		expect(keep.duplicates).toBe(2);
	});
});
