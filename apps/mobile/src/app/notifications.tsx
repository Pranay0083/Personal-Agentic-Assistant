import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useMeRequired } from '@/lib/auth';
import { useUpdateMe } from '@/lib/queries';
import { enablePush } from '@/lib/push';
import { errorMessage, type UpdateMe } from '@/lib/api';
import { colors, HIT } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Input, Row, SectionTitle, ToggleCard } from '@/components/ui';
import { BackLink, Notice, Screen } from '@/components/layout';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Accept "7:30" or "0730" and normalise to "07:30". */
function normaliseTime(v: string): string {
  const t = v.trim();
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : t;
}

export default function NotificationsScreen() {
  const me = useMeRequired();
  const update = useUpdateMe();
  const s = me.settings;
  const [start, setStart] = useState(s.quietHours.start);
  const [end, setEnd] = useState(s.quietHours.end);
  const [brief, setBrief] = useState(s.briefTime);
  const [vip, setVip] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the keys that changed are sent; the API merges them into the stored settings.
  const save = (settings: UpdateMe['settings']) => {
    setNote(null);
    update.mutate({ settings }, { onError: (e) => setNote(errorMessage(e)) });
  };

  const toggle = async (on: boolean) => {
    if (!on) return save({ notificationsEnabled: false });
    setBusy(true);
    const res = await enablePush();
    setBusy(false);
    if (res.ok) save({ notificationsEnabled: true });
    else setNote(res.message);
  };

  const qs = normaliseTime(start);
  const qe = normaliseTime(end);
  const bt = normaliseTime(brief);
  const hoursValid = HHMM.test(qs) && HHMM.test(qe);
  const hoursDirty = qs !== s.quietHours.start || qe !== s.quietHours.end;
  const briefValid = HHMM.test(bt);

  const addVip = () => {
    const v = vip.trim();
    if (!v || s.vips.includes(v)) return;
    save({ vips: [...s.vips, v] });
    setVip('');
  };

  return (
    <Screen>
      <BackLink />
      <View style={{ gap: 6 }}>
        <Title size={36} lh={1}>
          Notifications
        </Title>
        <Txt size={13} color={colors.secondary}>
          Approvals and VIPs only. Nothing during quiet hours.
        </Txt>
      </View>
      {note ? <Notice text={note} /> : null}
      <ToggleCard
        title="Push notifications"
        subtitle={busy ? 'Asking for permission…' : 'Approvals, access requests and VIP messages'}
        value={s.notificationsEnabled}
        onChange={(v) => void toggle(v)}
        disabled={busy}
      />

      <View style={{ gap: 6 }}>
        <SectionTitle>Quiet hours</SectionTitle>
        <Card style={{ padding: 14, gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Txt size={12} weight={600} color={colors.secondary}>
                From
              </Txt>
              <Input
                value={start}
                onChangeText={setStart}
                placeholder="22:00"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                accessibilityLabel="Quiet hours start"
              />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Txt size={12} weight={600} color={colors.secondary}>
                Until
              </Txt>
              <Input
                value={end}
                onChangeText={setEnd}
                placeholder="07:00"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                accessibilityLabel="Quiet hours end"
              />
            </View>
          </View>
          {!hoursValid ? (
            <Txt size={12} color={colors.amberDark}>
              Use 24-hour time, like 22:00.
            </Txt>
          ) : null}
          {hoursDirty ? (
            <Button
              label="Save quiet hours"
              variant="dark"
              disabled={!hoursValid}
              onPress={() => save({ quietHours: { start: qs, end: qe } })}
            />
          ) : null}
        </Card>
      </View>

      <View style={{ gap: 6 }}>
        <SectionTitle>Daily brief</SectionTitle>
        <Card style={{ padding: 14, gap: 10, flexDirection: 'row', alignItems: 'center' }}>
          <Txt size={15} weight={500} style={{ flex: 1 }}>
            Brief arrives at
          </Txt>
          <Input
            value={brief}
            onChangeText={setBrief}
            placeholder="07:30"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            accessibilityLabel="Brief time"
            style={{ width: 90, textAlign: 'center' }}
          />
          {bt !== s.briefTime ? (
            <Button label="Save" disabled={!briefValid} onPress={() => save({ briefTime: bt })} />
          ) : null}
        </Card>
      </View>

      <View style={{ gap: 6 }}>
        <SectionTitle>VIPs</SectionTitle>
        <Txt size={12} color={colors.secondary}>
          Messages from these people notify you right away, even with a quiet inbox.
        </Txt>
        <Card>
          {s.vips.map((v, i) => (
            <Row
              key={v}
              first={i === 0}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: 48,
                paddingLeft: 14,
                paddingRight: 6,
              }}
            >
              <Txt size={15} style={{ flex: 1 }} numberOfLines={1}>
                {v}
              </Txt>
              <Pressable
                onPress={() => save({ vips: s.vips.filter((x) => x !== v) })}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${v}`}
                style={{
                  minHeight: HIT,
                  minWidth: HIT,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Txt size={13} weight={600} color={colors.secondary}>
                  Remove
                </Txt>
              </Pressable>
            </Row>
          ))}
          <Row
            first={s.vips.length === 0}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 }}
          >
            <Input
              value={vip}
              onChangeText={setVip}
              placeholder="name@company.com or @handle"
              autoCapitalize="none"
              keyboardType="email-address"
              accessibilityLabel="Add a VIP"
              onSubmitEditing={addVip}
              style={{ flex: 1 }}
            />
            <Button label="Add" onPress={addVip} disabled={!vip.trim()} radius={10} />
          </Row>
        </Card>
      </View>
    </Screen>
  );
}
