import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardPaste, Copy, Replace, X } from "lucide-react";
import { animate, prefersReducedMotion } from "../animations/core";
import { MaterialButton } from "../components/MaterialButton";
import { closeEditor, editorPresence, generateEdit, openEditor, type EditorAvailability,
  type EditorSelection, type EditorUpdates, type VoiceEditIntent } from "./api";
import { DEFAULT_QUICK_ACTIONS, QUICK_ACTIONS, quickInstruction, type QuickAction } from "./quickActions";
import "./QuickTextActions.css";

type Job = { source: EditorSelection; instruction: string; example: string };
type View =
  | { kind: "working"; label: string; delivering?: boolean }
  | { kind: "result"; text: string; source: EditorSelection; notice?: string; error?: boolean }
  | { kind: "source"; voice: VoiceEditIntent }
  | { kind: "message"; text: string; error?: boolean };

function QuickActionButton({ action, busy, active, onHover, onFocus, onClick }: {
  action: QuickAction; busy: boolean; active: boolean;
  onHover: (value: boolean) => void; onFocus: (value: boolean) => void; onClick: () => void;
}) {
  const { label, icon: Glyph } = QUICK_ACTIONS[action];
  const button = useRef<HTMLButtonElement>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  const caption = useRef<HTMLSpanElement>(null);
  const captionText = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!button.current || !highlight.current || !caption.current || !captionText.current) return;
    const reduced = prefersReducedMotion();
    const timing = { duration: reduced ? 0 : active ? 220 : 170, ease: "outCubic" };
    const resize = animate(button.current, { flexGrow: active ? 1.9 : 1, ...timing });
    const fill = animate(highlight.current, { opacity: active ? 1 : 0, ...timing });
    const expand = animate(caption.current, { width: active ? captionText.current.offsetWidth : 0,
      ...timing });
    const slide = animate(captionText.current, { x: reduced || active ? 0 : -6,
      opacity: active ? 1 : 0, ...timing });
    return () => { resize.cancel(); fill.cancel(); expand.cancel(); slide.cancel(); };
  }, [active]);

  return <MaterialButton ref={button} type="button" materialKey={`desktop.quick.${action}`} appearance="plain"
    className="desktop-quick-action" aria-label={label} aria-disabled={busy || undefined}
    onPointerEnter={event => { if (event.pointerType !== "touch") onHover(true); }}
    onPointerLeave={() => onHover(false)} onPointerCancel={() => onHover(false)}
    onFocus={event => onFocus(event.currentTarget.matches(":focus-visible"))} onBlur={() => onFocus(false)}
    onClick={() => { if (!busy) onClick(); }}>
    <span ref={highlight} className="desktop-quick-highlight" aria-hidden="true" />
    <span className="desktop-quick-glyph" aria-hidden="true"><Glyph size={20} /></span>
    <span ref={caption} className="desktop-quick-caption" aria-hidden="true">
      <span ref={captionText}>{label}</span>
    </span>
  </MaterialButton>;
}

export function QuickTextActions({ skill, voiceSession }: {
  skill: EditorAvailability; voiceSession: { id: number } | null;
}) {
  const [view, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<QuickAction | null>(null);
  const [focused, setFocused] = useState<QuickAction | null>(null);
  const [editorId] = useState(() => crypto.randomUUID());
  const session = useRef<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLDivElement>(null);

  function dismiss() {
    request.current?.abort();
    request.current = null;
    const id = session.current;
    session.current = null;
    if (id !== null) void closeEditor(id).catch(() => {});
    setView(null);
  }

  function begin(label: string, delivering = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setView({ kind: "working", label, delivering });
    return controller.signal;
  }

  function fail(signal: AbortSignal, cause: unknown) {
    if (signal.aborted) return;
    setView({ kind: "message", error: true, text: cause instanceof Error ? cause.message
      : typeof cause === "string" ? cause : "Не удалось обработать текст." });
  }

  async function run(job: Job, signal: AbortSignal) {
    if (signal.aborted) return;
    setView({ kind: "working", label: "Обрабатываю…" });
    try {
      const result = await generateEdit({ revision: skill.revision, text: job.source.text,
        instruction: job.instruction, example: job.example }, signal);
      if (!signal.aborted) setView({ kind: "result", text: result.text, source: job.source });
    } catch (cause) { fail(signal, cause); }
  }

  async function start(action: QuickAction) {
    const signal = begin("Беру текст…");
    try {
      const id = await openEditor(skill.revision);
      if (signal.aborted) {
        if (session.current !== id) void closeEditor(id).catch(() => {});
        return;
      }
      session.current = id;
      const { updates } = await invoke<EditorUpdates>("take_text_editor_updates", { id });
      if (signal.aborted) return;
      const source = updates.find(update => update.selection)?.selection;
      if (source?.text.trim()) {
        await run({ source, instruction: quickInstruction(action, source.text), example: "" }, signal);
      } else {
        setView({ kind: "message", text: "Выделите или скопируйте текст." });
      }
    } catch (cause) { fail(signal, cause); }
  }

  const readVoice = useEffectEvent(async (id: number) => {
    const draft = view?.kind === "result" ? { ...view.source, text: view.text } : null;
    session.current = id;
    const signal = begin("Беру текст…");
    try {
      const { updates } = await invoke<EditorUpdates>("take_text_editor_updates", { id });
      if (signal.aborted) return;
      const update = [...updates].reverse().find(item => item.voice);
      const voice = update?.voice;
      if (!voice) { setView(null); return; }
      const source = voice.source === "draft" ? draft : update.selection;
      if (source?.text.trim() && voice.instruction.trim()) {
        await run({ source, instruction: voice.instruction, example: voice.example }, signal);
      }
      else setView({ kind: "source", voice });
    } catch (cause) { fail(signal, cause); }
  });

  async function captureVoice(voice: VoiceEditIntent) {
    const id = session.current;
    if (id === null) return;
    const signal = begin("Беру текст…");
    try {
      const source = await invoke<EditorSelection>("capture_editor_selection", { id });
      if (signal.aborted) return;
      if (source.text.trim() && voice.instruction.trim()) {
        await run({ source, instruction: voice.instruction, example: voice.example }, signal);
      }
      else setView({ kind: "message", text: source.text.trim()
        ? "Назовите нужную правку или выберите действие." : "Выделите или скопируйте текст." });
    } catch (cause) { fail(signal, cause); }
  }

  useEffect(() => {
    if (!voiceSession) return;
    let active = true;
    queueMicrotask(() => { if (active) void readVoice(voiceSession.id); });
    return () => { active = false; };
  }, [voiceSession]);

  useEffect(() => () => {
    request.current?.abort();
    const id = session.current;
    session.current = null;
    if (id !== null) void closeEditor(id).catch(() => {});
  }, []);

  useEffect(() => {
    const blur = () => setView(current => current?.kind === "result" && current.source.replaceable
      ? { ...current, source: { ...current.source, replaceable: false } } : current);
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);

  const hasResult = view?.kind === "result";
  const needsSource = view?.kind === "source";
  useEffect(() => {
    if (!hasResult && !needsSource) return;
    const controller = new AbortController();
    const publish = () => void editorPresence(editorId, { revision: skill.revision,
      has_draft: hasResult, pending_source: needsSource }, controller.signal).catch(() => {});
    publish();
    const timer = window.setInterval(publish, 20_000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
      void editorPresence(editorId, null).catch(() => {});
    };
  }, [editorId, hasResult, needsSource, skill.revision]);

  const phase = view?.kind;
  useLayoutEffect(() => {
    if (!feedback.current || prefersReducedMotion()) return;
    const motion = animate(feedback.current, { opacity: [.5, 1], y: [3, 0], duration: 150, ease: "outCubic" });
    return () => { motion.cancel(); };
  }, [phase]);

  async function deliver(result: Extract<View, { kind: "result" }>, replace: boolean) {
    const id = session.current;
    if (id === null) return;
    const signal = begin(replace ? "Заменяю…" : "Копирую…", true);
    try {
      if (replace) await invoke("replace_editor_selection", { id, selectionId: result.source.id, text: result.text });
      else await navigator.clipboard.writeText(result.text);
      if (!signal.aborted) setView({ ...result, source: { ...result.source, replaceable: !replace && result.source.replaceable },
        notice: replace ? "Выделение заменено" : "Скопировано", error: false });
    } catch (cause) {
      if (signal.aborted) return;
      // A rejected replacement leaves the result available for copying.
      setView({ ...result, source: { ...result.source, replaceable: !replace && result.source.replaceable },
        notice: typeof cause === "string" ? cause : "Не удалось выполнить действие.", error: true });
    }
  }

  const working = phase === "working";
  function icon(label: string, child: ReactNode, action: () => void) {
    return <MaterialButton key={label} type="button" materialKey={`desktop.quick.${label}`} appearance="plain"
      className="desktop-avatar-icon desktop-quick-icon" aria-label={label} title={label}
      onClick={action}>{child}</MaterialButton>;
  }

  const actions = skill.quick_actions ?? DEFAULT_QUICK_ACTIONS;
  const rows = actions.length > 3 ? [actions.slice(0, 3), actions.slice(3)] : [actions];
  return <section className="desktop-quick" aria-label="Правки текста" data-i18n-skip>
    <div className="desktop-quick-actions" role="group" aria-label="Быстрые действия">
      {rows.map(row => <div key={row[0]} className="desktop-quick-row">
        {row.map(action => <QuickActionButton key={action} action={action} busy={working}
          active={!working && (hovered ?? focused) === action}
          onHover={value => setHovered(current => value ? action : current === action ? null : current)}
          onFocus={value => setFocused(current => value ? action : current === action ? null : current)}
          onClick={() => void start(action)} />)}
      </div>)}
    </div>
    {view && <div ref={feedback} className="desktop-quick-feedback">
      {view.kind === "result" ? <>
        <p className="desktop-quick-result" tabIndex={0} aria-label="Результат">{view.text}</p>
        <div className="desktop-quick-output">
          {view.notice && <p role={view.error ? "alert" : "status"}>{view.notice}</p>}
          {view.source.replaceable && icon("Заменить выделение", <Replace size={18} aria-hidden="true" />, () => void deliver(view, true))}
          {icon("Копировать результат", <Copy size={17} aria-hidden="true" />, () => void deliver(view, false))}
          {icon("Закрыть результат", <X size={18} aria-hidden="true" />, dismiss)}
        </div>
      </> : <div className="desktop-quick-line">
        <p role={view.kind === "message" && view.error ? "alert" : "status"}>
          {view.kind === "working" ? view.label : view.kind === "source" ? "Выделите или скопируйте текст." : view.text}
        </p>
        {view.kind === "source" && icon("Взять текст", <ClipboardPaste size={18} aria-hidden="true" />, () => void captureVoice(view.voice))}
        {!(view.kind === "working" && view.delivering) &&
          icon(working ? "Отменить" : "Закрыть сообщение", <X size={18} aria-hidden="true" />, dismiss)}
      </div>}
    </div>}
  </section>;
}
