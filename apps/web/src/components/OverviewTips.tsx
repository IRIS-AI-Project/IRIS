import { useLayoutEffect, useRef, useState } from "react";
import { IconInterfaceArrowUpRight, IconInterfaceChevronLeft, IconInterfaceChevronRight } from "../CustomIcons";
import { animate, isTestEnvironment, prefersReducedMotion } from "../animations";
import type { SettingsSection } from "../settings/registry";
import { MaterialButton } from "./MaterialButton";

type TipAction = { label: string } & (
  | { view: "settings"; section: SettingsSection; focusId?: string }
  | { view: "memory" }
);
type OverviewTip = {
  id: string;
  topic: string;
  title: string;
  description: string;
  action?: TipAction;
  note?: string;
};

const tips: OverviewTip[] = [
  {
    id: "voice",
    topic: "Голос",
    title: "А можно помедленнее?",
    description: "Iris тараторит или читает как на сцене? Подкрутите скорость и выразительность.",
    action: { label: "Настроить голос", view: "settings", section: "voice" },
  },
  {
    id: "memory",
    topic: "Память",
    title: "Я такого не говорил",
    description: "Iris что-то запомнила не так? Откройте память, поправьте запись или удалите её.",
    action: { label: "Посмотреть память", view: "memory" },
  },
  {
    id: "team",
    topic: "Команда",
    title: "«Да там на пять минут»",
    description: "Над Iris работают полтора разработчика. А эта фраза у нас на полную ставку.",
    note: "Из жизни проекта",
  },
  {
    id: "shortcuts",
    topic: "Горячие клавиши",
    title: "Мышь может отдохнуть",
    description: "Микрофон, поиск и звук можно повесить на клавиши. На случай срочного мута.",
    action: { label: "Выбрать сочетания", view: "settings", section: "shortcuts" },
  },
  {
    id: "origin",
    topic: "Как всё началось",
    title: "Всё началось с /chat",
    description: "В v0.1 проект назывался NeuroAsist. Поговорить с ним можно было текстом через API.",
    note: "Июль 2026 · v0.1",
  },
  {
    id: "pronunciation",
    topic: "Произношение",
    title: "Здесь ударение на «а»",
    description: "Iris коверкает имя или аббревиатуру? Подскажите ей произношение в словаре.",
    action: { label: "Открыть словарь", view: "settings", section: "voice", focusId: "voice-pronunciations" },
  },
  {
    id: "incognito",
    topic: "Инкогнито",
    title: "Этого разговора не было",
    description: "Включите инкогнито, чтобы Iris не сохраняла новые сообщения и факты.",
    action: { label: "Перейти к инкогнито", view: "settings", section: "memory", focusId: "memory-incognito" },
  },
  {
    id: "search",
    topic: "Веб-поиск",
    title: "Погоди, я погуглю",
    description: "Подключите поиск, чтобы Iris могла сверять свежие новости и факты по источникам.",
    action: { label: "Настроить поиск", view: "settings", section: "internet" },
  },
  {
    id: "backups",
    topic: "Резервные копии",
    title: "Переезд с вещами",
    description: "Переезжаете на новый ПК? Разговоры, память и настройки влезут в один бэкап.",
    action: { label: "Открыть резервные копии", view: "settings", section: "backups" },
  },
  {
    id: "avatar",
    topic: "Из истории Iris",
    title: "«Работает ртом»",
    description: "Так назвали коммит, в котором Unity-аватар начал шевелить губами под голос Iris.",
    note: "13 июля 2026 · 5d733e3",
  },
];

export function OverviewTips({ onOpenSettings, onOpenMemory }: {
  onOpenSettings?: (section: SettingsSection, focusId?: string) => void;
  onOpenMemory: () => void;
}) {
  const [index, setIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const directionRef = useRef(1);
  const previousIndex = useRef(index);
  const tip = tips[index];
  const action = tip.action;
  const canOpen = action && (action.view === "memory" || onOpenSettings);

  const select = (next: number) => {
    directionRef.current = next < index ? -1 : 1;
    setIndex((next + tips.length) % tips.length);
  };

  useLayoutEffect(() => {
    if (previousIndex.current === index) return;
    previousIndex.current = index;
    if (!contentRef.current || isTestEnvironment()) return;
    const reduced = prefersReducedMotion();
    const motion = animate(contentRef.current, {
      opacity: [0, 1],
      translateX: reduced ? 0 : [directionRef.current * 8, 0],
      duration: reduced ? 100 : 200,
      ease: "outQuad",
    });
    return () => { motion.revert(); };
  }, [index]);

  return <section className="overview-surface overview-tips overview-reveal" aria-label="Больше об Iris" aria-roledescription="карусель">
    <header className="overview-tips-header">
      <h2 className="overview-tips-heading">Больше об Iris</h2>
      <span className="overview-tips-count" aria-hidden="true"><strong>{String(index + 1).padStart(2, "0")}</strong> / {tips.length}</span>
    </header>
    <div id="overview-tip-content" className="overview-tip" data-tip={tip.id} ref={contentRef}>
      <div className="overview-tip-copy" aria-live="polite" aria-atomic="true">
        <p className="overview-tip-topic">{tip.topic}</p>
        <h3>{tip.title}</h3>
        <p className="overview-tip-description">{tip.description}</p>
        {tip.note && <p className="overview-tip-note">{tip.note}</p>}
        <span className="overview-tip-position">Карточка {index + 1} из {tips.length}</span>
      </div>
      {canOpen && <MaterialButton key={tip.id} materialKey={`overview.tips.${tip.id}`} type="button" className="secondary-button overview-tip-action" onClick={() => {
        if (action.view === "memory") onOpenMemory();
        else onOpenSettings?.(action.section, action.focusId);
      }}>
        <span>{action.label}</span><IconInterfaceArrowUpRight size={16} aria-hidden="true" />
      </MaterialButton>}
    </div>
    <footer className="overview-tips-footer">
      <progress className="overview-tips-progress" value={index + 1} max={tips.length} aria-hidden="true" />
      <div className="overview-tips-controls" role="group" aria-label="Перелистывание карточек" onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "ArrowLeft") { event.preventDefault(); select(index - 1); }
        else if (event.key === "ArrowRight") { event.preventDefault(); select(index + 1); }
        else if (event.key === "Home") { event.preventDefault(); select(0); }
        else if (event.key === "End") { event.preventDefault(); select(tips.length - 1); }
      }}>
        <MaterialButton materialKey="overview.tips.previous" type="button" className="icon-button" aria-label="Предыдущая карточка" aria-controls="overview-tip-content" onClick={() => select(index - 1)}>
          <IconInterfaceChevronLeft size={19} aria-hidden="true" />
        </MaterialButton>
        <MaterialButton materialKey="overview.tips.next" type="button" className="icon-button" aria-label="Следующая карточка" aria-controls="overview-tip-content" onClick={() => select(index + 1)}>
          <IconInterfaceChevronRight size={19} aria-hidden="true" />
        </MaterialButton>
      </div>
    </footer>
  </section>;
}
