import { Text, type TextProps, type TextStyle } from 'react-native';
import { colors, fonts } from '@/theme';

type Props = TextProps & {
  size?: number;
  /** 400 | 500 | 600 for IBM Plex Sans. Ignored for serif/mono. */
  weight?: 400 | 500 | 600;
  color?: string;
  serif?: boolean;
  mono?: boolean;
  /** Line height as a multiple of size, like CSS unitless line-height. */
  lh?: number;
  /** Letter spacing in em, like the designs. */
  em?: number;
  align?: TextStyle['textAlign'];
};

export function Txt({
  size = 15,
  weight = 400,
  color = colors.ink,
  serif,
  mono,
  lh,
  em,
  align,
  style,
  ...rest
}: Props) {
  const fontFamily = serif
    ? fonts.serif
    : mono
      ? fonts.mono
      : weight === 600
        ? fonts.sansSemiBold
        : weight === 500
          ? fonts.sansMedium
          : fonts.sans;
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily,
          fontSize: size,
          color,
          lineHeight: lh ? Math.round(size * lh) : undefined,
          letterSpacing: em ? size * em : undefined,
          textAlign: align,
        },
        style,
      ]}
    />
  );
}

/** Instrument Serif screen title. */
export function Title({ size = 40, lh = 1.05, children, ...rest }: Props) {
  return (
    <Txt serif size={size} lh={lh} accessibilityRole="header" {...rest}>
      {children}
    </Txt>
  );
}

/** Mono uppercase label, e.g. "STEP 1 OF 7", "DAILY BRIEF · 7:30". */
export function Label({ size = 11, em = 0.08, color = colors.secondary, ...rest }: Props) {
  return <Txt mono size={size} em={em} color={color} {...rest} />;
}
