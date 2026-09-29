// React Native exposes the JS global object as `global`; whisper.rn's
// TypeScript sources reference it directly. Ambient globals must use `var`.
// eslint-disable-next-line no-var
declare var global: typeof globalThis;
