'use client';

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

/**
 * feature-mobile-presence-card — controlled `open` state for a
 * Portal-rendered overlay (Radix `DropdownMenu` / `Popover` / `Sheet`)
 * that must force-close when an ancestor stops being interactive.
 *
 * `PageHeader` keeps its expanded subtree mounted and marks it
 * `inert` + `invisible` on `expanded -> compact`, but every overlay
 * above renders its content into a body-level Portal — outside that
 * subtree — so an already-open overlay would stay visible and
 * interactive after its trigger is gone. Each owner therefore takes a
 * `forceClose` prop and routes its `open` state through this hook:
 * while `forceClose` is `true` the overlay is closed (and re-opening is
 * pointless since the trigger is unreachable); flipping back to `false`
 * simply restores normal user-driven open/close.
 *
 * Extracted because the exact same three lines (state + close-on-edge
 * effect, including the `set-state-in-effect` suppression this pattern
 * inherently needs) were repeated in every overlay owner.
 */
export function useForceCloseable(forceClose: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (forceClose) setOpen(false);
  }, [forceClose]);

  return [open, setOpen];
}
