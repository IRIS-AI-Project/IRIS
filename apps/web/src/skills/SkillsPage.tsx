import { emit } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, Plug, Settings2 } from "lucide-react";
import { AppCheckbox } from "../components/AppCheckbox";
import { Disclosure } from "../components/Disclosure";
import { MaterialButton } from "../components/MaterialButton";
import { isDesktopApp } from "../desktop";
import { closeEditor, EDITOR_SETTING_EVENT, getSkills, patchEditor, toggleEditor, type EditorAvailability, type SkillsCatalog } from "./api";
import { DEFAULT_QUICK_ACTIONS, QUICK_ACTION_ORDER, QUICK_ACTIONS } from "./quickActions";
import { SkillArtwork } from "./SkillArtwork";
import "./skills.css";

type SkillId = keyof SkillsCatalog;

const SKILLS: Record<SkillId, { title: string; description: string; art?: string }> = {
  web_search: { title: "Поиск в интернете", description: "Ирис находит свежие сведения и проверяет факты по источникам." },
  reminders: { title: "Напоминания", description: "Скажите Ирис, о чём и когда напомнить." },
  text_editor: { title: "Редактор текста", description: "Исправляет, сокращает и переводит выделенный или вставленный текст." },
};

function SkillCard({ id, status, statusTone, children, note, error, settings }: {
  id: SkillId;
  status?: string;
  statusTone?: "active" | "warning";
  children?: ReactNode;
  note?: string;
  error?: ReactNode;
  settings?: ReactNode;
}) {
  const { title, description, art } = SKILLS[id];
  return (
    <article className="skills-card" aria-labelledby={`skill-${id}`}>
      <div className="skills-card-main">
        <div className="skills-card-copy">
          <h3 id={`skill-${id}`}>{title}</h3>
          <p>{description}</p>
          {note && <p className="skills-card-note">{note}</p>}
        </div>
        <div className="skills-card-art" aria-hidden="true">
          {art ? <img src={art} alt="" loading="lazy" /> : <SkillArtwork id={id} />}
        </div>
      </div>
      {(status || children || error) && <div className="skills-card-bottom">
        <div className="skills-card-footer">
          {status && <span className={statusTone ? `settings-status-pill is-${statusTone}` : "settings-status-pill"} role="status">{status}</span>}
          {children && <div className="skills-card-actions">{children}</div>}
        </div>
        {error}
        {settings}
      </div>}
    </article>
  );
}

type CatalogState = { phase: "loading" | "failed" } | { phase: "ready"; data: SkillsCatalog };

export function SkillsPage({ active, onOpenInternet, onOpenDeepSeek }: {
  active: boolean;
  onOpenInternet: () => void;
  onOpenDeepSeek: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [syncError, setSyncError] = useState<EditorAvailability | null>(null);
  const savingRef = useRef(false);
  const desktop = isDesktopApp();

  useEffect(() => {
    if (!active || savingRef.current) return;
    const controller = new AbortController();
    setCatalog({ phase: "loading" });
    void getSkills(controller.signal).then(
      data => { if (!controller.signal.aborted) setCatalog({ phase: "ready", data }); },
      () => { if (!controller.signal.aborted) setCatalog({ phase: "failed" }); },
    );
    return () => controller.abort();
  }, [active, attempt]);

  const data = catalog.phase === "ready" ? catalog.data : null;
  const editor = data?.text_editor;
  const quickActions = editor?.quick_actions ?? DEFAULT_QUICK_ACTIONS;
  const needsKey = desktop && editor?.model_available === false;
  const syncPending = syncError !== null && editor?.revision === syncError.revision && editor.enabled === syncError.enabled;
  const editorStatus = !desktop ? "Только в приложении для Windows"
    : saving ? "Сохраняем…"
    : needsKey ? "Нужен ключ DeepSeek"
    : editor ? (editor.enabled ? "Подключён" : "Не подключён")
    : undefined;

  async function saveEditor(save: () => Promise<EditorAvailability>) {
    if (!editor || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      const next = syncPending ? editor : await save();
      setCatalog(current => current.phase === "ready"
        ? { phase: "ready", data: { ...current.data, text_editor: next } }
        : current);
      const update = await Promise.allSettled([
        emit(EDITOR_SETTING_EVENT, next),
        ...(!next.enabled ? [closeEditor(null)] : []),
      ]);
      setSyncError(update.some(result => result.status === "rejected") ? next : null);
    } catch {
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="panel skills-page" aria-label="Навыки Ирис">
      <div className="skills-groups">
        <p className="skills-intro">В разговоре Ирис сама выбирает подходящий навык. Дополнительные возможности можно подключить здесь.</p>
        {catalog.phase === "loading" && <p className="skills-feedback" role="status">Проверяем доступность навыков…</p>}
        {catalog.phase === "failed" && <div className="skills-feedback">
          <p role="alert">Не удалось проверить доступность навыков.</p>
          <MaterialButton type="button" materialKey="skills.refresh" className="skills-action"
            onClick={() => setAttempt(value => value + 1)}>Повторить</MaterialButton>
        </div>}
        <section className="skills-group" aria-labelledby="skills-builtin">
          <h2 id="skills-builtin">Встроенные</h2>
          <div className="skills-row skills-row--lead">
            <SkillCard id="web_search" status={data ? (data.web_search ? "Доступен" : "Недоступен") : undefined}
              statusTone={data?.web_search ? "active" : undefined}>
              <MaterialButton type="button" materialKey="skills.internet" className="skills-action" onClick={onOpenInternet}>
                <Settings2 size={16} aria-hidden="true" /> Настройки поиска
              </MaterialButton>
            </SkillCard>
            <SkillCard id="reminders" status={data ? (data.reminders ? "Доступны" : "Временно недоступны") : undefined}
              statusTone={data?.reminders ? "active" : undefined} />
          </div>
        </section>
        <section className="skills-group" aria-labelledby="skills-connectable">
          <h2 id="skills-connectable">Подключаемые</h2>
          <div className="skills-row">
            <SkillCard id="text_editor" status={editorStatus}
              statusTone={saving ? undefined : needsKey ? "warning" : desktop && editor?.enabled ? "active" : undefined}
              note={desktop ? "Действия у аватара отправляют выбранный текст в DeepSeek. Если выделение недоступно, кнопка берёт текст из буфера обмена." : undefined}
              settings={desktop && editor?.enabled && <Disclosure materialKey="skills.editor.quick"
                className="skills-quick" label="Кнопки у аватара">
                <fieldset className="skills-quick-actions" disabled={saving || syncPending}>
                  <legend>Показывать в панели инструментов</legend>
                  {QUICK_ACTION_ORDER.map(action => {
                    const { icon: Glyph, label } = QUICK_ACTIONS[action];
                    const checked = quickActions.includes(action);
                    return <label key={action}>
                      <AppCheckbox checked={checked} disabled={checked && quickActions.length === 1}
                        onChange={event => {
                          const next = event.target.checked ? [...quickActions, action] : quickActions.filter(item => item !== action);
                          void saveEditor(() => patchEditor({ quick_actions: QUICK_ACTION_ORDER.filter(item => next.includes(item)) }));
                        }} />
                      <Glyph size={17} aria-hidden="true" /> {label}
                    </label>;
                  })}
                </fieldset>
              </Disclosure>}
              error={saveError ? <p className="skills-error" role="alert">Не удалось сохранить настройку. Попробуйте ещё раз.</p>
                : syncPending ? <p className="skills-error" role="alert">Настройка сохранена. Не удалось обновить настольный интерфейс.</p> : undefined}>
              {needsKey && !syncPending && <MaterialButton type="button" materialKey="skills.editor.key" className="skills-action"
                disabled={saving} onClick={onOpenDeepSeek}><KeyRound size={16} aria-hidden="true" /> Настроить ключ</MaterialButton>}
              {desktop && editor && (syncPending || editor.enabled || !needsKey) &&
                <MaterialButton type="button" materialKey="skills.editor.connection" className="skills-action"
                  tone={editor.enabled || syncPending ? "graphite" : "accent"} disabled={saving}
                  onClick={() => void saveEditor(() => toggleEditor(!editor.enabled))}>
                  <Plug size={16} aria-hidden="true" />
                  {syncPending ? "Повторить обновление" : editor.enabled ? "Отключить" : "Подключить"}
                </MaterialButton>}
            </SkillCard>
          </div>
        </section>
      </div>
    </section>
  );
}
