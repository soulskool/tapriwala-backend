import { COUNTER_KEYS, KOT_SEQUENCE_START, type CounterKey } from '../config/constants.js';
import { env } from '../config/env.js';
import { Counter } from '../models/Counter.js';
import { dayKey } from '../utils/helpers.js';

/**
 * Sequence numbers that humans read out loud (KOT 1051, session #37).
 *
 * These come from an atomic `$inc` rather than `count() + 1`: two waiters
 * placing orders in the same second must not both be handed KOT 1051.
 */
async function nextSeq(key: CounterKey, scope = 'global', startAt = 0): Promise<number> {
  const counter = await Counter.findOneAndUpdate(
    { key, scope },
    { $inc: { seq: 1 }, $setOnInsert: { key, scope } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  const seq = counter?.seq ?? 1;
  return startAt > 0 ? startAt + seq : seq;
}

/**
 * Session numbers reset at midnight by default (SESSION_NUMBER_RESET=daily), so
 * staff say "session 12" and mean today's twelfth, not the four-thousandth.
 */
export function nextSessionNumber(): Promise<number> {
  const scope = env.sessionNumberReset === 'daily' ? dayKey() : 'global';
  return nextSeq(COUNTER_KEYS.SESSION_NUMBER, scope);
}

/** KOT ids run forever and start above 1000 so they never look like a table number. */
export async function nextKotId(): Promise<string> {
  const seq = await nextSeq(COUNTER_KEYS.KOT_ID, 'global', KOT_SEQUENCE_START);
  return String(seq);
}

/** Bill numbers run forever — they are a financial sequence, never reset. */
export function nextBillNumber(): Promise<number> {
  return nextSeq(COUNTER_KEYS.BILL_NUMBER, 'global');
}

export default { nextSessionNumber, nextKotId, nextBillNumber };
