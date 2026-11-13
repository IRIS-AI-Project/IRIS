import React, { useRef } from "react";
import type { InstallerStep, InstallerScenario } from "./types";
import { MaterialButton } from "../components/MaterialButton";
import { INSTALLER_INFO, type InstallerInfoTopic } from "./InstallerInfoDialog";
import { APP_VERSION } from "../changelog/catalog";
import { useInstallerArtMotion } from "./useInstallerArtMotion";
import {
  IconInterfaceMinus,
  IconInterfaceCross,
  IconInterfaceChevronRight,
  IconInterfaceAlertTriangle,
} from "../CustomIcons";

interface VerticalArtPanelProps {
  currentStep: InstallerStep;
  currentScenario?: InstallerScenario;
  onOpenInfo?: (topic: InstallerInfoTopic) => void;
  onOpenScenario?: () => void;
  onOpenChangelog?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
}

type BottomNotchMode = "bottom-left" | "bottom-right" | "step-left-out";

interface StageVisualConfig {
  backdropSrc: string;
  backdropPosition?: string;
  backdropBleed?: string;
  /** If null, step renders a pure sharp poster banner without a second character cutout on top */
  cutoutSrc: string | null;
  cutoutMode: "protrude-all" | "clip-to-banner" | "none";
  cutoutPoseClass: string;
  bottomNotch: BottomNotchMode;
}

const STEP_VISUALS: Record<InstallerStep, StageVisualConfig> = {
  welcome: {
    backdropSrc: "/brand/installer/bg-step1-sky.png",
    backdropPosition: "center 46%",
    backdropBleed: "3%",
    cutoutSrc: "/brand/installer/cutout-welcome-reaching.png",
    cutoutMode: "clip-to-banner",
    cutoutPoseClass: "pose-reaching",
    bottomNotch: "bottom-left",
  },
  options: {
    backdropSrc: "/brand/installer/bg-step2-options.png",
    backdropPosition: "center center",
    cutoutSrc: null,
    cutoutMode: "none",
    cutoutPoseClass: "",
    bottomNotch: "bottom-right",
  },
  installing: {
    backdropSrc: "/brand/installer/poster-magazine.png",
    backdropPosition: "center center",
    cutoutSrc: null,
    cutoutMode: "none",
    cutoutPoseClass: "",
    bottomNotch: "step-left-out",
  },
  completed: {
    backdropSrc: "/brand/installer/bg-step4-iris-print.png",
    backdropPosition: "center center",
    backdropBleed: "2%",
    cutoutSrc: "/brand/installer/cutout-bloom.png",
    cutoutMode: "clip-to-banner",
    cutoutPoseClass: "pose-bloom",
    bottomNotch: "bottom-left",
  },
};

const UNINSTALL_VISUALS: Record<InstallerStep, StageVisualConfig> = {
  welcome: { ...STEP_VISUALS.welcome, cutoutSrc: "/brand/installer/cutout-uninstall-sad.png" },
  options: { ...STEP_VISUALS.options, backdropSrc: "/brand/installer/poster-uninstall-profile.png", backdropPosition: "42% center" },
  installing: { ...STEP_VISUALS.installing, backdropSrc: "/brand/installer/poster-uninstall-iris.png", backdropPosition: "51% center" },
  completed: { ...STEP_VISUALS.options, backdropSrc: "/brand/installer/poster-uninstall-lollipop.png", backdropPosition: "43% center", bottomNotch: "bottom-left" },
};

/**
 * Concave SVG corner connector ("liquid fillet") that seamlessly curves
 * the dark graphite chassis into the poster's rounded edge.
 */
function ConcaveCorner({
  className,
  rotation = 0,
}: {
  className?: string;
  rotation?: 0 | 90 | 180 | 270;
}) {
  return (
    <svg
      className={`installer-concave-svg ${className ?? ""}`}
      viewBox="0 0 22 22"
      aria-hidden="true"
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }}
    >
      <path
        d="M 0 0 L 0 -1.5 L 23.5 -1.5 L 23.5 22 L 22 22 A 22 22 0 0 0 0 0 Z"
        fill="var(--installer-chassis)"
      />
    </svg>
  );
}

/**
 * Single continuous C1 cubic-Bezier S-curve for Step 03's left step-out.
 * Replaces the two-piece border-radius + ConcaveCorner junction so there is ZERO spike ("зазубрина").
 */
function LeftStepSCurve() {
  return (
    <svg
      className="installer-left-step-scurve"
      viewBox="0 0 29 48"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M -1.5 -1.5 L 29 -1.5 L 29 0 C 29 24, 0 24, 0 48 L -1.5 48 Z"
        fill="var(--installer-chassis)"
      />
    </svg>
  );
}

export function VerticalArtPanel({
  currentStep,
  currentScenario = "normal",
  onOpenInfo,
  onOpenScenario,
  onOpenChangelog,
  onMinimize,
  onClose,
}: VerticalArtPanelProps) {
  const stageRef = useRef<HTMLElement>(null);
  const cutoutWrapRef = useRef<HTMLDivElement>(null);
  const cutoutImgRef = useRef<HTMLImageElement>(null);
  const backdropRef = useRef<HTMLImageElement>(null);

  const isSignpostScenario =
    currentScenario === "low-disk";

  const visual = currentScenario === "uninstall" ? UNINSTALL_VISUALS[currentStep] : STEP_VISUALS[currentStep];
  const activeCutoutSrc = isSignpostScenario
    ? "/brand/installer/cutout-error-sign.png"
    : visual.cutoutSrc;
  const activeCutoutMode = isSignpostScenario ? "protrude-all" : visual.cutoutMode;
  const activePoseClass = isSignpostScenario
    ? "pose-warning-sign"
    : visual.cutoutPoseClass;
  const activeBottomNotch: BottomNotchMode = isSignpostScenario
    ? "bottom-left"
    : visual.bottomNotch;

  const topic: InstallerInfoTopic = currentScenario === "uninstall" ? "removal" : currentStep === "installing" ? "voice" : currentStep === "completed" ? "memory" : "trust";
  const info = INSTALLER_INFO[topic];
  const PocketIcon = isSignpostScenario ? IconInterfaceAlertTriangle : info.icon;
  const pocketTitle = isSignpostScenario
    ? "Мало места"
    : info.button;

  useInstallerArtMotion({ stage: stageRef, foreground: cutoutWrapRef, image: cutoutImgRef, backdrop: backdropRef },
    `${currentStep}:${isSignpostScenario}:${activeCutoutSrc ?? "poster"}`);

  return (
    <aside
      ref={stageRef}
      className={`installer-art-stage step-${currentStep} mode-${activeCutoutMode} notch-${activeBottomNotch}`}
      aria-label="Визуальная сцена Iris"
    >
      {/* 1. Sculpted Poster Vessel */}
      <div className={`installer-poster-vessel is-${activeBottomNotch}`}>
        <img
          ref={backdropRef}
          key={`${currentStep}-${visual.backdropSrc}`}
          src={visual.backdropSrc}
          alt=""
          style={{ objectPosition: visual.backdropPosition ?? "center center",
            "--installer-backdrop-bleed": visual.backdropBleed ?? "4%" } as React.CSSProperties}
          className={`installer-poster-backdrop ${
            activeCutoutSrc ? "has-foreground-character" : "is-pure-banner"
          }`}
          draggable={false}
        />
        <div className="installer-poster-vignette" />

        {/* Step 03 ("step-left-out"): Upper-left sculpted recess with a single continuous
            SVG cubic-Bezier S-curve so the lower half steps out to the left with ZERO spike! */}
        {activeBottomNotch === "step-left-out" && (
          <div className="installer-cutout-notch is-left-step-recess">
            <LeftStepSCurve />
          </div>
        )}

        {/* Top-Left Architectural Notch (houses quiet v0.9.1 button) */}
        <div className="installer-cutout-notch is-top-left" data-tauri-drag-region>
          <ConcaveCorner className="corner-tl-right" rotation={270} />
          <ConcaveCorner className="corner-tl-bottom" rotation={270} />
        </div>

        {/* Top-Right Window Controls Cutout Pocket */}
        <div className="installer-cutout-notch is-top-right">
          <ConcaveCorner className="corner-tr-left" rotation={0} />
          <ConcaveCorner className="corner-tr-bottom" rotation={0} />
        </div>
      </div>

      {/* 2A. Single-Layer Clipped-to-Banner Character (Step 04 Completed):
          Top extends above the frame (-28px) so the crown/buns never get sliced,
          while left, right, bottom, and the bottom-left notch (z-index: 18) cleanly trim her lower silhouette! */}
      {activeCutoutSrc && activeCutoutMode === "clip-to-banner" && (
        <div className="installer-character-clipped-stage">
          <div
            ref={cutoutWrapRef}
            className={`installer-character-clipped ${activePoseClass}`}
          >
            <img
              ref={cutoutImgRef}
              src={activeCutoutSrc}
              alt="Iris"
              className="installer-character-img"
              draggable={false}
            />
          </div>
        </div>
      )}

      {/* Dynamic Bottom Cutout Notches sit at z-index: 18 (above clip-to-banner character,
          below protrude-all character) so they cleanly mask both the poster and Step 04's lower-left corner! */}
      {activeBottomNotch === "bottom-left" && (
        <div className="installer-cutout-notch is-bottom-left">
          <ConcaveCorner className="corner-bl-top" rotation={180} />
          <ConcaveCorner className="corner-bl-right" rotation={180} />
        </div>
      )}

      {(activeBottomNotch === "bottom-right" || activeBottomNotch === "step-left-out") && (
        <div className="installer-cutout-notch is-bottom-right">
          <ConcaveCorner className="corner-br-top" rotation={90} />
          <ConcaveCorner className="corner-br-left" rotation={90} />
        </div>
      )}

      {/* 2B. Full Protruding Foreground Character Layer (Step 01 & Signpost) */}
      {activeCutoutSrc && activeCutoutMode === "protrude-all" && (
        <div
          ref={cutoutWrapRef}
          className={`installer-character-popout ${activePoseClass}`}
        >
          <img
            ref={cutoutImgRef}
            src={activeCutoutSrc}
            alt={isSignpostScenario ? "Предупреждение о нехватке места" : "Iris"}
            className="installer-character-img"
            draggable={false}
          />
        </div>
      )}

      {/* 3. Top-Left Quiet Version Button — no hover jump (surfaceMotion={false}) */}
      <div className="installer-top-left-pocket" data-tauri-drag-region>
        <MaterialButton
          materialKey="installer.win.version"
          appearance="quiet"
          tone="graphite"
          surfaceMotion={false}
          onClick={onOpenChangelog}
          className="installer-version-quiet-btn"
          title="Что нового в Iris"
          aria-label={`Версия ${APP_VERSION} — что нового`}
          aria-haspopup="dialog"
        >
          <span>v{APP_VERSION}</span>
        </MaterialButton>
      </div>

      {/* 4. Top-Right Genuine Iris Window Controls — no hover jump (surfaceMotion={false}) */}
      <div className="installer-window-controls-pocket" aria-label="Управление окном">
        <MaterialButton
          materialKey="installer.win.min"
          appearance="quiet"
          tone="graphite"
          surfaceMotion={false}
          onClick={onMinimize}
          aria-label="Свернуть окно"
          className="installer-win-btn"
        >
          <IconInterfaceMinus size={14} />
        </MaterialButton>

        <MaterialButton
          materialKey="installer.win.close"
          appearance="quiet"
          tone="danger"
          surfaceMotion={false}
          className="window-close installer-win-btn"
          onClick={onClose}
          aria-label="Закрыть установщик"
        >
          <IconInterfaceCross size={15} />
        </MaterialButton>
      </div>

      <MaterialButton materialKey={`installer.info.${isSignpostScenario ? currentScenario : topic}`}
        type="button" tone="graphite" appearance="lens" surfaceMotion={false}
        className={`installer-bento-pocket-card ${activeBottomNotch === "bottom-left" ? "is-left" : "is-right"}`}
        onClick={() => isSignpostScenario ? onOpenScenario?.() : onOpenInfo?.(topic)}
        aria-haspopup="dialog" title={isSignpostScenario ? pocketTitle : info.title}>
        <span className="installer-bento-icon" aria-hidden="true"><PocketIcon size={23} /></span>
        <span className="installer-bento-copy">
          <span className="installer-bento-eyebrow">{isSignpostScenario ? "Подробности" : info.eyebrow}</span>
          <strong className="installer-bento-title">{pocketTitle}</strong>
        </span>
        <IconInterfaceChevronRight className="installer-bento-arrow" size={12} aria-hidden="true" />
      </MaterialButton>
    </aside>
  );
}
