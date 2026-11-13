// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallerWindow } from "./InstallerWindow";
import { InstallerPreviewApp } from "./InstallerPreviewApp";
import { APP_VERSION, currentRelease } from "../changelog/catalog";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("установщик Iris", () => {
  it("даёт проверить исходники и документы на старте и при выборе папки", async () => {
    render(<InstallerWindow />);
    for (const options of [false, true]) {
      if (options) fireEvent.click(screen.getByRole("button", { name: "Настроить установку" }));
      fireEvent.click(screen.getByRole("button", { name: /Код и данные/ }));
      const dialog = await screen.findByRole("dialog", { name: "Открытый код и ваши данные" });
      expect(within(dialog).getByRole("link", { name: /Исходники/ })).toHaveAttribute("href", "https://github.com/bad1and/NeuroAsist");
      expect(within(dialog).getByRole("link", { name: /PRIVACY.md/ })).toHaveAttribute("target", "_blank");
      expect(within(dialog).getByRole("link", { name: /SECURITY.md/ })).toHaveAttribute("rel", "noopener noreferrer");
      fireEvent.click(within(dialog).getByRole("button", { name: "Понятно" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
  });

  it("сохраняет заметку о голосе открытой, когда установка заканчивается", async () => {
    vi.useFakeTimers();
    const { container } = render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: /03 Установка/ }));
    fireEvent.click(screen.getByRole("button", { name: /Как Iris слышит/ }));
    expect(screen.getByRole("dialog", { name: "Как Iris слышит и отвечает" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(container.querySelector(".installer-step-body")).toHaveTextContent("Iris установлена");
    expect(screen.getByRole("dialog", { name: "Как Iris слышит и отвечает" })).toBeInTheDocument();
  });

  it("открывает заметку о памяти после установки", () => {
    render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: /04 Готово/ }));
    fireEvent.click(screen.getByRole("button", { name: /Память Iris/ }));
    const dialog = screen.getByRole("dialog", { name: "Что Iris запоминает" });
    expect(within(dialog).getByText(/Удаление факта из памяти не удаляет исходную реплику/)).toBeInTheDocument();
  });

  it("сохраняет папку и ярлыки при переходах без дублирующего запуска", () => {
    render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Настроить установку" }));
    fireEvent.click(screen.getByRole("button", { name: "Обзор…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "На рабочем столе" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ярлык в меню «Пуск»" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Настроить установку" }));
    expect(screen.getByRole("textbox", { name: "Папка установки" })).toHaveValue("D:\\Programs\\Iris");
    expect(screen.getByRole("checkbox", { name: "На рабочем столе" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Ярлык в меню «Пуск»" })).not.toBeChecked();
    expect(screen.queryByText("Параметры первого запуска")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("открывает общий журнал внутри окна без отметки об установленной версии", async () => {
    const { container } = render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: `Версия ${APP_VERSION} — что нового` }));
    const dialog = await screen.findByRole("dialog", { name: "Что нового" });
    expect(container.querySelector(".installer-window")).toContainElement(dialog);
    expect(within(dialog).getByRole("heading", { name: currentRelease.title })).toBeInTheDocument();
    expect(within(dialog).queryByText("Установлена")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("разделяет сворачивание и закрытие", () => {
    const close = vi.fn(), minimize = vi.fn();
    render(<InstallerWindow onClose={close} onMinimize={minimize} />);
    fireEvent.click(screen.getByRole("button", { name: "Свернуть окно" }));
    expect(minimize).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть установщик" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("разделяет завершение, запуск и открытие папки", () => {
    const close = vi.fn(), launch = vi.fn(), folder = vi.fn();
    render(<InstallerWindow onClose={close} onLaunchIris={launch} onOpenAppFolder={folder} />);
    fireEvent.click(screen.getByRole("button", { name: /04 Готово/ }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(close).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Запустить Iris" }));
    expect(launch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Открыть папку" }));
    expect(folder).toHaveBeenCalledOnce();
  });

  it("блокирует установку при нехватке места и учитывает смену диска", async () => {
    const { container } = render(<InstallerWindow currentScenario="low-disk" />);
    expect(container.querySelector(".installer-window")).toContainElement(screen.getByRole("alertdialog"));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Установить" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Настроить установку" }));
    expect(screen.getByRole("button", { name: "Установить Iris" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Обзор…" }));
    expect(screen.getByRole("button", { name: "Установить Iris" })).toBeEnabled();
  });

  it("завершает имитацию установки и отменяет отложенный переход при уходе", async () => {
    vi.useFakeTimers();
    render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Установить" }));
    await act(async () => { vi.advanceTimersByTime(5500); });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole("heading", { name: "Папка установки" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Установить Iris" }));
    await act(async () => { vi.advanceTimersByTime(5500); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole("heading", { name: "Iris установлена" })).toBeInTheDocument();
  });

  it("сохраняет сценарий обновления до завершения", async () => {
    vi.useFakeTimers();
    render(<InstallerPreviewApp />);
    expect(screen.getByText("960 × 580")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Обновление$/ }));
    expect(screen.getByRole("heading", { name: "Обновление Iris" })).toBeInTheDocument();
    expect(screen.getByText("0.8.4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Параметры обновления" }));
    expect(screen.queryByRole("button", { name: "Обзор…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Обновить Iris" }));
    expect(screen.getByRole("heading", { name: "Обновляем Iris" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(5500); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole("heading", { name: "Iris обновлена" })).toBeInTheDocument();
    expect(screen.queryByText("Iris установлена")).not.toBeInTheDocument();
  });

  it("позволяет пропустить отзыв и сохраняет выбор данных до конца удаления", async () => {
    vi.useFakeTimers();
    render(<InstallerWindow currentScenario="uninstall" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /03 Удаление/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Речевые модели/ }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(screen.getByRole("checkbox", { name: /Речевые модели/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Удалить Iris" }));
    expect(screen.getByRole("progressbar", { name: "Удаление Iris" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole("heading", { name: "Iris удалена" })).toBeInTheDocument();
    expect(screen.getByText("Профиль и настройки · История разговоров · Память Iris")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Запустить Iris" })).not.toBeInTheDocument();
  });

  it("сохраняет черновик обратной связи и показывает только введённое в отчёте", async () => {
    render(<InstallerWindow currentScenario="uninstall" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Хочу оставить обратную связь" }));
    const dialog = await screen.findByRole("dialog", { name: "Что не подошло?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Проблемы с голосом" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Комментарий к удалению" }), { target: { value: "Не подошёл голос" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Предпросмотр отчёта" }));
    const report = await screen.findByRole("dialog", { name: "Предпросмотр отчёта" });
    const reportText = (within(report).getByRole("textbox", { name: "Текст отчёта" }) as HTMLTextAreaElement).value;
    expect(reportText).toContain("Проблемы с голосом");
    expect(reportText).toContain("Не подошёл голос");
    expect(within(report).queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(within(report).getByRole("button", { name: "Закрыть" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    expect(screen.getByRole("textbox", { name: "Комментарий к удалению" })).toHaveValue("Не подошёл голос");
  });

  it("сбрасывает прогресс при смене режима и не выдаёт установку за удаление", () => {
    const { rerender } = render(<InstallerWindow />);
    fireEvent.click(screen.getByRole("button", { name: /04 Готово/ }));
    rerender(<InstallerWindow currentScenario="uninstall" />);
    expect(screen.getByRole("heading", { name: "Удаление Iris" })).toBeInTheDocument();
    rerender(<InstallerWindow currentScenario="upgrade" />);
    expect(screen.getByRole("heading", { name: "Обновление Iris" })).toBeInTheDocument();
  });

  it("показывает удаление всех данных только после снятия всех отметок", async () => {
    vi.useFakeTimers();
    render(<InstallerWindow currentScenario="uninstall" />);
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(screen.getByText("Неотмеченные данные будут удалены без возможности восстановления.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Удалить Iris" }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByText("Данные удалены")).toBeInTheDocument();
    expect(screen.queryByText("Сохранено на компьютере")).not.toBeInTheDocument();
  });
});
