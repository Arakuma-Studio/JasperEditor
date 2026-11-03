// Spec 19 TL-094: the badge. The check itself is TL-056 (`lintAppearance`, tested with the library); here it is a stand-in
// so the badge's counts, list, one-click fix and honest "not measured" line are tested on their own.
import type { Appearance, LookRecipe } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

const lint = vi.hoisted(() => ({
	report: { issues: [] as unknown[], unmeasured: [] as string[] },
	calls: [] as unknown[],
}));

vi.mock('@jasper/project', async (orig) => ({
	...(await orig<typeof import('@jasper/project')>()),
	lintAppearance: (_a: unknown, ctx: unknown) => {
		lint.calls.push(ctx);
		return lint.report;
	},
}));

const { PropertiesPanel } = await import('../src/panels/properties/PropertiesPanel.tsx');
const { clipLook, titleLooksOf } = await import('@jasper/project');

const recipe: LookRecipe = { layers: [{ type: 'rim', params: { width: 1 } }, { type: 'face' }] };

function looked(n = 1): { session: EditorSession; ids: string[] } {
	const session = makeSession();
	const r = session.apply({
		label: 's',
		origin: 'user',
		commands: [
			{ type: 'look.create', name: 'A', recipe },
			...Array.from({ length: n }, (_, i) => ({
				type: 'clip.addText',
				at: i * 40,
				duration: 30,
				track: 'V2',
				content: { text: 'Title', style: { sizePx: 100 } },
			})),
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const ids = r.created.filter((id) => id.startsWith('clp_'));
	session.apply({
		label: 'l',
		origin: 'user',
		commands: [
			{ type: 'look.apply', clipIds: ids, lookId: titleLooksOf(session.getCommitted())[0]!.id },
		] as never,
	});
	act(() => session.select('timeline', ids));
	return { session, ids };
}

// The real lint's issue shape (`LintIssue`): the badge shows `template` with its translated `args`.
const issue = (over: Record<string, unknown> = {}) => ({
	id: 'x',
	code: 'LOOK_RIMS_THIN',
	severity: 'warning',
	message: 'The rim is too thin.',
	template: (over.message as string | undefined) ?? 'The rim is too thin.',
	args: [],
	rule: 'A rim must survive a downscale.',
	layerIds: [],
	fixable: true,
	...over,
});

afterEach(() => {
	cleanup();
	lint.report = { issues: [], unmeasured: [] };
	lint.calls.length = 0;
});

describe('style check badge (TL-094)', () => {
	it('gives the check what only the clip knows', () => {
		const { session } = looked();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(lint.calls[0]).toMatchObject({ clipKind: 'text', text: 'Title', sizePx: 100, frameHeight: 1080 });
	});

	it('with nothing found, says it is a check, not that all is well: unmeasured stays unmeasured', () => {
		lint.report = { issues: [], unmeasured: ['backdrop-contrast'] };
		const { session } = looked();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const badge = screen.getByTestId('look-style-badge');
		expect(badge.textContent).toBe('Style check');
		expect(badge.dataset.count).toBe('0');
		fireEvent.click(badge);
		expect(screen.getByTestId('look-style-unmeasured-backdrop-contrast').textContent).toMatch(/not measured/);
	});

	it('counts errors and warnings, not notes', () => {
		lint.report = {
			issues: [
				issue({ id: 'a' }),
				issue({ id: 'b', code: 'LOOK_RIMS_FLOOD', severity: 'error', message: 'Flooded.' }),
				issue({ id: 'c', code: 'LOOK_HIDDEN_LAYER', severity: 'info', message: 'A note.' }),
			],
			unmeasured: [],
		};
		const { session } = looked();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const badge = screen.getByTestId('look-style-badge');
		expect(badge.textContent).toBe('2 issues');
		fireEvent.click(badge);
		const rows = [...screen.getByTestId('look-style-list').querySelectorAll('[data-issue]')];
		expect(rows.map((r) => r.getAttribute('data-severity'))).toEqual(['error', 'warning', 'info']);
	});

	it('applies a fix in one click, as one undo step', () => {
		const { session, ids } = looked();
		const fx = clipLook((clipOf(session, ids[0]!) as unknown as { effects: never[] }).effects) as unknown as {
			id: string;
			appearance: Appearance;
		};
		const rim = fx.appearance.layers[0]!.id;
		lint.report = {
			issues: [
				issue({
					fix: {
						label: 'Widen the rim',
						commands: [{ type: 'param.set', target: ['appearance', fx.id, rim, 'width'], value: 3 }],
					},
				}),
			],
			unmeasured: [],
		};
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-style-badge'));
		const n = session.getState().history.entries.length;
		fireEvent.click(screen.getByTestId('look-style-fix-LOOK_RIMS_THIN'));
		expect(session.getState().history.entries.length).toBe(n + 1);
		const read = () =>
			(
				clipLook((clipOf(session, ids[0]!) as unknown as { effects: never[] }).effects) as unknown as {
					appearance: Appearance;
				}
			).appearance.layers[0]!.params.width!.value;
		expect(read()).toBe(3);
		session.undo();
		expect(read()).toBe(1);
	});

	it('an issue on several clips is one line, and its fix reaches each of them', () => {
		const { session, ids } = looked(2);
		const fxOf = (id: string) =>
			clipLook((clipOf(session, id) as unknown as { effects: never[] }).effects) as unknown as {
				id: string;
				appearance: Appearance;
			};
		const report = (fx: { id: string; appearance: Appearance }) => ({
			issues: [
				issue({
					fix: {
						label: 'Widen the rim',
						commands: [
							{
								type: 'param.set',
								target: ['appearance', fx.id, fx.appearance.layers[0]!.id, 'width'],
								value: 3,
							},
						],
					},
				}),
			],
			unmeasured: [],
		});
		let i = 0;
		const reports = [report(fxOf(ids[0]!)), report(fxOf(ids[1]!))];
		Object.defineProperty(lint, 'report', { configurable: true, get: () => reports[i++ % 2], set: () => {} });
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('look-style-badge').textContent).toBe('1 issue');
		fireEvent.click(screen.getByTestId('look-style-badge'));
		fireEvent.click(screen.getByTestId('look-style-fix-LOOK_RIMS_THIN'));
		for (const id of ids) expect(fxOf(id).appearance.layers[0]!.params.width!.value).toBe(3);
		Object.defineProperty(lint, 'report', {
			configurable: true,
			writable: true,
			value: { issues: [], unmeasured: [] },
		});
	});
});
