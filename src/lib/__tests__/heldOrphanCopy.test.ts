/**
 * #344 RULING 3 — the two signed strings, and the one property that is a RULING rather than a
 * preference.
 *
 * THE TEST THAT MATTERS is 'HELD_ORPHAN_NOT_SAVED offers no override'. Everything else here is
 * ordinary copy pinning; that one is a gate against a specific future change.
 *
 * WHY IT NEEDS A TEST AND NOT A COMMENT. The change it forbids is the reasonable-sounding one. An
 * operator presses "I have checked this payment", the terminal is offline, the record stays, and
 * they press it again tomorrow and it stays again. The obvious kindness is a second button --
 * "clear anyway", behind a confirmation dialog, for the case where someone has genuinely checked
 * the payment and the server simply cannot be reached.
 *
 * That button is the defect. `consumeOrphanedPaymentResult` is destructive, so the held record is
 * the ONLY remaining trace of that card transaction on this device; clearing it on the strength of
 * a human having read a message is exactly the discard #344 removed. In the owner's words:
 * *an override is the discard we removed wearing a confirmation dialog.*
 *
 * So the property is asserted from two directions -- the STRING may not offer an escape hatch, and
 * the NOTICE may not render a second action per record -- because either one alone could be
 * satisfied while the other reintroduced it.
 */
import {
  HELD_ORPHAN_ACKNOWLEDGE,
  HELD_ORPHAN_NOT_SAVED,
  HELD_ORPHAN_SAVING,
} from '../../constants/paymentCopy';

describe('HELD_ORPHAN_SAVING', () => {
  it('is three ASCII full stops, not U+2026', () => {
    // Signed that way, matching UNCONFIRMED_CHECK_IN_PROGRESS. A formatter "tidying" this is
    // editing signed copy.
    expect(HELD_ORPHAN_SAVING).toBe('Saving...');
    expect(HELD_ORPHAN_SAVING).not.toContain('…');
  });

  it('says something is being SAVED, not merely that the app is busy', () => {
    // What the operator is waiting for is the record existing somewhere other than this device.
    // "Please wait" would be the #346 defect on a smaller screen.
    expect(HELD_ORPHAN_SAVING.toLowerCase()).toContain('sav');
    expect(HELD_ORPHAN_SAVING.toLowerCase()).not.toContain('please wait');
  });
});

describe('HELD_ORPHAN_NOT_SAVED — signed 2026-08-26', () => {
  it('is the signed string, exactly', () => {
    expect(HELD_ORPHAN_NOT_SAVED).toBe(
      'This payment could not be saved yet, so it has been kept here. Nothing was lost. Try again when the terminal is back online.',
    );
  });

  it('OWNER DECISION 1 — it names the SAVING as what failed, never the payment', () => {
    // Nothing about the card transaction changed; a save did not go through. Conflating those is
    // the family of defect #327's UNCONFIRMED_CHECK_FAILED exists to end.
    expect(HELD_ORPHAN_NOT_SAVED).toMatch(/could not be saved/);
    for (const wrong of [
      'payment failed',
      'payment could not be completed',
      'the payment did not go through',
      'declined',
    ]) {
      expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).not.toContain(wrong);
    }
  });

  it('says nothing was lost, so the operator is not left guessing', () => {
    expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).toContain('nothing was lost');
    expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).toContain('kept');
  });

  it('names an action the operator can actually take', () => {
    // Trying again is the only one available. A message with no action is a message staff learn
    // to scroll past.
    expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).toContain('try again');
  });

  it('OWNER DECISION 2 — IT OFFERS NO OVERRIDE, AND NOBODY MAY ADD ONE', () => {
    /*
     * "An override is the discard we removed wearing a confirmation dialog."
     *
     * The held record is the only remaining trace of a card transaction on this device --
     * consumeOrphanedPaymentResult is destructive. Clearing it because a human read a message is
     * the behaviour #344 exists to end, and a durable write is the ONLY acknowledgement (ruling 1).
     */
    const forbidden = [
      'clear anyway',
      'dismiss anyway',
      'remove anyway',
      'delete anyway',
      'force',
      'override',
      'discard',
      'clear it anyway',
      'skip',
    ];
    for (const phrase of forbidden) {
      expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).not.toContain(phrase);
    }
  });

  it('does not tell the operator to do anything to the record itself', () => {
    // The only thing they may do is retry the save. Not delete, not edit, not resolve.
    for (const verb of ['delete', 'remove this', 'clear this', 'resolve it yourself']) {
      expect(HELD_ORPHAN_NOT_SAVED.toLowerCase()).not.toContain(verb);
    }
  });
});

/**
 * THE SECOND DIRECTION. The string above could keep every property and the override could still
 * arrive as a button beside it, captioned from a NEW constant this test does not know about. So the
 * copy module is checked as a whole: there is exactly ONE action string for a held record, and it
 * is the acknowledge.
 *
 * This is deliberately a test over the module's exports rather than over the component, because a
 * component test would pass the moment someone rendered a `<Pressable>` with an inline string --
 * and an inline string is how unsigned copy gets onto a screen in the first place.
 */
describe('there is exactly one action a held record offers', () => {
  it('the acknowledge is the only held-orphan action label', () => {
    // SIGNED 2026-08-26, REPLACING 'I have checked this payment'. The old label asserted what the
    // OPERATOR DID while the button attempts a server write that can fail, so HELD_ORPHAN_NOT_SAVED
    // had to contradict a claim they had already made. Naming the action makes "could not be saved"
    // read as that action failing. The forbidden list below is what stops it coming back.
    expect(HELD_ORPHAN_ACKNOWLEDGE).toBe('Send for checking');
  });

  it('no held-orphan constant reads like a second, destructive action', () => {
    const copy = require('../../constants/paymentCopy') as Record<string, unknown>;
    const heldStrings = Object.entries(copy).filter(
      ([name, value]) => name.startsWith('HELD_ORPHAN') && typeof value === 'string',
    ) as Array<[string, string]>;

    // The control: if this list is ever empty the loop below asserts nothing at all, and the
    // reassuring green would mean the test had stopped looking rather than found nothing.
    expect(heldStrings.length).toBeGreaterThanOrEqual(6);

    for (const [name, text] of heldStrings) {
      for (const phrase of [
        'clear anyway',
        'delete',
        'discard',
        'remove anyway',
        'override',
        /*
         * ADDED 2026-08-26 WITH THE SIGNED ACKNOWLEDGE. Per the owner, a label reading "I have
         * checked", "dismiss" or "clear" is the discard we removed wearing a different word: each
         * one puts the operator's having READ something in the place of the durable write that
         * ruling 1 makes the only acknowledgement.
         *
         * 'clear' subsumes 'clear anyway' above. The narrower phrase is kept deliberately rather
         * than tidied away -- it is the one the owner named in decision 2, and a failure quoting
         * it points at that decision directly.
         */
        'i have checked',
        'dismiss',
        'clear',
      ]) {
        expect([name, text.toLowerCase().includes(phrase)]).toEqual([name, false]);
      }
    }
  });
});
