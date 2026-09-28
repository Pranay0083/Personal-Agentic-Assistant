import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { api, type AskT } from '@/lib/api';
import { colors, fonts } from '@/theme';
import { Txt } from './Txt';
import { Button } from './ui';
import { ErrorState, LoadingState, Sheet } from './layout';
import { ArrowUp, Chevron } from './icons';

export function useAsk() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const m = useMutation({ mutationFn: (q: string) => api.ask(q) });
  return {
    open,
    question,
    mutation: m,
    ask: (q: string) => {
      const text = q.trim();
      if (!text) return;
      setQuestion(text);
      setOpen(true);
      m.mutate(text);
    },
    close: () => setOpen(false),
    /** Open empty, ready for a new question. */
    start: () => {
      setQuestion('');
      m.reset();
      setOpen(true);
    },
  };
}

export type AskState = ReturnType<typeof useAsk>;

/** "Ask your hub anything…" bar from Main.dc.html. */
export function AskBar({ state }: { state: AskState }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    state.ask(text);
    setText('');
  };
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Ask your hub anything…"
        placeholderTextColor="#9A958A"
        accessibilityLabel="Ask your hub"
        returnKeyType="send"
        onSubmitEditing={submit}
        maxLength={2000}
        style={{
          flex: 1,
          height: 48,
          paddingHorizontal: 18,
          borderRadius: 24,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          backgroundColor: colors.white,
          fontFamily: fonts.sans,
          fontSize: 15,
          color: colors.ink,
        }}
      />
      <Pressable
        onPress={submit}
        accessibilityRole="button"
        accessibilityLabel="Send"
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: colors.ink,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <ArrowUp />
      </Pressable>
    </View>
  );
}

export function AskSheet({ state }: { state: AskState }) {
  const { mutation } = state;
  const res: AskT | undefined = mutation.data;
  return (
    <Sheet visible={state.open} onClose={state.close} title="Your hub">
      <View style={{ padding: 12, borderRadius: 12, backgroundColor: colors.segmentBg }}>
        <Txt size={14} color={colors.body}>
          {state.question}
        </Txt>
      </View>
      {mutation.isPending ? (
        <LoadingState compact label="Thinking…" />
      ) : mutation.isError ? (
        <ErrorState
          error={mutation.error}
          onRetry={() => mutation.mutate(state.question)}
          title="Couldn't answer that"
        />
      ) : res ? (
        <View style={{ gap: 12 }}>
          <Txt size={15} lh={1.5} selectable>
            {res.answer}
          </Txt>
          {res.sources.length ? (
            <View style={{ gap: 4 }}>
              <Txt size={12} weight={600} color={colors.secondary}>
                {`Based on ${res.sources.length} ${res.sources.length === 1 ? 'item' : 'items'}`}
              </Txt>
              {res.sources.map((id, i) => (
                <Pressable
                  key={id}
                  onPress={() => {
                    state.close();
                    router.push({ pathname: '/item/[id]', params: { id } });
                  }}
                  accessibilityRole="link"
                  style={{
                    minHeight: 44,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Txt size={14} weight={500} color={colors.teal}>
                    {`Source ${i + 1}`}
                  </Txt>
                  <Chevron color={colors.teal} />
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {!mutation.isPending ? <Button label="Done" variant="outline" onPress={state.close} /> : null}
    </Sheet>
  );
}
