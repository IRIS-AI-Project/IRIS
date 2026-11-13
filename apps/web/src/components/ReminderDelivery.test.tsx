// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { notificationStore, notify } from "../notifications";
import { acknowledgeReminder, getReminders, updateReminder } from "../product-api";
import { DESKTOP_REMINDER_READ } from "../reminder-events";
import { ReminderDelivery } from "./ReminderDelivery";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../desktop", () => ({ isDesktopApp: () => true }));
vi.mock("../product-api", () => ({
  getReminders: vi.fn(),
  acknowledgeReminder: vi.fn().mockResolvedValue({ acknowledged: true }),
  updateReminder: vi.fn(),
}));

afterEach(() => {
  cleanup();
  notify.dismissAll();
  localStorage.clear();
});

it("dismisses only the app card for the desktop delivery that was read", async () => {
  const items = [
    { id: "1", title: "Ответить на сообщения", delivery_token: "delivery-1" },
    { id: "2", title: "Позвонить", delivery_token: "delivery-2" },
  ].map(item => ({
    ...item, status: "open" as const, due_at: "2026-11-10T12:00:00Z",
    timezone_label: "Europe/Moscow", delivered_at: null,
  }));
  vi.mocked(getReminders).mockResolvedValue({ items });
  let receive: ((payload: string) => void) | undefined;
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    expect(name).toBe(DESKTOP_REMINDER_READ);
    receive = payload => handler({ event: name, id: 1, payload });
    return unlisten;
  });

  const view = render(<ReminderDelivery enabled />);
  await waitFor(() => expect(acknowledgeReminder).toHaveBeenCalledTimes(2));
  expect(invoke).toHaveBeenCalledWith("show_reminder_window", {
    title: items[0].title, deliveryToken: items[0].delivery_token,
  });
  const cardIds = () => notificationStore.getSnapshot().map(card => card.id);
  expect(cardIds()).toEqual(expect.arrayContaining(["reminder.delivery-1", "reminder.delivery-2"]));
  act(() => receive!("delivery-1"));
  expect(cardIds()).toEqual(["reminder.delivery-2"]);
  expect(updateReminder).not.toHaveBeenCalled();

  view.unmount();
  await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
});
