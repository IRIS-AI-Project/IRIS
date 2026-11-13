// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TextEditorWindow } from "./TextEditorWindow";
import type { EditorUpdates } from "./api";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  generate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("./api", () => ({
  generateEdit: native.generate,
  closeEditor: native.close,
  editorPresence: vi.fn().mockResolvedValue({}),
  EDITOR_SETTING_EVENT: "text-editor-setting",
}));

const selection = { id: 8, text: "Срок 18 мая.", application: "Тестовое окно", replaceable: true };
const listeners = new Map<string, (event: { payload?: unknown }) => void>();
let update: EditorUpdates;

beforeEach(() => {
  update = { id: 1, revision: 3, updates: [{ selection, voice: null }] };
  native.invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "take_text_editor_updates" ? update : undefined));
  native.listen.mockImplementation(async (event, callback) => {
    listeners.set(event, callback);
    return () => listeners.delete(event);
  });
  native.close.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  listeners.clear();
  vi.clearAllMocks();
});

async function open() {
  render(<TextEditorWindow />);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Текст" })).toHaveProperty("value", selection.text));
}

test("a cancelled result cannot overwrite a newer draft or change the confirmed native target", async () => {
  let finish!: (value: { text: string }) => void;
  native.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  expect(screen.getByRole("button", { name: "Другие правки" }).getAttribute("aria-expanded")).toBe("false");
  const fix = screen.getByRole("button", { name: "Исправить" }) as HTMLButtonElement;
  expect(fix.disabled).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: /Разрешить отправку/ }));
  fireEvent.click(fix);
  expect(native.generate).toHaveBeenCalledOnce();
  const signal = native.generate.mock.calls[0][1] as AbortSignal;
  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  expect(signal.aborted).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Текст" }), { target: { value: "Свежая правка." } });
  await act(async () => finish({ text: "Запоздалый результат." }));
  expect(screen.getByRole("textbox", { name: "Текст" })).toHaveProperty("value", "Свежая правка.");
  fireEvent.click(screen.getByRole("button", { name: "Заменить выделение" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("replace_editor_selection", {
    id: 1, selectionId: 8, text: "Свежая правка.",
  }));
});

test("voice clarification uses the same draft and disable aborts the session", async () => {
  native.generate.mockImplementationOnce(() => new Promise(() => undefined));
  await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Текст" }), { target: { value: "Черновик после первой правки." } });
  update = { id: 1, revision: 3, updates: [{
    selection: null,
    voice: { source: "clarify", instruction: "Чуть короче.", example: "" },
  }] };
  await act(async () => listeners.get("text-editor-update")?.({}));
  expect(screen.getByText(/Какой текст отредактировать/)).toBeTruthy();
  expect(native.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("switch", { name: /Разрешить отправку/ }));
  fireEvent.click(screen.getByRole("button", { name: "Использовать черновик" }));
  expect(native.generate.mock.calls[0][0]).toEqual({
    revision: 3, text: "Черновик после первой правки.", instruction: "Чуть короче.", example: "",
  });
  await act(async () => listeners.get("text-editor-setting")?.({ payload: { enabled: false, revision: 4 } }));
  expect((native.generate.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  expect(native.close).toHaveBeenCalledWith(1);
});


test("closing on outside focus keeps the draft when the native window is revealed again", async () => {
  await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Текст" }), { target: { value: "Сохранённая правка." } });
  fireEvent.blur(window);
  await waitFor(() => expect(native.close).toHaveBeenCalledWith(1));
  update = { id: 1, revision: 3, updates: [] };
  await act(async () => listeners.get("text-editor-update")?.({}));
  expect(screen.getByRole("textbox", { name: "Текст" })).toHaveProperty("value", "Сохранённая правка.");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));
  await waitFor(() => expect(native.close).toHaveBeenCalledTimes(2));
});
