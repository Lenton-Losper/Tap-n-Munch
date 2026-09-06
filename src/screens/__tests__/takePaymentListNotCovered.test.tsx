/**
 * THE ITEM LIST MUST NOT SIT UNDER THE SETTLE PANEL.
 *
 * ================================================================================================
 * THE DEFECT — REPORTED FROM A P5, 2026-09-06
 * ================================================================================================
 *
 * "The settle panel now covers the list. Total, Add gratuity, Settle Selected, Settle Entire Tab,
 * Take Cash — five elements stacked at the bottom of a P5, and the item list is cut off behind them
 * with no way to scroll. A waiter can't see what they're ticking."
 *
 * Both bars are `position: 'absolute'` and overlay the list, so the list compensated with a
 * HARDCODED `paddingBottom: 120`. That was right when the bar held two buttons. It is not a
 * property of the bar, it is a guess about the bar, and the guess went stale the moment the
 * gratuity section and a second settle button were added.
 *
 * ================================================================================================
 * WHY THIS ASSERTS THE MECHANISM AND NOT A NUMBER
 * ================================================================================================
 *
 * Pinning "paddingBottom is 260" would be the same defect with a bigger constant: correct until
 * somebody adds a control, and silent when it breaks. What has to be true is that the padding is
 * DERIVED FROM THE MEASURED BAR, so it cannot drift from it.
 *
 * A device screenshot would prove it once. This proves it for whatever the bar becomes.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

const SRC = (require as unknown as {resolve: (m: string) => string}).resolve(
  '../TableDetailScreen',
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
const SOURCE = readFileSync(SRC, 'utf8');

describe('the padding is measured, not guessed', () => {
  it('no hardcoded bottom padding survives in the list style', () => {
    /**
     * The exact line that caused it. A constant here cannot know what the bar holds, and the bar
     * is the thing that covers the list.
     */
    const listStyle = SOURCE.slice(SOURCE.indexOf('  list: {'), SOURCE.indexOf('  emptyList: {'));
    expect(listStyle).not.toMatch(/paddingBottom:\s*\d+/);
  });

  it('the bar reports its own height', () => {
    // Both bars: the selection bar (five elements) and the plain one. Either can be on screen.
    const onLayouts = SOURCE.match(/onLayout=\{e => setBottomBarHeight\(e\.nativeEvent\.layout\.height\)\}/g);
    expect(onLayouts).not.toBeNull();
    expect(onLayouts!.length).toBe(2);
  });

  it('both lists pad by that measurement', () => {
    const uses = SOURCE.match(/paddingBottom: bottomBarHeight \+ Spacing\.md/g);
    expect(uses).not.toBeNull();
    expect(uses!.length).toBe(2);
  });

  it('the bars are still absolutely positioned, which is WHY the padding is needed', () => {
    /**
     * If somebody makes the bar part of the flow instead, this whole mechanism becomes unnecessary
     * and this suite should be deleted rather than worked around. Asserted so that change is a
     * deliberate one.
     */
    const selectionBar = SOURCE.slice(
      SOURCE.indexOf('  selectionBar: {'),
      SOURCE.indexOf('  selectionText: {'),
    );
    expect(selectionBar).toMatch(/position: 'absolute'/);
  });
});

describe('what the panel actually costs on a P5', () => {
  /**
   * A P5 is 720x1280 at ~2x, so about 360x640dp — not a modern phone viewport. The five stacked
   * elements are a running total, the gratuity section (collapsed by default), Settle Selected,
   * Settle Entire Tab and Take Cash.
   *
   * This does not assert a pixel budget, which would be brittle across densities. It asserts the
   * thing that makes the budget survivable: THE GRATUITY SECTION IS COLLAPSED BY DEFAULT, so the
   * bar's resting height is one row per control rather than an expanded form. If that default ever
   * flips, the bar grows by the height of an amount field and a staff picker on the smallest
   * screen in the estate.
   */
  it('the gratuity section starts collapsed, keeping the resting bar short', () => {
    const gratuity = readFileSync(
      (require as unknown as {resolve: (m: string) => string}).resolve(
        '../../components/GratuitySection',
      ),
      'utf8',
    );
    expect(gratuity).toMatch(/useState\(false\)/);
  });
});
