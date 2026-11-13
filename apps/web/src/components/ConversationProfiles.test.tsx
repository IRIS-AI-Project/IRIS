// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationProfiles } from "./ConversationProfiles";

afterEach(cleanup);

it("preserves saved profile values and changes only participation settings", () => {
  const onChange = vi.fn();
  render(<ConversationProfiles engagement="balanced" initiative="rare" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Помогать к месту" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "По обращению" }));
  expect(onChange).toHaveBeenLastCalledWith({ live_conversation_engagement: "low", live_conversation_initiative: "off" });
  fireEvent.click(screen.getByRole("button", { name: "Участвовать в беседе" }));
  expect(onChange).toHaveBeenLastCalledWith({ live_conversation_engagement: "high", live_conversation_initiative: "balanced" });
});

it("keeps a custom combination until the user selects a profile", () => {
  const onChange = vi.fn();
  render(<ConversationProfiles engagement="high" initiative="off" onChange={onChange} />);
  expect(screen.getByText("Свой вариант")).toBeInTheDocument();
  expect(screen.getAllByRole("button").every(button => button.getAttribute("aria-pressed") === "false")).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
