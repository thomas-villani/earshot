declare module 'ggwave' {
  /** Emscripten module factory; accepts Module overrides such as { print, printErr }. */
  const factory: (overrides?: Record<string, unknown>) => Promise<any>;
  export default factory;
}
