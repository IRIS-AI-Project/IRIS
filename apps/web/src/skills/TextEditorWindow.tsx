import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Check, ChevronDown, Clipboard, Copy, Languages, RefreshCw, X } from "lucide-react";
import { animate, prefersReducedMotion } from "../animations/core";
import { AppSwitch } from "../components/AppSwitch";
import { Disclosure } from "../components/Disclosure";
import { MaterialButton } from "../components/MaterialButton";
import { closeEditor, EDITOR_SETTING_EVENT, editorPresence, generateEdit, type EditorAvailability,
  type EditorSelection, type EditorUpdates } from "./api";
import { QUICK_ACTIONS } from "./quickActions";
import "./TextEditor.css";

const PRESETS = ["fix", "simplify", "shorten", "format"] as const;
const LANGUAGES = ["английский", "русский", "немецкий", "французский", "испанский", "китайский", "японский"];
const TONES = ["деловой", "дружелюбный", "нейтральный"];

type SourceDocument = { draft: string; original: string | null; selection: EditorSelection | null };
type Change = { instruction: string; example: string };
type EditRequest = Change & { translating?: boolean };
const EMPTY: SourceDocument = { draft: "", original: null, selection: null };
const NEED_SOURCE = "Какой текст отредактировать? Укажите черновик, возьмите выделение или вставьте текст.";

export function TextEditorWindow() {
  const surface = useRef<HTMLElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const [editorId] = useState(() => crypto.randomUUID());
  const session = useRef<{ id: number; revision: number } | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const closing = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [working, setWorking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [doc, setDoc] = useState<SourceDocument>(EMPTY);
  const current = useRef(doc);
  const [change, setChange] = useState<Change>({ instruction: "", example: "" });
  const queuedChange = useRef<Change | null>(null);
  const [retry, setRetry] = useState<EditRequest | null>(null);
  const [needSource, setNeedSource] = useState(false);
  const [cloud, setCloud] = useState(false);
  const [more, setMore] = useState(false);
  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [changed, setChanged] = useState(false);
  const [copied, setCopied] = useState(false);

  function show(next: SourceDocument) {
    current.current = next;
    setDoc(next);
    setCopied(false);
  }

  function cancel(message = "") {
    operation.current?.abort();
    operation.current = null;
    setWorking(false);
    setStatus(message);
  }

  async function close() {
    if (closing.current) return;
    closing.current = true;
    setCloud(false);
    cancel();
    void editorPresence(editorId, null).catch(() => undefined);
    try {
      await closeEditor(session.current?.id ?? null);
    } catch {
      closing.current = false;
      setError("Не удалось закрыть окно. Попробуйте ещё раз.");
    }
  }

  async function run(next: EditRequest, authorized = cloud) {
    const active = session.current;
    const source = current.current;
    if (!active || closing.current || !source.draft.trim() || !next.instruction.trim() || !authorized) return;
    const { translating, ...change } = next;
    cancel();
    const request = new AbortController();
    operation.current = request;
    queuedChange.current = null;
    setNeedSource(false);
    setRetry(null);
    setError("");
    setWorking(true);
    setStatus(translating ? "Перевожу…" : "Редактирую…");
    const frozen = { ...source, original: source.original ?? source.draft };
    show(frozen);
    try {
      const result = await generateEdit({ revision: active.revision, text: source.draft, ...change }, request.signal);
      if (operation.current !== request) return;
      show({ ...frozen, draft: result.text });
      setChanged(true);
      setStatus(translating ? "Перевод готов." : "Правка готова.");
    } catch (cause) {
      if (operation.current !== request) return;
      setStatus("");
      setError(cause instanceof Error ? cause.message : "Не удалось отредактировать текст.");
      setRetry(next);
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setWorking(false);
      }
    }
  }

  function setSource(selection: EditorSelection) {
    cancel();
    setRetry(null);
    if (!selection.text) {
      show({ ...current.current, selection: null });
      return false;
    }
    setChanged(false);
    show({ original: selection.text, draft: selection.text, selection });
    return true;
  }

  function resolveSource(next: Change | null) {
    queuedChange.current = null;
    setNeedSource(false);
    if (next?.instruction.trim()) {
      setChange(next);
      if (cloud) void run(next);
      else setStatus("Указание принято. Разрешите отправку текста и запустите правку.");
    }
  }

  const applyUpdates = useEffectEvent((payload: EditorUpdates) => {
    if (closing.current) return;
    if (session.current?.id !== payload.id) {
      cancel();
      show(EMPTY);
      queuedChange.current = null;
      setChange({ instruction: "", example: "" });
      setRetry(null);
      setNeedSource(false);
      setError("");
      setCloud(false);
      setMore(false);
      setChanged(false);
    }
    const maySend = session.current?.id === payload.id && cloud;
    session.current = { id: payload.id, revision: payload.revision };
    setRevision(payload.revision);
    for (const update of payload.updates) {
      const captured = update.selection ? setSource(update.selection) : false;
      if (!update.voice) continue;
      cancel();
      setRetry(null);
      setError("");
      const { source, instruction, example } = update.voice;
      const next = instruction.trim() ? { instruction, example } : queuedChange.current;
      if (next) { setChange(next); setMore(true); }
      if (source === "clarify" || (source === "selection" && !captured) || !current.current.draft.trim()) {
        queuedChange.current = next;
        setNeedSource(true);
        setStatus(NEED_SOURCE);
        continue;
      }
      queuedChange.current = null;
      setNeedSource(false);
      if (maySend && next) void run(next);
      else if (next) setStatus("Указание принято. Разрешите отправку текста и запустите правку.");
    }
  });

  const onNativeClose = useEffectEvent(() => { void close(); });
  const onSetting = useEffectEvent((setting: EditorAvailability) => {
    if (!setting.enabled || (session.current && setting.revision !== session.current.revision)) void close();
  });

  useEffect(() => {
    let disposed = false;
    let drain = Promise.resolve();
    function read() {
      drain = drain.then(async () => {
        if (disposed) return;
        const payload = await invoke<EditorUpdates>("take_text_editor_updates", { id: null });
        if (!disposed) {
          closing.current = false;
          applyUpdates(payload);
        }
      }).catch(() => { if (!disposed) onNativeClose(); });
    }
    const subscriptions = [
      listen("text-editor-update", read),
      listen("text-editor-close-requested", onNativeClose),
      listen<EditorAvailability>(EDITOR_SETTING_EVENT, ({ payload }) => onSetting(payload)),
    ];
    void Promise.all(subscriptions).then(read, () => { if (!disposed) onNativeClose(); });
    return () => {
      disposed = true;
      operation.current?.abort();
      for (const subscription of subscriptions) void subscription.then(unlisten => unlisten(), () => undefined);
    };
  }, []);

  const hasDraft = Boolean(doc.draft.trim());
  useEffect(() => {
    if (revision === null) return;
    const controller = new AbortController();
    function publish() {
      if (closing.current) return;
      void editorPresence(editorId, { revision: revision!, has_draft: hasDraft, pending_source: needSource }, controller.signal)
        .catch(cause => {
          if (!controller.signal.aborted && cause instanceof Error && cause.message === "Сессия редактора закрыта.") onNativeClose();
        });
    }
    publish();
    const timer = window.setInterval(publish, 20_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [editorId, hasDraft, needSource, revision]);

  useEffect(() => {
    if (!surface.current || prefersReducedMotion()) return;
    const entrance = animate(surface.current, { opacity: [0, 1], y: [5, 0], duration: 180, ease: "outCubic" });
    return () => { entrance.cancel(); };
  }, []);

  useEffect(() => () => {
    if (session.current && !closing.current) void editorPresence(editorId, null).catch(() => undefined);
  }, [editorId]);

  useEffect(() => {
    if (!feedback.current || !status || prefersReducedMotion()) return;
    const motion = animate(feedback.current, { opacity: [.5, 1], duration: 160, ease: "outCubic" });
    return () => { motion.cancel(); };
  }, [status]);

  useEffect(() => {
    function invalidateReplacement() {
      const source = current.current;
      if (source.selection?.replaceable) show({ ...source, selection: { ...source.selection, replaceable: false } });
    }
    function blur() {
      invalidateReplacement();
      void close();
    }
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);

  async function capture() {
    const active = session.current;
    if (!active) return;
    setCapturing(true);
    setError("");
    setStatus("");
    try {
      const selection = await invoke<EditorSelection>("capture_editor_selection", { id: active.id });
      if (closing.current || session.current?.id !== active.id) return;
      if (setSource(selection)) resolveSource(queuedChange.current);
      else setStatus("Текст не найден. Вставьте его сюда вручную.");
    } catch {
      setError("Не удалось получить текст.");
    } finally {
      setCapturing(false);
    }
  }

  async function copy() {
    const text = current.current.draft;
    try {
      await navigator.clipboard.writeText(text);
      if (current.current.draft !== text) return;
      setError("");
      setCopied(true);
      setStatus("Скопировано.");
    } catch {
      setError("Не удалось открыть буфер обмена. Выделите текст в черновике и скопируйте его вручную.");
    }
  }

  async function replace() {
    const active = session.current;
    const source = current.current;
    if (!active || !source.selection?.replaceable) return;
    setApplying(true);
    setError("");
    setStatus("");
    try {
      await invoke("replace_editor_selection", { id: active.id, selectionId: source.selection.id, text: source.draft });
      setStatus("Выделение заменено.");
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Не удалось заменить выделение. Скопируйте черновик вручную.");
    } finally {
      if (current.current.selection?.id === source.selection.id) {
        show({ ...current.current, selection: { ...source.selection, replaceable: false } });
      }
      setApplying(false);
    }
  }

  const canStart = revision !== null && hasDraft && !needSource && !working && !applying && !capturing;
  const canGenerate = canStart && cloud;
  function preset(instruction: string) { void run({ instruction, example: change.example }); }
  const source = doc.original ?? doc.draft;
  const target = language || ((source.match(/[а-яё]/gi)?.length ?? 0) > (source.match(/[a-z]/gi)?.length ?? 0) ? "английский" : "русский");
  const sourceName = doc.selection?.clipboard ? "Буфер обмена" : doc.selection ? "Выделение" : "Ввод вручную";
  function translate() {
    setCloud(true);
    void run({ instruction: `Переведи текст на ${target} язык.`, example: "", translating: true }, true);
  }

  return <section ref={surface} className="text-editor is-window"
    aria-labelledby="text-editor-title" data-i18n-skip
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void close();
      }
    }}>
    <header className="text-editor-header">
      <h1 id="text-editor-title" tabIndex={-1} data-tauri-drag-region>Перевод и правка</h1>
      <MaterialButton materialKey="editor.capture" tone="graphite" appearance="quiet" type="button"
        className="text-editor-icon" disabled={revision === null || working || applying || capturing}
        aria-label="Взять выделение или текст из буфера" title="Взять выделение или текст из буфера"
        onClick={() => void capture()}><RefreshCw size={16} aria-hidden="true" /></MaterialButton>
      <MaterialButton materialKey="editor.close" tone="graphite" appearance="quiet" type="button"
        className="text-editor-icon" aria-label="Закрыть редактор" onClick={() => void close()}>
        <X size={18} aria-hidden="true" />
      </MaterialButton>
    </header>

    <div className="text-editor-body">
      <div className="text-editor-source">
        <label htmlFor="text-editor-draft">{changed ? "Результат" : "Текст"}</label>
        <span className="text-editor-origin" title={doc.selection?.application || undefined}>
          {doc.selection?.clipboard && <Clipboard size={13} aria-hidden="true" />}
          {sourceName}
        </span>
      </div>
      <textarea id="text-editor-draft" ref={draftField} className="text-editor-draft" rows={3} value={doc.draft}
        maxLength={12000} disabled={revision === null || applying} aria-busy={working || capturing}
        placeholder="Выделите, скопируйте или введите текст" onChange={event => {
          cancel(); setRetry(null); setError(""); show({ ...current.current, draft: event.target.value });
        }} />

      {needSource && hasDraft && <MaterialButton materialKey="editor.use-draft" tone="graphite" type="button"
        onClick={() => resolveSource(queuedChange.current)}>Использовать черновик</MaterialButton>}

      <div className="text-editor-options">
        <label className="text-editor-select">
          <select value={target} aria-label="Язык перевода" disabled={working || applying} onChange={event => setLanguage(event.target.value)}>
            {LANGUAGES.map(item => <option key={item} value={item}>На {item}</option>)}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </label>
        {working ? <MaterialButton materialKey="editor.cancel" tone="graphite" type="button"
          onClick={() => cancel("Правка отменена.")}>Отменить</MaterialButton>
          : <MaterialButton materialKey="editor.translate" tone="accent" type="button" disabled={!canStart}
            aria-describedby={cloud ? undefined : "text-editor-consent-note"} onClick={translate}>
            {cloud && <Languages size={17} aria-hidden="true" />}
            {cloud ? "Перевести" : "Разрешить и перевести"}
          </MaterialButton>}
      </div>
      {hasDraft && (changed || doc.draft !== doc.original) && <div className="text-editor-actions text-editor-output">
        {doc.selection?.replaceable && doc.draft !== doc.original && <MaterialButton materialKey="editor.replace"
          tone="graphite" type="button" disabled={working || applying || capturing}
          onClick={() => void replace()}>Заменить выделение</MaterialButton>}
        <MaterialButton materialKey="editor.copy" tone="graphite" appearance="quiet" type="button"
          disabled={working || applying} onClick={() => void copy()}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copied ? "Скопировано" : "Копировать"}
        </MaterialButton>
      </div>}

      <div ref={feedback} className="text-editor-feedback">
        {status && <p role="status">{status}</p>}
        {error && <p role="alert">{error}</p>}
        {retry && <MaterialButton materialKey="editor.retry" tone="graphite" appearance="quiet" type="button"
          disabled={!canGenerate} onClick={() => void run(retry)}>Повторить</MaterialButton>}
      </div>

      {doc.original !== null && doc.draft !== doc.original && <Disclosure materialKey="editor.compare" label="Сравнить с исходником">
        <label className="text-editor-field">Исходный текст<textarea value={doc.original} rows={3} readOnly /></label>
      </Disclosure>}

      <div id="text-editor-consent-note">
        <AppSwitch className="text-editor-consent" checked={cloud} disabled={revision === null}
          label="Разрешить отправку в DeepSeek" description="Текст, указания и примеры · до закрытия редактора"
          onChange={value => { setCloud(value); if (!value) cancel(); }} />
      </div>
      <div className="text-editor-actions text-editor-presets" aria-label="Быстрые правки" role="group">
        {PRESETS.map(action => {
          const { label, instruction } = QUICK_ACTIONS[action];
          return <MaterialButton key={action} materialKey={`editor.preset.${label}`}
            tone="graphite" type="button" disabled={!canGenerate} onClick={() => preset(instruction)}>{label}</MaterialButton>;
        })}
      </div>
      <Disclosure materialKey="editor.more" label="Другие правки" open={more} onOpenChange={setMore}
        contentClassName="text-editor-more">
        {doc.original !== null && <MaterialButton materialKey="editor.manual" tone="graphite" appearance="quiet" type="button"
          disabled={working || applying || capturing} onClick={() => {
            cancel(); show(EMPTY); setChanged(false); setRetry(null); setError(""); draftField.current?.focus();
          }}>Ввести другой текст</MaterialButton>}
        <div className="text-editor-options">
          <label className="text-editor-select">
            <select value={tone} aria-label="Тон текста" onChange={event => setTone(event.target.value)}>
              <option value="">Тон текста</option>
              {TONES.map(item => <option key={item}>{item}</option>)}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          <MaterialButton materialKey="editor.tone" tone="graphite" type="button" disabled={!canGenerate || !tone}
            onClick={() => preset(`Перепиши текст в тоне «${tone}».`)}>Изменить</MaterialButton>
        </div>
        <form onSubmit={event => { event.preventDefault(); void run(change); }} className="text-editor-form">
          <label className="text-editor-field">Что изменить?
            <textarea rows={2} value={change.instruction} maxLength={3000}
              placeholder="Например, сделать из этого письмо"
              onChange={event => setChange({ ...change, instruction: event.target.value })} />
          </label>
          <Disclosure materialKey="editor.example" label="Добавить пример">
            <label className="text-editor-field">Пример стиля
              <textarea rows={2} value={change.example} maxLength={3000}
                onChange={event => setChange({ ...change, example: event.target.value })} />
            </label>
          </Disclosure>
          <MaterialButton materialKey="editor.run" tone="accent" type="submit"
            disabled={!canGenerate || !change.instruction.trim()}>Применить правку</MaterialButton>
        </form>
      </Disclosure>
    </div>
  </section>;
}
