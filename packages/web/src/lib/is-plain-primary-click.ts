import type { MouseEvent } from 'react';

/** A modifier-key or non-primary-button click is left alone so the browser's native "open in new tab / window" still works. */
export const isPlainPrimaryClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
