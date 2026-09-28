import { Pressable, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccessRequests, useProposals } from '@/lib/queries';
import { colors } from '@/theme';
import { Txt } from './Txt';
import { ControlIcon, InboxIcon, Shield, SunIcon, TasksIcon } from './icons';

const TABS: Record<string, { label: string; Icon: (p: { color: string }) => React.JSX.Element }> = {
  index: { label: 'Today', Icon: ({ color }) => <SunIcon color={color} /> },
  inbox: { label: 'Inbox', Icon: ({ color }) => <InboxIcon color={color} /> },
  tasks: { label: 'Tasks', Icon: ({ color }) => <TasksIcon color={color} /> },
  approvals: { label: 'Approvals', Icon: ({ color }) => <Shield color={color} size={22} /> },
  control: { label: 'Control', Icon: ({ color }) => <ControlIcon color={color} /> },
};

export function usePendingApprovalCount(): number {
  const proposals = useProposals();
  const requests = useAccessRequests();
  return (proposals.data?.proposals.length ?? 0) + (requests.data?.requests.length ?? 0);
}

/** Custom tab bar from the designs: #FBFAF6, top border, teal active, amber badge on Approvals. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const pending = usePendingApprovalCount();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingTop: 6,
        paddingHorizontal: 6,
        paddingBottom: Math.max(insets.bottom, 12) + 4,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.tabBarBg,
      }}
    >
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        const color = focused ? colors.teal : colors.faint;
        const badge = route.name === 'approvals' && pending > 0 ? pending : 0;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={badge ? `${tab.label}, ${badge} pending` : tab.label}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented)
                navigation.navigate(route.name, route.params);
            }}
            style={{
              minWidth: 64,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            <View>
              <tab.Icon color={color} />
              {badge ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -9,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    borderRadius: 8,
                    backgroundColor: colors.amber,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Txt size={10} weight={600} color={colors.white} lh={1.2}>
                    {badge > 99 ? '99+' : String(badge)}
                  </Txt>
                </View>
              ) : null}
            </View>
            <Txt size={11} weight={focused ? 600 : 500} color={color}>
              {tab.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
