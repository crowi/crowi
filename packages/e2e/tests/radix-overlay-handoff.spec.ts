import { e2eUsers } from '../src/config';
import { expect, test } from '../src/fixtures';

/**
 * feature-radix-upgrade-and-single-source — regression coverage for the
 * `document.body.style.pointerEvents` overlay lock across an admin row
 * action `DropdownMenu` -> `ConfirmActionDialog` (`AlertDialog`) handoff.
 *
 * Both overlays are modal Radix `DismissableLayer`s
 * (`disableOutsidePointerEvents`) that share ONE module-local body-lock
 * registry (`originalBodyPointerEvents` + a `Set` of layers, tracked inside
 * `@radix-ui/react-dismissable-layer`) as long as they both resolve that
 * package to the SAME installed copy. `dda4ba72` moved `Dialog` / `Select`
 * (and this feature moves the remaining `Avatar` / `Label` / `Slot` /
 * `Tabs` wrappers) onto the `radix-ui` meta package specifically to
 * guarantee that: before the fix, a leftover direct `@radix-ui/react-*`
 * dependency could pull in a second, differently-versioned copy of
 * `@radix-ui/react-dismissable-layer`, splitting the registry so the last
 * overlay to close didn't know to restore `pointerEvents` — leaving the
 * WHOLE page permanently unclickable behind an invisible
 * `pointer-events: none` on `<body>`.
 *
 * This spec drives that exact row-menu -> confirm-dialog handoff as the
 * installer admin against `e2e-user-a` (an accepted, non-self, non-admin
 * user — `Suspend` is destructive and available), Cancels, and asserts:
 *  - the body lock is held continuously. A `MutationObserver` observes
 *    `body[style]` with `attributeOldValue: true` and replays every
 *    record's `oldValue`, not just the live value read inside the
 *    callback — the menu's layer unmount (which restores the original
 *    `pointerEvents`) and the dialog's layer mount (which re-locks it) can
 *    both happen synchronously inside the same React commit, so a lock
 *    that is transiently dropped and re-acquired *during* the handoff can
 *    already be over before the (necessarily async, microtask) callback
 *    ever runs — only `oldValue` on each individual record can still
 *    reveal it, a live read at callback time cannot;
 *  - the lock is fully released after Cancel, and the same menu trigger is
 *    reusable (a stuck lock would hang this click);
 *  - Cancel never sends the suspend mutation request, so `e2e-user-a` is
 *    left untouched (AC-4 requires no user mutation for this flow).
 */

const MENU_OPEN_LABEL = /^(Open menu|メニューを開く)$/;
const SUSPEND_ITEM_LABEL = /^(Suspend|停止)$/;
const SUSPEND_TITLE = /^(Suspend user\?|ユーザーを停止しますか\?)$/;
const CANCEL_LABEL = /^(Cancel|キャンセル)$/;

test('admin users row menu -> confirm dialog: body pointer-events lock survives the handoff and releases cleanly on Cancel', async ({ adminPage }) => {
  // No status-mutation request may ever reach the API during this Cancel
  // flow — a regression that fires the suspend PUT on menu *selection*
  // (before the user confirms) would otherwise satisfy every UI-only
  // assertion below.
  const statusMutationRequests: string[] = [];
  adminPage.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/admin\/users\/[^/]+\/status\//.test(req.url())) {
      statusMutationRequests.push(`${req.method()} ${req.url()}`);
    }
  });

  await adminPage.goto(`/admin/users?q=${encodeURIComponent(e2eUsers.userA.username)}`);

  const row = adminPage.locator('tr', { hasText: `@${e2eUsers.userA.username}` });
  await expect(row).toBeVisible();

  const bodyPointerEvents = () => adminPage.locator('body').evaluate((el) => el.style.pointerEvents);
  const menuTrigger = row.getByRole('button', { name: MENU_OPEN_LABEL });

  // Start recording every `body[style]` mutation BEFORE opening the menu, so
  // the whole open -> handoff -> dialog-visible sequence is captured, not
  // just the endpoints.
  await adminPage.evaluate(() => {
    const w = window as typeof window & { __pointerEventsLog?: string[]; __pointerEventsObserver?: MutationObserver };
    w.__pointerEventsObserver?.disconnect();

    const extractPointerEvents = (styleAttrValue: string | null): string => {
      if (!styleAttrValue) return '';
      const match = /pointer-events:\s*([^;]+)/.exec(styleAttrValue);
      return match ? match[1].trim() : '';
    };

    w.__pointerEventsLog = [document.body.style.pointerEvents];
    const observer = new MutationObserver((records) => {
      // `attributeOldValue: true` is what makes each synchronous
      // `body.style.pointerEvents = ...` write produce its OWN
      // MutationRecord with an accurate `oldValue` -- without it, a browser
      // may coalesce several same-attribute writes that land inside a
      // single React commit (eg. the menu layer's cleanup restoring the
      // original value immediately followed, in the same synchronous
      // flush, by the dialog layer's effect re-locking to `'none'`) into
      // fewer records, and reading the LIVE `document.body.style.
      // pointerEvents` from inside the callback (necessarily a microtask,
      // so it only runs AFTER every synchronous mutation in that flush
      // already happened) can never see the transient state at all.
      // Replaying each record's `oldValue` (the value immediately BEFORE
      // that one mutation) reconstructs the full transition sequence even
      // though it happened synchronously and off-screen.
      for (const record of records) {
        w.__pointerEventsLog?.push(extractPointerEvents(record.oldValue));
      }
      w.__pointerEventsLog?.push(document.body.style.pointerEvents);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    w.__pointerEventsObserver = observer;
  });
  const readPointerEventsLog = () => adminPage.evaluate(() => (window as typeof window & { __pointerEventsLog?: string[] }).__pointerEventsLog ?? []);

  // 1. Open the row action menu — a modal DismissableLayer locks the body.
  await menuTrigger.click();
  const menu = adminPage.getByRole('menu');
  await expect(menu).toBeVisible();
  expect(await bodyPointerEvents()).toBe('none');

  // 2. Select a destructive, non-self action (Suspend) — the menu's layer
  // unmounts and the AlertDialog's layer mounts in the same handoff.
  await menu.getByRole('menuitem', { name: SUSPEND_ITEM_LABEL }).click();
  const dialog = adminPage.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="alert-dialog-title"]')).toHaveText(SUSPEND_TITLE);
  // Let any deferred cleanup/registration effect settle before reading the
  // recorded log back.
  await adminPage.waitForTimeout(150);

  // Every mutation recorded from the FIRST lock (menu opening) through the
  // dialog becoming visible must stay 'none' — an intermediate '' between
  // the menu's layer unregistering and the dialog's layer registering (the
  // exact handoff this feature protects) is captured here even though it
  // would be invisible to a single before/after sample.
  const handoffLog = await readPointerEventsLog();
  const firstLockIndex = handoffLog.indexOf('none');
  expect(firstLockIndex).toBeGreaterThanOrEqual(0);
  expect(handoffLog.slice(firstLockIndex)).not.toContain('');

  // 3. Cancel — no mutation is sent, so e2e-user-a's status never changes.
  await dialog.getByRole('button', { name: CANCEL_LABEL }).click();
  await expect(dialog).not.toBeVisible();

  // 4. The lock must be released, not stuck — this is the historical bug.
  await expect.poll(bodyPointerEvents).toBe('');

  // 5. And the SAME trigger must be reusable — a stuck lock would make the
  // whole page (including this button) unclickable, hanging this click.
  await menuTrigger.click();
  await expect(menu).toBeVisible();
  await adminPage.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();

  // 6. Cancel must never have triggered the suspend mutation.
  expect(statusMutationRequests).toEqual([]);
});
