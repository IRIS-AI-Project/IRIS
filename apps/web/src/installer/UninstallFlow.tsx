import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { InstallerStep } from "./types";
import { APP_VERSION } from "../changelog/catalog";
import { AppCheckbox } from "../components/AppCheckbox";
import { AppDialog } from "../components/AppDialog";
import { MaterialButton } from "../components/MaterialButton";
import { SegmentedProgress } from "../components/SegmentedProgress";
import { IconInterfaceArrowRight, IconInterfaceCheck, IconMailChatBubbleTextSquare } from "../CustomIcons";

const REASONS = ["Не удалось настроить", "Ошибки или зависания", "Качество ответов", "Проблемы с голосом", "Высокая нагрузка на ПК", "Другое"];
const DATA_GROUPS = [
  { id: "profile", title: "Профиль и настройки", detail: "Подключения, API-ключи и параметры Iris" },
  { id: "history", title: "История разговоров", detail: "Сохранённые диалоги" },
  { id: "memory", title: "Память Iris", detail: "Предпочтения и сохранённые сведения" },
  { id: "models", title: "Речевые модели", detail: "Скачанные модели распознавания и озвучивания" },
] as const;
type DataGroup = typeof DATA_GROUPS[number]["id"];

export function UninstallFlow({ currentStep, onStepChange, progress, onProgressChange, onClose, container }: {
  currentStep: InstallerStep;
  onStepChange: (step: InstallerStep) => void;
  progress: number;
  onProgressChange: Dispatch<SetStateAction<number>>;
  onClose: () => void;
  container: HTMLElement | null;
}) {
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const feedbackPanelRef = useRef<HTMLDivElement>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [keep, setKeep] = useState<Record<DataGroup, boolean>>({ profile: true, history: true, memory: true, models: true });
  const saved = DATA_GROUPS.filter(group => keep[group.id]);
  const removed = DATA_GROUPS.filter(group => !keep[group.id]);
  const report = `Iris ${APP_VERSION} · Обратная связь при удалении\n\nПричины: ${reasons.length ? reasons.join(", ") : "не указаны"}\n\nКомментарий:\n${comment.trim() || "не указан"}`;

  useLayoutEffect(() => {
    if (reportOpen) reportRef.current?.focus();
    else if (feedbackOpen) feedbackPanelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [reportOpen, feedbackOpen]);

  useEffect(() => {
    if (currentStep !== "installing") return;
    const interval = window.setInterval(() => onProgressChange(value => Math.min(100, value + 5)), 240);
    return () => window.clearInterval(interval);
  }, [currentStep, onProgressChange]);
  useEffect(() => {
    if (currentStep !== "installing" || progress < 100) return;
    const timer = window.setTimeout(() => onStepChange("completed"), 320);
    return () => window.clearTimeout(timer);
  }, [currentStep, progress, onStepChange]);

  return <>
    {currentStep === "welcome" && <div className="installer-step-pane">
      <div className="installer-copy-block">
        <h1 className="installer-display-title">Удаление Iris</h1>
        <p className="installer-display-sub">Удалим приложение с компьютера. На следующем шаге вы выберете, какие данные сохранить.</p>
      </div>
      <div className="installer-surface-card installer-uninstall-intro">
        <strong>Что не подошло?</strong>
        <p>Если хотите, расскажите о причине удаления. Этот шаг можно пропустить.</p>
        <label className="installer-checkbox-label">
          <AppCheckbox checked={feedbackEnabled} onChange={event => { setFeedbackEnabled(event.target.checked); if (event.target.checked) setFeedbackOpen(true); }} />
          <span>Хочу оставить обратную связь</span>
        </label>
        {feedbackEnabled && <div className="installer-feedback-summary">
          <span>{reasons.length ? reasons.join(" · ") : "Причина пока не выбрана"}</span>
          <MaterialButton materialKey="uninstall.feedback.edit" appearance="quiet" onClick={() => setFeedbackOpen(true)}>Изменить</MaterialButton>
        </div>}
      </div>
      <p className="installer-options-note">Отчёт доступен только в предпросмотре. Ничего не отправляется.</p>
      <footer className="installer-actions-row">
        <MaterialButton materialKey="uninstall.cancel" className="secondary installer-btn-secondary" onClick={onClose}>Отмена</MaterialButton>
        <MaterialButton materialKey="uninstall.continue" className="primary-button installer-btn-primary" onClick={() => onStepChange("options")}>
          <span>{feedbackEnabled ? "Продолжить" : "Пропустить"}</span><IconInterfaceArrowRight size={16} aria-hidden="true" />
        </MaterialButton>
      </footer>
    </div>}

    {currentStep === "options" && <div className="installer-step-pane installer-retention-pane">
      <div className="installer-copy-block">
        <h1 className="installer-display-title">Что сохранить</h1>
        <p className="installer-display-sub">Отмеченные данные останутся на ПК. Приложение и его ярлыки будут удалены.</p>
      </div>
      <div className="installer-retention-list">
        {DATA_GROUPS.map(group => <label className="installer-check-card installer-retention-row" key={group.id}>
          <AppCheckbox checked={keep[group.id]} onChange={event => setKeep(value => ({ ...value, [group.id]: event.target.checked }))} />
          <span><strong>{group.title}</strong><small>{group.detail}</small></span>
        </label>)}
      </div>
      <p className={`installer-options-note${removed.length ? " installer-removal-warning" : ""}`}>
        {removed.length ? "Неотмеченные данные будут удалены без возможности восстановления." : "При повторной установке сохранённые данные можно использовать снова."}
      </p>
      <footer className="installer-actions-row">
        <MaterialButton materialKey="uninstall.options.back" className="secondary installer-btn-secondary" onClick={() => onStepChange("welcome")}>Назад</MaterialButton>
        <MaterialButton materialKey="uninstall.remove" tone="danger" className="danger-button installer-btn-primary" onClick={() => { onProgressChange(0); onStepChange("installing"); }}>Удалить Iris</MaterialButton>
      </footer>
    </div>}

    {currentStep === "installing" && <div className="installer-step-pane">
      <div className="installer-copy-block"><h1 className="installer-display-title">Удаляем Iris</h1><p className="installer-display-sub">Удаление приложения и выбранных данных.</p></div>
      <div className="installer-surface-card installer-progress-card">
        <div className="installer-progress-header"><span className="installer-progress-number">{progress}%</span></div>
        <SegmentedProgress className="installer-operation-meter" value={progress / 100} now={progress} label="Удаление Iris" />
        <div className="installer-current-operation" role="status" aria-live="polite" aria-atomic="true"><span>Текущая операция</span>
          <p>{progress < 45 ? "Удаляем файлы приложения" : progress < 80 ? removed.length ? "Удаляем выбранные данные" : "Сохраняем ваши данные" : "Удаляем ярлыки и завершаем"}</p>
        </div>
      </div>
      <p className="installer-options-note">{saved.length ? `Сохраняем: ${saved.map(group => group.title).join(", ")}.` : "Личные данные и речевые модели также будут удалены."}</p>
    </div>}

    {currentStep === "completed" && <div className="installer-step-pane">
      <div className="installer-copy-block"><span className="installer-step-eyebrow">Удаление завершено</span><h1 className="installer-display-title">Iris удалена</h1><p className="installer-display-sub">Приложение и его ярлыки удалены с компьютера.</p></div>
      <div className="installer-surface-card installer-uninstall-result">
        <IconInterfaceCheck size={26} aria-hidden="true" />
        <div><strong>{saved.length ? "Сохранено на компьютере" : "Данные удалены"}</strong>
          <p>{saved.length ? saved.map(group => group.title).join(" · ") : "Профиль, история, память и речевые модели удалены вместе с приложением."}</p>
        </div>
      </div>
      {feedbackEnabled && <MaterialButton materialKey="uninstall.report.completed" className="secondary installer-report-button" onClick={() => setReportOpen(true)}>Посмотреть отчёт</MaterialButton>}
      <footer className="installer-actions-row"><MaterialButton materialKey="uninstall.finish" className="primary-button installer-btn-primary" onClick={onClose}>Завершить</MaterialButton></footer>
    </div>}

    <AppDialog open={feedbackOpen || reportOpen} onClose={() => { setFeedbackOpen(false); setReportOpen(false); }} container={container}
      title={reportOpen ? "Предпросмотр отчёта" : "Что не подошло?"}
      description={reportOpen ? "Отчёт не отправляется. Здесь только выбранные причины, ваш комментарий и версия Iris." : "Можно выбрать несколько причин и добавить комментарий."}
      icon={<IconMailChatBubbleTextSquare size={24} aria-hidden="true" />}
      variant="info" className="installer-dialog installer-feedback-dialog" presentation="spotlight" size="wide" showRim={false}>
      {reportOpen ? <>
        <textarea ref={reportRef} className="installer-report-preview" aria-label="Текст отчёта" value={report} readOnly rows={7} />
        <div className="dialog-actions"><MaterialButton materialKey="uninstall.report.back" className="secondary" onClick={() => { setReportOpen(false); setFeedbackOpen(true); }}>Редактировать</MaterialButton><MaterialButton materialKey="uninstall.report.close" className="primary-button" onClick={() => setReportOpen(false)}>Закрыть</MaterialButton></div>
      </> : <>
      <div ref={feedbackPanelRef} className="installer-feedback-reasons">{REASONS.map(reason => <label className="installer-check-card" key={reason}>
        <AppCheckbox checked={reasons.includes(reason)} onChange={event => setReasons(value => event.target.checked ? [...value, reason] : value.filter(item => item !== reason))} /><span>{reason}</span>
      </label>)}</div>
      <label className="installer-comment-label">Комментарий <span>необязательно</span><textarea aria-label="Комментарий к удалению" value={comment} maxLength={2000} rows={3} placeholder="Что произошло и чего вам не хватило?" onChange={event => setComment(event.target.value)} /></label>
      <div className="dialog-actions">
        <MaterialButton materialKey="uninstall.report.preview" className="secondary" onClick={() => { setFeedbackOpen(false); setReportOpen(true); }}>Предпросмотр отчёта</MaterialButton>
        <MaterialButton materialKey="uninstall.feedback.done" className="primary-button" onClick={() => setFeedbackOpen(false)}>Готово</MaterialButton>
      </div>
      </>}
    </AppDialog>
  </>;
}
