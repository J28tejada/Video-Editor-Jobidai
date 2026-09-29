/**
 * The assistant: a prompt bar always visible under the timeline, and a panel
 * with the conversation, change cards (undo) and suggestions.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAgent, type LogEntry } from '../agent/AgentContext';
import { useEditor } from '../editor/EditorContext';
import { Icon } from '../ui/Icon';
import { colors, radius } from '../ui/theme';

const SUGGESTIONS = [
  'Quita los silencios y las pausas largas',
  'Pon subtítulos grandes en amarillo',
  'Hazlo vertical para Reels',
  'Dale un look más cinematográfico',
  'Añade transiciones suaves entre clips',
  'Acorta el video a 30 segundos',
];

/** Prompt bar shown in the editor; opens the panel. */
export function AgentBar({ onOpen }: { onOpen: () => void }) {
  const { status, log } = useAgent();
  const last = [...log]
    .reverse()
    .find((e): e is Extract<LogEntry, { kind: 'assistant' | 'error' }> => e.kind === 'assistant' || e.kind === 'error');
  return (
    <Pressable onPress={onOpen} style={styles.bar}>
      <Icon name="ai" size={18} color={colors.accent} />
      <Text style={[styles.barText, !status && !last && { color: colors.textDim }]} numberOfLines={1}>
        {status ?? last?.text ?? 'Pídele algo a tu editor…'}
      </Text>
      {status ? <ActivityIndicator size="small" color={colors.accent} /> : null}
    </Pressable>
  );
}

export function AgentPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { configured, log, status, run, cancel, undoCard, reset, suggestions, analyze } = useAgent();
  const { duration } = useEditor();
  const [text, setText] = useState('');
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    const t = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [log.length, status]);

  const submit = (value: string) => {
    if (!value.trim() || status) return;
    setText('');
    run(value);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.panel, { paddingBottom: 10 + insets.bottom }]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Asistente de edición</Text>
          <View style={styles.headerActions}>
            {log.length > 0 && !status && (
              <Pressable onPress={reset} hitSlop={10}>
                <Text style={styles.link}>Nueva</Text>
              </Pressable>
            )}
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="close" size={20} />
            </Pressable>
          </View>
        </View>

        <ScrollView ref={scroll} style={styles.log} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
          {!configured && (
            <Text style={styles.warning}>
              El asistente necesita su servidor. Configura EXPO_PUBLIC_AGENT_URL al compilar la app
              (ver mobile/README.md).
            </Text>
          )}
          {log.length === 0 && (
            <>
              <Text style={styles.hint}>
                Dime qué quieres y edito por ti. Puedes deshacer cada cambio.
              </Text>
              <View style={styles.suggestions}>
                {(suggestions.length
                  ? suggestions
                  : SUGGESTIONS.map((t) => ({ id: t, label: t, prompt: t }))
                ).map((sug) => (
                  <Pressable
                    key={sug.id}
                    style={[styles.chip, duration <= 0 && { opacity: 0.4 }]}
                    disabled={duration <= 0 || !!status}
                    // Analysis runs on the phone; no need to ask the model.
                    onPress={() => (sug.id === 'analyze' ? analyze() : submit(sug.prompt))}
                  >
                    <Text style={styles.chipText}>{sug.label}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          {log.map((e) => (
            <Entry key={e.id} entry={e} onUndo={undoCard} />
          ))}
          {status && (
            <View style={styles.status}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.statusText}>{status}</Text>
              <Pressable onPress={cancel} hitSlop={10}>
                <Text style={styles.link}>Cancelar</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Pídele algo a tu editor…"
            placeholderTextColor={colors.textDim}
            style={styles.input}
            multiline
            editable={!status}
            onSubmitEditing={() => submit(text)}
            blurOnSubmit
            returnKeyType="send"
          />
          <Pressable
            onPress={() => submit(text)}
            disabled={!text.trim() || !!status}
            style={[styles.send, (!text.trim() || !!status) && { opacity: 0.4 }]}
          >
            <Icon name="ai" size={20} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Entry({ entry, onUndo }: { entry: LogEntry; onUndo: (id: string) => void }) {
  switch (entry.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.bubbleText}>{entry.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.agentBubble]}>
          <Text style={styles.bubbleText}>{entry.text}</Text>
        </View>
      );
    case 'error':
      return <Text style={styles.error}>{entry.text}</Text>;
    case 'changes':
      return (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{entry.undone ? 'Cambios deshechos' : 'Cambios aplicados'}</Text>
          {entry.lines.slice(0, 8).map((l, i) => (
            <Text key={i} style={[styles.cardLine, entry.undone && styles.strike]}>
              • {l}
            </Text>
          ))}
          {entry.lines.length > 8 && (
            <Text style={styles.cardLine}>• y {entry.lines.length - 8} más</Text>
          )}
          {!entry.undone && (
            <Pressable onPress={() => onUndo(entry.id)} style={styles.undo}>
              <Icon name="undo" size={16} />
              <Text style={styles.undoText}>Deshacer</Text>
            </Pressable>
          )}
        </View>
      );
  }
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 10,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: colors.panelHigh,
    borderWidth: 1,
    borderColor: colors.border,
  },
  barText: { flex: 1, color: colors.text, fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  panel: {
    height: '72%',
    backgroundColor: colors.panelHigh,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  log: { flex: 1 },
  hint: { color: colors.textDim, fontSize: 14 },
  warning: { color: '#fbbf24', fontSize: 13 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, fontSize: 13 },
  bubble: { padding: 10, borderRadius: radius.md, maxWidth: '88%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  agentBubble: { alignSelf: 'flex-start', backgroundColor: colors.panel },
  bubbleText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 13 },
  card: {
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accentSoft,
    padding: 12,
    gap: 3,
  },
  cardTitle: { color: colors.text, fontWeight: '700', fontSize: 13, marginBottom: 2 },
  cardLine: { color: colors.textDim, fontSize: 13 },
  strike: { textDecorationLine: 'line-through' },
  undo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, alignSelf: 'flex-start' },
  undoText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusText: { flex: 1, color: colors.textDim, fontSize: 13 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  input: {
    flex: 1,
    maxHeight: 110,
    minHeight: 44,
    backgroundColor: colors.panel,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
