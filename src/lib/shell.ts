import { createContext, useContext } from "react";

/**
 * What a page can ask of the shell around it: the phone drawer and the one
 * "Create agent" dialog the shell owns. Outside a shell — a page rendered on
 * its own in a test, the welcome flow — every call is a no-op.
 */
export type ShellApi = {
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  /** "New agent", empty or filled in from a use case. */
  openCreateAgent: (initial?: CreateAgentInitial) => void;
};

/**
 * What "New agent" opens filled with when an agent card on the use-cases
 * page asked for it. Everything stays editable; `trackAs` is the onboarding
 * step a create is counted under (`use-case:<id>`).
 */
export type CreateAgentInitial = {
  name: string;
  avatar: string | null;
  persona: string;
  webSearch?: boolean;
  mode?: "normal" | "brainstorm";
  trackAs?: string;
};

const NOOP: ShellApi = {
  drawerOpen: false,
  openDrawer: () => {},
  closeDrawer: () => {},
  openCreateAgent: () => {},
};

export const ShellContext = createContext<ShellApi>(NOOP);

export function useShell(): ShellApi {
  return useContext(ShellContext);
}
