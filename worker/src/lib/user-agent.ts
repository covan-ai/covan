/**
 * A browser's User-Agent as the two words a person recognises: the device and
 * the browser ("iPhone · Safari", "Windows · Chrome"). Settings › Security
 * lists the account's sign-ins this way (A16). Never a version number, never
 * an address — the screen has no use for either.
 */
export function describeUserAgent(ua: string | null | undefined): {
  device: string;
  browser: string;
} {
  const s = ua ?? "";
  const device = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /CrOS/.test(s)
              ? "Chromebook"
              : /Linux/.test(s)
                ? "Linux"
                : "A device";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /Firefox\//.test(s)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(s)
          ? "Chrome"
          : /Safari\//.test(s)
            ? "Safari"
            : "a browser";
  return { device, browser };
}
