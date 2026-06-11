# Despliegue

La app necesita los headers de **cross-origin isolation** para WebCodecs/IA:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Ya están configurados en `vercel.json` (Vercel) y `netlify.toml` + `public/_headers` (Netlify).

## Opción A — Vercel (recomendado)

Desde el móvil o el escritorio:

1. Entra a [vercel.com](https://vercel.com) e inicia sesión con GitHub.
2. **Add New → Project** → importa `J28tejada/Video-Editor-Jobidai`.
3. Vercel detecta Vite automáticamente (build `npm run build`, output `dist`). Deploy.
4. Tu app queda en `https://<proyecto>.vercel.app` con HTTPS.

CLI alternativo (en este equipo):

```bash
npm i -g vercel
vercel        # preview
vercel --prod # producción
```

## Opción B — Netlify

1. [netlify.com](https://netlify.com) → **Add new site → Import from Git** → elige el repo.
2. Build `npm run build`, publish `dist` (ya en `netlify.toml`). Deploy.

## Probar en el iPhone

1. Abre la URL (`https://…`) en **Safari** (iOS 16.4+; ideal Safari 26+ para WebCodecs completo).
2. Para instalarla como app: **Compartir → Añadir a inicio**.

> Nota: en Safari, `credentialless` puede no activar el aislamiento; la app sigue funcionando (WebCodecs no lo exige), solo que la IA con hilos va más lenta. En Chrome/Edge de escritorio el aislamiento sí se activa.

## Verificar headers tras desplegar

```bash
curl -sI https://<tu-dominio> | grep -i cross-origin
```
