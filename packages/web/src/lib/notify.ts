/**
 * Shared transient-notification utility: a thin wrapper over `sonner`'s
 * `toast` API with RFC-0004-pinned per-level colour + duration defaults,
 * so features don't reach for `sonner` directly with ad-hoc options.
 *
 * The backend is injectable ({@link setNotifyBackend}) only so unit tests
 * can assert behaviour without mounting a React tree.
 */
import { toast } from 'sonner';

/**
 * Cap on simultaneously visible toasts. Exported so the `(auth)` layout's
 * `<Toaster visibleToasts={...} />` and this module cannot drift apart.
 */
export const MAX_VISIBLE_TOASTS = 5;

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface NotifyOptions {
  /** Auto-dismiss delay. Defaults: info 4000 / warn 6000 / error 8000 ms. */
  durationMs?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Whether the toast shows a close affordance. Defaults to `true`. */
  dismissible?: boolean;
}

export interface NotifyHandle {
  dismiss(): void;
  /** Replaces the toast's message (and optionally its options) in place. */
  update(message: string, options?: NotifyOptions): void;
}

const DEFAULT_DURATION_MS: Record<NotifyLevel, number> = {
  info: 4000,
  warn: 6000,
  error: 8000,
};

/** Backend-agnostic description of a single toast. */
export interface NotifyPayload {
  id: string | number;
  level: NotifyLevel;
  message: string;
  durationMs: number;
  dismissible: boolean;
  action?: NotifyOptions['action'];
}

/** Toast backend contract: production delegates to `sonner`, tests inject a fake. */
export interface NotifyBackend {
  /** Shows (or, when `id` is reused, replaces) a toast. */
  show(payload: NotifyPayload): void;
  dismiss(id: string | number): void;
}

function resolvePayload(id: string | number, level: NotifyLevel, message: string, options?: NotifyOptions): NotifyPayload {
  return {
    id,
    level,
    message,
    durationMs: options?.durationMs ?? DEFAULT_DURATION_MS[level],
    dismissible: options?.dismissible ?? true,
    action: options?.action,
  };
}

let backend: NotifyBackend | null = null;
let nextId = 0;

/**
 * Resolves the sonner backend lazily so importing this module never
 * eagerly pulls `sonner` into a non-browser bundle (Server Component,
 * unit test with an injected fake).
 */
function getBackend(): NotifyBackend {
  if (backend === null) {
    backend = createSonnerBackend();
  }
  return backend;
}

/** Overrides the toast backend (tests). Pass `null` to restore the default. */
export function setNotifyBackend(next: NotifyBackend | null): void {
  backend = next;
}

function emit(level: NotifyLevel, message: string, options?: NotifyOptions): NotifyHandle {
  const id = `notify-${nextId++}`;
  getBackend().show(resolvePayload(id, level, message, options));

  return {
    dismiss() {
      getBackend().dismiss(id);
    },
    update(nextMessage: string, nextOptions?: NotifyOptions) {
      // Reusing the same id makes the backend replace the toast in
      // place rather than stacking a second one.
      getBackend().show(resolvePayload(id, level, nextMessage, nextOptions));
    },
  };
}

export const notify = {
  info(message: string, options?: NotifyOptions): NotifyHandle {
    return emit('info', message, options);
  },
  warn(message: string, options?: NotifyOptions): NotifyHandle {
    return emit('warn', message, options);
  },
  error(message: string, options?: NotifyOptions): NotifyHandle {
    return emit('error', message, options);
  },
};

/**
 * Production backend. Level → colour relies on `<Toaster richColors />`:
 * `info` → `toast.message` (neutral), `warn` → `toast.warning` (yellow),
 * `error` → `toast.error` (red).
 */
function createSonnerBackend(): NotifyBackend {
  return {
    show(payload: NotifyPayload): void {
      const options = {
        id: payload.id,
        duration: payload.durationMs,
        dismissible: payload.dismissible,
        action: payload.action ? { label: payload.action.label, onClick: payload.action.onClick } : undefined,
      };
      switch (payload.level) {
        case 'info':
          toast.message(payload.message, options);
          return;
        case 'warn':
          toast.warning(payload.message, options);
          return;
        case 'error':
          toast.error(payload.message, options);
          return;
      }
    },
    dismiss(id: string | number): void {
      toast.dismiss(id);
    },
  };
}
