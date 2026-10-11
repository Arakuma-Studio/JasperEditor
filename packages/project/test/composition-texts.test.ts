import { describe, expect, it } from 'vitest';
import {
	accentRuns,
	checkCompositionText,
	compositionTextLayers,
	findTextLayer,
	inferPropsSchema,
	type MgCompositionInfo,
	type MgTextMeasurement,
	measuredTextIssues,
	mergeProps,
	overridesWithEdits,
	textAccentColor,
	textLayerPropertyKeys,
	textLayerValue,
} from '../src/index.ts';

const TITLE: MgCompositionInfo = {
	id: 'Title',
	width: 1920,
	height: 1080,
	fps: 30,
	durationInFrames: 90,
	defaultProps: { title: 'Hello Jasper', accent: '#ff3366', delay: 6 },
	propsSchema: {
		type: 'object',
		properties: {
			title: { type: 'string', minLength: 1, maxLength: 80, description: 'Headline text' },
			accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
			delay: { type: 'integer', minimum: 0, maximum: 60 },
		},
		required: ['title', 'accent', 'delay'],
		additionalProperties: false,
	},
	schemaSource: 'bundle',
	ui: { accent: { control: 'color' }, title: { control: 'text' } },
	thumbnailFrame: 45,
};

const LOWER_THIRD_DEFAULTS = {
	name: { text: 'Ada Lovelace', color: '#ffffff', fontSize: 72, fontFamily: 'Inter', align: 'left' },
	role: 'Mathematician',
	roleColor: '#ffcc00',
	roleSize: 40,
	quote: 'The Analytical Engine weaves algebraic patterns\njust as the Jacquard loom weaves flowers.',
	logoUrl: 'logo.png',
	theme: 'dark',
	accent: '#3366ff',
};

function lowerThird(over: Partial<MgCompositionInfo> = {}): MgCompositionInfo {
	const { schema, ui } = inferPropsSchema(LOWER_THIRD_DEFAULTS);
	return {
		id: 'LowerThird',
		width: 1920,
		height: 1080,
		fps: 30,
		durationInFrames: 120,
		defaultProps: LOWER_THIRD_DEFAULTS,
		propsSchema: schema,
		schemaSource: 'inferred',
		ui,
		...over,
	};
}

describe('text layer discovery (S08:MGC-036)', () => {
	it('a UI-hinted string is a text; colours and patterned strings are not', () => {
		const layers = compositionTextLayers(TITLE);
		expect(layers.map((l) => l.path.join('.'))).toEqual(['title']);
		const t = layers[0]!;
		expect(t).toMatchObject({
			key: 'props.title',
			label: 'Title',
			source: 'ui',
			multiline: false,
			minLength: 1,
			maxLength: 80,
			frame: 45,
			description: 'Headline text',
		});
		expect(t.style).toEqual({});
	});

	it('infers texts from plain strings and links style props by the object and prefix conventions', () => {
		const layers = compositionTextLayers(lowerThird());
		expect(layers.map((l) => [l.path.join('.'), l.label, l.source, l.multiline])).toEqual([
			['name.text', 'Name', 'inferred', false],
			['role', 'Role', 'inferred', false],
			['quote', 'Quote', 'ui', true], // inference hints a textarea (line break in the default)
		]);
		const name = layers[0]!;
		expect(Object.fromEntries(Object.entries(name.style).map(([k, v]) => [k, v!.key]))).toEqual({
			fontFamily: 'props.name.fontFamily',
			fontSize: 'props.name.fontSize',
			color: 'props.name.color',
			align: 'props.name.align',
		});
		const role = layers[1]!;
		expect(Object.fromEntries(Object.entries(role.style).map(([k, v]) => [k, v!.key]))).toEqual({
			fontSize: 'props.roleSize',
			color: 'props.roleColor',
		});
		expect(findTextLayer(layers, 'logoUrl')).toBeUndefined();
		expect(findTextLayer(layers, 'theme')).toBeUndefined();
		expect(findTextLayer(layers, 'name.fontFamily')).toBeUndefined();
		expect([...textLayerPropertyKeys(layers)].sort()).toEqual(
			[
				'props.name.align',
				'props.name.color',
				'props.name.fontFamily',
				'props.name.fontSize',
				'props.name.text',
				'props.quote',
				'props.role',
				'props.roleColor',
				'props.roleSize',
			].sort(),
		);
	});

	it('manifest declarations come first, set labels, limits and explicit style links; false hides a string', () => {
		const info = lowerThird({
			texts: {
				quote: {
					label: 'Quote',
					maxChars: 90,
					maxLines: 2,
					box: { x: 96, y: 700, width: 1200, height: 300 },
					frame: 60,
					hint: 'Line breaks start a new row',
					style: { color: 'accent' },
				},
				role: false,
			},
		});
		const layers = compositionTextLayers(info);
		expect(layers.map((l) => l.path.join('.'))).toEqual(['quote', 'name.text']);
		const quote = layers[0]!;
		expect(quote).toMatchObject({
			source: 'manifest',
			maxChars: 90,
			maxLines: 2,
			multiline: true,
			frame: 60,
			box: { x: 96, y: 700, width: 1200, height: 300 },
			hint: 'Line breaks start a new row',
		});
		expect(quote.style.color?.key).toBe('props.accent');
		expect(findTextLayer(layers, 'props.quote')).toBe(quote);
		expect(findTextLayer(layers, 'name')?.path).toEqual(['name', 'text']);
	});

	it('the x-jasper-text schema annotation declares (or excludes) a text', () => {
		const info: MgCompositionInfo = {
			...TITLE,
			propsSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', 'x-jasper-text': { label: 'Headline', maxChars: 30 } },
					slug: { type: 'string', 'x-jasper-text': true },
					note: { type: 'string', 'x-jasper-text': false },
				},
			},
			ui: {},
			defaultProps: { title: 'A', slug: 'b', note: 'c' },
		};
		const layers = compositionTextLayers(info);
		expect(layers.map((l) => [l.path[0], l.label, l.source])).toEqual([
			['title', 'Headline', 'schema'],
			['slug', 'Slug', 'schema'], // annotated: wins over the name heuristic
		]);
		expect(layers[0]!.maxChars).toBe(30);
	});
});

describe('text checks (S08:MGC-037)', () => {
	it('static: schema length is an error, soft limits and stray line breaks are warnings', () => {
		const [title] = compositionTextLayers(TITLE);
		expect(checkCompositionText(title!, 'Hello')).toEqual([]);
		expect(checkCompositionText(title!, '').map((i) => [i.code, i.severity])).toEqual([
			['MG_TEXT_TOO_SHORT', 'error'],
		]);
		const long = checkCompositionText(title!, 'x'.repeat(81));
		expect(long.map((i) => [i.code, i.severity])).toEqual([['MG_TEXT_TOO_LONG', 'error']]);
		expect(checkCompositionText(title!, 'a\nb').map((i) => i.code)).toEqual(['MG_TEXT_LINES']);
		const quote = compositionTextLayers(
			lowerThird({ texts: { quote: { maxChars: 10, maxLines: 1, multiline: true } } }),
		)[0]!;
		expect(checkCompositionText(quote, 'one two three\nfour').map((i) => [i.code, i.severity])).toEqual([
			['MG_TEXT_LONG', 'warning'],
			['MG_TEXT_LINES', 'warning'],
		]);
		// Characters are code points: an emoji counts once.
		expect(checkCompositionText(title!, '😀'.repeat(80))).toEqual([]);
	});

	it('measured: off frame, clipped, ellipsis, outside the safe box, wrapped lines, not drawn', () => {
		const quote = compositionTextLayers(
			lowerThird({ texts: { quote: { maxLines: 2, box: { x: 100, y: 700, width: 1000, height: 300 } } } }),
		)[0]!;
		const base: MgTextMeasurement = {
			id: 'quote',
			found: true,
			visible: true,
			rect: { x: 120, y: 720, width: 800, height: 200 },
			lines: [
				{ x: 120, y: 720, width: 800, height: 100 },
				{ x: 120, y: 820, width: 600, height: 100 },
			],
			clippedBy: null,
			truncated: false,
			style: null,
		};
		const frame = { width: 1920, height: 1080 };
		expect(measuredTextIssues(quote, base, frame)).toEqual([]);
		const wide = measuredTextIssues(
			quote,
			{
				...base,
				rect: { x: 120, y: 720, width: 2000, height: 300 },
				lines: [...base.lines, { x: 120, y: 920, width: 100, height: 100 }],
				clippedBy: { x: 100, y: 700, width: 1000, height: 300 },
				truncated: true,
			},
			frame,
		);
		expect(wide.map((i) => i.code)).toEqual([
			'MG_TEXT_CLIPPED', // the visible intersection stays within the frame and safe box
			'MG_TEXT_TRUNCATED',
			'MG_TEXT_LINES',
		]);
		const off = measuredTextIssues(
			quote,
			{ ...base, rect: { x: 120, y: 720, width: 2000, height: 300 } },
			frame,
		);
		expect(off.map((i) => i.code)).toEqual(['MG_TEXT_OFF_FRAME', 'MG_TEXT_OUTSIDE_BOX']);
		expect(
			measuredTextIssues(quote, { ...base, found: false, rect: null }, frame).map((i) => [
				i.code,
				i.severity,
			]),
		).toEqual([['MG_TEXT_NOT_FOUND', 'info']]);
	});
});

describe('text edits (S08:MGC-038)', () => {
	it('writes several values (text + style) into one override object, keeping siblings', () => {
		const info = lowerThird();
		const layers = compositionTextLayers(info);
		const name = layers[0]!;
		const next = overridesWithEdits(info.defaultProps, { role: 'Countess' }, [
			{ path: name.path, value: 'Grace Hopper' },
			{ path: name.style.fontSize!.path, value: 80 },
		]);
		expect(next).toEqual({
			role: 'Countess',
			name: { text: 'Grace Hopper', color: '#ffffff', fontSize: 80, fontFamily: 'Inter', align: 'left' },
		});
		const eff = mergeProps(info.defaultProps, next);
		expect(textLayerValue(eff, name)).toBe('Grace Hopper');
		expect(textLayerValue(eff, layers[1]!)).toBe('Countess');
	});
});

describe('accent markup (S08:MGU-005)', () => {
	it('splits *…* spans into runs that concatenate back to the value', () => {
		const v = 'Un solo panel.\n*Todo tu negocio.*';
		const runs = accentRuns(v);
		expect(runs.map((r) => [v.slice(r.start, r.end), r.kind])).toEqual([
			['Un solo panel.\n', 'plain'],
			['*', 'mark'],
			['Todo tu negocio.', 'accent'],
			['*', 'mark'],
		]);
		expect(runs.map((r) => v.slice(r.start, r.end)).join('')).toBe(v);
		expect(accentRuns('a *open').map((r) => r.kind)).toEqual(['plain', 'mark', 'accent']);
	});

	it('resolves the accent colour from a literal or a colour prop', () => {
		expect(textAccentColor({ accent: '#3E99F5' }, {})).toBe('#3E99F5');
		expect(textAccentColor({ accent: 'theme.accent' }, { theme: { accent: '#ff0000' } })).toBe('#ff0000');
		expect(textAccentColor({ accent: 'missing' }, {})).toBeNull();
		expect(textAccentColor({}, {})).toBeNull();
		const quote = compositionTextLayers(lowerThird({ texts: { quote: { accent: 'accent' } } }))[0]!;
		expect(quote.accent).toBe('accent');
		expect(textAccentColor(quote, LOWER_THIRD_DEFAULTS)).toBe('#3366ff');
	});
});
