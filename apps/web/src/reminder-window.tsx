import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { animate, prefersReducedMotion } from "./animations/core";
import { NotificationCountdown, useNotificationCountdown } from "./components/NotificationCountdown";
import { DESKTOP_REMINDER_READ } from "./reminder-events";
import "./fonts/geologica.css";
import "./tokens.css";
import "./components/NotificationHost.css";
import "./reminder-window.css";

const COUNTDOWN_MS = 5000;
const reminder = (window as Window & {
  __IRIS_REMINDER__?: { title: string; deliveryToken: string };
}).__IRIS_REMINDER__;
const text = reminder?.title ?? "";

function ReminderWindow() {
  const scene = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const readReported = useRef(false);
  const [started, setStarted] = useState(false);
  const [closing, setClosing] = useState(false);

  const reportRead = () => {
    if (readReported.current || !reminder?.deliveryToken) return;
    readReported.current = true;
    void emitTo("main", DESKTOP_REMINDER_READ, reminder.deliveryToken).catch(() => {
      readReported.current = false;
    });
  };

  useNotificationCountdown({
    duration: started ? COUNTDOWN_MS : null,
    paused: closing,
    onComplete: () => setClosing(true),
    pathRef: path,
  });

  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const close = () => {
      void getCurrentWindow().close().catch(() => {
        path.current?.style.removeProperty("stroke-dashoffset");
        setStarted(false);
        setClosing(false);
      });
    };
    if (prefersReducedMotion()) {
      if (closing) close();
      return;
    }
    const motion = animate(element, closing ? {
      opacity: 0, translateX: 32, duration: 180, ease: "inQuad", onComplete: close,
    } : {
      opacity: [0, 1], translateX: [36, 0], duration: 280, ease: "outCubic",
    });
    return () => { motion.cancel(); };
  }, [closing]);

  return <main className="iris-reminder" ref={scene} aria-labelledby="reminder-label">
    <div className="notification-card iris-reminder-card" ref={card}
      onPointerEnter={event => {
        if (event.pointerType !== "mouse" || closing) return;
        reportRead();
        setStarted(true);
      }}>
      <NotificationCountdown cardRef={card} pathRef={path} seed={0} />
      <img className="iris-reminder-portrait" src="/brand/iris-pixel/seated-side.png" alt="" width="56" height="84" />
      <button type="button" className="iris-reminder-content" onClick={() => {
        reportRead();
        void invoke("open_main_from_avatar").then(() => setClosing(true)).catch(() => undefined);
      }}>
        <span className="iris-reminder-label" id="reminder-label">Напоминаю</span>
        <span className="notification-message" title={text}>{text}</span>
      </button>
      <button type="button" className="notification-close-btn" aria-label="Закрыть уведомление"
        onClick={() => {
          reportRead();
          setClosing(true);
        }}><X size={16} aria-hidden="true" /></button>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ReminderWindow />);
