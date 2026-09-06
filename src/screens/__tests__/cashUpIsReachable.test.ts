/**
 * THE CASH-UP SCREEN MUST BE REACHABLE, NOT MERELY PRESENT.
 *
 * ================================================================================================
 * THE DEFECT THIS EXISTS TO CATCH — IT SHIPPED INTO AN APK
 * ================================================================================================
 *
 * Build 128 was assembled with CashUpScreen.tsx written, tested and committed, and the screen was
 * ABSENT FROM THE BUNDLE. Nothing imported it, so Metro never included it: an unreachable module is
 * not a module. Every unit test passed, tsc was clean, the copy was signed and locked, and the
 * feature did not exist on the device.
 *
 * It was found by extracting assets/index.android.bundle from the packaged APK and grepping for
 * the signed strings — "Print cash-up" and "Not a tax invoice" were missing while the void and
 * gratuity strings were present. Nothing in the repo would have told anyone.
 *
 * This is the same shape as two earlier failures in this project: `orders:void` had a label and
 * appeared in no PERMISSION_GROUP, so the staff page rendered no checkbox; and getTabLines
 * declared five fields it never copied. In all three the artefact was correct and DISCONNECTED.
 *
 * ================================================================================================
 * WHAT IS ASSERTED, AND WHY IT IS THE SOURCE AND NOT A MOCK
 * ================================================================================================
 *
 * Rendering the navigator here would prove only that a test can render it. What broke was the
 * static import graph — whether the bundler can SEE the screen — so that is what is read: the
 * navigator's own source must import the screen and register a route, and some screen must
 * navigate to that route. A route registered but navigated to by nobody is the same defect one
 * level up.
 */
/**
 * `require`, not `import`, and paths resolved through require.resolve. This project's tsconfig
 * carries no @types/node — it is a React Native app — so 'fs', 'path' and __dirname do not resolve
 * under tsc even though jest runs them happily. A suite that passes while tsc is red is how a red
 * build gets ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
const resolve = (require as unknown as {resolve: (m: string) => string}).resolve;

const read = (...p: string[]) => readFileSync(resolve('../../' + p.join('/')), 'utf8');

const NAV = read('navigation', 'AppNavigator');
const SETTINGS = read('screens', 'SettingsScreen');

describe('the navigator can see the screen', () => {
  it('imports CashUpScreen, so the bundler includes it', () => {
    // The whole defect in one assertion: without this import the module is unreachable and Metro
    // drops it, however complete the file is.
    expect(NAV).toMatch(/import CashUpScreen from '\.\.\/screens\/CashUpScreen'/);
  });

  it('registers a CashUp route wired to that component', () => {
    // Importing without registering would keep the code in the bundle and still leave no way in.
    expect(NAV).toMatch(/name="CashUp"/);
    expect(NAV).toMatch(/component=\{CashUpScreen\}/);
  });

  it('declares the route on the stack param list, so navigate() typechecks', () => {
    expect(NAV).toMatch(/^\s*CashUp: undefined;/m);
  });
});

describe('something actually navigates to it', () => {
  it('Settings offers the way in', () => {
    /**
     * A registered route nobody navigates to is unreachable in exactly the way the original defect
     * was — the code ships and the feature does not exist for the person holding the device.
     */
    expect(SETTINGS).toMatch(/navigation\?\.navigate\('CashUp'\)/);
  });

  it('the button carries the signed label rather than an invented one', () => {
    // So the entry point cannot drift from the copy that was signed for it.
    expect(SETTINGS).toMatch(/import \{CASH_UP_NEEDS_PRINTER, CASH_UP_PRINT\} from '\.\.\/constants\/cashUpCopy'/);
    expect(SETTINGS).toMatch(/\{CASH_UP_PRINT\}/);
  });

  it('Settings can reach a navigator at all — not just call navigate', () => {
    /**
     * NavigationContext, NOT useNavigation, and the difference is load-bearing: `useNavigation`
     * THROWS outside a navigator, and the #101 Test Print suite renders SettingsScreen bare. The
     * hook turned that suite red for a reason unrelated to what it tests. Reading the context
     * returns undefined instead, so the screen renders and the button is inert — which is honest,
     * there is nowhere for it to go.
     */
    expect(SETTINGS).toMatch(/React\.useContext\(NavigationContext\)/);
    expect(SETTINGS).toMatch(/import \{NavigationContext\} from '@react-navigation\/native'/);
    // And it must be DISABLED rather than throwing when there is no navigator — and equally when
    // there is no printer, which is the state that used to hide the button entirely.
    expect(SETTINGS).toMatch(/disabled=\{!navigation \|\| !printerConfig\}/);
  });
});

describe('the button is visible even with no printer paired', () => {
  /**
   * It used to live inside the `printerConfig ?` branch, so a terminal with no printer showed NO
   * BUTTON — a manager had to already know the cash-up was conditional on a printer. Absent and
   * disabled look the same across a room, and only one of them can be acted on.
   */
  it('is rendered outside the printerConfig branch', () => {
    const printerBranch = SETTINGS.slice(
      SETTINGS.indexOf(') : printerConfig ? ('),
      SETTINGS.indexOf('<Text style={styles.sectionTitle}>Actions</Text>'),
    );
    const button = printerBranch.indexOf('testID="settings-cash-up"');
    const branchClose = printerBranch.indexOf(') : (');
    expect(button).toBeGreaterThan(-1);
    // After the whole conditional closes, not inside its configured arm.
    expect(button).toBeGreaterThan(branchClose);
  });

  it('says what unblocks it, rather than vanishing', () => {
    expect(SETTINGS).toMatch(/settings-cash-up-needs-printer/);
    expect(SETTINGS).toMatch(/\{CASH_UP_NEEDS_PRINTER\}/);
  });
});

describe('the screen it points at is the real one', () => {
  it('CashUpScreen exists and default-exports a component', () => {
    const screen = read('screens', 'CashUpScreen');
    expect(screen).toMatch(/export default function CashUpScreen\(/);
  });

  it('and it pulls in the signed copy, so the bundle carries those strings', () => {
    // The strings whose absence from the APK exposed the defect.
    const screen = read('screens', 'CashUpScreen');
    expect(screen).toMatch(/from '\.\.\/constants\/cashUpCopy'/);
  });
});
