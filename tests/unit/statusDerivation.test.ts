import { describe, expect, it } from 'vitest';

import { ITEM_STATUS, ROUND_STATUS, SESSION_STATUS } from '../../src/config/constants.js';
import { deriveRoundStatus, deriveSessionStatus } from '../../src/services/statusDerivation.js';

/**
 * Status derivation — the rule that keeps the KDS, the table grid and the
 * customer's phone from ever disagreeing. Item status is the only stored truth;
 * everything else is computed from it here.
 */

const item = (status: (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS]) => ({
  status,
  quantity: 1,
  unitPrice: 100,
  taxPercent: 5,
});

describe('deriveRoundStatus', () => {
  it('reports the least-progressed live item, not the most', () => {
    // Two teas ready, one sandwich still cooking: the ticket is not "ready".
    const status = deriveRoundStatus([
      item(ITEM_STATUS.READY),
      item(ITEM_STATUS.READY),
      item(ITEM_STATUS.PREPARING),
    ]);
    expect(status).toBe(ROUND_STATUS.PREPARING);
  });

  it('is ready only when every live item is ready', () => {
    expect(deriveRoundStatus([item(ITEM_STATUS.READY), item(ITEM_STATUS.READY)])).toBe(
      ROUND_STATUS.READY,
    );
  });

  it('is served only when every live item is served', () => {
    expect(deriveRoundStatus([item(ITEM_STATUS.SERVED), item(ITEM_STATUS.SERVED)])).toBe(
      ROUND_STATUS.SERVED,
    );
    expect(deriveRoundStatus([item(ITEM_STATUS.SERVED), item(ITEM_STATUS.READY)])).toBe(
      ROUND_STATUS.READY,
    );
  });

  it('ignores cancelled items — they must not hold a ticket back', () => {
    const status = deriveRoundStatus([
      item(ITEM_STATUS.READY),
      item(ITEM_STATUS.CANCELLED),
    ]);
    expect(status).toBe(ROUND_STATUS.READY);
  });

  it('is cancelled when nothing is left alive', () => {
    expect(deriveRoundStatus([item(ITEM_STATUS.CANCELLED)])).toBe(ROUND_STATUS.CANCELLED);
    expect(deriveRoundStatus([])).toBe(ROUND_STATUS.CANCELLED);
  });

  it('treats accepted as its own step between pending and preparing', () => {
    expect(deriveRoundStatus([item(ITEM_STATUS.ACCEPTED), item(ITEM_STATUS.READY)])).toBe(
      ROUND_STATUS.ACCEPTED,
    );
  });
});

describe('deriveSessionStatus', () => {
  const round = (...statuses: (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS][]) => ({
    status: ROUND_STATUS.PENDING,
    items: statuses.map(item),
  });

  it('is occupied when the table has ordered nothing yet', () => {
    expect(deriveSessionStatus([], { billRequested: false })).toBe(SESSION_STATUS.OCCUPIED);
  });

  it('is order_pending while anything is unaccepted', () => {
    expect(
      deriveSessionStatus([round(ITEM_STATUS.PENDING, ITEM_STATUS.READY)], {
        billRequested: false,
      }),
    ).toBe(SESSION_STATUS.ORDER_PENDING);
  });

  it('is preparing once the kitchen has picked everything up', () => {
    expect(
      deriveSessionStatus([round(ITEM_STATUS.PREPARING, ITEM_STATUS.READY)], {
        billRequested: false,
      }),
    ).toBe(SESSION_STATUS.PREPARING);
  });

  it('is ready when food is waiting to go out', () => {
    expect(
      deriveSessionStatus([round(ITEM_STATUS.READY), round(ITEM_STATUS.SERVED)], {
        billRequested: false,
      }),
    ).toBe(SESSION_STATUS.READY);
  });

  it('falls back to occupied once everything is served', () => {
    // Nothing outstanding — the table is simply sitting there.
    expect(deriveSessionStatus([round(ITEM_STATUS.SERVED)], { billRequested: false })).toBe(
      SESSION_STATUS.OCCUPIED,
    );
  });

  it('lets bill_requested outrank everything else', () => {
    // Staff must see "wants to pay" even if an add-on is still cooking.
    expect(
      deriveSessionStatus([round(ITEM_STATUS.PENDING)], { billRequested: true }),
    ).toBe(SESSION_STATUS.BILL_REQUESTED);
  });

  it('spans rounds: the slowest item anywhere in the session wins', () => {
    const status = deriveSessionStatus(
      [round(ITEM_STATUS.SERVED), round(ITEM_STATUS.PENDING)],
      { billRequested: false },
    );
    expect(status).toBe(SESSION_STATUS.ORDER_PENDING);
  });

  it('ignores a fully cancelled round', () => {
    const status = deriveSessionStatus(
      [round(ITEM_STATUS.CANCELLED), round(ITEM_STATUS.READY)],
      { billRequested: false },
    );
    expect(status).toBe(SESSION_STATUS.READY);
  });
});
