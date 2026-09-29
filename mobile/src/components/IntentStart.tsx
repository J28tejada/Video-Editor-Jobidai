/**
 * Empty-project start: "What do you want to make?". Picking an intent imports
 * videos and hands the goal to the agent, which analyzes and builds a first
 * cut the user can then refine by asking.
 */
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAgent } from '../agent/AgentContext';
import { useEditor } from '../editor/EditorContext';
import { Icon } from '../ui/Icon';
import { colors, radius } from '../ui/theme';

const INTENTS = [
  {
    id: 'reel',
    title: 'Reel de 30 s',
    subtitle: 'Lo mejor, con gancho y subtítulos',
    prompt:
      'Analiza mis videos y haz un reel vertical de unos 30 segundos con los mejores momentos: un gancho fuerte al inicio, sin silencios ni muletillas, que siga a la persona en el cuadro, subtítulos grandes y un look vivo.',
  },
  {
    id: 'tutorial',
    title: 'Tutorial',
    subtitle: 'Claro, limpio y con subtítulos',
    prompt:
      'Analiza el video y déjalo como un tutorial claro: quita silencios y muletillas, añade subtítulos y un título al inicio con el tema.',
  },
  {
    id: 'vlog',
    title: 'Vlog',
    subtitle: 'Dinámico, con transiciones y color',
    prompt:
      'Analiza mis videos y arma un vlog dinámico: ordena las tomas para contar la historia, transiciones suaves, look cálido, zooms en los momentos clave y subtítulos.',
  },
  {
    id: 'podcast',
    title: 'Clip de podcast',
    subtitle: 'El mejor fragmento, vertical',
    prompt:
      'Analiza la conversación y saca el mejor fragmento de 45 a 60 segundos como clip vertical: reencuadre siguiendo a quien habla y subtítulos grandes.',
  },
  {
    id: 'ad',
    title: 'Anuncio',
    subtitle: '15–20 s con llamado a la acción',
    prompt:
      'Haz un anuncio vertical de 15 a 20 segundos con los planos más atractivos, textos con el mensaje principal y un llamado a la acción al final.',
  },
] as const;

export function IntentStart() {
  const { importVideos } = useEditor();
  const { run, configured } = useAgent();

  const start = async (prompt: string | null) => {
    try {
      const count = await importVideos();
      if (count > 0 && prompt && configured) run(prompt);
    } catch (e) {
      Alert.alert('No se pudo importar', (e as Error).message);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Icon name="ai" size={30} color={colors.accent} />
      <Text style={styles.title}>¿Qué quieres crear?</Text>
      <Text style={styles.subtitle}>
        Elige un objetivo e importa tus videos: el editor arma un primer montaje que luego ajustas pidiéndoselo.
      </Text>
      <View style={styles.grid}>
        {INTENTS.map((intent) => (
          <Pressable key={intent.id} style={styles.card} onPress={() => start(intent.prompt)}>
            <Text style={styles.cardTitle}>{intent.title}</Text>
            <Text style={styles.cardSubtitle}>{intent.subtitle}</Text>
          </Pressable>
        ))}
        <Pressable style={[styles.card, styles.plain]} onPress={() => start(null)}>
          <Text style={styles.cardTitle}>Solo editar</Text>
          <Text style={styles.cardSubtitle}>Importar y editar a mano</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', padding: 16, gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  subtitle: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  card: {
    width: '47%',
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.panelHigh,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 3,
  },
  plain: { backgroundColor: colors.panel },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  cardSubtitle: { color: colors.textDim, fontSize: 12 },
});
