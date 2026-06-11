# Editor de Video Web — Fase 0

Editor de video que corre **100% en el navegador** (web-first), construido sobre
**WebCodecs + Mediabunny**. Sin servidor de procesamiento, sin instalación.

> Estado: **Fase 0** del roadmap — importar, recortar, cortar, reordenar, borrar y
> exportar MP4 en una sola pista. Sin IA todavía.

## Cómo correr

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # build de producción (tsc + vite)
npm run typecheck  # solo verificación de tipos
```

Requiere **Node 20+** y un navegador con WebCodecs (Chrome/Edge actuales, Safari 26+).

## Decisiones de arquitectura

| Capa | Tecnología | Por qué |
|------|-----------|---------|
| Decode / encode / mux | **WebCodecs + Mediabunny** | Aceleración por hardware (~200fps vs ~25fps de ffmpeg.wasm). Mediabunny es MPL-2.0 → seguro para uso comercial. |
| Composición / preview | **Canvas 2D** (interfaz `Compositor`) | Suficiente para Fase 0. Swappable a PixiJS/WebGL en Fase 1 sin tocar playback/export. |
| Modelo de timeline | **JSON propio** (`Project → Track → Clip`) | Serializable, inmutable, operaciones puras. |
| UI | **React + TypeScript + Vite** | Ecosistema y mantenibilidad. |

Notas técnicas resueltas desde el día 1:

- **Cross-origin isolation**: el dev/preview server envía `COOP: same-origin` y
  `COEP: require-corp` (ver `vite.config.ts`), para que el fallback futuro
  (ffmpeg.wasm / SharedArrayBuffer) no rompa el contrato de hosting.
- **Codec base = H.264 (AVC)** con detección de soporte (`src/lib/capabilities.ts`):
  se valida que el dispositivo pueda **codificar** a la resolución objetivo antes
  de exportar (algunos móviles tienen tope de resolución y el encoder no avisa).
- **YUV→RGB y seeking por frame** los maneja Mediabunny vía `CanvasSink`.

## Estructura

```
src/
  core/
    media/        # carga de archivos, registro de media viva, acceso a frames
    timeline/     # modelo Project/Track/Clip + operaciones puras + serialización
    compositor/   # interfaz Compositor + implementación Canvas 2D
    export/       # pipeline de export (compone frames → encode → mux MP4)
  lib/
    capabilities.ts  # detección WebCodecs + codec codificable
  state/
    EditorContext.tsx  # store central (reducer + acciones async)
  ui/components/    # Toolbar, Preview, Timeline
  app.tsx
```

## Criterios de aceptación de Fase 0

- [x] Importar MP4 (selector + drag-and-drop) y verlo en el preview.
- [x] Cortar un clip en dos por el cursor (✂ Cortar).
- [x] Recortar inicio/fin de un clip (arrastrar los bordes del clip).
- [x] Reordenar (◀ ▶ en el clip seleccionado) y borrar clips.
- [x] Exportar MP4 H.264 que refleje la edición (con barra de progreso).
- [x] Guardar y recargar el proyecto desde JSON.
- [x] Funciona en Chrome de escritorio; banner de aviso si falta WebCodecs.

### Relink de media al recargar un proyecto

El `.json` del proyecto guarda solo metadatos (no los bytes del video). Al cargar
un proyecto, vuelve a importar los archivos de video originales: se re-vinculan
automáticamente por nombre de archivo.

## Siguiente (roadmap)

- **Fase 1**: multipista, texto/overlays, audio separado, transiciones. Migrar el
  compositor a PixiJS.
- **Fase 2**: auto-subtítulos con Whisper on-device (Transformers.js) + remoción de fondo.
- **Fase 3**: PWA pulida → Capacitor (App Store / Play Store); freemium.
