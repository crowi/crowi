import { validateImageDisplayProps } from './url';

/**
 * The "structure owner table": display properties of elements `toHast` itself
 * created (headings, footnotes, task lists, the alert/figure/card shells…).
 * After the parse these are restored onto the matching parsed element, so the
 * same class or data attribute written by an author in raw HTML earns nothing.
 * Closed set — arbitrary hProperties are never carried over wholesale.
 */
export interface OwnerEntry {
  tagName: string;
  /** Generated id/name (spec R-5): restored without author filtering. */
  id?: string;
  name?: string;
  /** Generated `section` target: only restored when the child heading's id matches. */
  sectionId?: string;
  fixed: Record<string, unknown>;
}

const LINK_CARD_CLASSES = [
  'crowi-link-card',
  'crowi-link-card-preview-surface',
  'crowi-link-card-body',
  'crowi-link-card-title',
  'crowi-link-card-preview-message',
];
const ALERT_VARIANTS: ReadonlySet<string> = new Set(['note', 'tip', 'important', 'warning', 'caution']);
const LANGUAGE_CLASS_RE = /^language-[A-Za-z0-9_-]{1,64}$/;
const SOURCE_LINE_STRING_RE = /^[1-9]\d*$/;

function classes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

function prop(props: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in props) return props[name];
  return undefined;
}

export function buildOwnerEntry(tagName: string, props: Record<string, unknown>): OwnerEntry {
  const fixed: Record<string, unknown> = {};
  const entry: OwnerEntry = { tagName, fixed };
  const cls = classes(props.className ?? props.class);

  const id = props.id;
  if (typeof id === 'string' && id !== '') entry.id = id;
  const name = props.name;
  if (tagName === 'a' && typeof name === 'string' && name !== '') entry.name = name;

  const sourceLine = prop(props, 'dataSourceLine', 'data-source-line');
  if (typeof sourceLine === 'number' && Number.isInteger(sourceLine) && sourceLine > 0) fixed.dataSourceLine = sourceLine;
  else if (typeof sourceLine === 'string' && SOURCE_LINE_STRING_RE.test(sourceLine)) fixed.dataSourceLine = sourceLine;

  switch (tagName) {
    case 'ul':
    case 'ol':
      if (cls.includes('contains-task-list')) fixed.className = ['contains-task-list'];
      break;
    case 'li':
      if (cls.includes('task-list-item')) fixed.className = ['task-list-item'];
      break;
    case 'a': {
      const kept = cls.filter((c) => c === 'mention' || c === 'wikilink-broken' || c === 'data-footnote-backref');
      if (kept.length > 0) fixed.className = kept;
      if (prop(props, 'dataFootnoteRef', 'data-footnote-ref') !== undefined) {
        fixed.dataFootnoteRef = '';
        if (classes(prop(props, 'ariaDescribedBy', 'aria-describedby')).join(' ') === 'footnote-label') fixed.ariaDescribedBy = ['footnote-label'];
      }
      if (prop(props, 'dataFootnoteBackref', 'data-footnote-backref') !== undefined) {
        fixed.dataFootnoteBackref = '';
        const label = prop(props, 'ariaLabel', 'aria-label');
        if (typeof label === 'string') fixed.ariaLabel = label;
      }
      break;
    }
    case 'code': {
      const language = cls.find((c) => LANGUAGE_CLASS_RE.test(c));
      if (language) fixed.className = [language];
      break;
    }
    case 'span': {
      if (prop(props, 'role') === 'img') {
        const label = prop(props, 'ariaLabel', 'aria-label');
        if (typeof label === 'string') {
          fixed.role = 'img';
          fixed.ariaLabel = label;
        }
      }
      const card = cls.find((c) => LINK_CARD_CLASSES.includes(c));
      if (card) fixed.className = [card];
      break;
    }
    case 'section': {
      const sectionId = prop(props, 'dataSectionId', 'data-section-id');
      if (typeof sectionId === 'string' && sectionId !== '') entry.sectionId = sectionId;
      if (prop(props, 'dataFootnotes', 'data-footnotes') !== undefined && cls.includes('footnotes')) {
        fixed.dataFootnotes = '';
        fixed.className = ['footnotes'];
      }
      break;
    }
    case 'h2':
      if (id === 'footnote-label' && cls.includes('sr-only')) fixed.className = ['sr-only'];
      break;
    case 'dl':
      if (cls.includes('crowi-frontmatter')) fixed.className = ['crowi-frontmatter'];
      break;
    case 'aside': {
      const variant = prop(props, 'dataCrowiAlertVariant', 'data-crowi-alert-variant');
      if (typeof variant === 'string' && ALERT_VARIANTS.has(variant)) fixed.dataCrowiAlertVariant = variant;
      break;
    }
    case 'figure':
      if (cls.includes('crowi-figure')) {
        fixed.className = ['crowi-figure'];
        const layout = validateImageDisplayProps(props);
        if (layout.align) fixed.dataCrowiImageAlign = layout.align;
        if (layout.float) fixed.dataCrowiImageFloat = layout.float;
      }
      break;
    case 'input':
      if (props.type === 'checkbox') {
        fixed.type = 'checkbox';
        fixed.disabled = true;
        if (props.checked === true) fixed.checked = true;
      }
      break;
    default:
      break;
  }
  return entry;
}
