// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QuickTextActions } from "./QuickTextActions";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), close: vi.fn(), edit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("./api", () => ({
  openEditor: mock.open, closeEditor: mock.close, generateEdit: mock.edit, editorPresence: async () => ({}),
}));
const skill = { enabled: true, revision: 3, model_available: true };
const selected = { id: 5, text: "Короткий пример.", application: "Блокнот", replaceable: true };

beforeEach(() => {
  vi.resetAllMocks();
  mock.open.mockResolvedValue(7);
  mock.close.mockResolvedValue(undefined);
  mock.invoke.mockResolvedValue({ id: 7, revision: 3, updates: [{ selection: selected, voice: null }] });
});
afterEach(cleanup);

test("a quick icon captures text and translates immediately", async () => {
  mock.edit.mockResolvedValue({ text: "A short example." });
  render(<QuickTextActions skill={skill} voiceSession={null} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Перевести" }));
  await screen.findByText("A short example.");
  expect(mock.edit.mock.calls[0][0]).toEqual({
    revision: 3, text: selected.text, instruction: "Переведи текст на английский язык.", example: "",
  });
  const replace = screen.getByRole("button", { name: "Заменить выделение" });
  const copy = screen.getByRole("button", { name: "Копировать результат" });
  expect(replace.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(replace);
  await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("replace_editor_selection", {
    id: 7, selectionId: 5, text: "A short example.",
  }));
});

test("clipboard text goes straight to translation and cancellation hides late results", async () => {
  mock.invoke.mockResolvedValue({ id: 7, revision: 3, updates: [{ selection: {
    ...selected, text: "A short example.", clipboard: true, replaceable: false,
  }, voice: null }] });
  let finish!: (result: { text: string }) => void;
  mock.edit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<QuickTextActions skill={skill} voiceSession={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Перевести" }));
  await waitFor(() => expect(mock.edit).toHaveBeenCalledOnce());
  expect(screen.queryByText("Отправить текст в DeepSeek?")).toBeNull();
  expect(mock.edit.mock.calls[0][0].instruction).toBe("Переведи текст на русский язык.");
  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  await act(async () => finish({ text: "Короткий пример." }));
  expect(mock.edit.mock.calls[0][1].aborted).toBe(true);
  expect(screen.queryByText("Короткий пример.")).toBeNull();
  expect(mock.close).toHaveBeenCalledWith(7);
});

test("a voice request uses the same compact panel", async () => {
  mock.invoke.mockResolvedValue({ id: 7, revision: 3, updates: [{
    selection: selected, voice: { source: "selection", instruction: "Сократи.", example: "" },
  }] });
  mock.edit.mockResolvedValue({ text: "Пример." });
  render(<QuickTextActions skill={skill} voiceSession={{ id: 7 }} />);
  await screen.findByText("Пример.");
  expect(mock.edit.mock.calls[0][0]).toEqual({
    revision: 3, text: selected.text, instruction: "Сократи.", example: "",
  });
  expect(screen.queryByRole("textbox")).toBeNull();
});
