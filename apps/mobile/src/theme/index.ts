/** Design tokens from design/README.md and the .dc.html screens. */
export const colors = {
  bg: '#F6F4EF',
  card: '#FFFFFF',
  border: '#E4E0D6',
  divider: '#EEEAE1',
  inputBorder: '#D8D3C7',
  ink: '#1B1A17',
  body: '#3A372F',
  secondary: '#5E5A52',
  muted: '#4A463F',
  faint: '#6B665C',
  chevron: '#8A857A',
  segmentBg: '#ECE8DF',
  tagBg: '#ECE8DF',
  tagFg: '#4A463F',
  progressOff: '#DDD8CC',
  toggleOff: '#CFCABE',
  tabBarBg: '#FBFAF6',
  teal: '#1F6F6B',
  tealTint: '#E3EFEC',
  tealDark: '#174F4C',
  tealOnDark: '#CFE5E1',
  tealOnDarkBody: '#E8F3F1',
  tealTintBody: '#3A5A56',
  amber: '#9A4F0E',
  amberTint: '#F7EBDD',
  amberDark: '#7A3E0B',
  warnBg: '#FBF4EA',
  warnBorder: '#E8CFB0',
  warnButtonBorder: '#D8B894',
  warnTag: '#F2E0C8',
  warnBody: '#6B4A2A',
  green: '#2F8F5B',
  codeBg: '#1B1A17',
  codeFg: '#E8E4DA',
  white: '#FFFFFF',
  scrim: 'rgba(27,26,23,0.36)',
} as const;

export const ACCOUNT_SWATCHES = [
  { color: '#1F6F6B', label: 'Teal' },
  { color: '#3B5BA9', label: 'Blue' },
  { color: '#6B4FA0', label: 'Purple' },
  { color: '#8A5A2B', label: 'Brown' },
] as const;

/** Font family names, as registered with useFonts in the root layout. */
export const fonts = {
  serif: 'InstrumentSerif_400Regular',
  sans: 'IBMPlexSans_400Regular',
  sansMedium: 'IBMPlexSans_500Medium',
  sansSemiBold: 'IBMPlexSans_600SemiBold',
  mono: 'IBMPlexMono_500Medium',
} as const;

export const radii = {
  tag: 4,
  button: 10,
  buttonLg: 14,
  card: 14,
  cardLg: 16,
  pill: 999,
} as const;

/** Minimum touch target. */
export const HIT = 44;
