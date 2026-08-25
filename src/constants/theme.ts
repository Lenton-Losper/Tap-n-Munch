export const Colors = {
  primary: '#18181B',
  background: '#FFFFFF',
  surface: '#F9FAFB',
  border: '#E5E7EB',

  orange: '#F97316',
  orangeLight: '#FFF7ED',
  blue: '#3B82F6',
  blueLight: '#EFF6FF',
  green: '#22C55E',
  greenLight: '#F0FDF4',
  red: '#EF4444',
  redLight: '#FEF2F2',
  /**
   * #327. The colour of "we cannot say" — used only by the UNCONFIRMED payment state. Deliberately
   * neither green nor red: an operator reading the colour alone must not be able to sort an
   * unconfirmed payment into "done" or "declined", because those are the two answers it is
   * specifically not. Darker than `orange` so the two do not read as the same status on a bright
   * counter-top screen.
   */
  amber: '#D97706',
  amberLight: '#FFFBEB',

  textPrimary: '#111827',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  white: '#FFFFFF',
};

export const Typography = {
  tableNumber: {fontSize: 64, fontWeight: '800' as const},
  heading: {fontSize: 24, fontWeight: '700' as const},
  subheading: {fontSize: 18, fontWeight: '600' as const},
  body: {fontSize: 16, fontWeight: '400' as const},
  small: {fontSize: 14, fontWeight: '400' as const},
  tiny: {fontSize: 12, fontWeight: '400' as const},
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};
