import React, { useEffect, useLayoutEffect, useRef } from "react";
import { PREVIEW_INSTALLED_VERSION, type InstallerMode, type InstallerStep, type InstallOptions, type DiskStatus } from "./types";
import { APP_VERSION } from "../changelog/catalog";
import { ButtonMaterialLayers, MaterialButton } from "../components/MaterialButton";
import { buttonSeed, materialStyle } from "../components/buttonMaterial";
import { AppCheckbox } from "../components/AppCheckbox";
import { animate, prefersReducedMotion } from "../animations/core";
import { VOICE_MODELS_DOWNLOAD_SIZE } from "./voiceModels";
import { InstallerFeatureCard } from "./InstallerFeatureCard";
import { SegmentedProgress } from "../components/SegmentedProgress";
import {
  IconInterfaceArrowRight,
  IconInterfaceCheck,
  IconInterfaceFolder,
} from "../CustomIcons";

interface StepWizardProps {
  mode?: InstallerMode;
  uninstallContent?: React.ReactNode;
  onOpenChangelog?: () => void;
  currentStep: InstallerStep;
  onStepChange: (step: InstallerStep) => void;
  options: InstallOptions;
  onOptionsChange: (options: InstallOptions) => void;
  diskStatus: DiskStatus;
  installProgress: number;
  onProgressChange: React.Dispatch<React.SetStateAction<number>>;
  onFinish: () => void;
  onLaunchIris: () => void;
  onOpenAppFolder: () => void;
}

const STEPS: { id: InstallerStep; num: string; label: string }[] = [
  { id: "welcome", num: "01", label: "Старт" },
  { id: "options", num: "02", label: "Папка" },
  { id: "installing", num: "03", label: "Установка" },
  { id: "completed", num: "04", label: "Готово" },
];

const pillFaceStyle = materialStyle(buttonSeed("installer.step.active-face"), 0.35);

export function StepWizard({
  mode = "install",
  uninstallContent,
  onOpenChangelog,
  currentStep,
  onStepChange,
  options,
  onOptionsChange,
  diskStatus,
  installProgress,
  onProgressChange,
  onLaunchIris,
  onOpenAppFolder,
  onFinish,
}: StepWizardProps) {
  const stepRailRef = useRef<HTMLElement>(null);
  const stepFaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);
  const isUpgrade = mode === "upgrade";
  const stepLabels = mode === "uninstall" ? ["Старт", "Данные", "Удаление", "Готово"]
    : isUpgrade ? ["Старт", "Параметры", "Обновление", "Готово"] : STEPS.map(step => step.label);

  // Animate the sliding dp-lens step indicator with Anime.js v4
  useLayoutEffect(() => {
    const rail = stepRailRef.current;
    const face = stepFaceRef.current;
    if (!rail || !face) return;

    const buttons = rail.querySelectorAll<HTMLButtonElement>(".installer-step-tab");
    const activeBtn = buttons[currentIdx];
    if (!activeBtn) return;

    const x = activeBtn.offsetLeft;
    const w = activeBtn.offsetWidth;

    if (prefersReducedMotion()) {
      face.style.transform = `translateX(${x}px)`;
      face.style.width = `${w}px`;
      face.style.opacity = "1";
      return;
    }

    const anim = animate(face, {
      translateX: x,
      width: w,
      opacity: 1,
      duration: 380,
      ease: "outQuint",
    });

    return () => {
      anim.cancel();
    };
  }, [currentIdx]);

  // Animate step content view entrance with Anime.js v4
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || prefersReducedMotion()) return;

    const anim = animate(view, {
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 300,
      ease: "outCubic",
    });

    return () => {
      anim.cancel();
    };
  }, [currentStep]);

  // Installation progress simulation
  useEffect(() => {
    if (currentStep !== "installing" || mode === "uninstall") return;

    const interval = window.setInterval(() => {
      onProgressChange(prev => Math.min(prev + 4, 100));
    }, 240);

    return () => window.clearInterval(interval);
  }, [currentStep, onProgressChange, onStepChange, mode]);

  useEffect(() => {
    if (currentStep !== "installing" || installProgress < 100 || mode === "uninstall") return;
    const timer = window.setTimeout(() => onStepChange("completed"), 320);
    return () => window.clearTimeout(timer);
  }, [currentStep, installProgress, onStepChange, mode]);

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const requiredGb = formatGb(diskStatus.totalRequiredBytes);
  const freeGb = formatGb(diskStatus.freeBytes);
  const diskPercentage = Math.min(
    100,
    Math.max(6, (diskStatus.totalRequiredBytes / diskStatus.freeBytes) * 100)
  );

  const activePhaseText =
    installProgress > 75
      ? isUpgrade ? "Обновляем ярлыки и завершаем" : "Создаём ярлыки и завершаем установку"
      : installProgress > 38
        ? isUpgrade ? "Обновляем аватар" : "Устанавливаем аватар"
        : isUpgrade ? "Заменяем файлы приложения" : "Распаковываем файлы приложения";

  return (
    <div className="installer-wizard-flow" role="region" aria-label={mode === "uninstall" ? "Этапы удаления" : isUpgrade ? "Этапы обновления" : "Этапы установки"}>
      {/* Genuine Iris Animated Step Rail (SetupStepNavigation style) */}
      <nav ref={stepRailRef} className="installer-step-rail" aria-label={mode === "uninstall" ? "Шаги удаления" : isUpgrade ? "Шаги обновления" : "Шаги установки"}>
        <div
          ref={stepFaceRef}
          className="installer-step-face iris-button dp-lens dp-accent"
          style={pillFaceStyle}
          aria-hidden="true"
        >
          <ButtonMaterialLayers />
        </div>

        {STEPS.map((step, idx) => {
          const isCurrent = step.id === currentStep;
          const isPassed = currentIdx > idx;

          return (
            <button
              key={step.id}
              type="button"
              className={`installer-step-tab ${isCurrent ? "is-current" : ""} ${isPassed ? "is-passed" : ""}`}
              aria-current={isCurrent ? "step" : undefined}
              disabled={mode === "uninstall" && (idx > currentIdx || currentStep === "installing" || currentStep === "completed")}
              onClick={() => {
                if (step.id === "installing") {

                  onProgressChange(42);
                }
                onStepChange(step.id);
              }}
            >
              <span className="installer-step-num">
                {isPassed ? <IconInterfaceCheck size={11} /> : step.num}
              </span>
              <span className="installer-step-name">{stepLabels[idx]}</span>
            </button>
          );
        })}
      </nav>

      {/* Active Step Body */}
      <div ref={viewRef} key={mode === "uninstall" ? "uninstall" : currentStep} className="installer-step-body">
        {mode === "uninstall" ? uninstallContent : <>
        {/* ================================================================
            STEP 01: WELCOME (MINIMALIST & EDITORIAL)
            ================================================================ */}
        {currentStep === "welcome" && (
          <div className="installer-step-pane">
            <div className="installer-copy-block">
              <h1 className="installer-display-title">
                {isUpgrade ? "Обновление Iris" : "Установка Iris"}
              </h1>
              <p className="installer-display-sub">
                {isUpgrade ? "Установим новую версию в текущую папку приложения." : "Голосовой помощник с аватаром и памятью о ваших разговорах."}
              </p>
            </div>

            {isUpgrade ? <div className="installer-surface-card installer-upgrade-summary">
              <div className="installer-version-change"><span><small>Установлена</small><strong>{PREVIEW_INSTALLED_VERSION}</strong></span><IconInterfaceArrowRight size={22} aria-hidden="true" /><span><small>Новая версия</small><strong>{APP_VERSION}</strong></span></div>
              <p>История разговоров, память, API-ключи и настройки сохранятся.</p>
              <p className="installer-options-note">Повторно скачивать установленные речевые модели не нужно.</p>
              <MaterialButton materialKey="installer.upgrade.changelog" appearance="quiet" className="installer-upgrade-changelog" onClick={onOpenChangelog}>Что нового в {APP_VERSION}<IconInterfaceArrowRight size={14} aria-hidden="true" /></MaterialButton>
            </div> : <div className="installer-feature-bento" role="list" aria-label="Что нужно для начала">
              <InstallerFeatureCard materialKey="installer.feature.avatar" image="/brand/installer/feature-app-avatar.png" width={640} height={633} title="Приложение и аватар">
                Iris и 3D-аватар входят в установку.
              </InstallerFeatureCard>
              <InstallerFeatureCard materialKey="installer.feature.voice" image="/brand/installer/feature-voice-mode.png" width={811} height={611} title="Голосовой режим">
                Речевые модели скачиваются отдельно — около {VOICE_MODELS_DOWNLOAD_SIZE}.
              </InstallerFeatureCard>
              <InstallerFeatureCard materialKey="installer.feature.api" image="/brand/installer/feature-neural-api.png" width={858} height={621} title="Подключение нейросети">
                После установки укажите API-ключ выбранного сервиса.
              </InstallerFeatureCard>
            </div>}

            <footer className={`installer-actions-row${isUpgrade ? " installer-upgrade-actions" : ""}`}>
              <MaterialButton
                materialKey="installer.welcome.quick"
                appearance="lens"
                tone={isUpgrade ? "accent" : "graphite"}
                surfaceMotion={true}
                className={isUpgrade ? "primary-button installer-btn-primary" : "secondary installer-btn-secondary"}
                disabled={!diskStatus.hasEnoughSpace}
                onClick={() => {

                  onProgressChange(18);
                  onStepChange("installing");
                }}
              >
                {isUpgrade ? "Обновить Iris" : "Установить"}
              </MaterialButton>

              <MaterialButton
                materialKey="installer.welcome.next"
                appearance="lens"
                tone={isUpgrade ? "graphite" : "accent"}
                surfaceMotion={true}
                className={isUpgrade ? "secondary installer-btn-secondary" : "primary-button installer-btn-primary"}
                onClick={() => onStepChange("options")}
              >
                <span>{isUpgrade ? "Параметры обновления" : "Настроить установку"}</span>
                <IconInterfaceArrowRight size={16} aria-hidden="true" />
              </MaterialButton>
            </footer>
          </div>
        )}

        {/* ================================================================
            STEP 02: OPTIONS (PATH, DISK & SHORTCUTS)
            ================================================================ */}
        {currentStep === "options" && (
          <div className="installer-step-pane">
            <div className={`installer-copy-block${isUpgrade ? "" : " installer-options-heading"}`}>
              {!isUpgrade && <img className="installer-scene-chibi installer-folder-guide" src="/brand/installer/chibi-folder-guide.png" alt="" width={840} height={908} draggable={false} />}

              <h1 className="installer-display-title">
                {isUpgrade ? "Параметры обновления" : "Папка установки"}
              </h1>
              <p className="installer-display-sub">
                {isUpgrade ? "Папка приложения остаётся прежней. Проверьте ярлыки." : "Выберите папку и нужные ярлыки."}
              </p>
            </div>

            <div className="installer-options-stack">
              {/* Unibody Path + Storage Card */}
              <div className="installer-surface-card">
                <div className="installer-path-bar">
                  <span className="installer-path-icon" aria-hidden="true">
                    <IconInterfaceFolder size={16} />
                  </span>
                  <input
                    id="install-path-input"
                    type="text"
                    aria-label="Папка установки"
                    readOnly
                    value={options.installPath}
                    className="installer-path-input"
                    title={options.installPath}
                  />
                  {!isUpgrade && <MaterialButton
                    materialKey="installer.options.browse"
                    appearance="lens"
                    tone="graphite"
                    surfaceMotion={false}
                    className="secondary installer-browse-btn"
                    onClick={() => {
                      const nextPath = options.installPath.startsWith("D:")
                        ? "%LOCALAPPDATA%\\Programs\\Iris"
                        : "D:\\Programs\\Iris";
                      onOptionsChange({ ...options, installPath: nextPath });
                    }}
                  >
                    Обзор…
                  </MaterialButton>}
                </div>

                <div className="installer-disk-strip">
                  <div className="installer-disk-meta">
                    <span>
                      Диск <strong>{diskStatus.driveLetter}</strong> · свободно{" "}
                      <strong>{freeGb} ГБ</strong>
                    </span>
                    <span className={`status-pill ${diskStatus.hasEnoughSpace ? "ok" : "bad"}`}>
                      Нужно {requiredGb} ГБ
                    </span>
                  </div>
                  <div className="installer-storage-track">
                    <div
                      className="installer-storage-fill"
                      style={{ width: `${Math.max(diskPercentage, 10)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Shortcuts Row */}
              <div className="installer-shortcuts-grid">
                <label className="installer-check-card">
                  <AppCheckbox
                    checked={options.startMenuShortcut}
                    onChange={(e) =>
                      onOptionsChange({ ...options, startMenuShortcut: e.target.checked })
                    }
                  />
                  <span>Ярлык в меню «Пуск»</span>
                </label>

                <label className="installer-check-card">
                  <AppCheckbox
                    checked={options.desktopShortcut}
                    onChange={(e) =>
                      onOptionsChange({ ...options, desktopShortcut: e.target.checked })
                    }
                  />
                  <span>На рабочем столе</span>
                </label>
              </div>

              <p className="installer-options-note">История разговоров, память и настройки хранятся отдельно от файлов приложения.</p>
            </div>

            <footer className="installer-actions-row">
              <MaterialButton
                materialKey="installer.options.back"
                appearance="lens"
                tone="graphite"
                surfaceMotion={true}
                className="secondary installer-btn-secondary"
                onClick={() => onStepChange("welcome")}
              >
                Назад
              </MaterialButton>

              <MaterialButton
                materialKey="installer.options.install"
                appearance="lens"
                tone="accent"
                surfaceMotion={true}
                className="primary-button installer-btn-primary"
                disabled={!diskStatus.hasEnoughSpace}
                onClick={() => {

                  onProgressChange(18);
                  onStepChange("installing");
                }}
              >
                <span>{isUpgrade ? "Обновить Iris" : "Установить Iris"}</span>
                <IconInterfaceArrowRight size={16} aria-hidden="true" />
              </MaterialButton>
            </footer>
          </div>
        )}

        {/* ================================================================
            STEP 03: INSTALLING (PROGRESS)
            ================================================================ */}
        {currentStep === "installing" && (
          <div className="installer-step-pane">
            <div className="installer-copy-block">

              <h1 className="installer-display-title">{isUpgrade ? "Обновляем Iris" : "Устанавливаем Iris"}</h1>
            </div>

            <div className="installer-installation-scene">
              <img className="installer-scene-chibi installer-laptop-chibi" src="/brand/installer/chibi-installing-laptop.png" alt="" width={1254} height={1254} draggable={false} />
              <div className="installer-progress-card installer-surface-card">
                <div className="installer-progress-header">
                  <span className="installer-progress-number">{installProgress}%</span>
                  <span className="status-pill">
                    {Math.round((installProgress / 100) * 1800)} / 1800 МБ
                  </span>
                </div>

                <SegmentedProgress className="installer-operation-meter" value={installProgress / 100}
                  label={isUpgrade ? "Обновление Iris" : "Установка Iris"} detail={activePhaseText} now={installProgress} />

                <div className="installer-current-operation" role="status" aria-live="polite" aria-atomic="true">
                  <span>Текущая операция</span>
                  <p>{activePhaseText}</p>
                </div>
              </div>
            </div>

            <footer className="installer-actions-row">
              <MaterialButton
                materialKey="installer.installing.cancel"
                appearance="lens"
                tone="graphite"
                surfaceMotion={true}
                className="secondary installer-btn-secondary"
                onClick={() => onStepChange("options")}
              >
                Отменить
              </MaterialButton>
            </footer>
          </div>
        )}

        {/* ================================================================
            STEP 04: COMPLETED (READY TO LAUNCH)
            ================================================================ */}
        {currentStep === "completed" && (
          <div className="installer-step-pane">
            <div className="installer-copy-block">
              <span className="installer-step-eyebrow">{isUpgrade ? "Обновление завершено" : "Установка завершена"}</span>
              <h1 className="installer-display-title">{isUpgrade ? "Iris обновлена" : "Iris установлена"}</h1>
              <p className="installer-display-sub">
                {isUpgrade ? "Всё готово. Можно вернуться к вашим разговорам." : "Запустите приложение, чтобы настроить диалог и голос."}
              </p>
            </div>

            <div className="installer-surface-card installer-done-card">
              <div className="installer-done-path-row">
                <span className="installer-done-label">{isUpgrade ? `Версия ${APP_VERSION} · папка приложения` : "Установлено в"}</span>
                <code className="installer-done-code">{options.installPath}</code>
              </div>

              <MaterialButton materialKey="installer.completed.folder" appearance="lens" surfaceMotion={false}
                className="secondary installer-folder-link" onClick={onOpenAppFolder}>
                <IconInterfaceFolder size={16} aria-hidden="true" />Открыть папку
              </MaterialButton>
            </div>

            <footer className="installer-actions-row">
              <MaterialButton
                materialKey="installer.completed.finish"
                appearance="lens"
                tone="graphite"
                surfaceMotion={true}
                className="secondary installer-btn-secondary"
                onClick={onFinish}
              >
                Завершить
              </MaterialButton>

              <div className="installer-launch-action">
                <img className="installer-scene-chibi installer-launch-guide" src="/brand/installer/chibi-launch-guide.png" alt="" width={1254} height={1254} draggable={false} />
                <MaterialButton
                  materialKey="installer.completed.launch"
                  appearance="lens"
                  tone="accent"
                  surfaceMotion={true}
                  className="primary-button installer-btn-primary"
                  onClick={onLaunchIris}
                >
                  <span>Запустить Iris</span>
                  <IconInterfaceArrowRight size={16} aria-hidden="true" />
                </MaterialButton>
              </div>
            </footer>
          </div>
        )}
        </>}
      </div>
    </div>
  );
}
