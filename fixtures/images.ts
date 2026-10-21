/**
 * The six images in the library, generated rather than committed.
 *
 * Each is a flat colour with a few shapes — no text, so no font is needed — fed
 * through the CMS's own processor, so the renditions, keys and row shape are
 * what an upload would have produced. Sharp's bytes are not pinned across
 * versions; the rows (ids, sizes, keys, variants) are what stays the same.
 */
import sharp from "sharp";

export interface FixtureImage {
  /** Short name the content refers to. */
  key: string;
  id: string;
  width: number;
  height: number;
  alt: string;
  focal: { x: number; y: number };
  background: string;
  accent: string;
  /** Who uploaded it (a persona key). */
  uploadedBy: string;
  uploadedAt: string;
}

export const IMAGES: readonly FixtureImage[] = [
  {
    key: "harbour",
    id: "10000000-0000-4000-8000-000000000001",
    width: 2400,
    height: 1350,
    alt: "Boats in the harbour at dawn",
    focal: { x: 0.5, y: 0.5 },
    background: "#2f5d7c",
    accent: "#f2c14e",
    uploadedBy: "priya",
    uploadedAt: "2026-01-06T10:00:00.000Z",
  },
  {
    // Used on two pages: the /about gallery and the /work gallery.
    key: "team",
    id: "10000000-0000-4000-8000-000000000002",
    width: 1600,
    height: 1067,
    alt: "The Northwind team around a table",
    focal: { x: 0.4, y: 0.35 },
    background: "#7a4b6b",
    accent: "#e8d5e0",
    uploadedBy: "priya",
    uploadedAt: "2026-01-06T10:05:00.000Z",
  },
  {
    key: "project",
    id: "10000000-0000-4000-8000-000000000003",
    width: 1600,
    height: 900,
    alt: "A finished project on a laptop screen",
    focal: { x: 0.5, y: 0.5 },
    background: "#3d6b4f",
    accent: "#d9ead3",
    uploadedBy: "leo",
    uploadedAt: "2026-01-07T09:30:00.000Z",
  },
  {
    // Too narrow for the hero's `minWidth: 400`. Used nowhere.
    key: "portrait",
    id: "10000000-0000-4000-8000-000000000004",
    width: 300,
    height: 450,
    alt: "A narrow portrait of the founder",
    focal: { x: 0.5, y: 0.3 },
    background: "#b5651d",
    accent: "#fde8cf",
    uploadedBy: "leo",
    uploadedAt: "2026-01-07T09:45:00.000Z",
  },
  {
    // Used nowhere: the one story 09 deletes.
    key: "office",
    id: "10000000-0000-4000-8000-000000000005",
    width: 1200,
    height: 800,
    alt: "The old office before the move",
    focal: { x: 0.5, y: 0.5 },
    background: "#5b5b5b",
    accent: "#dcdcdc",
    uploadedBy: "priya",
    uploadedAt: "2026-01-08T14:00:00.000Z",
  },
  {
    // Only a draft uses it (`/draft-ideas`), so it is deletable too.
    key: "sketch",
    id: "10000000-0000-4000-8000-000000000006",
    width: 1000,
    height: 1000,
    alt: "A pencil sketch of the new homepage",
    focal: { x: 0.5, y: 0.5 },
    background: "#e9e4d8",
    accent: "#444444",
    uploadedBy: "zofia",
    uploadedAt: "2026-01-09T08:15:00.000Z",
  },
];

export const imageId = (key: string): string => {
  const image = IMAGES.find((candidate) => candidate.key === key);
  if (!image) throw new Error(`Unknown fixture image "${key}"`);
  return image.id;
};

/** A deterministic JPEG: a flat colour with an accent rectangle and circle. */
export const renderImage = async (image: FixtureImage): Promise<Uint8Array> => {
  const { width, height } = image;
  const shapes = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="${width * 0.1}" y="${height * 0.6}" width="${width * 0.8}" height="${height * 0.25}" fill="${image.accent}" opacity="0.7"/>` +
      `<circle cx="${width * 0.75}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.15}" fill="${image.accent}"/>` +
      "</svg>",
  );
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: image.background },
    })
      .composite([{ input: shapes }])
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
};
