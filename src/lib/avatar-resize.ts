import { i18n } from "@/i18n";

/** What the photo is stored at: square, and twice the largest tile it fills. */
export const AVATAR_SIZE = 256;

/** Refused before decoding. A phone photo is a few megabytes; this is not one. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * A picked photo as a small square image, ready to upload.
 *
 * Done in the browser so a 6 MB phone photo goes up as a few kilobytes, and
 * so the server never has to decode an image: it only checks the bytes are a
 * PNG, JPEG or WebP and stores them. The crop is a centred square ("cover"),
 * which is what a square tile would have shown anyway.
 *
 * WebP where the browser can encode it, JPEG where it cannot — `toBlob` falls
 * back to PNG silently for a type it does not support, so the result's type is
 * checked rather than trusted.
 *
 * The errors are what the profile form shows, so they are worded — in the
 * page's language, read at the moment they are thrown.
 */
export async function resizeAvatar(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error(i18n.t("Pick an image file."));
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(i18n.t("That image is over 10 MB. Pick a smaller one."));
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(unreadable());
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(unreadable());
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();

  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

  const webp = await encode("image/webp", 0.85);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await encode("image/jpeg", 0.88);
  if (jpeg) return jpeg;
  throw new Error(unreadable());
}

function unreadable(): string {
  return i18n.t("That image could not be read.");
}
