import type { ReactNode } from "react";
import { ShellContext, type ShellApi } from "@/lib/shell";

export function ShellProvider({ value, children }: { value: ShellApi; children: ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
