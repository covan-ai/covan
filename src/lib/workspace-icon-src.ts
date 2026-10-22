import { assetSrc } from "./asset-src";

/** A workspace icon's stored path (0127), and only that shape, as a URL the browser can load. */
const STORED =
  /^\/workspace-icons\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{32}\.(png|jpg|webp)$/;

export function workspaceIconSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  return STORED.test(url) ? assetSrc(url) : null;
}
