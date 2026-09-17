import { createContext, useContext, useState, type ReactNode } from 'react';

// Mirrors useLibraryNotifications.tsx's provider pattern, but as a bare
// change signal (a version counter) rather than shared state itself --
// OptionsScreen already owns real cookie state (cookiesMode/cookiesBrowser/
// cookieLoaded/etc, with its own optimistic local updates ahead of
// persistence), so duplicating that in a second shared store would just be
// two sources of truth to keep in sync. MainPage's header only needs to know
// "something changed, go refetch" -- bumping this after every persisted
// cookie mutation in Options lets it do exactly that instead of only ever
// refetching once on its own mount (the actual bug this exists to fix).
function useCookiesChangeState() {
  const [version, setVersion] = useState(0);
  const notifyChanged = () => setVersion((v) => v + 1);
  return { version, notifyChanged };
}

type CookiesChangeContextValue = ReturnType<typeof useCookiesChangeState>;

const CookiesChangeContext = createContext<CookiesChangeContextValue | null>(null);

export function CookiesChangeProvider({ children }: { children: ReactNode }) {
  const value = useCookiesChangeState();
  return (
    <CookiesChangeContext.Provider value={value}>
      {children}
    </CookiesChangeContext.Provider>
  );
}

export function useCookiesChange() {
  const ctx = useContext(CookiesChangeContext);
  if (!ctx) {
    throw new Error('useCookiesChange must be used within a CookiesChangeProvider');
  }
  return ctx;
}
