import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, HIT } from '@/theme';
import { Label, Title, Txt } from './Txt';
import { Button, LinkButton } from './ui';
import { Chevron } from './icons';
import { errorMessage } from '@/lib/api';

/**
 * Scrollable page on the #F6F4EF background. `footer` stays pinned below the scroll area
 * (primary CTA on onboarding, ask bar on Today).
 */
export function Screen({
  children,
  footer,
  padTop = 12,
  padH = 20,
  gap = 14,
  scroll = true,
  onRefresh,
  refreshing = false,
  contentStyle,
  bottomInset = true,
}: {
  children: ReactNode;
  footer?: ReactNode;
  padTop?: number;
  padH?: number;
  gap?: number;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** False inside the tab navigator (the tab bar handles the home indicator). */
  bottomInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const body: StyleProp<ViewStyle> = [
    {
      paddingTop: insets.top + padTop,
      paddingHorizontal: padH,
      paddingBottom: footer ? 12 : 24 + (bottomInset ? insets.bottom : 0),
      gap,
    },
    contentStyle,
  ];
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[{ flexGrow: 1 }, body]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.teal}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, body]}>{children}</View>
      )}
      {footer ? (
        <View
          style={{
            paddingHorizontal: padH,
            paddingTop: 8,
            paddingBottom: (bottomInset ? Math.max(insets.bottom, 12) : 0) + 20,
            gap: 10,
          }}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

export function goBack(fallback: Parameters<typeof router.replace>[0]) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** Onboarding header: back arrow, "STEP N OF 7", optional Skip, and the 7-segment progress bar. */
export function StepHeader({
  step,
  suffix,
  onBack,
  onSkip,
}: {
  step: number;
  suffix?: string;
  onBack?: () => void;
  onSkip?: () => void;
}) {
  return (
    <View style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: HIT,
        }}
      >
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={{ width: HIT, height: HIT, justifyContent: 'center' }}
          >
            <Chevron dir="left" size={22} color={colors.ink} />
          </Pressable>
        ) : (
          <View style={{ width: HIT }} />
        )}
        <Label>{`STEP ${step} OF 7${suffix ? ` · ${suffix}` : ''}`}</Label>
        {onSkip ? (
          <LinkButton label="Skip" onPress={onSkip} align="flex-end" />
        ) : (
          <View style={{ width: HIT }} />
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }} accessibilityLabel={`Step ${step} of 7`}>
        {Array.from({ length: 7 }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: i < step ? colors.teal : colors.progressOff,
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Onboarding title + subtitle block. */
export function StepTitle({
  title,
  subtitle,
  size = 34,
}: {
  title: string;
  subtitle?: string;
  size?: number;
}) {
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <Title size={size}>{title}</Title>
      {subtitle ? (
        <Txt size={14} lh={1.45} color={colors.secondary}>
          {subtitle}
        </Txt>
      ) : null}
    </View>
  );
}

/** "‹ Control" back link used by stack screens. */
export function BackLink({
  label = 'Control',
  fallback = '/control' as const,
}: {
  label?: string;
  fallback?: '/control' | '/' | '/inbox';
}) {
  return (
    <Pressable
      onPress={() => goBack(fallback)}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minHeight: HIT,
        paddingRight: 8,
      }}
    >
      <Chevron dir="left" size={18} color={colors.teal} />
      <Txt size={15} weight={500} color={colors.teal}>
        {label}
      </Txt>
    </Pressable>
  );
}

// ---- States ----

export function LoadingState({
  label = 'Loading…',
  compact,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: compact ? 20 : 48,
        gap: 10,
        flexGrow: compact ? 0 : 1,
      }}
    >
      <ActivityIndicator color={colors.teal} />
      <Txt size={13} color={colors.secondary}>
        {label}
      </Txt>
    </View>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = "Couldn't load this",
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <View
      style={{
        padding: 16,
        borderRadius: 14,
        backgroundColor: colors.warnBg,
        borderWidth: 1,
        borderColor: colors.warnBorder,
        gap: 8,
      }}
      accessibilityRole="alert"
    >
      <Txt size={15} weight={600} color={colors.amberDark}>
        {title}
      </Txt>
      <Txt size={13} lh={1.45} color={colors.warnBody}>
        {errorMessage(error)}
      </Txt>
      {onRetry ? (
        <Button
          label="Try again"
          variant="warnOutline"
          onPress={onRetry}
          style={{ alignSelf: 'flex-start' }}
          size="md"
        />
      ) : null}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View
      style={{
        padding: 18,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.inputBorder,
        gap: 6,
        alignItems: 'flex-start',
      }}
    >
      <Txt size={15} weight={600}>
        {title}
      </Txt>
      {body ? (
        <Txt size={13} lh={1.45} color={colors.secondary}>
          {body}
        </Txt>
      ) : null}
      {action}
    </View>
  );
}

/** Inline, dismissable notice (e.g. "coming soon", push setup messages). */
export function Notice({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'teal' }) {
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: tone === 'warn' ? colors.warnBg : colors.tealTint,
        borderWidth: tone === 'warn' ? 1 : 0,
        borderColor: colors.warnBorder,
      }}
      accessibilityLiveRegion="polite"
    >
      <Txt size={13} lh={1.45} color={tone === 'warn' ? colors.warnBody : colors.tealDark}>
        {text}
      </Txt>
    </View>
  );
}

// ---- Bottom sheet ----

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: colors.scrim }}
          onPress={onClose}
          accessibilityLabel="Close"
          accessibilityRole="button"
        />
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingHorizontal: 20,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            maxHeight: '88%',
          }}
          accessibilityViewIsModal
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.progressOff,
              marginBottom: 8,
            }}
          />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: HIT,
            }}
          >
            <Title size={26}>{title ?? ''}</Title>
            <LinkButton label="Close" onPress={onClose} align="flex-end" />
          </View>
          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 12, paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={{ gap: 8, paddingTop: 4 }}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
