import type http from 'node:http';
import type { AttachedNotifications } from 'src/notifications/attach';

/**
 * Shared teardown for an http server carrying `attachNotificationsServer`
 * — extracted so `notifications/attach.test.ts` (fake redis) and
 * `notifications/attach.smoke.test.ts` (real Redis 8) stop drifting on the
 * subtle choreography: guarded `shutdown()` → drop half-closed peers
 * (`closeAllConnections`, Node 18.2+) → `close()` with a 1s timeout +
 * double-resolve guard so a stuck peer can't hang the suite. (The startup
 * half stays per-file — the two files build different crowi stubs.)
 */
export async function stopNotificationsHttpServer(server: http.Server, attachment: AttachedNotifications): Promise<void> {
  try {
    await attachment.shutdown();
  } catch {
    // best-effort
  }
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}
