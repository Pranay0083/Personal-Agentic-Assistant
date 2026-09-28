import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  api,
  type AccountT,
  type ConnectorInfoT,
  type ConnectorOptionT,
  type ConnectorSourceT,
  type UpdateAccount,
} from '@/lib/api';
import { accountUnit, serviceName } from '@/lib/format';
import { ACCOUNT_SWATCHES, colors, HIT } from '@/theme';
import { Txt } from './Txt';
import { Card, Checkbox, Input, LinkButton, Segmented } from './ui';
import { LoadingState } from './layout';
import { Check } from './icons';

type Days = 7 | 30 | 90;
type Filters = AccountT['filters'];
type OptionValue = Filters['options'][string];

/** Editable copy of an account's settings (Scope during onboarding, account settings after). */
export type AccountDraft = {
  nickname: string;
  color: string;
  filters: Filters;
  days: Days;
  isPersonal: boolean;
  /** "Use these settings for my other <Provider> accounts". */
  applyAll: boolean;
};

export function useAccountDraft(account: AccountT) {
  return useState<AccountDraft>(() => ({
    nickname: account.nickname,
    color: account.color,
    filters: account.filters,
    days: account.backfillDays,
    isPersonal: account.isPersonal,
    applyAll: false,
  }));
}

/** PATCH /accounts/:id, then copy to the provider's other accounts if asked. */
export async function saveAccountDraft(account: AccountT, draft: AccountDraft, others: number) {
  const patch: UpdateAccount = {
    nickname: draft.nickname.trim() || account.nickname,
    color: draft.color,
    filters: draft.filters,
    backfillDays: draft.days,
    isPersonal: draft.isPersonal,
  };
  await api.updateAccount(account.id, patch);
  if (draft.applyAll && others > 0) await api.applySettingsToProvider(account.id);
}

/** "Set up this Gmail", "Set up this Slack workspace", "Set up this Atlassian site". */
export function setupTitle(account: AccountT, info: ConnectorInfoT | undefined): string {
  if (account.provider === 'gmail') return 'Set up this Gmail';
  return `Set up this ${info?.name ?? serviceName(account.provider)} ${accountUnit(account.provider, 1)}`;
}

const MAIL_FILTERS: { key: 'inbox' | 'sent' | 'promotions'; label: string; hint?: string }[] = [
  { key: 'inbox', label: 'Primary inbox' },
  { key: 'sent', label: 'Sent mail', hint: '· catches your promises' },
  { key: 'promotions', label: 'Promotions and Social' },
];

export function sourceOn(filters: Filters, s: ConnectorSourceT): boolean {
  return filters.sources[s.id] ?? s.defaultOn;
}

function optionValue(filters: Filters, o: ConnectorOptionT): OptionValue {
  return filters.options[o.key] ?? o.default;
}

export function AccountSettingsFields({
  account,
  info,
  catalogState,
  onRetryCatalog,
  otherCount,
  draft,
  setDraft,
  onboarding = false,
}: {
  /** During onboarding the stricter personal rules are picked in the next step. */
  onboarding?: boolean;
  account: AccountT;
  /** Catalog entry for the account's provider; undefined while loading or if missing. */
  info: ConnectorInfoT | undefined;
  catalogState: 'pending' | 'error' | 'success';
  onRetryCatalog: () => void;
  /** Other accounts of the same provider. */
  otherCount: number;
  draft: AccountDraft;
  setDraft: (d: AccountDraft) => void;
}) {
  const { filters } = draft;
  const setFilters = (f: Filters) => setDraft({ ...draft, filters: f });
  const sources = info?.sources ?? [];
  const options = info?.options ?? [];
  // One mail-only source (Gmail today): the mail filters are the whole "What to read".
  const mailOnly = sources.length === 1 && sources[0]!.kind === 'email';
  const boolOptions = options.filter((o) => o.type === 'boolean');
  const choiceOptions = options.filter((o) => o.type === 'choice' && o.choices.length > 0);
  const name = info?.name ?? serviceName(account.provider);

  const mailRows = (indent: number) => (
    <>
      {MAIL_FILTERS.map((r) => (
        <CheckRow
          key={r.key}
          indent={indent}
          label={r.label}
          hint={r.hint}
          checked={filters[r.key]}
          onPress={() => setFilters({ ...filters, [r.key]: !filters[r.key] })}
        />
      ))}
      {filters.labels.map((l) => (
        <CheckRow
          key={`label:${l}`}
          indent={indent}
          label={`Label: ${l}`}
          checked
          onPress={() => setFilters({ ...filters, labels: filters.labels.filter((x) => x !== l) })}
        />
      ))}
    </>
  );

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Txt size={12} weight={600} color={colors.secondary}>
            Nickname
          </Txt>
          <Input
            value={draft.nickname}
            onChangeText={(nickname) => setDraft({ ...draft, nickname })}
            placeholder="Work"
            maxLength={40}
            accessibilityLabel="Nickname"
          />
        </View>
        <View style={{ gap: 6 }}>
          <Txt size={12} weight={600} color={colors.secondary}>
            Color
          </Txt>
          <View style={{ flexDirection: 'row', gap: 2 }}>
            {ACCOUNT_SWATCHES.map((s) => (
              <Swatch
                key={s.color}
                color={s.color}
                label={s.label}
                on={s.color === draft.color}
                onPress={() => setDraft({ ...draft, color: s.color })}
              />
            ))}
          </View>
        </View>
      </View>

      <Card style={{ paddingVertical: 8, paddingHorizontal: 14, gap: 4 }}>
        <Txt size={12} weight={600} color={colors.secondary} style={{ paddingVertical: 4 }}>
          What to read
        </Txt>
        {catalogState === 'pending' ? (
          <LoadingState compact label="Loading what this service offers…" />
        ) : catalogState === 'error' ? (
          <View style={{ gap: 2, paddingBottom: 4 }}>
            <Txt size={13} color={colors.warnBody}>
              {`Couldn't load what ${name} offers. Your other settings still save.`}
            </Txt>
            <LinkButton label="Try again" align="flex-start" onPress={onRetryCatalog} />
          </View>
        ) : sources.length === 0 ? (
          <Txt size={13} color={colors.secondary} style={{ paddingBottom: 8 }}>
            {`Your hub doesn't list anything to read for ${name} yet.`}
          </Txt>
        ) : mailOnly ? (
          mailRows(0)
        ) : (
          sources.map((s) => {
            const on = sourceOn(filters, s);
            return (
              <View key={s.id}>
                <CheckRow
                  label={s.label}
                  hint={s.hint ? (s.hint.startsWith('·') ? s.hint : `· ${s.hint}`) : undefined}
                  checked={on}
                  onPress={() =>
                    setFilters({ ...filters, sources: { ...filters.sources, [s.id]: !on } })
                  }
                />
                {s.kind === 'email' && on ? mailRows(32) : null}
              </View>
            );
          })
        )}
      </Card>

      {boolOptions.length ? (
        <Card style={{ paddingVertical: 8, paddingHorizontal: 14, gap: 4 }}>
          <Txt size={12} weight={600} color={colors.secondary} style={{ paddingVertical: 4 }}>
            Options
          </Txt>
          {boolOptions.map((o) => {
            const on = optionValue(filters, o) === true;
            return (
              <CheckRow
                key={o.key}
                label={o.label}
                sub={o.hint ?? undefined}
                checked={on}
                onPress={() =>
                  setFilters({ ...filters, options: { ...filters.options, [o.key]: !on } })
                }
              />
            );
          })}
        </Card>
      ) : null}

      {choiceOptions.map((o) => {
        const v = optionValue(filters, o);
        const value = typeof v === 'string' ? v : String(o.default);
        const pick = (next: string) =>
          setFilters({ ...filters, options: { ...filters.options, [o.key]: next } });
        return (
          <View key={o.key} style={{ gap: 6 }}>
            <Txt size={12} weight={600} color={colors.secondary}>
              {o.label}
            </Txt>
            {o.choices.length <= 3 ? (
              <Segmented value={value} onChange={pick} options={o.choices} />
            ) : (
              <Card>
                {o.choices.map((c, i) => (
                  <Pressable
                    key={c.value}
                    onPress={() => pick(c.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: c.value === value }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      minHeight: HIT,
                      paddingHorizontal: 14,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: colors.divider,
                    }}
                  >
                    <Txt size={15} style={{ flex: 1 }}>
                      {c.label}
                    </Txt>
                    {c.value === value ? <Check color={colors.teal} /> : null}
                  </Pressable>
                ))}
              </Card>
            )}
            {o.hint ? (
              <Txt size={12} color={colors.secondary}>
                {o.hint}
              </Txt>
            ) : null}
          </View>
        );
      })}

      <View style={{ gap: 6 }}>
        <Txt size={12} weight={600} color={colors.secondary}>
          How far back
        </Txt>
        <Segmented<`${Days}`>
          value={`${draft.days}`}
          onChange={(v) => setDraft({ ...draft, days: Number(v) as Days })}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
        <Txt size={12} color={colors.secondary}>
          Imports in the background. You can keep going.
        </Txt>
      </View>

      <CheckRow
        label="This is a personal account"
        sub={
          onboarding
            ? 'Gets the stricter rules if you keep them on in the next step.'
            : 'Gets the stricter rules for personal accounts, if you have them on.'
        }
        size={14}
        checked={draft.isPersonal}
        onPress={() => setDraft({ ...draft, isPersonal: !draft.isPersonal })}
      />

      {otherCount > 0 ? (
        <CheckRow
          label={`Use these settings for my other ${name} accounts`}
          size={14}
          checked={draft.applyAll}
          onPress={() => setDraft({ ...draft, applyAll: !draft.applyAll })}
        />
      ) : null}
    </>
  );
}

function CheckRow({
  label,
  hint,
  sub,
  checked,
  onPress,
  indent = 0,
  size = 15,
}: {
  label: string;
  /** Inline, after the label ("· catches your promises"). */
  hint?: string;
  /** On its own line under the label. */
  sub?: string;
  checked: boolean;
  onPress: () => void;
  indent?: number;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: HIT,
        paddingLeft: indent,
      }}
    >
      <Checkbox checked={checked} size={20} />
      <View style={{ flex: 1, gap: 2, paddingVertical: sub ? 6 : 0 }}>
        <Txt size={size}>
          {label}
          {hint ? <Txt size={12} color={colors.secondary}>{` ${hint}`}</Txt> : null}
        </Txt>
        {sub ? (
          <Txt size={12} color={colors.secondary}>
            {sub}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

function Swatch({
  color,
  label,
  on,
  onPress,
}: {
  color: string;
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={{ width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: on ? 34 : 26,
          height: on ? 34 : 26,
          borderRadius: 17,
          borderWidth: on ? 2 : 0,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: color,
            borderWidth: on ? 3 : 0,
            borderColor: colors.bg,
          }}
        />
      </View>
    </Pressable>
  );
}
