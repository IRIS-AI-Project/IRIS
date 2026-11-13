// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SkillsPage } from "./SkillsPage";
import type { SkillsCatalog } from "./api";

const mock = vi.hoisted(() => ({
  desktop: vi.fn(), get: vi.fn(), toggle: vi.fn(), patch: vi.fn(), emit: vi.fn(), close: vi.fn(),
}));
vi.mock("../desktop", () => ({ isDesktopApp: mock.desktop }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mock.emit }));
vi.mock("./api", () => ({
  getSkills: mock.get, toggleEditor: mock.toggle, patchEditor: mock.patch, closeEditor: mock.close,
  EDITOR_SETTING_EVENT: "text-editor-setting",
}));

const catalog: SkillsCatalog = {
  web_search: true,
  reminders: true,
  text_editor: { enabled: false, revision: 1, model_available: true },
};

function open() {
  const onOpenInternet = vi.fn();
  const onOpenDeepSeek = vi.fn();
  render(<SkillsPage active onOpenInternet={onOpenInternet} onOpenDeepSeek={onOpenDeepSeek} />);
  return { onOpenInternet, onOpenDeepSeek };
}

beforeEach(() => {
  vi.resetAllMocks();
  mock.desktop.mockReturnValue(true);
  mock.get.mockResolvedValue(catalog);
  mock.emit.mockResolvedValue(undefined);
  mock.close.mockResolvedValue(undefined);
});

test("saves which quick icons appear without toggling the skill", async () => {
  const enabled = { ...catalog.text_editor, enabled: true };
  const updated = { ...enabled, quick_actions: ["fix", "simplify", "translate", "shorten"] };
  mock.get.mockResolvedValue({ ...catalog, text_editor: enabled });
  mock.patch.mockResolvedValue(updated);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Кнопки у аватара" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Сократить" }));
  await waitFor(() => expect(mock.emit).toHaveBeenCalledWith("text-editor-setting", updated));
  expect(mock.patch).toHaveBeenCalledWith({ quick_actions: updated.quick_actions });
  expect(mock.toggle).not.toHaveBeenCalled();
});

afterEach(cleanup);

test("keeps search settings accessible and can recover from an unavailable catalog", async () => {
  mock.get.mockRejectedValueOnce(new Error("offline"));
  const { onOpenInternet } = open();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Подключить" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Настройки поиска" }));
  expect(onOpenInternet).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByRole("button", { name: "Подключить" });
});

test("takes the user to the missing key before enabling the editor", async () => {
  mock.get.mockResolvedValue({ ...catalog, text_editor: { ...catalog.text_editor, model_available: false } });
  const { onOpenDeepSeek } = open();
  fireEvent.click(await screen.findByRole("button", { name: "Настроить ключ" }));
  expect(onOpenDeepSeek).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Подключить" })).toBeNull();
  expect(mock.toggle).not.toHaveBeenCalled();
});

test("retries native synchronization without resaving the editor preference", async () => {
  const enabled = { ...catalog.text_editor, enabled: true, revision: 2 };
  const disabled = { ...enabled, enabled: false, revision: 3 };
  mock.toggle.mockResolvedValueOnce(enabled).mockResolvedValueOnce(disabled);
  mock.close.mockRejectedValueOnce(new Error("native IPC"));
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Подключить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Отключить" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Настройка сохранена");
  expect(screen.getByText("Не подключён")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Повторить обновление" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(mock.toggle.mock.calls).toEqual([[true], [false]]);
  expect(mock.emit.mock.calls).toEqual([enabled, disabled, disabled].map(state => ["text-editor-setting", state]));
  expect(mock.close.mock.calls).toEqual([[null], [null]]);
});
