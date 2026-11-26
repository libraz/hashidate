import { describe, expect, it } from 'vitest';
import { wrapYaw } from '@/engine/types';

describe('wrapYaw', () => {
  it('lands in (-180, 180]', () => {
    expect(wrapYaw(180)).toBe(180);
    expect(wrapYaw(-180)).toBe(180);
    expect(wrapYaw(190)).toBe(-170);
    expect(wrapYaw(-190)).toBe(170);
    expect(wrapYaw(720)).toBe(0);
  });

  it('turns negative zero into zero', () => {
    expect(wrapYaw(-0)).toBe(0);
  });
});
