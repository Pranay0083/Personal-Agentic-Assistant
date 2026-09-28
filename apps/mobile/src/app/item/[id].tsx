import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useItem } from '@/lib/queries';
import { useAccountMap } from '@/lib/hooks';
import { itemTag, serviceName } from '@/lib/format';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Dot, Pill, SourceTag } from '@/components/ui';
import { BackLink, ErrorState, LoadingState, Screen } from '@/components/layout';

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useItem(id);
  const accounts = useAccountMap();

  if (q.isPending) {
    return (
      <Screen>
        <BackLink label="Back" fallback="/inbox" />
        <LoadingState />
      </Screen>
    );
  }
  if (q.isError) {
    return (
      <Screen>
        <BackLink label="Back" fallback="/inbox" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </Screen>
    );
  }

  const { item, body } = q.data;
  const account = accounts.get(item.accountId);
  const when = new Date(item.receivedAt);
  const url = item.url && /^https:\/\//i.test(item.url) ? item.url : null;

  return (
    <Screen gap={14}>
      <BackLink label="Back" fallback="/inbox" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {account ? <Dot color={account.color} size={9} /> : null}
        <SourceTag label={itemTag(item, account)} />
        <Txt size={12} color={colors.secondary}>
          {when.toLocaleString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </Txt>
      </View>
      <Title size={32} lh={1.1}>
        {item.title ?? '(no subject)'}
      </Title>
      {item.author ? (
        <Txt size={14} weight={500} color={colors.body}>
          {`From ${item.author}`}
        </Txt>
      ) : null}
      {item.statusLabel ? (
        <Pill label={item.statusLabel} tone={item.bucket === 'needs_you' ? 'amber' : 'teal'} />
      ) : null}
      {item.summary ? (
        <Card tone="tint" style={{ padding: 14, gap: 4 }}>
          <Txt size={12} weight={600} color={colors.tealDark}>
            Summary
          </Txt>
          <Txt size={14} lh={1.45} color={colors.tealDark}>
            {item.summary}
          </Txt>
        </Card>
      ) : null}
      <Card style={{ padding: 14 }}>
        {body ? (
          <Txt size={15} lh={1.5} color={colors.ink} selectable>
            {body}
          </Txt>
        ) : (
          <Txt size={14} color={colors.secondary}>
            The full text isn't stored on your hub for this item.
          </Txt>
        )}
      </Card>
      {url ? (
        <Button
          label={`Open in ${account ? serviceName(account.provider) : 'browser'}`}
          variant="outline"
          onPress={() => void WebBrowser.openBrowserAsync(url)}
        />
      ) : null}
    </Screen>
  );
}
