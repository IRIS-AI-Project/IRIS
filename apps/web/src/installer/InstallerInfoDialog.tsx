import { ExternalLink, FileText, Github, ShieldCheck } from "lucide-react";
import { IconInterfaceBrain, IconInterfaceMicrophone, IconInterfaceSecurityShield4 } from "../CustomIcons";
import { AppDialog } from "../components/AppDialog";
import { MaterialButton } from "../components/MaterialButton";
import { VOICE_MODELS_DOWNLOAD_SIZE } from "./voiceModels";

export type InstallerInfoTopic = "trust" | "voice" | "memory" | "removal";

const repository = "https://github.com/bad1and/NeuroAsist";
const documents = `${repository}/blob/v0.9.1`;

export const INSTALLER_INFO = {
  removal: {
    icon: IconInterfaceSecurityShield4,
    eyebrow: "Ваши данные",
    button: "Что останется",
    title: "Удаление и ваши данные",
    description: "Вы сами выбираете, какие данные оставить на компьютере.",
    items: [
      { title: "Приложение и данные — отдельно", text: "Файлы Iris и ярлыки удаляются. Профиль, разговоры, память и речевые модели можно сохранить по отдельности на шаге «Данные»." },
      { title: "Сохранённое остаётся на ПК", text: "При повторной установке эти данные можно использовать снова. Неотмеченные группы будут удалены." },
      { title: "Обратная связь необязательна", text: "Вы можете пропустить выбор причин. Отчёт в этом предпросмотре никуда не отправляется." },
    ],
    links: [],
  },
  trust: {
    icon: IconInterfaceSecurityShield4,
    eyebrow: "Открытый проект",
    button: "Код и данные",
    title: "Открытый код и ваши данные",
    description: "Устройство Iris можно изучить до первого запуска.",
    items: [
      { title: "Исходники доступны", text: "Код приложения, история изменений и инструкции для самостоятельной сборки опубликованы на GitHub." },
      { title: "Личные данные хранятся на компьютере", text: "История, память и настройки — в вашем профиле Windows. API-ключи хранятся отдельно, в диспетчере учётных данных Windows." },
      { title: "Внешние сервисы получают контекст", text: "Модель диалога получает запрос и выбранный контекст. Поиск и другие подключения тоже обращаются в сеть. Обработка данных зависит от провайдера." },
    ],
    links: [
      { title: "Исходники", detail: "GitHub", href: repository, icon: Github },
      { title: "Ваши данные", detail: "PRIVACY.md", href: `${documents}/PRIVACY.md`, icon: FileText },
      { title: "Защита", detail: "SECURITY.md", href: `${documents}/SECURITY.md`, icon: ShieldCheck },
    ],
  },
  voice: {
    icon: IconInterfaceMicrophone,
    eyebrow: "Узнать больше",
    button: "Как Iris слышит",
    title: "Как Iris слышит и отвечает",
    description: "Голосовой разговор состоит из нескольких шагов.",
    items: [
      { title: "Сначала — текст", text: "GigaAM распознаёт речь на компьютере. Затем текст запроса получает модель диалога." },
      { title: "Потом — голос", text: `TeraTTS озвучивает ответ локально. Модели для распознавания и озвучивания скачиваются отдельно — около ${VOICE_MODELS_DOWNLOAD_SIZE}.` },
      { title: "Не каждая пауза — конец фразы", text: "Детектор конца реплики помогает выбрать момент для ответа. Короткая остановка не всегда означает, что вы закончили говорить." },
    ],
    links: [],
  },
  memory: {
    icon: IconInterfaceBrain,
    eyebrow: "Узнать больше",
    button: "Память Iris",
    title: "Что Iris запоминает",
    description: "История разговоров и память решают разные задачи.",
    items: [
      { title: "История хранит разговор", text: "К прежним репликам можно вернуться, чтобы перечитать беседу или продолжить её." },
      { title: "Память сохраняет важное", text: "Предпочтения и другие сохранённые сведения помогают учитывать контекст в следующих разговорах." },
      { title: "Записи можно менять", text: "В разделе памяти сведения можно просмотреть, исправить или удалить. Удаление факта из памяти не удаляет исходную реплику из истории." },
    ],
    links: [],
  },
};

export function InstallerInfoDialog({ topic, open, onClose, container }: {
  topic: InstallerInfoTopic;
  open: boolean;
  onClose: () => void;
  container?: HTMLElement | null;
}) {
  const content = INSTALLER_INFO[topic];
  const Icon = content.icon;
  return <AppDialog open={open} onClose={onClose} container={container}
    className="installer-dialog installer-info-dialog" showRim={false}
    title={content.title} description={content.description}
    icon={<Icon size={26} aria-hidden="true" />}
    variant="info" presentation="spotlight" size="wide">
    <div className="installer-info-items">
      {content.items.map((item, index) => <section className="installer-info-item" key={item.title}>
        <span className="installer-info-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div><h3>{item.title}</h3><p>{item.text}</p></div>
      </section>)}
    </div>
    {content.links.length > 0 && <nav className="installer-info-links" aria-label="Документы проекта">
      {content.links.map(link => { const LinkIcon = link.icon;
        return <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
          <LinkIcon size={18} strokeWidth={1.7} aria-hidden="true" />
          <span><strong>{link.title}</strong><small>{link.detail}</small></span>
          <ExternalLink size={13} aria-hidden="true" />
        </a>;
      })}
    </nav>}
    <div className="dialog-actions">
      <MaterialButton materialKey={`installer.info.${topic}.close`} className="primary-button" onClick={onClose}>
        Понятно
      </MaterialButton>
    </div>
  </AppDialog>;
}
