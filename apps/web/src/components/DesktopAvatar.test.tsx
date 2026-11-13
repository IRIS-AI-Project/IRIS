// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(() => ({
  listeners:new Map<string,(event:{payload:any})=>void>(), invoke:vi.fn(), overlay:vi.fn(), update:vi.fn(), failSend:false, snapshot:null as any,
}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mock.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async (name:string,callback:(event:{payload:any})=>void)=>{
  mock.listeners.set(name,callback); return ()=>mock.listeners.delete(name);
})}));
vi.mock("../api",()=>({
  getAvatarOverlay:mock.overlay,updateAvatarOverlay:mock.update,WS_EVENTS_URL:"ws://test/events",
  requestJson:vi.fn(async path => path === "/skills" ? {text_editor:{enabled:true,revision:1,model_available:true}} : {}),
}));
import { DesktopAvatar } from "./DesktopAvatar";
import { desktopAvatarControls, localAvatarRect, placePanel } from "../desktop-avatar";
const layout={monitor:"primary",x_ratio:0.8,y_ratio:1,height_dip:400};
const overlay={visible:true,always_on_top:true,locked:true,desktop_mode:"waist",layouts:{waist:layout},subtitles_enabled:true,subtitle_position:"above",scale:1,monitor:"primary",x:0,y:0,width:640,height:720};
const geometry={desktop_mode:"waist",monitor:{id:"primary",name:"Test",area:{x:0,y:0,width:1024,height:760},scale:1,primary:true},rect:{x:750,y:360,width:264,height:400},layout,transforming:false,commit:false};
const conversation={session_id:"session",ready:true,loading:false,document_busy:false,microphone_active:false,microphone_starting:false,sound_muted:false,voice_state:"speaking",cue:"Субтитры видны без наведения.",error:null};
function emit(name:string,payload:unknown) { mock.listeners.get(name)?.({payload}); }
function publishConversation(patch:Partial<typeof conversation>) {
  mock.snapshot={...mock.snapshot,...patch};
  emit("desktop-avatar-conversation",mock.snapshot);
}
beforeEach(()=>{
  mock.listeners.clear();mock.invoke.mockReset();mock.failSend=false;
  mock.snapshot={...conversation};
  mock.update.mockReset();
  mock.overlay.mockResolvedValue(overlay);mock.update.mockImplementation(async patch=>({...overlay,...patch}));
  vi.stubGlobal("WebSocket",class {close(){} });
  mock.invoke.mockImplementation(async (name,args)=>{
    if(name==="configure_desktop_avatar") return geometry;
    if(name==="desktop_avatar_command") queueMicrotask(()=>emit("desktop-avatar-conversation",{
      ...mock.snapshot,ack:args.command.id,command_error:args.command.type==="send" && mock.failSend?"Нет связи":undefined,
    }));
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();document.body.classList.remove("desktop-avatar-body");vi.unstubAllGlobals();});

it("does not show a historical cue while Iris is idle",async()=>{
  mock.snapshot={...conversation,voice_state:"idle",cue:"Старая реплика."};
  render(<DesktopAvatar/>);
  await screen.findByLabelText("Переместить Iris");
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
  act(()=>publishConversation({cue:"Ответ ещё не произнесён.",loading:true}));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
});

it("hides the last spoken cue exactly two seconds after speech despite idle snapshots",async()=>{
  render(<DesktopAvatar/>);
  await screen.findByRole("region",{name:"Субтитры Iris"});
  vi.useFakeTimers();
  act(()=>publishConversation({voice_state:"idle"}));
  act(()=>vi.advanceTimersByTime(1000));
  act(()=>publishConversation({cue:"Новая, но не произнесённая строка."}));
  act(()=>vi.advanceTimersByTime(999));
  expect(screen.getByRole("region",{name:"Субтитры Iris"})).toHaveTextContent(conversation.cue);
  act(()=>vi.advanceTimersByTime(1));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
  act(()=>vi.advanceTimersByTime(3000));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
});

it("cancels the old hide timer for resumed speech and clears the cue on session changes",async()=>{
  render(<DesktopAvatar/>);
  await screen.findByRole("region",{name:"Субтитры Iris"});
  vi.useFakeTimers();
  act(()=>publishConversation({voice_state:"idle"}));
  act(()=>vi.advanceTimersByTime(1000));
  act(()=>publishConversation({voice_state:"speaking",cue:"Следующая фраза."}));
  act(()=>vi.advanceTimersByTime(1500));
  expect(screen.getByRole("region",{name:"Субтитры Iris"})).toHaveTextContent("Следующая фраза.");
  act(()=>publishConversation({voice_state:"idle"}));
  act(()=>vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
  act(()=>publishConversation({voice_state:"speaking",cue:"Последняя фраза."}));
  act(()=>publishConversation({session_id:"another",voice_state:"idle",cue:"Старая строка другого диалога."}));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
  act(()=>publishConversation({session_id:"session",voice_state:"idle"}));
  expect(screen.queryByRole("region",{name:"Субтитры Iris"})).not.toBeInTheDocument();
});

it("shows subtitles without hover and reveals the toolbar only over the avatar",async()=>{
  render(<DesktopAvatar/>);
  await screen.findByRole("region",{name:"Субтитры Iris"});
  expect(screen.getByRole("region",{name:"Субтитры Iris"}).querySelector(".confirmation-rim")).toBeNull();
  expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  act(()=>emit("desktop-avatar-hover",true));
  await waitFor(()=>expect(screen.getByRole("toolbar")).toBeVisible());
  expect(screen.queryByRole("button",{name:"Изменить размер Iris"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:/положение и размер|Открыть приложение Iris/})).not.toBeInTheDocument();
  expect(screen.getByRole("group",{name:"Микрофон и звук"})).toContainElement(screen.getByRole("button",{name:"Включить микрофон"}));
  // Only actual controls become native hit regions; the full-screen toolbar stays transparent.
  await waitFor(()=>expect(mock.invoke).toHaveBeenCalledWith("set_desktop_avatar_regions",expect.anything()));
  expect(mock.update).not.toHaveBeenCalled();
});
it("keeps resize available when placement is unlocked in settings",async()=>{
  mock.overlay.mockResolvedValue({...overlay,locked:false});
  render(<DesktopAvatar/>); await screen.findByLabelText("Переместить Iris");
  act(()=>emit("desktop-avatar-hover",true));
  expect(await screen.findByRole("button",{name:"Изменить размер Iris"})).toBeVisible();
});
it.each([true,false])("keeps controls usable across native avatar gaps and buttons (locked=%s)",async locked=>{
  mock.overlay.mockResolvedValue({...overlay,locked});
  render(<DesktopAvatar/>);
  await screen.findByRole("region",{name:"Субтитры Iris"});
  vi.useFakeTimers();
  act(()=>emit("desktop-avatar-hover",true));
  const avatar=screen.getByLabelText("Переместить Iris");
  const toolbar=screen.getByRole("toolbar");
  // Crossing Unity/WebView or click-through gaps can send DOM leave without
  // leaving the shared native hover area. The native value stays true.
  fireEvent.pointerEnter(avatar);
  fireEvent.pointerLeave(avatar);
  act(()=>vi.advanceTimersByTime(700));
  expect(toolbar).toBeVisible();
  const microphone=screen.getByRole("button",{name:"Включить микрофон"});
  fireEvent.pointerEnter(microphone);
  fireEvent.click(microphone);
  fireEvent.pointerLeave(toolbar);
  fireEvent.blur(window);
  act(()=>vi.advanceTimersByTime(700));
  expect(toolbar).toBeVisible();
  const sound=screen.getByRole("button",{name:"Выключить звук Iris"});
  fireEvent.pointerEnter(sound);
  fireEvent.click(sound);
  await act(async()=>{});
  for(const type of ["microphone","sound"]) {
    expect(mock.invoke).toHaveBeenCalledWith("desktop_avatar_command",{command:expect.objectContaining({type,session_id:"session"})});
  }
});
it("hides controls after leaving the native area and cancels hiding on reentry",async()=>{
  render(<DesktopAvatar/>);
  await screen.findByLabelText("Переместить Iris");
  vi.useFakeTimers();
  act(()=>emit("desktop-avatar-hover",true));
  act(()=>emit("desktop-avatar-hover",false));
  act(()=>vi.advanceTimersByTime(349));
  expect(screen.getByRole("toolbar")).toBeVisible();
  act(()=>emit("desktop-avatar-hover",true));
  act(()=>vi.advanceTimersByTime(700));
  expect(screen.getByRole("toolbar")).toBeVisible();
  act(()=>emit("desktop-avatar-hover",false));
  act(()=>vi.advanceTimersByTime(350));
  expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  act(()=>emit("desktop-avatar-hover",true));
  expect(screen.getByRole("toolbar")).toBeVisible();
});
it("switches left panels, retains the draft and returns focus on Escape",async()=>{
  render(<DesktopAvatar/>); await screen.findByLabelText("Переместить Iris");
  act(()=>emit("desktop-avatar-hover",true));
  const chat=screen.getByRole("button",{name:"Написать Iris"});
  const tools=screen.getByRole("button",{name:"Инструменты"});
  fireEvent.click(chat);
  const input=screen.getByRole("textbox",{name:"Сообщение Iris"});
  expect(input).toHaveFocus();
  fireEvent.change(input,{target:{value:"Черновик"}});
  expect(chat).toHaveAttribute("aria-expanded","true");
  expect(chat).toHaveClass("dp-accent");
  fireEvent.click(tools);
  expect(screen.getByRole("dialog",{name:"Инструменты Iris"})).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(chat).toHaveAttribute("aria-expanded","false");
  fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"});
  expect(tools).toHaveFocus();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(chat);
  expect(screen.getByRole("textbox",{name:"Сообщение Iris"})).toHaveValue("Черновик");
  fireEvent.click(chat);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("previews tools on mouse hover and keeps the preview open across the gap without moving focus", async () => {
  render(<DesktopAvatar />);
  await screen.findByLabelText("Переместить Iris");
  vi.useFakeTimers();
  act(() => emit("desktop-avatar-hover", true));
  const trigger = screen.getByRole("button", { name: "Инструменты" });
  const pointer = (type: string, pointerType: string, target: HTMLElement) =>
    fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType }));
  pointer("pointerover", "touch", trigger);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  pointer("pointerout", "touch", trigger);
  pointer("pointerover", "mouse", trigger);
  act(() => vi.advanceTimersByTime(64));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  const panel = screen.getByRole("dialog", { name: "Инструменты Iris" });
  expect(panel).toBeVisible();
  expect(document.activeElement).toBe(document.body);

  pointer("pointerout", "mouse", trigger);
  act(() => vi.advanceTimersByTime(200));
  pointer("pointerover", "mouse", panel);
  act(() => vi.advanceTimersByTime(500));
  expect(panel).toBeVisible();
  pointer("pointerout", "mouse", panel);
  act(() => vi.advanceTimersByTime(320));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  pointer("pointerover", "mouse", trigger);
  act(() => vi.advanceTimersByTime(65));
  fireEvent.click(trigger, { detail: 1 });
  pointer("pointerout", "mouse", trigger);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("dialog", { name: "Инструменты Iris" })).toBeVisible();
});
it("keeps clicked chat open after pointer leave and preserves its draft after an outside click", async () => {
  render(<DesktopAvatar />);
  await screen.findByLabelText("Переместить Iris");
  vi.useFakeTimers();
  act(() => emit("desktop-avatar-hover", true));
  const trigger = screen.getByRole("button", { name: "Написать Iris" });
  const pointer = (type: string, target: HTMLElement) =>
    fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: "mouse" }));
  pointer("pointerover", trigger);
  act(() => vi.advanceTimersByTime(65));
  const panel = screen.getByRole("dialog", { name: "Написать Iris" });
  const input = screen.getByRole("textbox", { name: "Сообщение Iris" });
  expect(document.body).toHaveFocus();

  pointer("pointerout", trigger);
  pointer("pointerover", panel);
  act(() => vi.advanceTimersByTime(400));
  expect(panel).toBeVisible();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(panel).not.toBeVisible();
  expect(document.body).toHaveFocus();

  pointer("pointerover", trigger);
  act(() => vi.advanceTimersByTime(65));
  fireEvent.click(trigger, { detail: 1 });
  expect(input).toHaveFocus();
  pointer("pointerout", trigger);
  act(() => vi.advanceTimersByTime(400));
  expect(panel).toBeVisible();
  fireEvent.pointerDown(document.body);
  expect(panel).not.toBeVisible();

  pointer("pointerover", trigger);
  act(() => vi.advanceTimersByTime(65));
  fireEvent.click(trigger, { detail: 1 });
  fireEvent.change(input, { target: { value: "Черновик" } });
  pointer("pointerout", panel);
  act(() => vi.advanceTimersByTime(400));
  expect(panel).toBeVisible();
  fireEvent.blur(window);
  expect(panel).not.toBeVisible();
  fireEvent.click(trigger, { detail: 1 });
  expect(input).toHaveValue("Черновик");
});
it("sends to the existing session, preserves failed text and clears accepted text",async()=>{
  render(<DesktopAvatar/>); await screen.findByLabelText("Переместить Iris");
  await waitFor(()=>expect(mock.invoke).toHaveBeenCalledWith("desktop_avatar_command",expect.anything()));
  act(()=>emit("desktop-avatar-hover",true));
  fireEvent.click(screen.getByRole("button",{name:"Написать Iris"}));
  const input=screen.getByRole("textbox",{name:"Сообщение Iris"});
  fireEvent.change(input,{target:{value:"Привет"}});mock.failSend=true;
  fireEvent.click(screen.getByRole("button",{name:"Отправить сообщение"}));
  await screen.findByText("Нет связи");expect(input).toHaveValue("Привет");
  mock.failSend=false;
  fireEvent.click(screen.getByRole("button",{name:"Отправить сообщение"}));
  await waitFor(()=>expect(input).toHaveValue(""));
  const sends=mock.invoke.mock.calls.filter(([name,args])=>name==="desktop_avatar_command"&&args.command.type==="send");
  expect(sends).toHaveLength(2);expect(sends[0][1].command.session_id).toBe("session");
});
it("saves the completed gesture only for its own desktop mode",async()=>{
  render(<DesktopAvatar/>);await screen.findByLabelText("Переместить Iris");
  const moved={...geometry,layout:{...layout,x_ratio:0.2}};
  act(()=>emit("desktop-avatar-geometry",moved));expect(mock.update).not.toHaveBeenCalled();
  act(()=>emit("desktop-avatar-geometry",{...moved,commit:true}));
  await waitFor(()=>expect(mock.update).toHaveBeenCalledWith({layouts:{waist:moved.layout}}));
});
it("converts negative physical coordinates into local DIPs and keeps the panel on screen",()=>{
  const local=localAvatarRect({...geometry,monitor:{...geometry.monitor,area:{x:-1920,y:0,width:1920,height:1040},scale:2},rect:{x:-1500,y:240,width:600,height:800}} as any);
  expect(local).toEqual({x:210,y:120,width:300,height:400});
  const panel=placePanel({x:800,y:500,width:200,height:200},296,220,{x:0,y:0,width:1024,height:760});
  expect(panel.x+panel.width).toBeLessThanOrEqual(1012);expect(panel.y+panel.height).toBeLessThanOrEqual(748);
});
it("anchors controls inside the avatar and opens panels to their left without resizing it",()=>{
  const avatar={x:600,y:200,width:352,height:400};
  const work={x:0,y:0,width:1024,height:760};
  const controls=desktopAvatarControls(avatar,work);
  expect(controls.left.x).toBe(608);
  expect(controls.right.x+controls.right.width).toBe(944);
  const panel=placePanel(avatar,296,220,work);
  expect(panel.x+panel.width).toBe(controls.left.x-12);
  expect(panel.y).toBe(controls.left.y);
  const edge={...avatar,x:0,width:93};
  const edgeControls=desktopAvatarControls(edge,work);
  const edgePanel=placePanel(edge,296,220,work);
  expect(edgePanel.x).toBe(12);
  expect(edgePanel.y).toBeGreaterThanOrEqual(edgeControls.left.y+edgeControls.left.height);
  expect(edgeControls.left.x+44).toBeLessThanOrEqual(edgeControls.right.x);
});

it("scales the desktop controls while keeping small hit targets at 44 DIP", () => {
  const work = { x: 0, y: 0, width: 1024, height: 760 };
  expect(desktopAvatarControls({ x: 0, y: 560, width: 90, height: 160 }, work).size).toBe(44);
  const large = desktopAvatarControls({ x: 0, y: 50, width: 410, height: 700 }, work);
  expect(large.size).toBe(56);
  expect(large.left.height).toBe(large.size * 2 + large.gap);
  expect(large.right.height).toBe(large.size * 2);
});


it("retains a quick edit result after outside dismissal and switching to chat", async () => {
  render(<DesktopAvatar />);
  await screen.findByLabelText("Переместить Iris");
  act(() => emit("desktop-avatar-hover", true));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("button", { name: "Перевести" });
  const original = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (name, args) => {
    if (name === "open_text_editor") return 7;
    if (name === "take_text_editor_updates") return { id: 7, revision: 1, updates: [{
      selection: { id: 5, text: "Текст", application: "Поле", replaceable: true }, voice: null,
    }] };
    return original(name, args);
  });
  const { requestJson } = await import("../api");
  vi.mocked(requestJson).mockImplementation(async (path: string) => path === "/skills"
    ? { text_editor: { enabled: true, revision: 1, model_available: true } } as any
    : path === "/skills/text-editor/edit" ? { text: "Translated text" } as any : {});
  fireEvent.pointerDown(screen.getByRole("button", { name: "Перевести" }));
  fireEvent.click(screen.getByRole("button", { name: "Перевести" }));
  await screen.findByText("Translated text");
  fireEvent.pointerLeave(screen.getByRole("dialog"));
  fireEvent.blur(window);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Написать Iris" }));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  expect(screen.getByText("Translated text")).toBeVisible();
  expect(mock.invoke).not.toHaveBeenCalledWith("close_text_editor", expect.anything());
});
