import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pager } from './pager';

afterEach(() => {
  cleanup();
});

describe('Pager (mode="numbered")', () => {
  it('renders nothing when there is only one page', () => {
    const { container } = render(<Pager mode="numbered" page={1} totalPages={1} onPageChange={vi.fn()} ariaLabel="Pagination" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a number button per page and marks the current one aria-current', () => {
    render(<Pager mode="numbered" page={2} totalPages={3} onPageChange={vi.fn()} ariaLabel="Pagination" />);
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(nav).toBeTruthy();

    const current = screen.getByRole('button', { name: '2' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '1' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: '3' }).getAttribute('aria-current')).toBeNull();
  });

  it('invokes onPageChange with the clicked page number', () => {
    const onPageChange = vi.fn();
    render(<Pager mode="numbered" page={2} totalPages={3} onPageChange={onPageChange} ariaLabel="Pagination" />);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('disables Previous on the first page and Next on the last page', () => {
    const onPageChange = vi.fn();
    render(<Pager mode="numbered" page={1} totalPages={3} onPageChange={onPageChange} ariaLabel="Pagination" />);
    const previous = screen.getByRole('button', { name: m['common.pager.previous']() });
    const next = screen.getByRole('button', { name: m['common.pager.next']() });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(previous);
    expect(onPageChange).not.toHaveBeenCalled();

    fireEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows windowed dots with a Paraglide aria-label on the edge page buttons', () => {
    render(<Pager mode="numbered" page={10} totalPages={20} onPageChange={vi.fn()} ariaLabel="Pagination" />);
    const firstPageButton = screen.getByRole('button', { name: m['common.pager.page_aria']({ page: 1 }) });
    expect(firstPageButton.textContent).toBe('1');
    // page 10 of 20 with the default span=2 windows [8..12], which reaches
    // neither boundary, so both the left "1 ..." and right "... 20"
    // affordances render.
    const lastPageButton = screen.getByRole('button', { name: m['common.pager.page_aria']({ page: 20 }) });
    expect(lastPageButton.textContent).toBe('20');
  });
});

describe('Pager (mode="prev-next")', () => {
  it('renders the current page label using common.pager.page_label', () => {
    render(<Pager mode="prev-next" page={3} hasPrev hasNext onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByText(m['common.pager.page_label']({ page: 3 }))).toBeTruthy();
  });

  it('disables Previous/Next based on hasPrev/hasNext and invokes the right callback', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<Pager mode="prev-next" page={1} hasPrev={false} hasNext onPrev={onPrev} onNext={onNext} />);

    const previous = screen.getByRole('button', { name: new RegExp(m['common.pager.previous']()) });
    const next = screen.getByRole('button', { name: new RegExp(m['common.pager.next']()) });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });
});
