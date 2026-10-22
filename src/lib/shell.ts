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
  openCreateAgent: () => void;
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
