# Plan: Editor de Video nativo (iOS + Android)

**Stack:** React Native (Expo SDK 57, New Architecture) para la UI + un motor de
video nativo propio (`modules/video-engine`) sobre AVFoundation (iOS) y Media3
(Android).

**Principio (aprendido en la versión web):** JavaScript nunca toca frames. La UI
edita el proyecto (el mismo modelo de timeline que la web) y le envía al motor
una descripción aplanada (`EngineComposition`). El motor decodifica,
compone y codifica con el hardware del teléfono.

```
┌──────────────── React Native (TypeScript) ────────────────┐
│  Timeline · Toolbar · Hojas de edición · Deshacer/Rehacer │
│  Modelo compartido con la web: ../src/core/timeline        │
└───────────────┬──────────────────────────▲────────────────┘
   composition (JSON)                eventos (tiempo, fin,
   play/pause/seek, export           progreso de exportación)
┌───────────────▼──────────────────────────┴────────────────┐
│  modules/video-engine                                      │
│  iOS:     AVMutableComposition · AVPlayer · AVAssetExport  │
│  Android: ExoPlayer (MediaCodec) · Media3 Transformer      │
└────────────────────────────────────────────────────────────┘
```

## Fases

| Fase | Contenido | Estado |
| --- | --- | --- |
| **F0 Estructura** | App Expo en `mobile/`, Expo Router, reutiliza `src/core/timeline` vía `@timeline/*` (sin duplicar código), EAS configurado | ✅ Hecho |
| **F1a Motor iOS** | Preview con AVPlayer sobre una composición (cortes, recortes, velocidad, volumen, contain/cover), seek coalescido, miniaturas, info de medios, exportación MP4 con textos quemados (Core Animation) y progreso | ✅ Escrito · ⚠️ sin compilar (requiere macOS/EAS) |
| **F1b Motor Android** | Mismo contrato: playlist ExoPlayer con clips recortados, velocidad/volumen/encuadre por clip, miniaturas, exportación con Transformer (Presentation, ganancia, velocidad manteniendo tono, textos con OverlayEffect) | ✅ Hecho · compila contra Media3 1.11.1 |
| **F2 UI** | Importar de galería, preview con proporción del proyecto, timeline estilo CapCut (playhead fijo, scroll a 60 fps con reloj extrapolado), miniaturas, cortar, borrar, recortar con asas, velocidad, volumen, encuadre, textos (arrastrables, tamaño, color, fondo, posición, duración), formato 9:16/1:1/4:5/16:9, deshacer/rehacer, autoguardado, exportar → galería / compartir | ✅ Hecho |
| **F3 Audio** | Música de fondo (volumen, entrada/salida gradual, bajar con la voz, repetir hasta el final) y efectos de sonido (7 sintetizados en el dispositivo como WAV + importados). JS calcula una envolvente de ganancia por capa (misma lógica que la web). iOS: pistas extra en la composición con rampas de volumen. Android: secuencias de audio en Transformer con un procesador de envolvente; en el preview, la mezcla se pre-renderiza y suena sincronizada con el video | ✅ Hecho · Android compila; iOS sin compilar |
| **F4 Visual** | Filtros de color (estilos compartidos con la web + brillo, contraste, saturación, calidez), zoom y reencuadre por clip, transiciones centradas en el corte (fundido, a negro, deslizar) con congelado de frame cuando la fuente no alcanza. JS convierte los filtros CSS en una matriz de color única. iOS: compositor propio (Core Image) con pistas A/B para preview y export. Android: el preview pasa a `CompositionPlayer`, que reproduce la misma composición que exporta Transformer (secuencia de transición + `VideoCompositorSettings`); textos como efecto de composición | ✅ Hecho · Android compila; iOS sin compilar |
| **F4b Video sobre video** | Pistas de overlay (PiP) con posición/escala, animaciones de entrada/salida | Pendiente — en Media3 la secuencia principal va encima; requiere pruebas en dispositivo |
| **F5 IA en el dispositivo** | Subtítulos automáticos con Whisper (whisper.cpp vía `whisper.rn`; modelo rápido 57 MB o preciso 181 MB, descargado una vez; español, inglés, portugués o auto) con tiempos por palabra mapeados al timeline y agrupados en líneas con la lógica de la web; estilo aplicable a todos los subtítulos a la vez. Quitar silencios con el mismo detector de la web (suave/normal/agresivo). El motor decodifica el audio a PCM 16 kHz mono (AVAssetReader / MediaCodec) | ✅ Hecho · Android compila; iOS sin compilar |
| **F5b Quitar fondo** | Segmentación de personas por frame (Vision en iOS, MediaPipe/ML Kit en Android) dentro del compositor | Pendiente — en Android requiere integrar la segmentación en el pipeline de GPU de Media3 |
| **F6 Producción** | Íconos y splash propios, bundle id definitivo, EAS Build + Submit a App Store / Play Store, analítica y crash reporting | Pendiente |

## Verificación hecha

- `tsc --noEmit` y `expo lint`: sin errores.
- `expo-doctor`: 21/21 comprobaciones.
- Metro empaqueta la app e incluye el modelo compartido de `../src/core/timeline`.
- Android: `./gradlew assembleDebug` y `assembleRelease` compilan (APK instalable).
- La conversión filtros CSS → matriz de color está verificada numéricamente
  (brillo, contraste, B/N, saturación, tono y el orden de aplicación).
- IA: detección de silencios sobre una señal sintética, mapeo de tiempos de
  Whisper al timeline (incluida velocidad 2×) y unión de tokens en palabras.
- iOS: `swiftc -parse` valida la sintaxis; la compilación real requiere Xcode
  (usar `eas build -p ios` o un Mac).

## Pendiente de probar en dispositivo

El motor no se ha podido ejecutar en un teléfono real desde este entorno. Lo
primero al instalar: importar 2–3 videos (vertical y horizontal), cortar,
cambiar velocidad, añadir un texto y exportar; comprobar que el texto aparece
en el momento correcto del MP4 exportado en ambos sistemas.

IA (F5): generar subtítulos de un clip con voz (la primera vez descarga el
modelo, necesita internet) y revisar que las líneas caen en su momento, también
en un clip acelerado; quitar silencios en un clip con pausas y deshacer.

Visual (F4): aplicar un estilo y un zoom a un clip, añadir una transición de
cada tipo entre dos clips (uno recortado y otro sin recortar, para ver el
congelado de frame) y comprobar que el preview y el MP4 exportado coinciden.

Audio (F3): añadir una canción y un par de efectos; comprobar que la música
entra/sale gradualmente, baja cuando hablan en el video, y que en Android el
preview la toca sincronizada (la primera vez tarda un momento en prepararse la
mezcla). Exportar y escuchar el MP4.
