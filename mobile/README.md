# Editor de Video — app móvil (iOS + Android)

App nativa con Expo (React Native) y un motor de video propio sobre
AVFoundation (iOS) y Media3 (Android). Comparte el modelo de timeline con el
editor web (`../src/core/timeline`). Plan y estado: [PLAN.md](./PLAN.md).

## Requisitos

- Node 20+ y npm.
- Para Android local: Android Studio (SDK 36, NDK 27.1) o solo EAS Build.
- Para iOS: un Mac con Xcode 16+, o EAS Build en la nube.

El motor es código nativo, así que **no funciona en Expo Go**: se usa un
_development build_.

## Ejecutar en desarrollo

```bash
cd mobile
npm install

# Android (emulador o teléfono por USB)
npx expo run:android

# iOS (en un Mac)
npx expo run:ios
```

Después, `npm start` levanta Metro para recargar el JavaScript al instante.
Los cambios en `modules/video-engine` (Swift/Kotlin) requieren recompilar.

## Compilar en la nube (sin Mac)

```bash
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform ios      # dev build
npx eas-cli@latest build --profile preview --platform android      # APK para probar
npx eas-cli@latest build --profile production --platform all       # tiendas
```

Antes de publicar, cambia `ios.bundleIdentifier` y `android.package` en
`app.json` (ahora `ai.jobid.videoeditor`) por los de tu cuenta.

## APK de Android desde GitHub

El flujo `.github/workflows/android-apk.yml` compila un APK instalable en cada
push a `main` que toque `mobile/` o `src/core/` (y a mano con *Run workflow*).
Descárgalo en GitHub → **Actions** → **Android APK** → última ejecución →
**Artifacts**, descomprime el zip y abre el `.apk` en el teléfono (permite
"instalar apps desconocidas"). El APK sirve para teléfonos (arm64) y para
el emulador de Android Studio en cualquier computadora (x86_64 o arm64):
arrástralo a la ventana del emulador para instalarlo.

Para que el asistente funcione, en *Settings → Secrets and variables →
Actions* define la variable `AGENT_URL` (`https://<tu-sitio>.vercel.app/api/agent`)
y, si usas `AGENT_APP_KEY` en Vercel, el secreto `AGENT_APP_KEY`.

## Estructura

```
mobile/
├── src/app/                 Rutas (Expo Router)
├── src/editor/              Estado: proyecto, deshacer/rehacer, persistencia
├── src/engine/              Proyecto → EngineComposition, reloj de reproducción
├── src/media/               Importación y almacenamiento de videos
├── src/components/          Preview, Timeline, Toolbar, hojas de edición
└── modules/video-engine/    Motor nativo (Expo Module)
    ├── src/                 Contrato TypeScript
    ├── ios/                 AVFoundation
    └── android/             Media3 (ExoPlayer + Transformer)
```

## Comandos de verificación

```bash
npm run typecheck
npm run lint
npm run doctor
```
