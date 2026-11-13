// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceArtAxis, useInstallerArtMotion } from "./useInstallerArtMotion";

type TestClock = { tick: (ms: number) => void; cancel: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
const state = vi.hoisted(() => ({ reduced: false, clocks: [] as TestClock[] }));
vi.mock("animejs", () => ({ createTimer: (params: { onUpdate: (timer: { deltaTime: number }) => void }) => {
  const clock = { tick: (ms: number) => params.onUpdate({ deltaTime: ms }), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  state.clocks.push(clock);
  return clock;
} }));
vi.mock("../animations/core", () => ({
  animate: () => ({ cancel: vi.fn() }), prefersReducedMotion: () => state.reduced,
}));
let media: EventTarget;
beforeEach(() => {
  state.reduced = false;
  state.clocks = [];
  media = new EventTarget();
  vi.stubGlobal("matchMedia", () => media);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Scene() {
  const stage = useRef<HTMLElement>(null), foreground = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null), backdrop = useRef<HTMLImageElement>(null);
  useInstallerArtMotion({ stage, foreground, image, backdrop }, "welcome");
  return <aside ref={stage} data-testid="stage">
    <img ref={backdrop} alt="" data-testid="backdrop" />
    <div ref={foreground} data-testid="foreground"><img ref={image} alt="Iris" /></div>
    <button>Версия</button>
  </aside>;
}
const pointer = (target: Element, x: number, y: number, pointerType = "mouse") => {
  fireEvent(target, Object.assign(new Event("pointermove", { bubbles: true }), { clientX: x, clientY: y, pointerType }));
};

describe("инерция иллюстрации", () => {
  it("даёт одинаковое положение и скорость при разной частоте кадров", () => {
    const one = { position: 0, velocity: 0 }, two = { ...one };
    advanceArtAxis(one, 7, 11, 1 / 30);
    advanceArtAxis(two, 7, 11, 1 / 60);
    advanceArtAxis(two, 7, 11, 1 / 60);
    expect(one.position).toBeCloseTo(two.position, 10);
    expect(one.velocity).toBeCloseTo(two.velocity, 10);
  });
  it("сохраняет движение при резкой смене направления и затем спокойно возвращается", () => {
    const axis = { position: 0, velocity: 0 };
    for (let i = 0; i < 10; i++) advanceArtAxis(axis, 7, 11, 1 / 60);
    const before = axis.position;
    advanceArtAxis(axis, -7, 11, .001);
    expect(axis.velocity).toBeGreaterThan(0);
    expect(axis.position - before).toBeGreaterThan(0);
    expect(axis.position - before).toBeLessThan(.1);
    for (let i = 0; i < 180; i++) advanceArtAxis(axis, 0, 11, 1 / 60);
    expect(axis.position).toBeCloseTo(0, 5);
    expect(axis.velocity).toBeCloseTo(0, 5);
  });
});

describe("сцена установщика", () => {
  it("следует к последней позиции курсора, игнорирует касания и прекращает следование над кнопками", async () => {
    render(<Scene />);
    await act(async () => {});
    const host = screen.getByTestId("stage");
    const face = screen.getByTestId("foreground");
    const back = screen.getByTestId("backdrop");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 500 } as DOMRect);
    const clock = state.clocks[0];
    pointer(host, 400, 500, "touch"); clock.tick(16);
    expect(back.style.transform).toBe("translate3d(0px, 0px, 0)");
    pointer(host, 0, 0); pointer(host, 400, 500);
    clock.tick(16);
    expect(face.style.transform).toMatch(/translate3d\(0\./);
    expect(back.style.transform).toMatch(/translate3d\(-0\./);
    pointer(screen.getByRole("button"), 400, 500);
    for (let i = 0; i < 180; i++) clock.tick(16);
    const settled = back.style.transform.match(/translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\)/);
    expect(settled).not.toBeNull();
    expect(Number(settled![1])).toBeCloseTo(0, 5);
    expect(Number(settled![2])).toBeCloseTo(0, 5);
  });
  it("пауза окна не сбрасывает позу, reduced motion сразу отключает движение", async () => {
    render(<Scene />);
    await act(async () => {});
    const clock = state.clocks[0]; clock.tick(16);
    const face = screen.getByTestId("foreground");
    const pose = face.style.transform;
    fireEvent(window, new Event("blur"));
    expect(clock.pause).toHaveBeenCalled();
    expect(face.style.transform).toBe(pose);
    fireEvent(window, new Event("focus"));
    expect(clock.resume).toHaveBeenCalled();
    state.reduced = true;
    media.dispatchEvent(new Event("change"));
    expect(clock.cancel).toHaveBeenCalledOnce();
    expect(face.style.transform).toBe("");
    expect(state.clocks).toHaveLength(1);
  });
  it("не запускает анимацию после декодирования картинки уже закрытого экрана", async () => {
    const finish: (() => void)[] = [];
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true, value: vi.fn(() => new Promise<void>(resolve => finish.push(resolve))),
    });
    const { unmount } = render(<Scene />);
    unmount();
    await act(async () => { finish.forEach(resolve => resolve()); });
    expect(state.clocks).toHaveLength(0);
    delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  });
});
