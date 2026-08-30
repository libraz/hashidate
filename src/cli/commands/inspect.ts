import type { Vocabulary } from '../../protocol';
import type { Handler } from '../args';
import { localized, show } from '../output';

/** Matches the server's own long-poll default, so `watch` never idles out. */
const WATCH_WAIT_SECONDS = 30;

/**
 * Reading rather than sending: what the avatar can be asked for, what it is
 * doing, and what has happened.
 */

export const vocab: Handler = async (client) => {
  const vocabulary = await client.vocabulary();
  if (Object.keys(vocabulary).length === 0) {
    console.log('no vocabulary (no viewer connected)');
    return;
  }
  // First, because the rest of the listing is this avatar's vocabulary and
  // means nothing without knowing which one is loaded.
  console.log(
    `avatar: ${vocabulary.avatar?.label ? localized(vocabulary.avatar.label) : '?'} (${vocabulary.avatar?.id ?? '?'})`,
  );
  // Performances first: a caller reading this to decide what to send should see
  // the composed vocabulary before the parts it is composed from. What each one
  // is made of is printed alongside, so the listing also answers "and what does
  // that do" without a second round trip.
  const performances: Vocabulary['performances'] = vocabulary.performances ?? [];
  console.log(`performances (${performances.length})`);
  for (const item of performances) {
    const parts = [item.gesture, item.hop].filter(Boolean).join(' + ') || 'expression only';
    const held = item.sustain ? ' *' : '';
    console.log(
      `  ${item.id.padEnd(16)} ${localized(item.label).padEnd(12)} [${item.group}] ${parts}${held}`,
    );
  }
  for (const key of ['emotions', 'expressions', 'overlays', 'gestures'] as const) {
    const items = vocabulary[key] ?? [];
    console.log(`${key} (${items.length})`);
    for (const item of items) {
      const extra = 'group' in item ? `  [${item.group}]` : '';
      console.log(`  ${item.id.padEnd(16)} ${localized(item.label)}${extra}`);
    }
  }
  const hops: Vocabulary['hops'] = vocabulary.hops ?? [];
  console.log(`hops: ${hops.map((h) => `${h.id} (${localized(h.label)})`).join(', ')}`);
  const cameras: Vocabulary['cameras'] = vocabulary.cameras ?? [];
  console.log(`cameras: ${cameras.join(', ')}`);
  const rooms: Vocabulary['rooms'] = vocabulary.rooms ?? [];
  console.log(
    `rooms: ${rooms.length === 0 ? '(no audio)' : rooms.map((r) => `${r.id} (${localized(r.label)})`).join(', ')}`,
  );
  const wardrobe: Vocabulary['wardrobe'] = vocabulary.wardrobe ?? {};
  for (const [slot, entry] of Object.entries(wardrobe)) {
    console.log(
      `wear ${slot.padEnd(8)} ${localized(entry.label)}: ${entry.items.map((i) => i.id).join(', ')}`,
    );
  }
};

export const state: Handler = async (client) => {
  const snapshot = await client.state();
  if (!snapshot.connected) console.log('no viewer connected');
  show(snapshot.state);
};

/** Follow the event log. Useful to see how turns actually sequence. */
export const watch: Handler = async (client) => {
  let since = (await client.state()).seq;
  console.log(`following from seq=${since} (Ctrl-C to stop)`);
  for (;;) {
    const response = await client.events(since, WATCH_WAIT_SECONDS);
    since = response.seq;
    for (const event of response.events) {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event)) {
        if (key !== 'seq' && key !== 'at' && key !== 'type') extra[key] = value;
      }
      const seq = String(event.seq ?? 0).padStart(5);
      console.log(`${seq}  ${event.type.padEnd(18)} ${JSON.stringify(extra)}`);
    }
  }
};
