export type ReadingWidth = 'standard' | 'full';

export const READING_WIDTH_STORAGE_KEY = 'crowi:reading-width:v1';
export const READING_WIDTH_ATTRIBUTE = 'data-reading-width';

const FULL: ReadingWidth = 'full';
const STANDARD: ReadingWidth = 'standard';

/** Anything but the literal `full` (unset, empty, unknown, unreadable) is the standard width. */
export function parseReadingWidth(value: string | null): ReadingWidth {
  return value === FULL ? FULL : STANDARD;
}

/**
 * Body of a synchronous `<head>` script that sets the root width attribute
 * before the body paints. It only compares the stored string with the fixed
 * `full` literal, so a stored value is never interpreted as markup or code.
 */
export function readingWidthBootstrapScript(): string {
  const key = JSON.stringify(READING_WIDTH_STORAGE_KEY);
  const attr = JSON.stringify(READING_WIDTH_ATTRIBUTE);
  const full = JSON.stringify(FULL);
  const standard = JSON.stringify(STANDARD);
  return `(function(){var w=${standard};try{if(window.localStorage.getItem(${key})===${full})w=${full}}catch(e){}document.documentElement.setAttribute(${attr},w)})();`;
}
