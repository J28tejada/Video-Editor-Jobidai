# Agente de edición

La app móvil gira alrededor de un asistente: el usuario pide en lenguaje
natural ("quita los silencios y pon subtítulos amarillos") y el agente edita
el proyecto llamando herramientas. Cada pedido llega como una tarjeta de
cambios con **Deshacer**.

## Arquitectura

```
App (teléfono)                                   Backend (Vercel)            Claude
────────────────────────────────────────         ─────────────────           ──────────────
Proyecto (JSON) ──► describeProject() ─┐
                                        ├─ POST /api/agent ─► prompt + herramientas ─► Opus 5.5
runAgent(): ejecuta las herramientas ◄──┘◄── contenido del asistente ◄──────────────────┘
  · puras: executeTool()  (src/core/agent/execute.ts)
  · del dispositivo: subtítulos (Whisper), silencios
```

- **El proyecto y el video nunca salen del teléfono.** Al modelo le llega una
  descripción en texto del timeline (ids, tiempos, ajustes) y, cuando hay
  análisis, la transcripción y descripciones de planos.
- **El bucle corre en la app** (`src/core/agent/loop.ts`) porque las
  herramientas modifican el proyecto local. El backend es un proxy sin
  estado: guarda la clave de API, el prompt de sistema y las definiciones de
  herramientas.
- **Código compartido** en `src/core/agent/`: herramientas (`tools.ts`),
  ejecutor puro (`execute.ts`), operaciones nuevas (`editOps.ts`), contexto
  (`context.ts`), prompt (`prompt.ts`) y bucle (`loop.ts`). Se prueban con
  `npm run test:agent` sin red.

### Uso de la API de Claude

- Modelo `claude-opus-5-5`, esfuerzo `medium` (comandos de edición no
  necesitan más; se puede subir para pedidos complejos).
- **Caché de prompt**: herramientas + sistema fijos, y caché automática de la
  conversación, así cada vuelta relee el historial a precio de caché.
- **Fallbacks del servidor** (`fallbacks: "default"`): si un clasificador de
  seguridad rechaza un pedido, la API lo reintenta en el modelo recomendado en
  lugar de fallar.
- El contenido del asistente se devuelve y se reenvía sin modificar (los
  bloques de razonamiento deben volver intactos).

## Comprensión del material (A2)

Cada video del timeline se puede analizar (botón *Analizar mis videos*, la
herramienta `analyze_media` del agente, o al abrir *Texto a video*). El
resultado se guarda en el teléfono (`analysis.json`) por fuente y en segundos
de la fuente, así sigue siendo válido después de cualquier corte:

| Dato | Cómo se obtiene | Dónde corre |
| --- | --- | --- |
| Transcripción con tiempo por palabra | Whisper (whisper.cpp) sobre todo el audio | Teléfono |
| Cambios de plano | Diferencia de histograma y luminancia entre fotogramas diminutos (`measureShotChangesAsync`) | Teléfono (nativo) |
| Qué muestra cada plano | Un fotograma de 256 px por plano (máx. 12 por video) → `/api/describe` con Claude Haiku 4.5 y salida estructurada | Backend |

Con eso:
- el agente recibe la transcripción (en segundos del timeline) y los planos
  descritos en su contexto, y puede cortar por contenido;
- **Texto a video**: la transcripción como texto; tocar palabras y borrarlas
  corta el video (`cutSourceRanges`);
- **Muletillas** ("eh", "um", "o sea", palabras repetidas): herramienta
  `remove_filler_words` y botón en *Texto a video*;
- **Sugerencias** calculadas (`suggestEdits`): muletillas, pausas largas,
  inicio lento, falta de subtítulos, formato, duración;
- los subtítulos reutilizan la transcripción ya hecha (instantáneos).

## Crear por intención (A3)

- **Inicio por intención**: con el proyecto vacío la app pregunta "¿Qué
  quieres crear?" (Reel de 30 s, Tutorial, Vlog, Clip de podcast, Anuncio o
  Solo editar). Tras importar, el agente recibe el objetivo, analiza y arma un
  primer montaje.
- **Reels / versiones cortas**: `keep_only` reconstruye el montaje con tramos
  del timeline en el orden elegido por el agente (frases completas de la
  transcripción).
- **Reencuadre automático** (`auto_reframe`): detecta la cara principal
  (Vision en iOS, `FaceDetector` en Android) cada ~0,5 s, suaviza el
  recorrido y genera fotogramas clave de encuadre para que la persona quede
  centrada al pasar de horizontal a vertical, sin dejar bordes.
- **Zooms de énfasis** (`add_zoom`): acercamiento rápido, pausa y vuelta.
- **Transformaciones animadas**: `Clip.transformKeys` (segundos de la fuente,
  interpolación lineal). iOS las evalúa por fotograma en el compositor;
  Android con un `MatrixTransformation` y encaje completo + escala (así el
  paneo nunca muestra bordes); la web también las respeta.
- **Subtítulos karaoke**: la palabra que se dice se resalta en el preview y en
  el video exportado (iOS: una capa por palabra; Android: redibujo por
  palabra activa).

## Configuración

### Backend (Vercel, mismo proyecto que la web)

En *Settings → Environment Variables* del proyecto de Vercel:

| Variable | Valor |
| --- | --- |
| `ANTHROPIC_API_KEY` | Clave de la consola de Anthropic (obligatoria) |
| `AGENT_APP_KEY` | Un secreto largo y aleatorio (recomendado) |

Al hacer push a `main`, Vercel despliega `api/agent.ts` como
`https://<tu-dominio>/api/agent`.

### App

Al compilar la app (EAS o local) define:

```bash
EXPO_PUBLIC_AGENT_URL=https://<tu-dominio-de-vercel>
EXPO_PUBLIC_AGENT_KEY=<mismo valor que AGENT_APP_KEY>
```

Con EAS se añaden en `eas.json` → `build.<perfil>.env`, o como variables del
proyecto en expo.dev.

### Seguridad y costos

- `AGENT_APP_KEY` evita el uso casual del endpoint, pero cualquier secreto
  dentro de una app se puede extraer. Antes de publicar hace falta **cuentas de
  usuario** (p. ej. Supabase Auth) y **límites/créditos por usuario** en el
  backend. Es una decisión de producto pendiente (proveedor y modelo de cobro).
- Cada pedido cuesta del orden de centavos de dólar; la caché reduce mucho el
  costo de los pedidos siguientes en la misma conversación.
