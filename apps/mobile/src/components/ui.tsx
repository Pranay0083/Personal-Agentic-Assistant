import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, fonts, HIT, radii } from '@/theme';
import { Txt } from './Txt';
import { Check, Chevron } from './icons';

// ---- Buttons ----

type BtnVariant =
  'dark' | 'teal' | 'outline' | 'ghost' | 'link' | 'warnOutline' | 'darkOutline' | 'tealOutline';

const BTN: Record<BtnVariant, { bg: string; fg: string; border?: string }> = {
  dark: { bg: colors.ink, fg: colors.white },
  teal: { bg: colors.teal, fg: colors.white },
  outline: { bg: colors.white, fg: colors.ink, border: colors.inputBorder },
  ghost: { bg: 'transparent', fg: colors.secondary },
  link: { bg: 'transparent', fg: colors.teal },
  warnOutline: { bg: colors.white, fg: colors.amberDark, border: colors.warnButtonBorder },
  darkOutline: { bg: 'transparent', fg: colors.white, border: colors.secondary },
  tealOutline: { bg: 'transparent', fg: colors.tealDark, border: colors.teal },
};

export function Button({
  label,
  onPress,
  variant = 'dark',
  size = 'md',
  disabled,
  loading,
  grow,
  radius,
  style,
  weight = 600,
  textSize,
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  variant?: BtnVariant;
  /** lg = 52px primary CTA, md = 44px, sm = 40px (inside a 44px row). */
  size?: 'lg' | 'md' | 'sm';
  disabled?: boolean;
  loading?: boolean;
  grow?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  weight?: 400 | 500 | 600;
  textSize?: number;
  accessibilityLabel?: string;
}) {
  const v = BTN[variant];
  const h = size === 'lg' ? 52 : size === 'sm' ? 40 : HIT;
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      hitSlop={size === 'sm' ? 2 : 0}
      style={({ pressed }) => [
        {
          minHeight: h,
          paddingHorizontal: size === 'lg' ? 20 : 16,
          borderRadius: radius ?? (size === 'lg' ? radii.buttonLg : 12),
          backgroundColor: v.bg,
          borderWidth: v.border ? 1 : 0,
          borderColor: v.border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
          flexGrow: grow ? 1 : 0,
          flexShrink: grow ? 1 : 0,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={v.fg} /> : null}
      <Txt
        size={textSize ?? (size === 'lg' ? 16 : size === 'sm' ? 13 : 14)}
        weight={weight}
        color={v.fg}
        numberOfLines={1}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

/** Plain text link-style button (teal), e.g. "Skip", "+ Add another", "See all". */
export function LinkButton({
  label,
  onPress,
  color = colors.teal,
  size = 14,
  weight = 500,
  align = 'center',
  minHeight = HIT,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  color?: string;
  size?: number;
  weight?: 400 | 500 | 600;
  align?: 'flex-start' | 'center' | 'flex-end';
  minHeight?: number;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={minHeight < HIT ? (HIT - minHeight) / 2 : 0}
      style={({ pressed }) => ({
        minHeight,
        minWidth: HIT,
        justifyContent: 'center',
        alignItems: align,
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <Txt size={size} weight={weight} color={color}>
        {label}
      </Txt>
    </Pressable>
  );
}

// ---- Surfaces ----

export function Card({
  children,
  style,
  tone = 'default',
  radius = radii.card,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: 'default' | 'warn' | 'tint';
  radius?: number;
}) {
  const bg = tone === 'warn' ? colors.warnBg : tone === 'tint' ? colors.tealTint : colors.card;
  const border =
    tone === 'warn' ? colors.warnBorder : tone === 'tint' ? 'transparent' : colors.border;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: border,
          borderRadius: radius,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A list row inside a Card, with a top divider for every row after the first. */
export function Row({
  first,
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  first?: boolean;
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const base: ViewStyle = { borderTopWidth: first ? 0 : 1, borderTopColor: colors.divider };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [base, style, pressed && { backgroundColor: '#FAF8F3' }]}
    >
      {children}
    </Pressable>
  );
}

/** Settings-hub style row: title, subtitle, chevron. */
export function NavRow({
  title,
  subtitle,
  first,
  onPress,
}: {
  title: string;
  subtitle?: ReactNode;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <Row
      first={first}
      onPress={onPress}
      accessibilityLabel={title}
      style={{
        minHeight: 56,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
        <Txt size={15} weight={500}>
          {title}
        </Txt>
        {typeof subtitle === 'string' ? (
          <Txt size={12} color={colors.secondary}>
            {subtitle}
          </Txt>
        ) : (
          subtitle
        )}
      </View>
      <Chevron dir="right" />
    </Row>
  );
}

export function SectionTitle({
  children,
  color = colors.secondary,
  size = 12,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
}) {
  return (
    <Txt size={size} weight={600} color={color} accessibilityRole="header">
      {children}
    </Txt>
  );
}

// ---- Small bits ----

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

/** Mono source tag, e.g. "GMAIL · WORK". */
export function SourceTag({
  label,
  tone = 'default',
}: {
  label: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: 6,
        borderRadius: radii.tag,
        backgroundColor: tone === 'warn' ? colors.warnTag : colors.tagBg,
        alignSelf: 'flex-start',
      }}
    >
      <Txt
        mono
        size={10}
        em={0.06}
        color={tone === 'warn' ? colors.amberDark : colors.tagFg}
        lh={1.2}
      >
        {label}
      </Txt>
    </View>
  );
}

export type PillTone = 'teal' | 'amber' | 'grey' | 'solid';
const PILL: Record<PillTone, { bg: string; fg: string }> = {
  teal: { bg: colors.tealTint, fg: colors.tealDark },
  amber: { bg: colors.amberTint, fg: colors.amberDark },
  grey: { bg: colors.segmentBg, fg: colors.tagFg },
  solid: { bg: colors.teal, fg: colors.white },
};

/** Status chip / pill (full radius). */
export function Pill({
  label,
  tone = 'teal',
  size = 11,
  padH = 8,
  padV = 3,
}: {
  label: string;
  tone?: PillTone;
  size?: number;
  padH?: number;
  padV?: number;
}) {
  const p = PILL[tone];
  return (
    <View
      style={{
        paddingHorizontal: padH,
        paddingVertical: padV,
        borderRadius: radii.pill,
        backgroundColor: p.bg,
        alignSelf: 'flex-start',
      }}
    >
      <Txt size={size} weight={600} color={p.fg}>
        {label}
      </Txt>
    </View>
  );
}

/** 52×32 switch from the designs. */
export function Toggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      hitSlop={6}
      style={{
        width: 52,
        height: 32,
        borderRadius: 16,
        backgroundColor: value ? colors.teal : colors.toggleOff,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: 3,
          left: value ? 23 : 3,
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: colors.white,
        }}
      />
    </Pressable>
  );
}

/** Card with a title, subtitle and a Toggle on the right. */
export function ToggleCard({
  title,
  subtitle,
  value,
  onChange,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Card
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Txt size={15} weight={500}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt size={12} color={colors.secondary}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      <Toggle value={value} onChange={onChange} label={title} disabled={disabled} />
    </Card>
  );
}

export function Checkbox({ checked, size = 22 }: { checked: boolean; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 5,
        borderWidth: checked ? 0 : 1.5,
        borderColor: '#8F8A7F',
        backgroundColor: checked ? colors.teal : colors.white,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {checked ? <Check size={size * 0.8} color={colors.white} stroke={2.2} /> : null}
    </View>
  );
}

/** Segmented control on the #ECE8DF track. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  height = 40,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  height?: number;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 4,
        padding: 4,
        borderRadius: 12,
        backgroundColor: colors.segmentBg,
      }}
      accessibilityRole="tablist"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            hitSlop={{ top: 2, bottom: 2 }}
            style={{
              flex: 1,
              minHeight: height,
              borderRadius: 9,
              backgroundColor: on ? colors.white : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 4,
            }}
          >
            <Txt
              size={13}
              weight={on ? 600 : 500}
              color={on ? colors.ink : colors.muted}
              numberOfLines={1}
            >
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Round filter chip (Inbox filters, Permissions principals). */
export function Chip({
  label,
  on,
  onPress,
  minHeight = 36,
  weight,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  minHeight?: number;
  weight?: 400 | 500 | 600;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      hitSlop={minHeight < HIT ? { top: (HIT - minHeight) / 2, bottom: (HIT - minHeight) / 2 } : 0}
      style={{
        minHeight,
        paddingHorizontal: 14,
        borderRadius: minHeight / 2,
        borderWidth: 1,
        borderColor: on ? colors.ink : colors.inputBorder,
        backgroundColor: on ? colors.ink : colors.white,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Txt
        size={13}
        weight={weight ?? (on ? 500 : 400)}
        color={on ? colors.white : colors.ink}
        numberOfLines={1}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

/** Selectable card-style option (Role, Presets, provider chips). */
export function OptionCard({
  selected,
  onPress,
  children,
  style,
  accessibilityLabel,
}: {
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          borderWidth: 2,
          borderColor: selected ? colors.teal : colors.border,
          backgroundColor: selected ? colors.tealTint : colors.white,
          borderRadius: radii.cardLg,
          opacity: pressed ? 0.9 : 1,
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function Field({
  label,
  inputBg = colors.white,
  ...props
}: TextInputProps & { label: string; inputBg?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt size={12} weight={600} color={colors.secondary}>
        {label}
      </Txt>
      <Input
        {...props}
        accessibilityLabel={label}
        style={[{ backgroundColor: inputBg }, props.style]}
      />
    </View>
  );
}

/** Replace the browser's default focus ring with a teal one on web. */
const WEB_FOCUS = Platform.OS === 'web' ? ({ outlineColor: colors.teal } as object) : {};

export function Input(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor="#9A958A"
      autoCorrect={false}
      {...props}
      style={[
        {
          minHeight: HIT,
          paddingHorizontal: 12,
          borderRadius: radii.button,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          backgroundColor: colors.white,
          fontFamily: fonts.sans,
          fontSize: 15,
          color: colors.ink,
        },
        WEB_FOCUS,
        props.style,
      ]}
    />
  );
}

export function Spacer() {
  return <View style={{ flexGrow: 1 }} />;
}

export function Pressy(props: PressableProps & { style?: StyleProp<ViewStyle> }) {
  const { style, ...rest } = props;
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [style, pressed && { opacity: 0.7 }]}
    />
  );
}
