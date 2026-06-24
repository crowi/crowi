/**
 * Lightweight Markdown → Slack *mrkdwn* converter for unfurl excerpts.
 *
 * This is deliberately a PREVIEW-GRADE converter, not a full
 * Markdown→mrkdwn engine. Its only job is to keep a ~300-char unfurl
 * excerpt from looking like raw source: it handles the handful of
 * constructs that read worst verbatim (ATX headings, list markers, links,
 * images, fenced-code markers, `**bold**`). Inline `_italic_` / `*…*` /
 * `` `code` `` are left untouched for Slack's own mrkdwn parser
 * (`mrkdwn_in: ['text']`), since those markers already overlap.
 *
 * It intentionally replaces the legacy `convertMarkdownToMrkdwn`
 * (`util/slack.ts.reference`), which bolded every heading-ish line via a
 * greedy un-anchored regex, only normalised `*` bullets, and broke on
 * nested link brackets. Here the line-anchored rules run first and image
 * syntax is consumed before links, so the common cases stay correct.
 *
 * Pure function — unit-tested in `mrkdwn.test.ts`.
 */
export function markdownToMrkdwn(md: string, opts: { baseUrl?: string | null } = {}): string {
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : null;

  // Line-anchored constructs: drop fenced-code markers, bold-ify headings,
  // normalise unordered-list bullets. Inline rules run afterwards.
  const kept: string[] = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) continue; // drop ``` / ~~~ fence lines
    const line = raw
      // `# Heading` … `###### Heading` (optional closing #s) → `*Heading*`
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/, '*$1*')
      // `- ` / `* ` / `+ ` bullet → `• ` (leading indent preserved)
      .replace(/^(\s*)[-*+]\s+(.+)$/, '$1• $2');
    kept.push(line);
  }
  let text = kept.join('\n');

  // Images first, so `![alt](url)` is consumed before the link rule turns
  // its inner `[alt](url)` into a link. Keep the alt text, drop the image.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // `[label](href)` → Slack `<href|label>` for http(s) / site-relative
  // links; anything else (anchors, mailto, malformed) keeps just the label.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_full, label: string, href: string) => {
    if (/^https?:\/\//.test(href)) return `<${href}|${label}>`;
    if (href.startsWith('/') && base) return `<${base}${href}|${label}>`;
    return label;
  });

  // Markdown bold `**x**` / `__x__` → mrkdwn `*x*`. Single `*`/`_` are left
  // for Slack to interpret (its italic/bold markers already overlap).
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/__([^_\n]+)__/g, '*$1*');

  // Collapse runs of blank lines a heading/list strip may have opened up.
  return text.replace(/\n{3,}/g, '\n\n');
}
