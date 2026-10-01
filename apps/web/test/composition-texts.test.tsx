// Properties ▸ Composition ▸ Text (M3, wp-m3-mgtext, S08:MGU-006): the text editors of a composition clip — texts
// in manifest order with their style props, live preview while typing (transient document, no History entry),
// one "Edit Text" entry on apply, Esc reverts, schema errors are not applied, measured layout warnings and the
// bundle's fonts in the font menu (the measuring page is faked here; e2e/mg-texts.spec.ts runs the real one).
import type { MgCompositionInfo, MgTextMeasurement } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositionSection } from '../src/mg-bundles/CompositionSection.tsx';
import { canvasTextEditStore, endCanvasTextEdit } from '../src/mg-bundles/text-edit.ts';
import { makeSession, renderWithSession } from './inspector-helpers.tsx';
import { labels } from './tracking-helpers.tsx';

const measure = vi.fn();
vi.mock('../src/mg-bundles/text-measure.ts', () => ({ textMeasurer: () => ({ measure }) }));

const HEX = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const LOWER_THIRD: MgCompositionInfo = {
	id: 'LowerThird',
	width: 1920,
	height: 1080,
	fps: 30,
	durationInFrames: 120,
	defaultProps: {
		name: {
			text: 'Ada Lovelace',
			color: '#ffffff',
			fontSize: 84,
			fontFamily: 'Inter',
			fontWeight: 700,
			align: 'left',
		},
		role: 'Mathematician',
		roleColor: '#ffcc33',
		roleSize: 44,
		quote: 'Two\nrows',
		accent: '#3366ff',
	},
	propsSchema: {
		type: 'object',
		properties: {
			name: {
				type: 'object',
				properties: {
					text: { type: 'string', minLength: 1, maxLength: 60 },
					color: HEX,
					fontSize: { type: 'integer', minimum: 24, maximum: 160 },
					fontFamily: { type: 'string', minLength: 1 },
					fontWeight: { type: 'integer', minimum: 100, maximum: 900 },
					align: { type: 'string', enum: ['left', 'center', 'right'] },
				},
			},
			role: { type: 'string', maxLength: 80 },
			roleColor: HEX,
			roleSize: { type: 'integer', minimum: 16, maximum: 96 },
			quote: { type: 'string', maxLength: 200 },
			accent: HEX,
		},
	},
	schemaSource: 'bundle',
	ui: {
		'name.color': { control: 'color' },
		roleColor: { control: 'color' },
		quote: { control: 'textarea' },
		accent: { control: 'color' },
	},
	texts: {
		'name.text': { label: 'Name', maxChars: 24 },
		role: { label: 'Role', maxChars: 40 },
		quote: { label: 'Quote', multiline: true, maxLines: 2 },
	},
};

function setup(): { session: EditorSession; clipId: string } {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: {
					kind: 'mg-bundle',
					fingerprint: 'q1:abc',
					originalName: 'fixture',
					sizeBytes: 1,
					container: 'remotion-bundle',
					probe: {
						durationFlicks: null,
						startTimecode: null,
						streams: [],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_fixture' }],
					mgBundle: {
						remotionVersion: '4.0.499',
						bundleHash: 'a'.repeat(64),
						builtAt: '2026-10-01T00:00:00.000Z',
						source: { type: 'project-dir', path: '/tmp/x', name: 'fixture' },
						compositions: [LOWER_THIRD],
					},
				},
				ref: '$b',
			},
			{
				type: 'clip.addComposition',
				composition: { mediaId: '$b', id: 'LowerThird' },
				at: 0,
				track: 'V1',
				ref: '$c',
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, clipId: r.refs.$c! };
}

function renderSection(session: EditorSession, clipId: string) {
	const seq = Object.values(session.getCommitted().sequences)[0]!;
	return renderWithSession(
		session,
		<CompositionSection session={session} clips={[seq.clips[clipId]!]} frame={0} sequenceId={seq.id} />,
	);
}

const props = (s: EditorSession, id: string, transient = false) => {
	const st = s.getState();
	const doc = transient ? (st.transient ?? st.document) : st.document;
	return (Object.values(doc.sequences)[0]!.clips[id] as { props: Record<string, unknown> }).props;
};

const frames = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

const clipped: MgTextMeasurement = {
	id: 'name.text',
	found: true,
	visible: true,
	rect: { x: 136, y: 696, width: 1500, height: 97 },
	lines: [{ x: 136, y: 696, width: 1500, height: 97 }],
	clippedBy: { x: 96, y: 660, width: 1100, height: 300 },
	truncated: false,
	style: null,
};

beforeEach(() => {
	measure.mockReset();
	measure.mockImplementation(async (req: { items: { id: string }[] }) => ({
		measurements: req.items.map((i) =>
			i.id === 'name.text'
				? clipped
				: {
						...clipped,
						id: i.id,
						clippedBy: null,
						rect: { x: 100, y: 100, width: 100, height: 50 },
						lines: [],
					},
		),
		fonts: [{ family: 'Inter', weight: '700', style: 'normal', loaded: true, source: 'url("x")' }],
	}));
});
afterEach(() => {
	cleanup();
	endCanvasTextEdit();
});

describe('Properties ▸ Composition ▸ Text (S08:MGU-006)', () => {
	it('lists the texts with counters and their style props; the generic form keeps the rest', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		const layers = document.querySelectorAll('[data-text-layer]');
		expect([...layers].map((l) => l.getAttribute('data-text-layer'))).toEqual(['name.text', 'role', 'quote']);
		expect((screen.getByTestId('text-name.text') as HTMLInputElement).value).toBe('Ada Lovelace');
		expect(screen.getByTestId('text-name.text-count').textContent).toBe('12/24');
		expect(screen.getByTestId('text-quote').tagName).toBe('TEXTAREA');
		expect(screen.getByTestId('prop-props.name.align-left').getAttribute('aria-pressed')).toBe('true');
		expect(
			[...document.querySelectorAll('[data-testid="composition-props"] [data-prop]')].map((e) =>
				e.getAttribute('data-prop'),
			),
		).toEqual(['props.accent']);
		// Measured in the bundle page (faked): the bundle's font family and the clipped name.
		await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
		expect(measure).toHaveBeenCalled();
		expect(measure.mock.calls[0]![0]).toMatchObject({
			bundleKey: 'mk_fixture',
			compositionId: 'LowerThird',
			frame: 60,
		});
		const font = screen.getByTestId('prop-props.name.fontFamily') as HTMLSelectElement;
		expect([...font.options].map((o) => o.value)).toEqual(['Inter']);
		const issues = screen.getByTestId('text-name.text-issues');
		expect(issues.querySelector('[data-code="MG_TEXT_CLIPPED"]')).not.toBeNull();
	});

	it('previews while typing (no History entry), applies one "Edit Text" step; Esc reverts', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		const before = labels(session).length;
		const field = screen.getByTestId('text-name.text') as HTMLInputElement;
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'Grace' } });
		await frames();
		fireEvent.change(field, { target: { value: 'Grace Hopper' } });
		await frames();
		expect((props(session, clipId, true).name as { text: string }).text).toBe('Grace Hopper');
		expect(props(session, clipId)).toEqual({});
		expect(labels(session)).toHaveLength(before);
		expect(screen.queryByTestId('text-name.text-issues')?.textContent ?? '').not.toMatch(/designed for/);
		fireEvent.keyDown(field, { key: 'Enter' });
		fireEvent.blur(field);
		await frames();
		expect(labels(session).slice(before)).toEqual(['Edit Text «Name»']);
		expect(props(session, clipId)).toMatchObject({ name: { text: 'Grace Hopper', fontSize: 84 } });

		// Esc: back to the applied value, nothing new in History.
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'Something else' } });
		await frames();
		fireEvent.keyDown(field, { key: 'Escape' });
		fireEvent.blur(field);
		await frames();
		expect(field.value).toBe('Grace Hopper');
		expect(labels(session).slice(before)).toEqual(['Edit Text «Name»']);
		expect(session.getState().transient).toBeNull();
	});

	it('refuses values the schema rejects and warns about soft limits while typing', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		const field = screen.getByTestId('text-name.text') as HTMLInputElement;
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'An unusually long name here' } });
		await frames();
		expect(screen.getByTestId('text-name.text-issues').textContent).toMatch(
			/27 characters \(designed for 24\)/,
		);
		fireEvent.change(field, { target: { value: 'x'.repeat(61) } });
		await frames();
		expect(screen.getByTestId('text-name.text-error').textContent).toMatch(/at most 60/);
		fireEvent.blur(field);
		await frames();
		expect(screen.getByTestId('composition-message').textContent).toMatch(/Not applied/);
		expect(props(session, clipId)).toEqual({});
		expect(field.value).toBe('Ada Lovelace');
	});

	it('style rows write their props; Edit on canvas opens the Program monitor editor for that text', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		fireEvent.click(screen.getByTestId('prop-props.name.align-center'));
		expect(props(session, clipId)).toMatchObject({ name: { align: 'center' } });
		expect(labels(session).at(-1)).toBe('Name Align');
		fireEvent.click(screen.getByTestId('text-quote-canvas'));
		expect(canvasTextEditStore.getState().edit).toMatchObject({ clipId, path: ['quote'] });
	});
});
