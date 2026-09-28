import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { ModelProviderKind } from '@hub/shared';
import type { AddProvider } from '@/lib/api';
import { colors, HIT } from '@/theme';
import { Txt } from './Txt';
import { Card, Input } from './ui';

type Kind = ReturnType<typeof ModelProviderKind.parse>;

type FieldDef = {
  key: string;
  label: string;
  placeholder: string;
  /** Secret fields go in `secret` (encrypted server-side). Everything else is non-secret config. */
  secret?: boolean;
  /**
   * When several secret fields make up one credential (AWS access key + secret), each names
   * its key and they are sent together as a JSON object.
   */
  secretKey?: string;
  optional?: boolean;
  keyboard?: 'url' | 'default';
};

export type ProviderDef = {
  id: string;
  kind: Kind;
  chip: string;
  name: string;
  note: string;
  fields: FieldDef[];
};

const apiKey = (placeholder: string): FieldDef => ({
  key: 'apiKey',
  label: 'API key',
  placeholder,
  secret: true,
});

/** The 8 providers from ModelsSetup.dc.html, in design order. */
export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    chip: 'Anthropic',
    name: 'Anthropic',
    note: 'Claude models with your own API key.',
    fields: [apiKey('sk-ant-…')],
  },
  {
    id: 'openai',
    kind: 'openai',
    chip: 'OpenAI',
    name: 'OpenAI',
    note: 'GPT models with your own API key.',
    fields: [
      apiKey('sk-…'),
      {
        key: 'organization',
        label: 'Organization ID (optional)',
        placeholder: 'org-…',
        optional: true,
      },
    ],
  },
  {
    id: 'groq',
    kind: 'groq',
    chip: 'Groq',
    name: 'Groq',
    note: 'Very fast open models. A good fit for triage.',
    fields: [apiKey('gsk_…')],
  },
  {
    id: 'bedrock',
    kind: 'bedrock',
    chip: 'Bedrock',
    name: 'AWS Bedrock',
    note: 'Claude and other models inside your AWS account and region.',
    fields: [
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      {
        key: 'accessKeyId',
        label: 'Access key ID',
        placeholder: 'AKIA…',
        secret: true,
        secretKey: 'accessKeyId',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret access key',
        placeholder: '••••••••',
        secret: true,
        secretKey: 'secretAccessKey',
      },
    ],
  },
  {
    id: 'vertex',
    kind: 'vertex',
    chip: 'Vertex AI',
    name: 'Google Vertex AI',
    note: 'Claude and Gemini through your Google Cloud project.',
    fields: [
      { key: 'projectId', label: 'Project ID', placeholder: 'my-project' },
      { key: 'region', label: 'Region', placeholder: 'us-east5' },
      {
        key: 'serviceAccount',
        label: 'Service account key (JSON)',
        placeholder: '{"type":"service_account",…}',
        secret: true,
      },
    ],
  },
  {
    id: 'azure',
    kind: 'azure',
    chip: 'Azure',
    name: 'Azure OpenAI',
    note: 'OpenAI models in your Azure tenant.',
    fields: [
      {
        key: 'baseUrl',
        label: 'Endpoint URL',
        placeholder: 'https://[name].openai.azure.com',
        keyboard: 'url',
      },
      { ...apiKey('Paste key') },
    ],
  },
  {
    id: 'openrouter',
    kind: 'openrouter',
    chip: 'OpenRouter',
    name: 'OpenRouter',
    note: 'Many models behind one key, with routing and fallbacks.',
    fields: [apiKey('sk-or-…')],
  },
  {
    id: 'gateway',
    kind: 'openai_compatible',
    chip: 'Gateway',
    name: 'Custom gateway',
    note: 'Any OpenAI-compatible router: OmniRoute, LiteLLM, Portkey or your own.',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        placeholder: 'https://[your-router]/v1',
        keyboard: 'url',
      },
      { ...apiKey('Paste key') },
    ],
  },
];

/** Optional model id stored as non-secret config; the API lists it as a picker option. */
const MODEL_FIELD: FieldDef = {
  key: 'model',
  label: 'Model (optional)',
  placeholder: 'Model or deployment name',
  optional: true,
};
for (const p of PROVIDERS) if (p.kind !== 'anthropic') p.fields.push(MODEL_FIELD);

export function providerByKind(kind: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.kind === kind);
}

/** Form state for one provider. Secret values live only in component state until submitted. */
export function useProviderForm(initial = 'bedrock') {
  const [id, setId] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>({});
  const def = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
  const complete = def.fields.every((f) => f.optional || (values[f.key] ?? '').trim().length > 0);
  const touched = def.fields.some((f) => (values[f.key] ?? '').trim().length > 0);

  const build = (): AddProvider => {
    const config: Record<string, string> = {};
    let secret: string | undefined;
    const parts: Record<string, string> = {};
    for (const f of def.fields) {
      const v = (values[f.key] ?? '').trim();
      if (!v) continue;
      if (f.secret && f.secretKey) parts[f.secretKey] = v;
      else if (f.secret) secret = v;
      else config[f.key] = v;
    }
    if (Object.keys(parts).length > 0) secret = JSON.stringify(parts);
    return { kind: def.kind, label: def.name, config, secret };
  };

  return {
    def,
    select: (next: string) => {
      setId(next);
      setValues({}); // never carry a key across providers
    },
    values,
    setValue: (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v })),
    clear: () => setValues({}),
    complete,
    touched,
    build,
  };
}

export type ProviderFormState = ReturnType<typeof useProviderForm>;

export function ProviderChips({ form }: { form: ProviderFormState }) {
  const rows = [PROVIDERS.slice(0, 4), PROVIDERS.slice(4)];
  return (
    <View style={{ gap: 6 }}>
      <Txt size={12} weight={600} color={colors.secondary}>
        Provider
      </Txt>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
          {row.map((p) => {
            const on = p.id === form.def.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => form.select(p.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={{
                  flex: 1,
                  minHeight: HIT,
                  paddingHorizontal: 4,
                  borderRadius: 10,
                  borderWidth: 2,
                  borderColor: on ? colors.teal : colors.border,
                  backgroundColor: on ? colors.tealTint : colors.white,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Txt
                  size={12}
                  weight={on ? 600 : 500}
                  color={on ? colors.tealDark : colors.ink}
                  numberOfLines={1}
                >
                  {p.chip}
                </Txt>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function ProviderFields({ form }: { form: ProviderFormState }) {
  const { def } = form;
  return (
    <Card style={{ padding: 14, gap: 10 }}>
      <View style={{ gap: 2 }}>
        <Txt size={15} weight={600}>
          {def.name}
        </Txt>
        <Txt size={12} lh={1.4} color={colors.secondary}>
          {def.note}
        </Txt>
      </View>
      {def.fields.map((f) => (
        <View key={`${def.id}-${f.key}`} style={{ gap: 5 }}>
          <Txt size={12} weight={600} color={colors.secondary}>
            {f.label}
          </Txt>
          <Input
            value={form.values[f.key] ?? ''}
            onChangeText={(v) => form.setValue(f.key, v)}
            placeholder={f.placeholder}
            secureTextEntry={f.secret}
            autoCapitalize="none"
            autoComplete="off"
            textContentType={f.secret ? 'password' : 'none'}
            keyboardType={f.keyboard === 'url' ? 'url' : 'default'}
            accessibilityLabel={f.label}
            style={{ backgroundColor: colors.bg, fontSize: 14 }}
          />
        </View>
      ))}
    </Card>
  );
}
