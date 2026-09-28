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
| **F3 Audio** | Música de fondo con fades y ducking, efectos de sonido (el modelo ya los soporta; falta mezclarlos en el motor) | ⏭️ Siguiente |
| **F4 Visual** | Filtros de color (Core Image / Media3 `RgbMatrix`), transiciones entre clips, overlays de video (PiP), zoom/pan por clip | Pendiente |
| **F5 IA en el dispositivo** | Subtítulos automáticos (whisper.cpp / WhisperKit), quitar silencios, quitar fondo (Vision / ML Kit) | Pendiente |
| **F6 Producción** | Íconos y splash propios, bundle id definitivo, EAS Build + Submit a App Store / Play Store, analítica y crash reporting | Pendiente |

## Verificación hecha

- `tsc --noEmit` y `expo lint`: sin errores.
- `expo-doctor`: 21/21 comprobaciones.
- Metro empaqueta la app e incluye el modelo compartido de `../src/core/timeline`.
- Android: `./gradlew assembleDebug` y `assembleRelease` compilan (APK instalable).
- iOS: `swiftc -parse` valida la sintaxis; la compilación real requiere Xcode
  (usar `eas build -p ios` o un Mac).

## Pendiente de probar en dispositivo

El motor no se ha podido ejecutar en un teléfono real desde este entorno. Lo
primero al instalar: importar 2–3 videos (vertical y horizontal), cortar,
cambiar velocidad, añadir un texto y exportar; comprobar que el texto aparece
en el momento correcto del MP4 exportado en ambos sistemas.
