import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { m } from '@paraglide/messages.js';
import { MarkdownTableFullscreen } from './markdown-table-fullscreen';

afterEach(() => {
  cleanup();
});

const expandLabel = m['page.table_fullscreen_open']();

function Harness({ label = 'a', ...props }: { label?: string } & Record<string, unknown>) {
  return (
    <MarkdownTableFullscreen {...props}>
      <tbody>
        <tr>
          <td>cell-{label}</td>
        </tr>
      </tbody>
    </MarkdownTableFullscreen>
  );
}

describe('MarkdownTableFullscreen — three-layer structure', () => {
  it('renders a non-scrolling relative/group-table outer div > always-on toolbar row > overflow-x-auto inner div', () => {
    const { container } = render(<Harness />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('relative');
    expect(outer.className).toContain('group/table');
    expect(outer.className).not.toContain('overflow-x-auto');

    const toolbar = outer.children[0] as HTMLElement;
    expect(toolbar.className).toContain('flex');
    expect(toolbar.className).toContain('justify-end');
    expect(toolbar.querySelector('button')).not.toBeNull();

    const scrollWrapper = outer.children[1] as HTMLElement;
    expect(scrollWrapper.className).toBe('overflow-x-auto');
    expect(scrollWrapper.querySelector('table')).not.toBeNull();
  });

  it('keeps the toolbar row mounted (and the trigger inside it) across open/close — only the <table> subtree moves', () => {
    const { container } = render(<Harness />);
    const outer = container.firstElementChild as HTMLElement;
    const toolbar = outer.children[0] as HTMLElement;
    const button = screen.getByRole('button', { name: expandLabel });

    fireEvent.click(button);
    expect(toolbar.contains(button)).toBe(true);
    expect(document.body.contains(button)).toBe(true); // still mounted, now inside the portal-adjacent tree

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(toolbar.contains(button)).toBe(true);
  });
});

describe('MarkdownTableFullscreen — single mount (never duplicated)', () => {
  it('mounts the table inline while closed and inside the Dialog while open, never both at once', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(document.body.querySelectorAll('table')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: expandLabel }));

    // The inline `overflow-x-auto` wrapper no longer has a table child...
    const scrollWrapper = container.querySelector('.overflow-x-auto') as HTMLElement;
    expect(scrollWrapper.querySelector('table')).toBeNull();
    // ...and there is still exactly ONE table in the whole document, now
    // inside the Radix dialog portal.
    expect(document.body.querySelectorAll('table')).toHaveLength(1);
    expect(document.body.querySelector('[role="dialog"] table')).not.toBeNull();
  });
});

describe('MarkdownTableFullscreen — trigger button', () => {
  it('has the new i18n aria-label', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: expandLabel })).toBeTruthy();
  });

  it('is an explicit type="button" (so a raw-HTML <form> wrapper cannot turn a click into a submit)', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: expandLabel }).getAttribute('type')).toBe('button');
  });

  it('meets the WCAG 2.5.8 24x24 CSS px minimum target size (h-8 w-8 = 32px)', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: expandLabel });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('w-8');
  });

  it('is a native, Tab-reachable, keyboard-activatable <button> (no tabIndex override, no keydown handler that could interfere)', () => {
    // "Tab-focusable" + "Enter/Space opens the Dialog" are both native
    // <button> browser behaviour that requires no code of ours — they hold
    // as long as (a) the element really is a <button> with no `tabindex`
    // override, and (b) nothing intercepts the keydown to stop the browser
    // translating it into a click. jsdom does not implement the UA's
    // Enter/Space-to-click activation behaviour (verified: dispatching
    // keydown/keyup on a plain jsdom <button> never fires its onClick), and
    // this repo has no `@testing-library/user-event` (the library that
    // simulates it) — so this is asserted structurally rather than by
    // firing a keyboard event and checking the Dialog opens; full keyboard
    // activation is confirmed by manual QA.
    render(<Harness />);
    const button = screen.getByRole('button', { name: expandLabel });
    expect(button.tagName).toBe('BUTTON');
    expect(button.hasAttribute('tabindex')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('opens the Dialog exactly once per click — no double-toggle from the DialogTrigger asChild composed onClick', () => {
    // Regression guard for the composeEventHandlers/defaultPrevented
    // ordering documented in markdown-table-fullscreen.tsx: if Radix's own
    // composed onClick ran too, it would toggle `open` a second time and
    // the dialog would immediately close again after a single click.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: expandLabel }));
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
});

describe('MarkdownTableFullscreen — Dialog sizing and accessible name', () => {
  it('opens a near-fullscreen DialogContent (dvh height, not vh) with a sr-only DialogTitle and no dangling aria-describedby', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: expandLabel }));

    const dialogContent = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialogContent).not.toBeNull();
    expect(dialogContent.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(dialogContent.className).toContain('sm:max-w-[calc(100vw-4rem)]');
    // Height uses dvh (dynamic viewport height), not vh — mobile address-bar
    // safe (see design notes: create-page-dialog.tsx precedent).
    expect(dialogContent.className).toContain('max-h-[calc(100dvh-4rem)]');
    expect(dialogContent.className).not.toContain('calc(100vh');
    // No DialogDescription is rendered; aria-describedby={undefined} clears
    // Radix's always-set dangling reference (mirrors live-presence-row.tsx).
    expect(dialogContent.hasAttribute('aria-describedby')).toBe(false);

    const title = screen.getByText(expandLabel);
    expect(title.className).toContain('sr-only');
    expect(dialogContent.contains(title)).toBe(true);
  });

  it('gives the Dialog scroll container min-h-0 flex-1 overflow-auto, the crowi-prose scope, and pt-10 close-button clearance', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: expandLabel }));

    const dialogContent = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const scrollContainer = dialogContent.querySelector('table')?.closest('div.crowi-prose') as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.className).toContain('min-h-0');
    expect(scrollContainer.className).toContain('flex-1');
    expect(scrollContainer.className).toContain('overflow-auto');
    // Not the inline "overflow-x-auto" wrapper's class — the Dialog
    // container allows scrolling on both axes.
    expect(scrollContainer.className).not.toContain('overflow-x-auto');
    expect(scrollContainer.className).toContain('px-4');
    expect(scrollContainer.className).toContain('pb-4');
    expect(scrollContainer.className).toContain('pt-10');
  });
});

describe('MarkdownTableFullscreen — inline wrapper height preservation (AC: minHeight)', () => {
  it('sets a measured minHeight inline style on the inner scroll wrapper while open, and clears it on close', () => {
    // jsdom's layout engine always reports 0 — mock the pre-open measurement.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 123 });

    const { container } = render(<Harness />);
    const scrollWrapper = container.querySelector('.overflow-x-auto') as HTMLElement;
    expect(scrollWrapper.style.minHeight).toBe('');

    fireEvent.click(screen.getByRole('button', { name: expandLabel }));
    expect(scrollWrapper.style.minHeight).toBe('123px');

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(scrollWrapper.style.minHeight).toBe('');
  });
});

describe('MarkdownTableFullscreen — horizontal scroll handoff (AC: scrollLeft)', () => {
  it('applies the inline scrollport scrollLeft to the Dialog scroll container exactly once on open, and later re-renders do not clobber further in-dialog scrolling', () => {
    const { container, rerender } = render(<Harness label="a" />);
    const scrollWrapper = container.querySelector('.overflow-x-auto') as HTMLElement;
    Object.defineProperty(scrollWrapper, 'scrollLeft', { configurable: true, writable: true, value: 42 });

    fireEvent.click(screen.getByRole('button', { name: expandLabel }));
    const dialogScrollContainer = document.body.querySelector('[role="dialog"] .crowi-prose') as HTMLElement;
    expect(dialogScrollContainer.scrollLeft).toBe(42);

    // Simulate the user scrolling inside the now-open dialog…
    dialogScrollContainer.scrollLeft = 999;
    // …then force another render of the (still-open) component with a new
    // `children` reference — `memo`'s shallow prop compare does NOT bail
    // out here, so the component body (and its inline dialog-container ref
    // callback, whose identity is fresh every render) runs again. The
    // consume-and-clear guard on `pendingDialogScrollLeft` must prevent
    // this later render from re-applying the stale captured value.
    rerender(<Harness label="a" />);
    expect(dialogScrollContainer.scrollLeft).toBe(999);
  });
});

describe('MarkdownTableFullscreen — own-attribute affordance suppression', () => {
  it('skips the toolbar entirely for a table with a boolean hidden prop', () => {
    const { container } = render(<Harness hidden />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('skips the toolbar entirely for a table with an own contentEditable prop', () => {
    const { container } = render(<Harness contentEditable="" />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('still renders the toolbar for an ordinary table with none of the suppression attributes', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('button')).not.toBeNull();
  });
});
