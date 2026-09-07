/**
 * EVERY REJECT CODE PaymentModule.kt CAN RAISE MUST BE CLASSIFIED ON PURPOSE.
 *
 * ==================================================================================================
 * WHY
 * ==================================================================================================
 *
 * payment.ts ends its error handling with a default: anything unrecognised becomes
 * 'confirmed_failure'. So a NEW native code needs no code change to reach production -- it simply
 * inherits a classification that claims the gateway declined the card.
 *
 * That is what happened. `INTENT_ERROR` -- raised when startActivityForResult throws, i.e.
 * WiseCashier could not be opened -- fell into that default, and a waiter at Digi Cofee was told
 * the card had been declined by a machine that never started.
 *
 * The sibling suite (paymentNativeBoundary) asserts what each code BECOMES. It cannot notice a code
 * it has never heard of. This one reads the Kotlin and fails when the two lists diverge, so adding
 * a reject in native forces a decision here rather than inheriting one.
 *
 * ==================================================================================================
 * IT REFUSES RATHER THAN SKIPPING
 * ==================================================================================================
 *
 * If the Kotlin cannot be read, this FAILS. A test that quietly passes when it cannot find its
 * subject is the "all clear from a dead instrument" shape that has cost this project three defects
 * in one session.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {readFileSync, existsSync} = require('fs') as {
  readFileSync: (p: string, e: string) => string;
  existsSync: (p: string) => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {join} = require('path') as {join: (...p: string[]) => string};

/**
 * Resolved from the REPO ROOT rather than from __dirname, which jest does not reliably provide
 * here. Both candidates are tried and the first that exists wins -- and if neither does, MODULE_KT
 * keeps the primary path so the readability assertion below FAILS with a path in the message
 * rather than passing on a silent miss.
 */
const proc = (globalThis as unknown as {process?: {cwd(): string}}).process;
const ROOT = proc ? proc.cwd() : '.';
const KT_TAIL = ['android', 'app', 'src', 'main', 'java', 'com', 'flashtap', 'pos', 'PaymentModule.kt'];
const CANDIDATES = [join(ROOT, ...KT_TAIL), join(ROOT, '..', ...KT_TAIL)];
const MODULE_KT = CANDIDATES.find(p => existsSync(p)) ?? CANDIDATES[0];
const here = join(ROOT, 'src', 'lib', '__tests__');

/**
 * Every `promise.reject("CODE"` in the native module.
 *
 * Anchored on `promise.reject(` rather than any quoted capital, so a code NAMED in a comment -- of
 * which there are now several, explaining this very defect -- is not counted as one the module
 * raises.
 */
function nativeRejectCodes(src: string): string[] {
  /**
   * WHOLE-FILE, NOT LINE BY LINE, and that distinction is not cosmetic.
   *
   * Kotlin wraps these across lines:
   *
   *     promise.reject(
   *       "MISSING_MERCHANT_ORDER_NO",
   *       "merchantOrderNo is required; call prepare-payment before launching Finatic",
   *     )
   *
   * A per-line regex sees `promise.reject(` and `"MISSING_..."` on DIFFERENT lines and matches
   * neither. The first version of this test did exactly that, and its own dead-classification
   * control caught it: four codes that native genuinely raises were reported as not existing. Had
   * only the forward check existed, the suite would have gone green while blind to every wrapped
   * reject in the file -- which is most of them.
   *
   * Comments are stripped first, so a code named in the prose explaining this defect is not counted
   * as one the module raises.
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ 	]*\/\/.*$/gm, '');
  const out = new Set<string>();
  const re = /promise\.reject\(\s*"([A-Z0-9_]+)"/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return [...out].sort();
}

/**
 * How payment.ts classifies each one. Kept HERE rather than imported, deliberately: importing the
 * classifier's own list would make this test agree with it by construction, which is the mistake
 * that let a fabricated mock agree with the caller that fabricated it.
 *
 * 'not_started'  raised before or instead of startActivityForResult. Nothing was presented.
 * 'ambiguous'    the reader ran and the outcome is unknown. Must reach a Finatic verify.
 * 'cancelled'    the customer dismissed a reader that did open.
 * 'declined'     the gateway refused, with a code to prove it.
 * 'n/a'          not a payment-launch code -- orphan/wiretap plumbing, never seen by a waiter.
 */
const EXPECTED: Record<string, string> = {
  NO_ACTIVITY: 'not_started',
  INTENT_ERROR: 'not_started',
  MISSING_MERCHANT_ORDER_NO: 'not_started',
  INVALID_MERCHANT_ORDER_NO: 'not_started',
  ORPHAN_READ_FAILED: 'n/a',
  ORPHAN_CLEAR_FAILED: 'n/a',
  WIRETAP_READ_FAILED: 'n/a',
  WIRETAP_CLEAR_FAILED: 'n/a',
};

describe('the native reject codes are all accounted for', () => {
  it('the Kotlin source is readable — this suite is not passing on an empty read', () => {
    expect({path: MODULE_KT, found: existsSync(MODULE_KT)}).toEqual({
      path: MODULE_KT,
      found: true,
    });
  });

  it('POSITIVE CONTROL: it finds codes, including the one that caused the incident', () => {
    const codes = nativeRejectCodes(readFileSync(MODULE_KT, 'utf8'));
    expect(codes.length).toBeGreaterThan(3);
    expect(codes).toContain('INTENT_ERROR');
    expect(codes).toContain('NO_ACTIVITY');
  });

  it('NEGATIVE CONTROL: a code named only in a comment is not counted', () => {
    const probe = [
      '// promise.reject("FAKE_FROM_A_COMMENT", "nope")',
      '/**',
      ' * promise.reject("ALSO_FAKE", "nope")',
      ' */',
      'promise.reject("GENUINELY_RAISED", "yes")',
      // Wrapped exactly as the Kotlin wraps it. This case is the whole reason the extractor reads
      // the file as one string rather than a line at a time.
      'promise.reject(',
      '  "WRAPPED_ACROSS_LINES",',
      '  "a message",',
      ')',
    ].join(String.fromCharCode(10));
    expect(nativeRejectCodes(probe)).toEqual(['GENUINELY_RAISED', 'WRAPPED_ACROSS_LINES']);
  });

  it('every code the module raises has a deliberate classification', () => {
    /**
     * A failure here means native gained a reject that payment.ts has never been told about. It is
     * currently inheriting 'confirmed_failure' — i.e. telling a waiter the card was declined. Decide
     * what it should be and add it to EXPECTED with a reason.
     */
    const codes = nativeRejectCodes(readFileSync(MODULE_KT, 'utf8'));
    const unclassified = codes.filter(c => !(c in EXPECTED));
    expect(unclassified).toEqual([]);
  });

  it('no classification is dead — every expected code still exists in native', () => {
    /**
     * The other direction. A classification for a code native no longer raises is either stale
     * documentation or, worse, a guess at a name — which would mean the REAL code is unclassified
     * and inheriting the decline default.
     */
    const codes = new Set(nativeRejectCodes(readFileSync(MODULE_KT, 'utf8')));
    const dead = Object.keys(EXPECTED).filter(c => !codes.has(c));
    expect(dead).toEqual([]);
  });

  it('every pre-reader code is one the classifier actually treats as not_started', () => {
    /**
     * Ties this list to the runtime. Without it the two could agree on paper -- both listing
     * INTENT_ERROR -- while payment.ts classified it as a decline anyway.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const payment = readFileSync(join(here, '..', 'payment.ts'), 'utf8');
    const block = /NEVER_REACHED_THE_READER\s*=\s*\[([\s\S]*?)\]/.exec(payment);
    expect(block).not.toBeNull();
    const inClassifier = new Set(
      [...(block?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]),
    );
    const shouldBe = Object.keys(EXPECTED).filter(c => EXPECTED[c] === 'not_started');
    const missing = shouldBe.filter(c => !inClassifier.has(c));
    expect(missing).toEqual([]);
  });
});
