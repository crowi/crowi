import { PageGrantEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { putGrant } = vi.hoisted(() => ({ putGrant: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: { pages: { grant: { $put: putGrant } } } }));

import { type UsePageGrantControlOptions, usePageGrantControl } from '@/lib/use-page-grant-control';
import { PageGrantControl, type PageGrantControlProps } from './page-grant-control';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => cleanup());

type HarnessProps = Partial<UsePageGrantControlOptions> &
  Partial<Pick<PageGrantControlProps, 'appearance' | 'active' | 'forceClose' | 'focusFallbackRef'>> & { copies?: number };

function Harness({ appearance = 'chip', active = true, forceClose, focusFallbackRef, copies = 1, ...options }: HarnessProps) {
  const controller = usePageGrantControl({
    page: { _id: 'p1', grant: PageGrantEnum.PUBLIC, status: 'published' } as UsePageGrantControlOptions['page'],
    actorId: 'u1',
    authorityMode: 'legacy',
    enabled: true,
    isPageRefreshing: false,
    isPageError: false,
    ...options,
  });
  return (
    <>
      {Array.from({ length: copies }, (_, i) => (
        <PageGrantControl
          key={i}
          controller={controller}
          appearance={appearance}
          active={active && i === 0}
          forceClose={forceClose}
          focusFallbackRef={focusFallbackRef}
        />
      ))}
    </>
  );
}

function renderGrantControl(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  const rerenderUi = (next: ReactElement) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>);
  return { ...view, invalidateSpy, rerenderUi };
}

const ok = (grant: number) => ({ ok: true, status: 200, json: async () => ({ page: { _id: 'p1', grant, grantedUsers: [] } }) });
const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: 'raw server body' } }) });

function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}

const user = {
  click: async (el: Element) => click(el),
  keyboard: async (keys: string) => {
    const target = document.activeElement ?? document.body;
    for (const token of keys.match(/\{[^}]+\}/g) ?? []) {
      fireEvent.keyDown(target, { key: token.slice(1, -1) });
    }
  },
};

async function pick(_user: typeof user, label: string) {
  click(screen.getByRole('combobox'));
  click(await screen.findByRole('option', { name: label }));
}

describe('PageGrantControl — select and save', () => {
  it('opens on the first click, picks, and sends exactly one PUT', async () => {
    putGrant.mockResolvedValue(ok(PageGrantEnum.OWNER));
    renderGrantControl(<Harness />);

    await pick(user, m['edit.grant_owner']());

    await waitFor(() => expect(putGrant).toHaveBeenCalledTimes(1));
    expect(putGrant).toHaveBeenCalledWith({ json: { page_id: 'p1', grant: PageGrantEnum.OWNER } });
  });

  it('opens and selects from the keyboard (Enter, arrows, Enter)', async () => {
    putGrant.mockResolvedValue(ok(PageGrantEnum.RESTRICTED));
    renderGrantControl(<Harness />);

    const trigger = screen.getByRole('combobox');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByRole('listbox');
    const restricted = await screen.findByRole('option', { name: m['edit.grant_restricted']() });
    restricted.focus();
    fireEvent.keyDown(restricted, { key: 'Enter' });

    await waitFor(() => expect(putGrant).toHaveBeenCalledTimes(1));
    expect(putGrant.mock.calls[0][0].json.grant).toBe(PageGrantEnum.RESTRICTED);
  });

  it('shows the current public value as a chip with an accessible name', () => {
    renderGrantControl(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.getAttribute('aria-label')).toBe(`${m['edit.grant_label']()}: ${m['page.grant_chip_public']()}`);
  });

  it('cannot be opened when the controller is disabled', async () => {
    renderGrantControl(<Harness authorityMode="model" />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(putGrant).not.toHaveBeenCalled();
  });
});

describe('PageGrantControl — specified-users confirmation', () => {
  const specified = { _id: 'p1', grant: PageGrantEnum.SPECIFIED, status: 'published' } as UsePageGrantControlOptions['page'];

  it('asks first, sends nothing on cancel, and sends once on confirm', async () => {
    putGrant.mockResolvedValue(ok(PageGrantEnum.PUBLIC));
    renderGrantControl(<Harness page={specified} />);

    await pick(user, m['edit.grant_public']());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(m['edit.grant_specified_reset_description']());
    expect(putGrant).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: m['common.cancel']() }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(putGrant).not.toHaveBeenCalled();

    await pick(user, m['edit.grant_public']());
    await user.click(await screen.findByRole('button', { name: m['edit.grant_confirm_change']() }));
    await waitFor(() => expect(putGrant).toHaveBeenCalledTimes(1));
    expect(putGrant).toHaveBeenCalledWith({ json: { page_id: 'p1', grant: PageGrantEnum.PUBLIC } });
  });

  it('Esc discards the candidate with no request, and Cancel holds the initial focus', async () => {
    renderGrantControl(<Harness page={specified} />);

    await pick(user, m['edit.grant_owner']());
    const cancel = await screen.findByRole('button', { name: m['common.cancel']() });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(putGrant).not.toHaveBeenCalled();
  });

  it('renders the dialog outside the control and only from the active copy', async () => {
    const { container } = renderGrantControl(<Harness page={specified} copies={2} />);
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: m['edit.grant_public']() }));
    const dialog = await screen.findByRole('alertdialog');
    expect(container.contains(dialog)).toBe(false);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('discards the candidate when the page changes before it is confirmed', async () => {
    const { rerenderUi } = renderGrantControl(<Harness page={specified} />);
    await pick(user, m['edit.grant_public']());
    await screen.findByRole('alertdialog');

    rerenderUi(<Harness page={{ ...specified!, _id: 'p2' }} />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(putGrant).not.toHaveBeenCalled();
  });
});

describe('PageGrantControl — failures', () => {
  it.each([400, 401, 403, 404, 500])('%i shows a safe inline alert, keeps the current value, and can be retried without any other request', async (status) => {
    putGrant.mockResolvedValueOnce(fail(status));
    putGrant.mockResolvedValueOnce(ok(PageGrantEnum.OWNER));
    const { invalidateSpy } = renderGrantControl(<Harness />);

    await pick(user, m['edit.grant_owner']());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(status === 404 ? m['errors.page_not_found']() : m['edit.grant_update_failed']());
    expect(alert.textContent).not.toContain('raw server body');
    expect(screen.getByRole('combobox').querySelector('[data-page-grant="1"]')).not.toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();

    await pick(user, m['edit.grant_owner']());
    await waitFor(() => expect(putGrant).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('turns a network exception into the fixed message without leaking its text', async () => {
    putGrant.mockRejectedValueOnce(new TypeError('socket hang up 10.0.0.5'));
    renderGrantControl(<Harness />);
    await pick(user, m['edit.grant_owner']());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(m['edit.grant_update_failed']());
  });

  it('is disabled while the displayed query is fetching or in error', async () => {
    for (const flags of [{ isPageRefreshing: true }, { isPageError: true }]) {
      const { unmount } = renderGrantControl(<Harness {...flags} />);
      await user.click(screen.getByRole('combobox'));
      expect(screen.queryByRole('listbox')).toBeNull();
      unmount();
    }
  });

  it('does not render the inline error from an inactive copy', async () => {
    putGrant.mockResolvedValueOnce(fail(500));
    renderGrantControl(<Harness copies={2} />);
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: m['edit.grant_owner']() }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
  });
});

describe('PageGrantControl — forced close', () => {
  it('closes an open menu on forceClose and hands focus to the fallback instead of the hidden trigger', async () => {
    const fallback = createRef<HTMLButtonElement>();
    const { rerenderUi } = renderGrantControl(
      <>
        <button ref={fallback} type="button">
          fallback
        </button>
        <Harness focusFallbackRef={fallback} />
      </>,
    );
    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');

    rerenderUi(
      <>
        <button ref={fallback} type="button">
          fallback
        </button>
        <Harness focusFallbackRef={fallback} forceClose />
      </>,
    );
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(fallback.current));
  });

  it('returns focus to the trigger after a normal Esc close', async () => {
    renderGrantControl(<Harness />);
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('completes a save that finishes after the menu was force-closed', async () => {
    let finish: () => void = () => {};
    putGrant.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok(PageGrantEnum.OWNER));
        }),
    );
    const { rerenderUi } = renderGrantControl(<Harness />);
    await pick(user, m['edit.grant_owner']());
    rerenderUi(<Harness forceClose />);
    await act(async () => finish());
    expect(putGrant).toHaveBeenCalledTimes(1);
  });
});
