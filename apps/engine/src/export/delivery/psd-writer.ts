// Spec 19 TL-112: a PSD assembled on disk, one layer at a time. ag-psd writes every byte of it, but `writePsd` takes all
// layers in RAM and returns one synchronous buffer (Pachislop's weakness; a 4K frame of 60 layers is 2 GiB). So each layer
// goes through ag-psd alone as a one-layer document, in a slice short enough not to hold the event loop; its record is
// kept and its compressed channels are appended to a scratch file; the file is then streamed together in the order the
// format wants. Memory is one frame's RGBA plus ag-psd's scratch buffer, whatever the layer count.
//
// File layout (Adobe Photoshop File Formats Specification): header, colour mode data, image resources, then the layer
// and mask section (layer info: count, records, channel data, even-rounded here to 4; global mask info; tagged blocks),
// then the composite. The head, the tail and the composite come from one ag-psd document without pixels in its layers.
import { createReadStream, createWriteStream } from 'node:fs';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Layer as AgLayer, ImageResources, Psd } from 'ag-psd';
import { writePsdUint8Array } from 'ag-psd';
import { fromBlendMode } from 'ag-psd/dist/helpers.js';
import { fsyncDir } from '../../tools/fs.ts';

/** PSD sections hold 32-bit lengths; Photoshop itself stops at 2 GiB. */
export const MAX_PSD_FILE_BYTES = 0x7fff_ffff;

export class PsdTooLargeError extends Error {
	constructor() {
		super("The PSD would pass the format's 2 GiB limit");
		this.name = 'PsdTooLargeError';
	}
}

const u32 = (b: Uint8Array, o: number) =>
	new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, false);
const u16 = (b: Uint8Array, o: number) =>
	new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, false);
const i16 = (b: Uint8Array, o: number) =>
	new DataView(b.buffer, b.byteOffset, b.byteLength).getInt16(o, false);

/** Offsets of the layer and mask section of an ag-psd document. */
function sections(psd: Uint8Array) {
	let o = 26;
	o += 4 + u32(psd, o); // colour mode data
	o += 4 + u32(psd, o); // image resources
	const layerMask = o;
	const layerMaskLength = u32(psd, o);
	const layerInfo = o + 4;
	const layerInfoLength = u32(psd, layerInfo);
	return { layerMask, layerMaskEnd: layerMask + 4 + layerMaskLength, layerInfo, layerInfoLength };
}

/** The layer record and the channel data of a one-layer document. */
function layerSlices(psd: Uint8Array): { record: Uint8Array; channels: Uint8Array } {
	const { layerInfo } = sections(psd);
	const start = layerInfo + 4 + 2;
	let o = start + 16;
	const count = u16(psd, o);
	o += 2;
	let channelBytes = 0;
	for (let i = 0; i < count; i++) {
		channelBytes += u32(psd, o + 2);
		o += 6;
	}
	o += 12; // blend signature, key, opacity, clipping, flags, filler
	o += 4 + u32(psd, o);
	return { record: psd.subarray(start, o), channels: psd.subarray(o, o + channelBytes) };
}

export type PsdPixels = {
	/** RGBA, straight alpha, `width × height`. */
	data: Uint8Array;
	width: number;
	height: number;
	/** Position in the document. */
	left: number;
	top: number;
};

export type PsdLayerInput = {
	name: string;
	blend: string;
	opacity: number;
	hidden: boolean;
	pixels: PsdPixels | null;
};

/** The empty rectangle of a one-layer document: no pixels (a transparent layer or a section divider). */
const asLayer = (l: PsdLayerInput, id: number): AgLayer => ({
	id,
	name: l.name,
	hidden: l.hidden,
	opacity: l.opacity,
	blendMode: l.blend as AgLayer['blendMode'],
	...(l.pixels
		? {
				left: l.pixels.left,
				top: l.pixels.top,
				imageData: {
					data: new Uint8ClampedArray(
						l.pixels.data.buffer,
						l.pixels.data.byteOffset,
						l.pixels.data.byteLength,
					),
					width: l.pixels.width,
					height: l.pixels.height,
				} as never,
			}
		: {}),
});

/** A one-layer document in the size of its pixels (its header is thrown away; records hold absolute coordinates). */
function oneLayer(layer: AgLayer, w: number, h: number): Uint8Array {
	const doc: Psd = { width: Math.max(1, w), height: Math.max(1, h), children: [layer] };
	return writePsdUint8Array(doc, { noBackground: true });
}

export class PsdAssembler {
	private readonly records: Uint8Array[] = [];
	private recordBytes = 0;
	private channelBytes = 0;
	private readonly channels: ReturnType<typeof createWriteStream>;
	private nextId = 1;

	constructor(
		private readonly channelFile: string,
		private readonly doc: { width: number; height: number; resources: ImageResources },
	) {
		this.channels = createWriteStream(channelFile);
	}

	private async append(psd: Uint8Array): Promise<void> {
		const { record, channels } = layerSlices(psd);
		this.records.push(record.slice());
		this.recordBytes += record.length;
		this.channelBytes += channels.length;
		if (
			this.recordBytes + this.channelBytes + (this.doc.width * this.doc.height * 4 + 4096) >
			MAX_PSD_FILE_BYTES
		)
			throw new PsdTooLargeError();
		if (!this.channels.write(channels))
			await new Promise<void>((resolve) => this.channels.once('drain', () => resolve()));
	}

	/** One raster layer, straight through ag-psd; `pixels` may be released when this resolves. */
	async addPixels(layer: PsdLayerInput): Promise<void> {
		const w = (layer.pixels?.left ?? 0) + (layer.pixels?.width ?? 1);
		const h = (layer.pixels?.top ?? 0) + (layer.pixels?.height ?? 1);
		// The document only bounds the layer here; `left`/`top` are kept by the record.
		await this.append(
			oneLayer(asLayer(layer, this.nextId++), layer.pixels?.width ?? w, layer.pixels?.height ?? h),
		);
	}

	/** `</Layer group>`: what precedes a group's members in the file. */
	async openGroup(): Promise<void> {
		await this.append(
			oneLayer({ id: this.nextId++, name: '</Layer group>', sectionDivider: { type: 3 } }, 1, 1),
		);
	}

	/** The group's own record, after its members. */
	async closeGroup(g: { name: string; hidden: boolean; opacity: number; blend: string }): Promise<void> {
		const pass = g.blend === 'pass through';
		const key = pass ? 'pass' : fromBlendMode[g.blend as keyof typeof fromBlendMode];
		await this.append(
			oneLayer(
				{
					id: this.nextId++,
					name: g.name,
					hidden: g.hidden,
					opacity: g.opacity,
					blendMode: pass ? 'normal' : (g.blend as AgLayer['blendMode']),
					sectionDivider: { type: 1, key, subType: 0 },
				},
				1,
				1,
			),
		);
	}

	/** Streams the file to a temporary name next to `dest`, fsyncs, renames, fsyncs the directory. */
	async finish(composite: Uint8Array, dest: string, signal?: AbortSignal): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.channels.once('error', reject);
			this.channels.end(() => resolve());
		});
		const { width, height, resources } = this.doc;
		// `children` of the right length: the resources list one group entry per layer.
		const base = writePsdUint8Array(
			{
				width,
				height,
				imageResources: resources,
				imageData: {
					data: new Uint8ClampedArray(composite.buffer, composite.byteOffset, composite.byteLength),
					width,
					height,
				} as never,
				children: this.records.map(() => ({})),
			},
			{ noBackground: true },
		);
		const s = sections(base);
		const count = i16(base, s.layerInfo + 4);
		const head = base.subarray(0, s.layerMask);
		// What follows the layer info in its section: global layer mask info and tagged blocks.
		const after = base.subarray(s.layerInfo + 4 + s.layerInfoLength, s.layerMaskEnd);
		const compositeBytes = base.subarray(s.layerMaskEnd);

		let info = 2 + this.recordBytes + this.channelBytes;
		const pad = (4 - (info % 4)) % 4;
		info += pad;
		const section = 4 + info + after.length;
		const total = head.length + 4 + section + compositeBytes.length;
		if (total > MAX_PSD_FILE_BYTES) throw new PsdTooLargeError();

		const tmp = join(dirname(dest), `.${basename(dest)}.tmp`);
		let fh: FileHandle | null = await open(tmp, 'w');
		try {
			const prefix = Buffer.alloc(10);
			prefix.writeUInt32BE(section, 0);
			prefix.writeUInt32BE(info, 4);
			prefix.writeInt16BE(count < 0 ? -this.records.length : this.records.length, 8);
			await fh.write(head);
			await fh.write(prefix);
			for (const r of this.records) await fh.write(r);
			await pipeline(createReadStream(this.channelFile), fh.createWriteStream({ autoClose: false }), {
				end: false,
				...(signal ? { signal } : {}),
			});
			if (pad) await fh.write(Buffer.alloc(pad));
			await fh.write(after);
			await fh.write(compositeBytes);
			await fh.sync();
			await fh.close();
			fh = null;
			await rename(tmp, dest);
			await fsyncDir(dirname(dest));
		} catch (e) {
			await fh?.close().catch(() => undefined);
			await rm(tmp, { force: true });
			throw e;
		}
		return total;
	}

	/** Releases the scratch stream (a failed or cancelled job). */
	close(): void {
		this.channels.destroy();
	}
}
