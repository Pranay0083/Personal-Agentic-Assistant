/**
 * Line icons drawn with Views (react-native-svg isn't installed). They approximate the
 * 24px stroke icons in the designs closely enough at 16–22px.
 */
import { View, type ViewStyle } from 'react-native';
import { colors } from '@/theme';

type P = { size?: number; color?: string; stroke?: number };

function Box({
  size,
  children,
  style,
}: {
  size: number;
  children?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

/** Chevron pointing left/right/up/down. */
export function Chevron({
  dir = 'right',
  size = 18,
  color = colors.chevron,
  stroke = 2,
}: P & { dir?: 'left' | 'right' | 'up' | 'down' }) {
  const s = size * 0.42;
  const rot = { right: '-45deg', down: '45deg', left: '135deg', up: '-135deg' }[dir];
  const shift = size * 0.1;
  const offset = {
    right: { left: -shift },
    left: { left: shift },
    down: { top: -shift },
    up: { top: shift },
  }[dir];
  return (
    <Box size={size}>
      <View
        style={{
          width: s,
          height: s,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          transform: [{ rotate: rot }],
          ...offset,
        }}
      />
    </Box>
  );
}

export function Check({ size = 16, color = colors.green, stroke = 2.2 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.34,
          height: size * 0.62,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
          marginTop: -size * 0.12,
        }}
      />
    </Box>
  );
}

export function Lock({ size = 18, color = colors.teal, stroke = 1.8 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.44,
          height: size * 0.34,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderTopLeftRadius: size * 0.22,
          borderTopRightRadius: size * 0.22,
          borderColor: color,
          marginBottom: -1,
        }}
      />
      <View
        style={{
          width: size * 0.62,
          height: size * 0.4,
          borderWidth: stroke,
          borderRadius: 3,
          borderColor: color,
        }}
      />
    </Box>
  );
}

export function Shield({
  size = 22,
  color = colors.teal,
  stroke = 1.8,
  check = true,
}: P & { check?: boolean }) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.62,
          height: size * 0.76,
          borderWidth: stroke,
          borderColor: color,
          borderTopLeftRadius: size * 0.08,
          borderTopRightRadius: size * 0.08,
          borderBottomLeftRadius: size * 0.34,
          borderBottomRightRadius: size * 0.34,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {check ? <Check size={size * 0.5} color={color} stroke={stroke} /> : null}
      </View>
    </Box>
  );
}

export function Trash({ size = 18, color = colors.teal, stroke = 1.8 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.26,
          height: size * 0.12,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderColor: color,
        }}
      />
      <View style={{ width: size * 0.72, height: stroke, backgroundColor: color }} />
      <View
        style={{
          width: size * 0.5,
          height: size * 0.5,
          borderWidth: stroke,
          borderTopWidth: 0,
          borderBottomLeftRadius: 2,
          borderBottomRightRadius: 2,
          borderColor: color,
        }}
      />
    </Box>
  );
}

export function Search({ size = 20, color = colors.ink, stroke = 1.8 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.52,
          height: size * 0.52,
          borderRadius: size,
          borderWidth: stroke,
          borderColor: color,
          marginLeft: -size * 0.12,
          marginTop: -size * 0.12,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: size * 0.28,
          height: stroke,
          backgroundColor: color,
          right: size * 0.1,
          bottom: size * 0.22,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </Box>
  );
}

export function ArrowUp({ size = 20, color = colors.white, stroke = 2 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          position: 'absolute',
          width: stroke,
          height: size * 0.66,
          backgroundColor: color,
          top: size * 0.2,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: size * 0.22,
          width: size * 0.42,
          height: size * 0.42,
          borderLeftWidth: stroke,
          borderTopWidth: stroke,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </Box>
  );
}

// ---- Tab icons ----

export function SunIcon({ size = 22, color = colors.faint, stroke = 1.8 }: P) {
  const ray = (rot: string) => (
    <View
      key={rot}
      style={{
        position: 'absolute',
        width: stroke,
        height: size,
        alignItems: 'center',
        transform: [{ rotate: rot }],
      }}
    >
      <View
        style={{
          width: stroke,
          height: size * 0.12,
          backgroundColor: color,
          marginTop: size * 0.08,
        }}
      />
      <View style={{ flex: 1 }} />
      <View
        style={{
          width: stroke,
          height: size * 0.12,
          backgroundColor: color,
          marginBottom: size * 0.08,
        }}
      />
    </View>
  );
  return (
    <Box size={size}>
      {['0deg', '45deg', '90deg', '135deg'].map(ray)}
      <View
        style={{
          width: size * 0.36,
          height: size * 0.36,
          borderRadius: size,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
    </Box>
  );
}

export function InboxIcon({ size = 22, color = colors.faint, stroke = 1.8 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.7,
          height: size * 0.56,
          borderWidth: stroke,
          borderColor: color,
          borderRadius: 3,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: size * 0.22,
            height: stroke,
            backgroundColor: color,
          }}
        />
        <View
          style={{
            position: 'absolute',
            top: size * 0.22,
            width: size * 0.26,
            height: size * 0.1,
            backgroundColor: 'transparent',
            borderBottomWidth: stroke,
            borderLeftWidth: stroke,
            borderRightWidth: stroke,
            borderColor: color,
          }}
        />
      </View>
    </Box>
  );
}

export function TasksIcon({ size = 22, color = colors.faint, stroke = 1.8 }: P) {
  return (
    <Box size={size}>
      <View
        style={{
          width: size * 0.68,
          height: size * 0.68,
          borderWidth: stroke,
          borderColor: color,
          borderRadius: size * 0.14,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Check size={size * 0.5} color={color} stroke={stroke} />
      </View>
    </Box>
  );
}

export function ControlIcon({
  size = 22,
  color = colors.faint,
  stroke = 1.8,
  bg = colors.tabBarBg,
}: P & { bg?: string }) {
  const line = (knobLeft: number, key: string) => (
    <View key={key} style={{ width: size * 0.72, height: size * 0.22, justifyContent: 'center' }}>
      <View style={{ height: stroke, backgroundColor: color }} />
      <View
        style={{
          position: 'absolute',
          left: knobLeft * size,
          width: size * 0.2,
          height: size * 0.2,
          borderRadius: size,
          borderWidth: stroke,
          borderColor: color,
          backgroundColor: bg,
        }}
      />
    </View>
  );
  return <Box size={size}>{[line(0.14, 'a'), line(0.4, 'b'), line(0.1, 'c')]}</Box>;
}
