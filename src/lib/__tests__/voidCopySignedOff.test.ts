/**
 * THE SIGNED VOID COPY. SIGNED BY THE OWNER 2026-09-06.
 *
 * Thirteen strings, every one shown to a waiter standing at a table with a customer waiting for an
 * answer about their bill. Pinned as written so a tidy-up, a refactor, or someone "improving" a
 * sentence fails here rather than silently changing what is read mid-service.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review: get the new
 * wording signed, change the constants in the same commit as this file, and say who signed it and
 * when.
 *
 * ============================================================================================
 * ONE OWNER EDIT AT SIGNING, RECORDED HERE BECAUSE IT HAS A REASON
 * ============================================================================================
 *
 * VOID_NEEDS_AUTHORIZATION said the terminal "is out of date" and told the reader to "Update the
 * app". A WAITER CANNOT UPDATE IT. Telling them to is a dead end in the middle of service, so the
 * only route offered is the one they can actually take: ask a manager to remove the item from the
 * dashboard. Asserted below as an absence, not just as the new text, because the useless
 * instruction is the thing that must not come back.
 */
import {
  VOID_CONFIRM,
  VOID_EFFECT_REDUCE,
  VOID_EFFECT_REDUCE_ONE,
  VOID_NEEDS_APPROVAL_BODY,
  VOID_NEEDS_APPROVAL_TITLE,
  VOID_NEEDS_AUTHORIZATION,
  VOID_NEEDS_REASON,
  VOID_NO_MANAGERS,
  VOID_PICK_MANAGER,
  VOID_PIN_PROMPT,
  VOID_REASON_PROMPT,
  VOID_REASON_TOO_LONG,
  VOID_REFUSED_PIN,
} from '../../constants/voidCopy';
import {AMEND_EFFECT_CHANGE, AMEND_EFFECT_REMOVE} from '../../constants/amendCopy';

const SIGNED_ON = '2026-09-06';

describe(`the signed void copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(VOID_NEEDS_APPROVAL_TITLE).toBe('A manager has to approve this');
    expect(VOID_NEEDS_APPROVAL_BODY).toBe(
      'Taking items off a bill takes the money off it too. A manager or owner approves it with their PIN, and their name stays on the record.',
    );
    expect(VOID_PICK_MANAGER).toBe('Who is approving this?');
    expect(VOID_PIN_PROMPT).toBe("{name}'s PIN");
    expect(VOID_REASON_PROMPT).toBe('Why is it coming off?');
    expect(VOID_NO_MANAGERS).toBe(
      'Nobody here can approve taking items off a bill. A manager or owner has to be added in Settings first. The item stays on the bill until then.',
    );
    expect(VOID_CONFIRM).toBe('Approve and take it off');
    expect(VOID_REFUSED_PIN).toBe(
      'That PIN was not accepted, so nothing came off the bill. Check who is approving it and try again.',
    );
    expect(VOID_NEEDS_REASON).toBe(
      'A reason is needed before this can come off the bill. Nothing has changed yet.',
    );
    expect(VOID_REASON_TOO_LONG).toBe(
      'That reason is too long. Shorten it to a sentence and try again — nothing has changed yet.',
    );
    expect(VOID_NEEDS_AUTHORIZATION).toBe(
      'This terminal needs updating before items can come off a bill. Nothing has changed. Ask a manager to remove it from the dashboard.',
    );
    expect(VOID_EFFECT_REDUCE).toBe('This takes {count} off the order and off the bill. The rest stays.');
    expect(VOID_EFFECT_REDUCE_ONE).toBe(
      'This takes one off the order and off the bill. The rest stays.',
    );
  });

  it('never tells a waiter to do something they cannot do', () => {
    // The owner's edit at signing. Asserted as an ABSENCE so restoring the instruction fails here.
    expect(VOID_NEEDS_AUTHORIZATION).not.toMatch(/update the app/i);
    expect(VOID_NEEDS_AUTHORIZATION).not.toMatch(/out of date/i);
    // ...and the route that IS open to them is still named.
    expect(VOID_NEEDS_AUTHORIZATION).toMatch(/dashboard/i);
  });

  it('the {name} and {count} slots survive, because a string without them renders a literal', () => {
    expect(VOID_PIN_PROMPT).toContain('{name}');
    expect(VOID_EFFECT_REDUCE).toContain('{count}');
    // The one-item wording takes no slot: "takes 1 off" is what it exists to avoid.
    expect(VOID_EFFECT_REDUCE_ONE).not.toContain('{count}');
  });

  it('every refusal says the bill is unchanged', () => {
    /**
     * The load-bearing half of all four. The waiter has already told the customer the item is
     * coming off; a refusal that does not say otherwise leaves everyone at the table believing it
     * did. voidApproval.test.ts asserts the same property through the mapping — this asserts it of
     * the signed words themselves.
     */
    for (const [name, text] of [
      ['VOID_REFUSED_PIN', VOID_REFUSED_PIN],
      ['VOID_NEEDS_REASON', VOID_NEEDS_REASON],
      ['VOID_REASON_TOO_LONG', VOID_REASON_TOO_LONG],
      ['VOID_NEEDS_AUTHORIZATION', VOID_NEEDS_AUTHORIZATION],
    ] as const) {
      expect({name, saysUnchanged: /nothing (has )?(came|changed)/i.test(text)}).toEqual({
        name,
        saysUnchanged: true,
      });
    }
  });

  it('the reduction wording talks about the bill, which the amend wording does not', () => {
    /**
     * WHY THESE TWO EXIST AT ALL. A reduction used to render AMEND_EFFECT_CHANGE, which describes
     * what the KITCHEN sees and mentions no money — so a manager approving 3→1 read nothing about
     * two dishes leaving the bill. Owner called it a real hole at signing.
     */
    for (const text of [VOID_EFFECT_REDUCE, VOID_EFFECT_REDUCE_ONE]) {
      expect(text).toMatch(/bill/i);
      expect(text).not.toBe(AMEND_EFFECT_CHANGE);
    }
    expect(AMEND_EFFECT_CHANGE).not.toMatch(/bill/i);
    // A full removal keeps its own signed wording, which already names the bill.
    expect(AMEND_EFFECT_REMOVE).toMatch(/bill/i);
  });

  it('the approval body names the consequence AND that a name is kept', () => {
    // House style on money: say the consequence. And the PIN is asked for an honest reason —
    // somebody's name goes on the record — rather than as a hoop.
    expect(VOID_NEEDS_APPROVAL_BODY).toMatch(/money/i);
    expect(VOID_NEEDS_APPROVAL_BODY).toMatch(/name/i);
  });

  it('the no-managers message does not promise the item can come off', () => {
    // It cannot, until somebody who can approve exists. Saying otherwise sends a waiter back to a
    // table with an answer that is not true.
    expect(VOID_NO_MANAGERS).toMatch(/stays on the bill/i);
    expect(VOID_NO_MANAGERS).toMatch(/Settings/);
  });

  it('nothing is left as a placeholder', () => {
    for (const [name, text] of Object.entries({
      VOID_NEEDS_APPROVAL_TITLE,
      VOID_NEEDS_APPROVAL_BODY,
      VOID_PICK_MANAGER,
      VOID_PIN_PROMPT,
      VOID_REASON_PROMPT,
      VOID_NO_MANAGERS,
      VOID_CONFIRM,
      VOID_REFUSED_PIN,
      VOID_NEEDS_REASON,
      VOID_REASON_TOO_LONG,
      VOID_NEEDS_AUTHORIZATION,
      VOID_EFFECT_REDUCE,
      VOID_EFFECT_REDUCE_ONE,
    })) {
      expect({name, placeholder: /PENDING|TODO|TBD|XXX/i.test(text)}).toEqual({
        name,
        placeholder: false,
      });
    }
  });
});
