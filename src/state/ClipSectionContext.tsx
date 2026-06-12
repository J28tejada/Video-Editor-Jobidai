import { createContext, useContext, useState, type ReactNode } from 'react';

export type ClipSection = 'removeBg' | 'speed' | 'color' | 'frame' | 'audio' | null;

const Ctx = createContext<{
  section: ClipSection;
  setSection: (s: ClipSection) => void;
}>({ section: null, setSection: () => {} });

export function ClipSectionProvider({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<ClipSection>(null);
  return <Ctx.Provider value={{ section, setSection }}>{children}</Ctx.Provider>;
}

export const useClipSection = () => useContext(Ctx);
