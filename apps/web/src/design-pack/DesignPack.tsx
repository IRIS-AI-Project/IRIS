import { useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  IconInterfaceArrowUp as ArrowUp,
  IconInterfaceCheck as Check,
  IconInterfaceChevronLeft as ChevronLeft,
  IconInterfaceChevronRight as ChevronRight,
  IconInterfaceCopy as Copy,
  IconInterfaceHelpCustomerSupport5 as Headphones,
  IconInterfaceMicrophone as Mic,
  IconInterfaceMinus as Minus,
  IconInterfaceSearch as Search,
  IconInterfaceSparkles as Sparkles,
  IconInterfaceStop as Square,
  IconInterfaceCross as X,
} from "../CustomIcons";
import { CustomSelect } from "../components/CustomSelect";
import { useMaterialFeedback } from "./useMaterialFeedback";
import { AppSwitch } from "../components/AppSwitch";
import { AppCheckbox } from "../components/AppCheckbox";
import { Disclosure } from "../components/Disclosure";
import { SlidingSegments } from "../components/SlidingSegments";
import { MaterialSeed, materialSeeds, materialStyle, maxSeed, readMaterialSeed, seedStorageKey, validSeed } from "./materialSeeds";
import { ButtonMaterialLayers, MaterialButton } from "../components/MaterialButton";
import { NotificationExamples } from "./NotificationExamples";
import { ConfirmationExamples } from "./ConfirmationExamples";

type Tone = "accent" | "graphite" | "danger";
type Vote = "accept" | "revise";
const groups = [
  ["buttons", "Кнопки действий"],
  ["compact", "Маленькие кнопки"],
  ["controls", "Переключатели и ползунок"],
  ["fields", "Обводки полей"],
  ["confirmation-calm", "Подтверждение — лёгкая отмена"],
  ["confirmation-rim", "Подтверждение — объёмная отмена"],
] as const;
const storageKey = "iris-design-pack-lens-v3";
const legacyCompactStorageKey = "iris-design-pack-compact-v1";
const seedGalleryMaterialKey = "design-pack.seed-gallery";
const sections = [
  ["buttons", "Кнопки"],
  ["compact", "Иконки"],
  ["controls", "Управление"],
  ["fields", "Поля"],
  ["notifications", "Уведомления"],
  ["confirmations", "Подтверждения"],
  ["seeds", "Материалы"],
] as const;

function readVotes(): Record<string, Vote> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const oldCompact = localStorage.getItem(legacyCompactStorageKey);
    return Object.fromEntries(groups.flatMap(([id]) => {
      if (id === "compact" && oldCompact && oldCompact !== "current") return [];
      const value = (raw as Record<string, unknown>)[id];
      const previousVariant = (raw as { variants?: Record<string, unknown> }).variants?.[id];
      return previousVariant !== "soft" && (value === "accept" || value === "revise") ? [[id, value]] : [];
    }));
  } catch { return {}; }
}


export function LensButton({ tone = "graphite", icon = false, seed, style, className = "", children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; icon?: boolean; seed?: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const inheritedSeed = useContext(MaterialSeed);
  const selectedSeed = seed ?? inheritedSeed;
  useMaterialFeedback(ref, { disabled: props.disabled, seed: selectedSeed });
  return <button {...props} type={props.type ?? "button"} ref={ref}
    data-material-seed={selectedSeed ?? undefined} style={{ ...(selectedSeed === null ? {} : materialStyle(selectedSeed)), ...style }}
    className={`dp-lens dp-${tone}${icon ? " dp-icon" : ""} ${className}`}>
    <ButtonMaterialLayers />
    <span className="dp-button-content">{children}</span>
  </button>;
}

export function FieldSurface({ children, pinned = "", disabled = false, error = false, className = "" }:
  { children: ReactNode; pinned?: string; disabled?: boolean; error?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useMaterialFeedback(ref, { field: true, disabled, pinned });
  return <div ref={ref} className={`dp-field${error ? " dp-error" : ""} ${className}`} data-disabled={disabled} data-demo={pinned || undefined}>
    <span className="dp-rim" aria-hidden="true" />{children}
  </div>;
}

function Review({ id, votes, onVote }: {
  id: string; votes: Record<string, Vote>; onVote: (id: string, vote: Vote) => void;
}) {
  return <div className="dp-review" aria-label="Оценка группы">
    <button type="button" aria-pressed={votes[id] === "accept"} onClick={() => onVote(id, "accept")}><Check size={15} />Нравится</button>
    <button type="button" aria-pressed={votes[id] === "revise"} onClick={() => onVote(id, "revise")}>Переделать</button>
  </div>;
}

function ControlsSample() {
  const [tab, setTab] = useState("Диалог");
  const [volume, setVolume] = useState(65);
  const [notes, setNotes] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  return <div className="dp-control-set">
    <div className="dp-example">
      <h3>Голосовые настройки</h3>
      <AppSwitch checked={voiceEnabled} label="Голосовой ответ" onChange={setVoiceEnabled} />
      <div className="dp-slider-line"><label htmlFor="preview-volume">Громкость <span>{volume}%</span></label>
        <input id="preview-volume" type="range" min="0" max="100" value={volume} disabled={!voiceEnabled}
          onChange={(event) => setVolume(Number(event.target.value))} />
      </div>
    </div>
    <div className="dp-example">
      <h3>Вид рабочей области</h3>
      <SlidingSegments value={tab} aria-label="Вид">
        {["Диалог", "История", "Память"].map((name) => <button key={name} type="button"
          aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}
      </SlidingSegments>
    </div>
    <div className="dp-example">
      <h3>Что сохранить</h3>
      <label className="dp-checkbox-line"><AppCheckbox checked={notes} onChange={event => setNotes(event.target.checked)} />Личные заметки</label>
      <label className="dp-checkbox-line"><AppCheckbox checked disabled />Текст диалога</label>
    </div>
  </div>;
}

function CompactSamples() {
  const selectedSeed = useContext(MaterialSeed);
  const [page, setPage] = useState(2);
  const [micMuted, setMicMuted] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  return <div className="dp-sample dp-example-list">
    <div className="dp-example">
      <h3>Листание записей <span>32 × 32 px</span></h3>
      <div className="dp-action-row">
        <LensButton icon className="dp-icon-small" aria-label="Назад" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></LensButton>
        <span className="dp-page-count" role="status" aria-label="Страница">{page} / 3</span>
        <LensButton icon className="dp-icon-small" aria-label="Вперёд" disabled={page === 3} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></LensButton>
      </div>
    </div>
    <div className="dp-example">
      <h3>Управление голосом <span>48 × 48 px</span></h3>
      <div className="dp-action-row">
        <LensButton icon tone={micMuted ? "danger" : "accent"} aria-label="Микрофон" aria-pressed={!micMuted}
          onClick={() => setMicMuted(!micMuted)}><Mic size={19} /></LensButton>
        <LensButton icon tone={soundMuted ? "danger" : "graphite"} aria-label="Наушники" aria-pressed={!soundMuted}
          onClick={() => setSoundMuted(!soundMuted)}><Headphones size={19} /></LensButton>
      </div>
    </div>
    <div className="dp-example">
      <h3>Кнопки окна <span>48 × 48 px в макете</span></h3>
      <div className="dp-action-row">{([
        [Minus, "Свернуть", "success"], [Square, "Развернуть", "warning"], [X, "Закрыть", "danger"],
      ] as const).map(([Symbol, label, tone]) => <MaterialButton key={tone} type="button"
        materialKey={`WindowChrome.${tone}`} seed={selectedSeed ?? undefined} appearance="quiet"
        tone={tone} className="dp-icon" aria-label={label}><Symbol size={18} aria-hidden="true" /></MaterialButton>)}</div>
    </div>
  </div>;
}

export function DesignPack() {
  const [selectedSeed, setSelectedSeed] = useState(readMaterialSeed);
  const [seedInput, setSeedInput] = useState(() => String(selectedSeed ?? 42));
  const [gallerySeed, setGallerySeed] = useState(selectedSeed ?? 42);
  const [votes, setVotes] = useState(readVotes);
  useEffect(() => {
    try {
      const oldCompact = localStorage.getItem(legacyCompactStorageKey);
      if (oldCompact && oldCompact !== "current") localStorage.setItem(storageKey, JSON.stringify(votes));
      localStorage.removeItem(legacyCompactStorageKey);
    } catch { /* The sole compact material also works without storage access. */ }
  }, [votes]);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [voice, setVoice] = useState("iris");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const persist = (nextVotes: Record<string, Vote>) => {
    try { localStorage.setItem(storageKey, JSON.stringify(nextVotes)); setStorageNotice(""); }
    catch { setStorageNotice("Выбор сохранён только до закрытия страницы."); }
  };
  const vote = (id: string, value: Vote) => {
    const next = { ...votes, [id]: value };
    setVotes(next);
    persist(next);
  };
  const reviewProps = { votes, onVote: vote };
  const chooseSeed = (seed: number | null) => {
    setSelectedSeed(seed);
    const nextVotes = { ...votes };
    for (const id of ["buttons", "compact", "controls"]) delete nextVotes[id];
    setVotes(nextVotes);
    persist(nextVotes);
    try { localStorage.setItem(seedStorageKey, JSON.stringify(seed)); }
    catch { setStorageNotice("Сид сохранён только до закрытия страницы."); }
  };
  const newSeeds = () => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] & maxSeed;
    setGallerySeed(seed);
    setSeedInput(String(seed));
  };
  const copy = async () => {
    const summary = groups.map(([id, title]) => `${title}: ${votes[id] === "accept" ? "одобрено" : votes[id] === "revise" ? "переделать" : "ещё не выбрано"}`).join("\n");
    try { await navigator.clipboard.writeText(`Дизайн Iris: линза + фиолетовая обводка\nСид материала: ${selectedSeed ?? "исходный"}\nМаленькие кнопки: Текущий\n${summary}`); setNotice("Выбор скопирован — можно вставить в чат."); }
    catch { setNotice(`Не удалось скопировать. ${summary.split("\n").join("; ")}`); }
  };
  return <MaterialSeed.Provider value={selectedSeed}><main className="dp-page">
    <header className="dp-header">
      <a className="dp-brand" href="/" aria-label="Открыть Iris"><img src="/brand/iris-mark-backed-dark.svg" alt="" />Iris</a>
      <h1>Образцы дизайна</h1>
      <p>Кнопки, поля и другие элементы Ирис. Попробуй их мышью или клавиатурой.</p>
      <nav className="dp-nav" aria-label="Разделы макета">
        {sections.map(([id, title]) => <a key={id} href={`#${id}`}>{title}</a>)}
      </nav>
    </header>
    <div className="dp-components">
    <section id="buttons" className="dp-section" aria-labelledby="buttons-title">
      <div className="dp-section-heading"><div><h2 id="buttons-title">Кнопки действий</h2></div><Review id="buttons" {...reviewProps} /></div>
      <div className="dp-sample dp-example-list">
        <div className="dp-example">
          <h3>Главное действие <span>58 px</span></h3>
          <LensButton className="dp-action-large" tone="accent" onClick={() => setActionNotice("Выбрано «Начать диалог».")}><Sparkles size={18} />Начать диалог</LensButton>
        </div>
        <div className="dp-example">
          <h3>Действия в диалоге <span>46 px</span></h3>
          <div className="dp-action-row">
            <LensButton onClick={() => setActionNotice("Выбрано «Новый диалог».")}>Новый диалог</LensButton>
            <LensButton tone="danger" onClick={() => setActionNotice("Выбрано «Завершить».")}>Завершить</LensButton>
          </div>
        </div>
        <div className="dp-example">
          <h3>Действия в списке <span>40 px</span></h3>
          <div className="dp-action-row">
            <LensButton className="dp-action-small" onClick={() => setActionNotice("Выбрано «Копировать».")}><Copy size={15} />Копировать</LensButton>
            <LensButton className="dp-action-small" disabled>Недоступно</LensButton>
          </div>
        </div>
        <p className="dp-action-result" role="status">{actionNotice || "Кнопки работают в пределах макета."}</p>
      </div>
    </section>
    <section id="compact" className="dp-section" aria-labelledby="compact-title">
      <div className="dp-section-heading"><div><h2 id="compact-title">Маленькие кнопки</h2></div><Review id="compact" {...reviewProps} /></div>
      <CompactSamples />
    </section>
    <section id="controls" className="dp-section" aria-labelledby="controls-title">
      <div className="dp-section-heading"><div><h2 id="controls-title">Переключатели и ползунок</h2></div><Review id="controls" {...reviewProps} /></div>
      <div className="dp-sample"><ControlsSample /></div>
    </section>
    </div>
    <section id="fields" className="dp-section" aria-labelledby="fields-title">
      <div className="dp-section-heading"><div><h2 id="fields-title">Световая обводка</h2></div><Review id="fields" {...reviewProps} /></div>
      <div className="dp-live-fields">
        <h3>Поля в диалоге</h3>
        <div className="dp-three-up">
          <label>Поиск<FieldSurface><Search size={18} /><input type="search" value={search} placeholder="Найти в истории" onChange={(event) => setSearch(event.target.value)} /></FieldSurface></label>
          <label>Название<FieldSurface><input value={name} placeholder="Название диалога" onChange={(event) => setName(event.target.value)} /></FieldSurface></label>
          <div>
            <label htmlFor="preview-voice">Голос</label>
            <FieldSurface>
              <CustomSelect id="preview-voice" value={voice} onChange={(event) => setVoice(event.target.value)}>
                <option value="iris">Iris · основной голос</option>
                <option value="quiet">Iris · спокойный голос</option>
              </CustomSelect>
            </FieldSurface>
          </div>
        </div>
        <label className="dp-message-label" htmlFor="preview-message">Сообщение</label>
        <FieldSurface className="dp-message">
          <textarea id="preview-message" rows={2} value={message} placeholder="Напиши Iris…" onChange={(event) => setMessage(event.target.value)} />
          <button className="dp-send" type="button" aria-label="Отправить образец сообщения"
            onClick={() => setNotice("Сообщение осталось в макете.")}><ArrowUp size={22} /></button>
        </FieldSurface>
        <div className="dp-two-up dp-extra-states">
          <label>Недоступное поле<FieldSurface disabled><input placeholder="Недоступно" disabled /></FieldSurface></label>
          <label>Ошибка<FieldSurface error><input aria-invalid="true" aria-describedby="preview-error" defaultValue="Неверное значение" /></FieldSurface>
            <span id="preview-error" className="dp-error-text">Проверь значение</span>
          </label>
        </div>
      </div>
      <Disclosure materialKey="design-pack.field-states" label="Сравнить состояния полей" className="dp-disclosure">
        <div className="dp-three-up">{[["", "Покой"], ["hover", "Наведение"], ["focus", "Активное поле"]].map(([state, title]) => <div className="dp-state" key={title}><h3>{title}</h3>
          <FieldSurface pinned={state}><Search size={18} /><input aria-label={`Поиск — ${title}`} placeholder="Найти в истории" readOnly tabIndex={-1} /></FieldSurface>
          <FieldSurface pinned={state}><input aria-label={`Поле — ${title}`} value={state === "focus" ? "Разговор с Iris" : ""} placeholder="Название диалога" readOnly tabIndex={-1} /></FieldSurface>
          <FieldSurface pinned={state}><span className="dp-static-select">Iris · основной голос</span><ChevronRight className="dp-chevron" size={16} /></FieldSurface>
        </div>)}</div>
      </Disclosure>
    </section>
    <NotificationExamples />
    <ConfirmationExamples renderReview={id => <Review id={id} {...reviewProps} />} />
    <section id="seeds" className="dp-section dp-seed-section" aria-labelledby="seeds-title">
      <div className="dp-section-heading"><div><h2 id="seeds-title">Вариации кнопки</h2></div></div>
      <Disclosure materialKey={seedGalleryMaterialKey} label="Сравнить материалы">
        <form className="dp-seed-toolbar" onSubmit={(event) => {
          event.preventDefault();
          const seed = Number(seedInput);
          if (seedInput.trim() && validSeed(seed)) setGallerySeed(seed);
        }}>
          <label>Базовый сид<input type="number" min="0" max={maxSeed} step="1" required value={seedInput} onChange={(event) => setSeedInput(event.target.value)} /></label>
          <MaterialButton materialKey={seedGalleryMaterialKey} className="dp-seed-action" type="submit">Показать варианты</MaterialButton>
          <MaterialButton materialKey={seedGalleryMaterialKey} className="dp-seed-action" type="button" onClick={newSeeds}>Новые сиды</MaterialButton>
          <button className="dp-seed-reset" type="button" onClick={() => chooseSeed(null)}>Исходный вид</button>
        </form>
        <div className="dp-seed-grid">{materialSeeds(gallerySeed).map((seed) => <article className="dp-seed-card" key={seed} data-selected={selectedSeed === seed}>
          <div className="dp-seed-label"><h3>Сид {seed}</h3>{selectedSeed === seed && <span><Check size={14} />Выбран</span>}</div>
          <LensButton tone="accent" seed={seed} onClick={() => setNotice(`Образец сида ${seed}. Диалог не запускается.`)}><Sparkles size={18} />Начать диалог</LensButton>
          <div className="dp-seed-tones"><LensButton seed={seed}>Новый диалог</LensButton><LensButton seed={seed} tone="danger">Завершить</LensButton></div>
          <button className="dp-seed-use" type="button" aria-label={`Использовать сид ${seed}`} aria-pressed={selectedSeed === seed} onClick={() => chooseSeed(seed)}>Использовать</button>
        </article>)}</div>
      </Disclosure>
      {selectedSeed !== null && <p className="dp-seed-current" role="status">Сид {selectedSeed}</p>}
    </section>
    <footer className="dp-footer"><LensButton onClick={() => void copy()}><Copy size={16} />Скопировать выбор</LensButton></footer>
    {(notice || storageNotice) && <p className="dp-notice" role="status">{notice || storageNotice}</p>}
  </main></MaterialSeed.Provider>;
}
