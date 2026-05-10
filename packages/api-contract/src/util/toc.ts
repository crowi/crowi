import { Slugger } from './slug';

export interface TocEntry {
  level: number;
  text: string;
  anchorId: string;
}

const FENCE_RE = /^(?:```|~~~)/;
const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Flat heading list extracted by line-based scan. Skips ATX-style
 * headings inside fenced code blocks. Setext headings and HTML-inline
 * markup are out of scope — adding them requires a real MDAST parser.
 */
export function extractToc(body: string): TocEntry[] {
  const lines = body.split(/\r?\n/);
  const entries: TocEntry[] = [];
  const slugger = new Slugger();

  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(ATX_HEADING_RE);
    if (!m) continue;

    const level = m[1].length;
    const rawText = m[2].trim();
    const text = stripInlineMarkup(rawText);
    const anchorId = slugger.slug(text);

    entries.push({ level, text, anchorId });
  }

  return entries;
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .trim();
}
