module.exports = {
  root: true,
  extends: '@react-native',
  /**
   * WHY TWO RULES ARE RELAXED, recorded here rather than only in a commit message, because this is
   * where someone about to turn them back on will actually be looking.
   *
   * Both were warning on EVERY occurrence in this codebase, and in every case the code was right
   * and the rule's assumption was not. Nine of the ten warnings the repo carried were these two.
   * A permanently-noisy signal is one nobody reads — the same argument that got #339/#340 fixed so
   * that `Test Suites: N failed` means something again. `npx eslint .` is now clean, so a NEW
   * warning is information.
   *
   * If you are here because you want the strict form back: the fix is not to flip these off. It is
   * to change the code they are pointing at, and the notes below say what that would cost.
   */
  rules: {
    /**
     * `void somePromise` IS THE DELIBERATE "not awaited, on purpose" IDIOM HERE, not an accident.
     *
     * All five sites are fire-and-forget calls that must NOT block the caller, and one carries its
     * own comment saying why: SettingsScreen's `void getBuiltInPrinterStatus().then(setBuiltInStatus)`
     * is annotated "Never block the spinner on status — getStatus can hang on a stuck SDK call."
     *
     * The two ways to "fix" the warning are both worse. Deleting `void` leaves a floating promise —
     * the very thing the marker exists to declare intentional. Awaiting it changes behaviour, and on
     * that printer call it reintroduces a hang the comment says was already hit.
     *
     * `allowAsStatement` permits exactly this shape and nothing else: `void` as a whole statement.
     * `void` used as an expression is still reported.
     */
    'no-void': ['warn', {allowAsStatement: true}],

    /**
     * ALL FOUR SITES ARE RENDER PROPS, NOT NESTED COMPONENTS — three `tabBarIcon` in AppNavigator
     * and one `ItemSeparatorComponent` in POSCartScreen.
     *
     * The harm this rule exists to prevent is real but does not apply to them: React sees a new
     * component type each render and destroys the subtree's state. A `MaterialCommunityIcons` tab
     * icon and a separator `<View style={styles.separator} />` HAVE no state and no DOM identity
     * worth preserving, so there is nothing to destroy.
     *
     * Extracting four of them to module scope would add indirection to the navigator's option
     * blocks — where the icon sits next to the label it belongs with — and buy nothing measurable.
     * The rule's own message names `allowAsProps` for precisely this case.
     *
     * NOTE THE LIMIT: this permits a component defined in a PROP. A component defined in the body
     * of another component is still reported, which is the case that actually costs state.
     */
    'react/no-unstable-nested-components': ['warn', {allowAsProps: true}],
  },
};
