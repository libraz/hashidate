import { describe, expect, it } from 'vitest';
import { queueEntrySchema, queueUpdateSchema, turnSchema } from '@/protocol';

describe('queueUpdateSchema', () => {
  it('accepts a non-empty reading, an explicit clear, or an omitted reading', () => {
    expect(queueUpdateSchema.safeParse({ id: 'q1', reading: 'よみ' }).success).toBe(true);
    expect(queueUpdateSchema.safeParse({ id: 'q1', reading: null }).success).toBe(true);
    expect(queueUpdateSchema.safeParse({ id: 'q1' }).success).toBe(true);
    expect(queueUpdateSchema.safeParse({ id: 'q1', reading: '' }).success).toBe(false);
  });

  it('does not widen TurnRequest or QueueEntry reading values', () => {
    expect(turnSchema.safeParse({ reading: null }).success).toBe(false);
    expect(queueEntrySchema.safeParse({ id: 'q1', at: 0, reading: null }).success).toBe(false);
  });
});
