import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { PageGrantEnum } from '@crowi/api-contract';
import { GrantSelect } from './grant-select';

// jsdom does not implement these layout APIs that Radix Select calls
// when its listbox opens. Stub them so the open-state assertions run.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('GrantSelect', () => {
  it('renders the current grant value on the trigger', () => {
    render(<GrantSelect value={PageGrantEnum.PUBLIC} onChange={vi.fn()} />);
    // The Radix trigger is a combobox; its accessible content reflects
    // the selected item's label. We assert it is non-empty rather than
    // locking in the locale-resolved wording.
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('disables the trigger when disabled is true', () => {
    render(<GrantSelect value={PageGrantEnum.OWNER} onChange={vi.fn()} disabled />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveProperty('disabled', true);
  });

  it('opens the listbox and offers the three sub-picker-free grants', () => {
    render(<GrantSelect value={PageGrantEnum.PUBLIC} onChange={vi.fn()} />);
    act(() => {
      screen.getByRole('combobox').click();
    });
    // public / restricted / owner — specified is intentionally absent
    // when the page is not already GRANT_SPECIFIED.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
  });

  it('surfaces the current GRANT_SPECIFIED value as an extra disabled option', () => {
    render(<GrantSelect value={PageGrantEnum.SPECIFIED} onChange={vi.fn()} />);
    act(() => {
      screen.getByRole('combobox').click();
    });
    // 3 selectable + 1 read-only specified entry so the trigger is not blank.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
  });

  it('calls onChange with the chosen grant value', () => {
    const onChange = vi.fn();
    render(<GrantSelect value={PageGrantEnum.PUBLIC} onChange={onChange} />);
    act(() => {
      screen.getByRole('combobox').click();
    });
    const options = screen.getAllByRole('option');
    // The OWNER option is the last selectable one.
    const ownerOption = options.find((o) => o.getAttribute('data-disabled') === null && o !== options[0]);
    act(() => {
      (ownerOption ?? options[options.length - 1]).click();
    });
    expect(onChange).toHaveBeenCalled();
    expect(typeof onChange.mock.calls[0][0]).toBe('number');
  });
});
