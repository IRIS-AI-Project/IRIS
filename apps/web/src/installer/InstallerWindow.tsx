import React, { useState, useEffect } from "react";
import type {
  InstallerStep,
  InstallOptions,
  DiskStatus,
  InstallerScenario,
  InstallerMode,
} from "./types";
import { VerticalArtPanel } from "./VerticalArtPanel";
import { StepWizard } from "./StepWizard";
import { ChangelogDialog } from "../components/Changelog";
import { InstallerInfoDialog, type InstallerInfoTopic } from "./InstallerInfoDialog";
import { UninstallFlow } from "./UninstallFlow";
import {
  ProcessLockDialog,
  LowDiskDialog,
} from "./InstallerDialogs";

interface InstallerWindowProps {
  currentScenario?: InstallerScenario;
  onScenarioChange?: (scenario: InstallerScenario) => void;
  onClose?: () => void;
  onMinimize?: () => void;
  onLaunchIris?: () => void;
  onOpenAppFolder?: () => void;
}

export function InstallerWindow(props: InstallerWindowProps) {
  const mode: InstallerMode = props.currentScenario === "uninstall" ? "uninstall" : props.currentScenario === "upgrade" ? "upgrade" : "install";
  return <InstallerSession key={mode} {...props} mode={mode} />;
}

function InstallerSession({
  currentScenario = "normal",
  onScenarioChange,
  onClose,
  onMinimize,
  onLaunchIris,
  onOpenAppFolder,
  mode,
}: InstallerWindowProps & { mode: InstallerMode }) {
  const [dialogContainer, setDialogContainer] = useState<HTMLDivElement | null>(null);
  const [currentStep, setCurrentStep] = useState<InstallerStep>("welcome");
  const [installProgress, setInstallProgress] = useState(28);
  const [infoTopic, setInfoTopic] = useState<InstallerInfoTopic | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [scenarioDialogDismissed, setScenarioDialogDismissed] = useState(false);

  // Reset dialog dismissal whenever scenario changes from the preview toolbar
  useEffect(() => {
    setScenarioDialogDismissed(false);
  }, [currentScenario]);

  const [options, setOptions] = useState<InstallOptions>({
    installPath: "%LOCALAPPDATA%\\Programs\\Iris",
    desktopShortcut: false,
    startMenuShortcut: true,
  });

  const driveLetter = options.installPath.startsWith("D:") ? "D:" : "C:";
  const lowDisk = currentScenario === "low-disk" && driveLetter === "C:";
  const diskStatus: DiskStatus = {
    totalRequiredBytes: 1.8 * 1024 * 1024 * 1024,
    freeBytes:
      lowDisk
        ? 640 * 1024 * 1024
        : driveLetter === "D:"
          ? 318.6 * 1024 * 1024 * 1024
          : 142.4 * 1024 * 1024 * 1024,
    driveLetter,
    hasEnoughSpace: !lowDisk,
  };

  return (
    <div
      ref={setDialogContainer}
      className="installer-window"
    >
      {/* ====================================================================
          LEFT WORKSTAGE: Single Brand Lockup + Step Rail + Typography & Controls
          ==================================================================== */}
      <div className="installer-left-workstage">
        {/* Top Brand Row — strictly ONE logo in the entire installer */}
        <header className="installer-brand-bar" data-tauri-drag-region>
          <span className="brand-lockup brand-lockup-wordmark installer-brand-lockup">
            <img
              className="brand-logo"
              src="/brand/iris-wordmark-light.svg"
              alt="Iris"
              draggable={false}
            />
          </span>
        </header>

        {/* 4-Step Flow */}
        <StepWizard
          mode={mode}
          onOpenChangelog={() => setChangelogOpen(true)}
          currentStep={currentStep}
          onStepChange={setCurrentStep}
          options={options}
          onOptionsChange={setOptions}
          diskStatus={diskStatus}
          installProgress={installProgress}
          onProgressChange={setInstallProgress}
          onLaunchIris={() => onLaunchIris?.()}
          onOpenAppFolder={() => onOpenAppFolder?.()}
          onFinish={() => onClose?.()}
          uninstallContent={mode === "uninstall" ? <UninstallFlow currentStep={currentStep} onStepChange={setCurrentStep}
            progress={installProgress} onProgressChange={setInstallProgress} onClose={() => onClose?.()}
            container={dialogContainer} /> : undefined}
        />
      </div>

      {/* ====================================================================
          RIGHT SCULPTED ART STAGE: Liquid Notches + Protruding Iris Cutout
          ==================================================================== */}
      <VerticalArtPanel
        currentStep={currentStep}
        currentScenario={currentScenario}
        onOpenInfo={setInfoTopic}
        onOpenScenario={() => setScenarioDialogDismissed(false)}
        onOpenChangelog={() => setChangelogOpen(true)}
        onMinimize={onMinimize}
        onClose={onClose}
      />

      {/* In-Window Modal Dialogs using genuine Iris AppDialog */}
      {dialogContainer && <>
        <ChangelogDialog open={changelogOpen} onClose={() => setChangelogOpen(false)}
          installedVersion={null} container={dialogContainer} />
        <InstallerInfoDialog
          topic={infoTopic ?? "trust"}
          open={infoTopic !== null}
          onClose={() => setInfoTopic(null)}
          container={dialogContainer}
        />

        <ProcessLockDialog
          open={currentScenario === "process-running" && !scenarioDialogDismissed}
          onCloseAppAndRetry={() => {
            if (onScenarioChange) onScenarioChange("normal");
          }}
          onCancel={() => setScenarioDialogDismissed(true)}
          container={dialogContainer}
        />

        <LowDiskDialog
          open={currentScenario === "low-disk" && !scenarioDialogDismissed}
          onSelectAnotherDrive={() => {
            setOptions({ ...options, installPath: "D:\\Programs\\Iris" });
            if (onScenarioChange) onScenarioChange("normal");
            setCurrentStep("options");
          }}
          onCancel={() => setScenarioDialogDismissed(true)}
          container={dialogContainer}
        />

      </>}
    </div>
  );
}
