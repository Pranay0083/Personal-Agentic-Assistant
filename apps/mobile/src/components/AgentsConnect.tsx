import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useMcp } from '@/lib/queries';
import { colors } from '@/theme';
import { Txt } from './Txt';
import { Button, Card } from './ui';
import { ErrorState, LoadingState, Sheet } from './layout';
import { Chevron } from './icons';

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  return {
    copied,
    copy: async (key: string, text: string) => {
      await Clipboard.setStringAsync(text);
      setCopied(key);
    },
  };
}

/** MCP link for Claude, `claude mcp add` for Claude Code, and "another tool". From GET /mcp. */
export function AgentsConnect() {
  const mcp = useMcp();
  const { copied, copy } = useCopied();
  const [other, setOther] = useState(false);

  if (mcp.isPending) return <LoadingState compact label="Getting your MCP link…" />;
  if (mcp.isError) return <ErrorState error={mcp.error} onRetry={() => void mcp.refetch()} />;
  const { url, command } = mcp.data;

  return (
    <View style={{ gap: 14 }}>
      <Card radius={16} style={{ padding: 16, gap: 10 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Txt size={16} weight={600}>
            Claude
          </Txt>
          <Txt size={12} color={colors.secondary}>
            Web, desktop, mobile
          </Txt>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 12,
            paddingRight: 4,
            borderRadius: 10,
            backgroundColor: colors.bg,
            minHeight: 44,
          }}
        >
          <Txt mono size={12} color={colors.body} style={{ flex: 1 }} numberOfLines={1} selectable>
            {url}
          </Txt>
          <Button
            label={copied === 'url' ? 'Copied' : 'Copy'}
            size="sm"
            radius={8}
            textSize={13}
            onPress={() => void copy('url', url)}
          />
        </View>
        <Txt size={12} color={colors.secondary}>
          {"Add it as a custom connector in Claude's settings."}
        </Txt>
      </Card>

      <Card radius={16} style={{ padding: 16, gap: 10 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Txt size={16} weight={600}>
            Claude Code
          </Txt>
          <Txt size={12} color={colors.secondary}>
            Terminal on your Mac
          </Txt>
        </View>
        <View style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: colors.codeBg }}>
          <Txt mono size={12} lh={1.5} color={colors.codeFg} selectable>
            {command}
          </Txt>
          <Button
            label={copied === 'cmd' ? 'Copied' : 'Copy command'}
            variant="darkOutline"
            size="sm"
            radius={8}
            textSize={13}
            style={{ alignSelf: 'flex-end' }}
            onPress={() => void copy('cmd', command)}
          />
        </View>
        <Txt size={12} color={colors.secondary}>
          Starts with Jira, GitHub and notes. No personal email.
        </Txt>
      </Card>

      <Pressable
        onPress={() => setOther(true)}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 56,
          paddingHorizontal: 16,
          backgroundColor: pressed ? '#FAF8F3' : colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 16,
        })}
      >
        <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
          <Txt size={15} weight={600}>
            Cursor or another tool
          </Txt>
          <Txt size={12} color={colors.secondary}>
            Copy the link to paste on your laptop
          </Txt>
        </View>
        <Chevron />
      </Pressable>

      <Sheet visible={other} onClose={() => setOther(false)} title="Another tool">
        <Txt size={14} lh={1.45} color={colors.body}>
          Any MCP client that supports remote servers over Streamable HTTP can connect with this
          link. It will ask you to approve it here, and gets the access you set in Permissions.
        </Txt>
        <View
          style={{
            padding: 12,
            borderRadius: 10,
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Txt mono size={12} color={colors.body} selectable>
            {url}
          </Txt>
        </View>
        <Button
          label={copied === 'url' ? 'Copied' : 'Copy link'}
          onPress={() => void copy('url', url)}
        />
      </Sheet>
    </View>
  );
}
