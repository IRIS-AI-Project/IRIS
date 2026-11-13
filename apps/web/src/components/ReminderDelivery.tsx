import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktopApp } from "../desktop";
import { getReminders, acknowledgeReminder, updateReminder, type Reminder } from "../product-api";
import { notify } from "../notifications";
import { DESKTOP_REMINDER_READ } from "../reminder-events";

const displayed = new Set<string>();
const pending = new Set<string>();

export async function allowReminderNotifications(): Promise<boolean> {
  return typeof Notification !== "undefined" && (Notification.permission === "granted" || await Notification.requestPermission() === "granted");
}

export async function showSystemReminder(item: Reminder): Promise<boolean> {
  if (isDesktopApp()) {
    return invoke<boolean>("show_reminder_window", { title: item.title, deliveryToken: item.delivery_token });
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("Iris · Напоминание", { body: item.title, tag: item.delivery_token });
    return true;
  }
  return false;
}

async function deliver(item: Reminder) {
  if (pending.has(item.delivery_token)) return;
  pending.add(item.delivery_token);
  try {
    const key = `iris.reminder-delivered.${item.delivery_token}`;
    let wasDisplayed = displayed.has(item.delivery_token);
    try { wasDisplayed ||= localStorage.getItem(key) === "1"; } catch { /* The in-memory guard still works. */ }
    if (!wasDisplayed) {
      const change = async (patch: Parameters<typeof updateReminder>[1]) => {
        try { await updateReminder(item.id, { ...patch, delivery_token: item.delivery_token }); notify.dismiss(`reminder.${item.delivery_token}`); }
        catch (error) { notify.error("Напоминание", String(error)); }
      };
      notify.reminder("Iris · Напоминание", item.title, { id: `reminder.${item.delivery_token}`, actions: [
        { label: "Готово", onClick: () => { void change({ status: "completed" }); } },
        { label: "Через 15 минут", onClick: () => { void change({ due_at: new Date(Date.now() + 15 * 60_000).toISOString() }); } },
      ] });
      try { await showSystemReminder(item); } catch { /* The in-app reminder remains available. */ }
      displayed.add(item.delivery_token);
      try { localStorage.setItem(key, "1"); } catch { /* Do not lose the in-app result. */ }
    }
    await acknowledgeReminder(item);
  } finally { pending.delete(item.delivery_token); }
}

export function ReminderDelivery({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    const controller = new AbortController();
    const desktopListener = isDesktopApp() ? listen<string>(DESKTOP_REMINDER_READ, ({ payload }) => {
      if (!controller.signal.aborted && typeof payload === "string" && payload) {
        notify.dismiss(`reminder.${payload}`);
      }
    }).catch(() => undefined) : Promise.resolve(undefined);
    let busy = false;
    const poll = async () => {
      if (!enabled || busy || controller.signal.aborted) return;
      busy = true;
      try {
        const response = await getReminders(true, controller.signal);
        for (const item of response.items) {
          if (controller.signal.aborted) break;
          await deliver(item);
        }
      } catch { /* A transient connection failure retries on the next tick. */ }
      finally { busy = false; }
    };
    const pollWhenReady = () => { void desktopListener.then(poll); };
    const timer = enabled ? window.setInterval(pollWhenReady, 5000) : undefined;
    if (enabled) {
      pollWhenReady();
      window.addEventListener("focus", pollWhenReady);
    }
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", pollWhenReady);
      void desktopListener.then(unlisten => unlisten?.());
    };
  }, [enabled]);
  return null;
}
