import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE_TOASTS, type NotifyBackend, type NotifyPayload, notify, setNotifyBackend } from './notify';

/**
 * In-memory fake backend. `notify.ts` keys updates by reusing the same
 * toast id, so this fake stores the *latest* payload per id (matching
 * sonner's in-place replacement) plus an append-only emit log to assert
 * call ordering / stacking.
 */
function createFakeBackend() {
  const live = new Map<string | number, NotifyPayload>();
  const emitted: NotifyPayload[] = [];
  const dismissed: (string | number)[] = [];

  const backend: NotifyBackend = {
    show(payload) {
      live.set(payload.id, payload);
      emitted.push(payload);
    },
    dismiss(id) {
      live.delete(id);
      dismissed.push(id);
    },
  };

  return { backend, live, emitted, dismissed };
}

describe('notify', () => {
  let fake: ReturnType<typeof createFakeBackend>;

  beforeEach(() => {
    fake = createFakeBackend();
    setNotifyBackend(fake.backend);
  });

  afterEach(() => {
    setNotifyBackend(null);
  });

  describe('levels and defaults', () => {
    it('emits info with neutral level and 4000ms default duration', () => {
      notify.info('hello');
      expect(fake.emitted).toHaveLength(1);
      expect(fake.emitted[0]).toMatchObject({ level: 'info', message: 'hello', durationMs: 4000, dismissible: true });
    });

    it('emits warn with 6000ms default duration', () => {
      notify.warn('careful');
      expect(fake.emitted[0]).toMatchObject({ level: 'warn', durationMs: 6000 });
    });

    it('emits error with 8000ms default duration', () => {
      notify.error('boom');
      expect(fake.emitted[0]).toMatchObject({ level: 'error', durationMs: 8000 });
    });

    it('honours an explicit durationMs override', () => {
      notify.info('pinned', { durationMs: 1234 });
      expect(fake.emitted[0].durationMs).toBe(1234);
    });

    it('honours dismissible: false', () => {
      notify.error('sticky', { dismissible: false });
      expect(fake.emitted[0].dismissible).toBe(false);
    });
  });

  describe('action button', () => {
    it('forwards the action label and onClick callback', () => {
      const onClick = vi.fn();
      notify.warn('with action', { action: { label: 'Undo', onClick } });

      const action = fake.emitted[0].action;
      expect(action?.label).toBe('Undo');
      action?.onClick();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('omits action when none is supplied', () => {
      notify.info('plain');
      expect(fake.emitted[0].action).toBeUndefined();
    });
  });

  describe('stacking', () => {
    it('caps the visible stack at 5 (MAX_VISIBLE_TOASTS)', () => {
      // The cap itself is enforced by sonner's <Toaster visibleToasts/>;
      // pin the shared constant so the layout and notify cannot drift.
      expect(MAX_VISIBLE_TOASTS).toBe(5);
    });

    it('assigns a distinct id to every emitted toast so they stack', () => {
      notify.info('a');
      notify.info('b');
      notify.warn('c');
      const ids = fake.emitted.map((p) => p.id);
      expect(new Set(ids).size).toBe(3);
      expect(fake.live.size).toBe(3);
    });
  });

  describe('dismiss', () => {
    it('dismisses the toast via the returned handle', () => {
      const handle = notify.info('to be dismissed');
      const id = fake.emitted[0].id;
      handle.dismiss();
      expect(fake.dismissed).toEqual([id]);
      expect(fake.live.has(id)).toBe(false);
    });
  });

  describe('update', () => {
    it('replaces the message in place reusing the same toast id', () => {
      const handle = notify.info('uploading 0%');
      const id = fake.emitted[0].id;

      handle.update('uploading 50%');

      expect(fake.emitted).toHaveLength(2);
      expect(fake.emitted[1].id).toBe(id);
      expect(fake.emitted[1].message).toBe('uploading 50%');
      // Same id => still a single live toast, not a second stacked one.
      expect(fake.live.size).toBe(1);
      expect(fake.live.get(id)?.message).toBe('uploading 50%');
    });

    it('keeps the original level and re-applies its default duration on update', () => {
      const handle = notify.error('failing', { durationMs: 9999 });
      handle.update('still failing');
      expect(fake.emitted[1]).toMatchObject({ level: 'error', durationMs: 8000 });
    });

    it('applies new options passed to update', () => {
      const handle = notify.warn('first');
      const onClick = vi.fn();
      handle.update('second', { durationMs: 2000, action: { label: 'Retry', onClick } });
      expect(fake.emitted[1]).toMatchObject({ message: 'second', durationMs: 2000 });
      expect(fake.emitted[1].action?.label).toBe('Retry');
    });
  });
});
