import {
	applyTransaction,
	type CommandContext,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type IdSource,
	type MediaAsset,
	type ProjectDocument,
	type Sequence,
	type TransactionResult,
} from '../src/index.ts';

export function makeCtx(
	overrides: Partial<CommandContext> = {},
	ids: IdSource = createCounterIdSource(7),
): CommandContext {
	return {
		ids,
		now: () => '2026-09-30T10:00:00.000Z',
		revision: 0,
		registries: defaultRegistries(),
		...overrides,
	};
}

/** A tiny harness that keeps a document, a revision counter and a seeded id source. */
export class Harness {
	doc: ProjectDocument;
	revision = 0;
	readonly ids: IdSource;
	entityRevisions = new Map<string, number>();
	constructor(opts: { preset?: string; seed?: number; ctx?: Partial<CommandContext> } = {}) {
		this.ids = createCounterIdSource(opts.seed ?? 1);
		this.doc = createEmptyProject({ ids: this.ids, name: 'Test', preset: opts.preset ?? 'hd-1080p-30' });
		this.extra = opts.ctx ?? {};
	}
	extra: Partial<CommandContext>;
	get seq(): Sequence {
		return Object.values(this.doc.sequences)[0]!;
	}
	get seqId(): string {
		return this.seq.id;
	}
	ctx(extra: Partial<CommandContext> = {}): CommandContext {
		return makeCtx(
			{ revision: this.revision, entityRevisions: this.entityRevisions, ...this.extra, ...extra },
			this.ids,
		);
	}
	/** Applies commands; returns the result. Commits on success. */
	tx(
		commands: unknown[],
		opts: {
			origin?: unknown;
			label?: string;
			expectedRevision?: number;
			dryRun?: boolean;
			ctx?: Partial<CommandContext>;
		} = {},
	): TransactionResult {
		const { document, result } = applyTransaction(
			this.doc,
			{
				label: opts.label ?? 'test',
				origin: opts.origin ?? 'user',
				sequenceId: this.seqId,
				commands,
				...(opts.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}),
				...(opts.dryRun ? { dryRun: true } : {}),
			},
			this.ctx(opts.ctx),
		);
		if (result.ok && document !== this.doc) {
			this.doc = document;
			this.revision = result.revision;
			for (const id of [...result.created, ...result.changed, ...result.deleted])
				this.entityRevisions.set(id, result.revision);
		}
		return result;
	}
	ok(commands: unknown[], opts: Parameters<Harness['tx']>[1] = {}): Extract<TransactionResult, { ok: true }> {
		const r = this.tx(commands, opts);
		if (!r.ok) throw new Error(`transaction failed: ${JSON.stringify(r.errors, null, 2)}`);
		return r;
	}
	clips(track?: string) {
		const seq = this.seq;
		const list = Object.values(seq.clips);
		const trackId = track ? resolveLabel(seq, track) : undefined;
		return list.filter((c) => !trackId || c.trackId === trackId).sort((a, b) => a.start - b.start);
	}
	/** [start, end) spans on a track. */
	spans(track: string): [number, number][] {
		return this.clips(track).map((c) => [c.start, c.start + c.duration]);
	}
	registerVideo(opts: Parameters<typeof videoAsset>[0] = {}): string {
		const r = this.ok([{ type: 'media.register', asset: videoAsset(opts) }]);
		return (r.results[0] as { mediaId: string }).mediaId;
	}
}

function resolveLabel(seq: Sequence, label: string): string {
	const m = /^([VA])(\d+)$/.exec(label);
	if (!m) return label;
	const list = m[1] === 'V' ? seq.videoTracks : seq.audioTracks;
	return list[Number(m[2]) - 1]!.id;
}

let fp = 0;
/** A probed video asset: 1920x1080, 30 fps, stereo AAC (defaults), `seconds` long. */
export function videoAsset(
	opts: {
		seconds?: number;
		width?: number;
		height?: number;
		fps?: { num: number; den: number };
		audio?: boolean;
		kind?: MediaAsset['kind'];
		rotation?: 0 | 90 | 180 | 270;
	} = {},
): Omit<MediaAsset, 'id'> & { id?: string } {
	const seconds = opts.seconds ?? 10;
	const kind = opts.kind ?? 'video';
	const streams: MediaAsset['probe']['streams'] = [];
	if (kind !== 'audio') {
		streams.push({
			index: 0,
			type: 'video',
			codec: kind === 'image' ? 'png' : 'h264',
			width: opts.width ?? 1920,
			height: opts.height ?? 1080,
			pixelAspect: { num: 1, den: 1 },
			frameRate: opts.fps ?? { num: 30, den: 1 },
			pixelFormat: 'yuv420p',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
			browserDecodable: true,
		});
	}
	if (kind === 'audio' || (kind === 'video' && opts.audio !== false)) {
		streams.push({
			index: streams.length,
			type: 'audio',
			codec: 'aac',
			sampleRate: 48000,
			channels: 2,
			channelLayout: 'stereo',
		});
	}
	return {
		kind,
		fingerprint: `q1:${(++fp).toString(16).padStart(64, '0')}`,
		originalName: `clip-${fp}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: kind === 'image' ? null : Math.round(seconds * 705_600_000),
			startTimecode: null,
			streams,
			rotationDegrees: opts.rotation ?? 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	};
}
