import { describe, expect, it } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { same } from '@/i18n/locale';
import { chooseAvatar } from '@/viewer/avatar-selection';

/** Array order is deliberately not id order: the server's order is the default. */
const roster = ['m', 'c', 'x', 'a'].map((id) => ({
  id,
  label: same(id),
  url: `/models/${id}.glb`,
})) as unknown as AvatarDescriptor[];

const none = { pending: null, pinned: null, remembered: null };

describe('chooseAvatar', () => {
  it('answers null for an empty roster whatever was asked for', () => {
    expect(chooseAvatar([], none)).toBeNull();
    expect(chooseAvatar([], { pending: 'a', pinned: 'c', remembered: 'm' })).toBeNull();
  });

  it('falls back to the first entry in server order', () => {
    expect(chooseAvatar(roster, none)?.id).toBe('m');
  });

  it('prefers pending, then pinned, then remembered', () => {
    expect(chooseAvatar(roster, { pending: 'x', pinned: 'c', remembered: 'a' })?.id).toBe('x');
    expect(chooseAvatar(roster, { pending: null, pinned: 'c', remembered: 'a' })?.id).toBe('c');
    expect(chooseAvatar(roster, { ...none, remembered: 'a' })?.id).toBe('a');
  });

  it('lets an id the roster lacks fall through to the next preference', () => {
    expect(chooseAvatar(roster, { pending: 'gone', pinned: 'c', remembered: 'a' })?.id).toBe('c');
    expect(chooseAvatar(roster, { pending: 'gone', pinned: 'gone', remembered: 'a' })?.id).toBe(
      'a',
    );
    expect(chooseAvatar(roster, { pending: 'gone', pinned: 'gone', remembered: 'gone' })?.id).toBe(
      'm',
    );
  });
});
