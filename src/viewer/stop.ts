import type { Session } from '@/engine/session';
import type { Command } from '@/protocol';
import type { ControlStatus } from './control-client';

/** POST one command to the control server; answers whether it was accepted. */
export async function postCommand(command: Command, base = '/api'): Promise<boolean> {
  try {
    const response = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    return response.ok;
  } catch {
    return false;
  }
}

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
  if (control === 'online' && (await postCommand({ cmd: 'interrupt' }, base))) return;
  session.interrupt();
}

/**
 * Switch the idle autopilot from this page's own controls.
 *
 * The autopilot runs on the control server, which sends every renderer the
 * same choices, so with a server the switch goes there as the panel's does.
 * Without one the local session is switched, and stands idle without picks.
 */
export async function switchIdle(
  session: Session,
  control: ControlStatus,
  on: boolean,
  base = '/api',
): Promise<void> {
  if (control === 'online' && (await postCommand({ cmd: 'idle', on }, base))) return;
  session.setIdle(on);
}
