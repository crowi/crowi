import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThumbsUp } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MetaChip } from './meta-chip';

afterEach(() => {
  cleanup();
});

function renderChip(props: Partial<React.ComponentProps<typeof MetaChip>> = {}) {
  const onClick = vi.fn();
  render(
    <TooltipProvider>
      <MetaChip icon={ThumbsUp} count={3} label="いいね" emptyTooltip="まだいいねがありません" ariaLabel="3 likes" onClick={onClick} {...props} />
    </TooltipProvider>,
  );
  return { onClick };
}

describe('MetaChip', () => {
  it('renders a clickable button with icon, count and label when count > 0', () => {
    renderChip({ count: 5, label: 'いいね' });
    const button = screen.getByRole('button', { name: '3 likes' });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('5');
    expect(button.textContent).toContain('いいね');
  });

  it('invokes onClick when the active chip is pressed', () => {
    const { onClick } = renderChip({ count: 2 });
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a non-interactive greyed element (no button) when count === 0', () => {
    const { onClick } = renderChip({ count: 0 });
    // Zero-count chip is not a button — it cannot be clicked.
    expect(screen.queryByRole('button')).toBeNull();
    const chip = screen.getByText('0');
    expect(chip.closest('[aria-disabled="true"]')).not.toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });
});
