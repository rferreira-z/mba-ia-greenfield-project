/**
 * RFC 6266 attachment header for a user-supplied file name: a quoted ASCII
 * fallback (unsafe characters replaced) plus the exact name in `filename*`
 * (RFC 5987 UTF-8 encoding), so non-ASCII names survive the download.
 */
export function attachmentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
