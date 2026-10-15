/**
 * Invisible characters built from their code points, so editors and formatters can't
 * silently turn the escapes into literal (and unreviewable) characters.
 */
export const UTF8_BOM = String.fromCharCode(0xfeff);
/** What Node's UTF-8 decoder substitutes for invalid byte sequences. */
export const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export const stripBom = (text: string): string =>
  text.startsWith(UTF8_BOM) ? text.slice(1) : text;
