/**
 * A HOST'S PRONUNCIATION GUIDE IS A CARD, AND NOTHING IS MADE FROM IT
 * (Owen, 2026-10-03: "the glossary building step should be its own process").
 *
 * The guide is the host's: drawn with its acts, read by its own cleanup. So its
 * card produces nothing this tree chains onto — no "from here" footer, which is
 * the `produces === null` rule a row with no words already follows.
 */
import { expect, test } from 'bun:test';

import { offeredFrom, PRODUCES_OF, type HostOperationOffer } from '../shared/host-ops';

test('a guide card produces nothing to chain onto', () => {
  expect(PRODUCES_OF.guide).toBeNull();
});

test('the host acts that made audio still make audio', () => {
  expect([PRODUCES_OF.narrate, PRODUCES_OF.enhance, PRODUCES_OF.assemble]).toEqual(['audio', 'audio', 'audio']);
});

test('a guide offered from a book is offered there, like any act that consumes the words', () => {
  const offers: HostOperationOffer[] = [
    { id: 'host.guide', label: 'Pronunciation guide', kind: 'guide', appliesTo: 'book' },
    { id: 'host.assemble', label: 'Assemble', kind: 'assemble', appliesTo: 'audio' },
  ];
  expect(offeredFrom(offers, 'book').map((o) => o.id)).toEqual(['host.guide']);
});
