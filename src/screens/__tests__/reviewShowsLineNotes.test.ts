/**
 * THE REVIEW SCREEN SHOWS EACH LINE'S NOTE, READ-ONLY.
 *
 * ================================================================================================
 * IT ALREADY DID — AND THAT WAS THE FINDING
 * ================================================================================================
 *
 * Reported 2026-09-06 as "the review screen shows nothing". It does render `line.note`, in orange,
 * under the item name, when the note is non-empty. Nothing was appearing because nothing was being
 * CAPTURED: the note field was buried on the basket row and easy to miss entirely.
 *
 * So this is not a fix, it is a pin. The render is correct and the capture changed around it (the
 * item sheet), and the thing worth asserting is that a waiter can still check a note before
 * sending — because that is what the display is for and nothing else guards it.
 *
 * ================================================================================================
 * READ-ONLY, DELIBERATELY
 * ================================================================================================
 *
 * The review screen is the last look before the round goes to the kitchen. An editable field there
 * would be a second place to write a note, competing with the sheet, and the two would disagree
 * about which one the kitchen gets. Asserted as an absence.
 */
/**
 * MAKES THIS FILE A MODULE. Without an import or export, TypeScript treats a test file as a global
 * script, and two suites declaring the same top-level `readFileSync` shim collide with TS2451 even
 * though both pass under jest. Same reason apiHarness was extracted.
 */
export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
const resolve = (require as unknown as {resolve: (m: string) => string}).resolve;

const REVIEW = readFileSync(resolve('../ServiceRoundReviewScreen'), 'utf8');

describe('the note is shown', () => {
  it('renders each line note', () => {
    // The condition, not a style: a note that exists must reach the screen.
    expect(REVIEW).toMatch(/line\.note\.trim\(\) \?/);
    expect(REVIEW).toMatch(/<Text style=\{styles\.reviewNote\}>\{line\.note\.trim\(\)\}<\/Text>/);
  });

  it('shows nothing when there is no note, rather than an empty row', () => {
    // An empty orange line under every item would make the ones that matter harder to see.
    expect(REVIEW).toMatch(/line\.note\.trim\(\) \? \(/);
    expect(REVIEW).toMatch(/\) : null/);
  });

  it('gives the note its own visual weight', () => {
    /**
     * It is the only thing on the screen the KITCHEN will act on differently, so it must not read
     * as secondary text next to the price. Asserted as "has its own style", not as a colour value.
     */
    expect(REVIEW).toMatch(/reviewNote: \{/);
  });
});

describe('and it cannot be edited there', () => {
  it('the review screen has no per-line note input', () => {
    /**
     * A second editor would compete with the sheet, and the kitchen would get whichever wrote
     * last. The ORDER-level instructions field is a different thing and stays.
     */
    const perLineInput = /onChangeText=\{[^}]*note[^}]*\}/i.test(REVIEW);
    expect(perLineInput).toBe(false);
  });

  it('the order-level note is still editable, which is a different field', () => {
    // "Order note (optional)" — one note for the whole round, not per item.
    expect(REVIEW).toMatch(/Order note \(optional\)/);
    expect(REVIEW).toMatch(/setOrderInstructions/);
  });

  it('says the per-item notes are the place for per-dish detail', () => {
    // The hint that stops a waiter putting "no onions on the second burger" in the order note.
    expect(REVIEW).toMatch(/per-item notes/i);
  });
});
