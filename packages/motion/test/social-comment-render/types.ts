/** Input props of the social-comment render entry. */
export type CardProps = {
	params: Record<string, unknown>;
	/** Font faces to load first: files of the bundle's public dir. */
	fonts: { family: string; weight: number; file: string }[];
	/** `mediaUrls` / `emojiUrls` of the template, as public-dir files. */
	mediaFiles: Record<string, string>;
	emojiFiles: Record<string, string>;
	/** `imageUrls` (remote manifest images by id, e.g. X's default avatar), as public-dir files. */
	imageFiles?: Record<string, string>;
	background?: string;
};
