import type { Session } from '@/engine/session';
import type { ControlStatus } from './control-client';

/**
 * Cut the line on air from this page's own controls.
 *
 * With a control server the queue lives there, so the stop goes through the
 * same `interrupt` command the panel and CLI send: the server empties its list
 * and every renderer cuts together. Interrupting only this session would leave
 * the server's queue intact to be played again. Without a server, or if it
 * cannot be reached, the local session is the only authority there is.
 */
export async function stopSpeech(
  session: Session,
  control: ControlStatus,
  base = '/api',
): Promise<void> {
  if (control === 'online') {
    try {
      const response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'interrupt' }),
      });
      if (response.ok) return;
    } catch {
      // Fall through to the local cut.
    }
  }
  session.interrupt();
}
