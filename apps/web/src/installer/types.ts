export type InstallerStep = "welcome" | "options" | "installing" | "completed";
export type InstallerMode = "install" | "upgrade" | "uninstall";
// Preview fixture; the native installer will supply the detected installation.
export const PREVIEW_INSTALLED_VERSION = "0.8.4";

export type InstallerScenario =
  | "normal"
  | "upgrade"
  | "reinstall"
  | "low-disk"
  | "process-running"
  | "uninstall";

export interface InstallOptions {
  installPath: string;
  desktopShortcut: boolean;
  startMenuShortcut: boolean;
}

export interface DiskStatus {
  totalRequiredBytes: number;
  freeBytes: number;
  driveLetter: string;
  hasEnoughSpace: boolean;
}
