/**
 * EVERY REFUSAL CODE THE SERVER CAN EMIT MUST HAVE A SIGNED STRING.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 * ==================================================================================================
 *
 * On 2026-09-08 a waiter at Digi Cofee tapped Settle Selected and read "Missing permission" off the
 * terminal. That is a server author's log wording, shown to a customer-facing screen, because the
 * lookup ended with `?? err.message`.
 *
 * Seventeen of the two routes' twenty-two refusal sites went out that way: seven carried no error
 * code at all, and ten carried a code nothing mapped. Each one would have surfaced raw English the
 * first time it fired, and the worst of them -- HOLD_CHECK_FAILED -- would have shown a waiter
 * "Could not confirm no card payment is in progress for these items": a system complaint, naming no
 * action, at the exact moment they are deciding whether to take cash for items a card may be
 * holding.
 *
 * The fallback is gone. But removing it only converts the failure mode: an unmapped code now shows
 * a correct-but-generic phase fallback instead of raw text, which is safer AND quieter. A new code
 * added server-side with no copy would degrade at a table rather than fail here.
 *
 * SO THE MAPPING IS CHECKED AGAINST THE SERVER'S OWN SOURCE, and adding a code without copy fails
 * the build.
 *
 * ==================================================================================================
 * IT READS THE WEB REPO, AND SKIPS HONESTLY IF IT IS NOT THERE
 * ==================================================================================================
 *
 * The routes live in the other repository. A CI checkout of the terminal alone cannot see them, and
 * a test that silently passes when it cannot find its subject is worse than no test -- that is the
 * "all clear from a dead instrument" shape.
 *
 * So: if the web repo is absent the suite FAILS on a missing-subject assertion unless the checkout
 * is explicitly declared absent via FLASHTAP_WEB_REPO=none. Nothing passes by accident.
 */
import {MAPPED_SPLIT_CARD_CODES, splitCardFailureMessage} from '../splitCardPayment';
import * as Copy from '../../constants/splitCardCopy';

/**
 * Node built-ins are reached through `require` rather than imported, because this tsconfig carries
 * no @types/node -- it is a React Native app. Every other filesystem-reading test in this repo does
 * the same; the cast is what keeps `tsc --noEmit` honest about what is being used.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {existsSync, readFileSync, writeFileSync, unlinkSync} = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, e: string) => string;
  writeFileSync: (p: string, d: string, e: string) => void;
  unlinkSync: (p: string) => void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {join} = require('path') as {join: (...parts: string[]) => string};
const env = (
  globalThis as unknown as {process?: {env?: Record<string, string | undefined>}}
).process?.env ?? {};

/** Where the two routes live. Overridable so this is not pinned to one machine's layout. */
const WEB_REPO = env.FLASHTAP_WEB_REPO ?? 'D:/dev/flashtap/build';

const ROUTES = [
  'app/api/terminal/tabs/[tabId]/prepare-split-payment/route.ts',
  'app/api/terminal/tabs/[tabId]/record-split-payment/route.ts',
];

/**
 * Every `code: 'X'` a route can return.
 *
 * Anchored on the `code:` property rather than on bare capitalised strings, so prose in a doc block
 * naming a code is not mistaken for a code the route emits.
 */
function codesEmittedBy(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    const re = /\bcode:\s*'([A-Z0-9_]+)'/g;
    let m;
    while ((m = re.exec(line))) out.add(m[1]);
  }
  return [...out];
}

const available = env.FLASHTAP_WEB_REPO !== 'none' && existsSync(join(WEB_REPO, ROUTES[0]));

describe('the server refusal codes are all covered by signed copy', () => {
  it('the subject exists — this suite is not passing on an empty read', () => {
    /**
     * The control. Without it, a wrong path means "zero codes found, all zero are covered", which
     * is the loudest possible green from an instrument that read nothing.
     */
    if (env.FLASHTAP_WEB_REPO === 'none') {
      // Declared absent on purpose. Nothing below runs, and that is a stated choice, not a silent one.
      expect(available).toBe(false);
      return;
    }
    expect({repo: WEB_REPO, found: available}).toEqual({repo: WEB_REPO, found: true});
  });

  const maybe = available ? it : it.skip;

  maybe('every code either route emits maps to a signed string', () => {
    const emitted = [...new Set(ROUTES.flatMap(r => codesEmittedBy(join(WEB_REPO, r))))].sort();

    // POSITIVE CONTROL: a plausible number, and one we know by name. A regex that matches nothing
    // would otherwise satisfy "all emitted codes are mapped" trivially.
    expect(emitted.length).toBeGreaterThan(15);
    expect(emitted).toContain('HOLD_CHECK_FAILED');
    expect(emitted).toContain('MISSING_PERMISSION');

    const mapped = new Set(MAPPED_SPLIT_CARD_CODES);
    const unmapped = emitted.filter(c => !mapped.has(c));
    expect(unmapped).toEqual([]);
  });

  maybe('and every mapping resolves to a string that is actually in the signed set', () => {
    /**
     * A code mapped to a typo'd or hand-written constant would pass the check above while showing
     * a waiter something nobody signed. So each mapping is resolved and checked for membership in
     * the copy module.
     */
    const signed = new Set(
      (Object.values(Copy) as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      ),
    );
    for (const code of MAPPED_SPLIT_CARD_CODES) {
      const text = splitCardFailureMessage(code, 'prepare');
      expect({code, signed: signed.has(text)}).toEqual({code, signed: true});
    }
  });

  maybe('no mapping is dead — every mapped code is one a route can actually emit', () => {
    /**
     * The other direction, and it is not pedantry. A mapping for a code no route emits is either a
     * server-side refusal that was deleted (so the copy is stale and misleading to the next reader)
     * or a code someone guessed at, which means the real one is unmapped and falls through.
     */
    const emitted = new Set(ROUTES.flatMap(r => codesEmittedBy(join(WEB_REPO, r))));
    const dead = MAPPED_SPLIT_CARD_CODES.filter(c => !emitted.has(c));
    expect(dead).toEqual([]);
  });
});

describe('the extractor itself', () => {
  it('reads code, not prose', () => {
    /**
     * If a doc block naming a code counted, every file explaining this defect would register codes
     * the route cannot emit -- and the dead-mapping check above would then be measuring comments.
     */
    const here = (
      globalThis as unknown as {__dirname?: string}
    ).__dirname ?? '.';
    const tmp = join(here, '.tmp-code-probe.ts');
    writeFileSync(
      tmp,
      [
        '/**',
        " * Returns code: 'FAKE_FROM_A_COMMENT' when the moon is full.",
        ' */',
        "// return NextResponse.json({ code: 'ALSO_FAKE' })",
        "const real = { code: 'GENUINELY_EMITTED' }",
      ].join('\n'),
      'utf8',
    );
    try {
      expect(codesEmittedBy(tmp)).toEqual(['GENUINELY_EMITTED']);
    } finally {
      unlinkSync(tmp);
    }
  });
});
