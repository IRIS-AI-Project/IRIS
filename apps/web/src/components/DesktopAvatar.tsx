import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAvatarOverlay, updateAvatarOverlay, WS_EVENTS_URL } from "../api";
import { EDITOR_SETTING_EVENT, getSkills, type EditorAvailability } from "../skills/api";
import { QuickTextActions } from "../skills/QuickTextActions";
import type { AvatarOverlaySettings, BackendEvent } from "../types";
import { configureDesktopAvatar, desktopAvatarControls, localAvatarRect, placePanel, type DesktopAvatarGeometry, type DesktopRect } from "../desktop-avatar";
import { DOCUMENT_CHANGED, type DesktopConversationCommand, type DesktopConversationSnapshot } from "../desktop-avatar-bridge";
import { MaterialButton, MaterialButtonGroup } from "./MaterialButton";
import { DocumentAttachment } from "./DocumentAttachment";
import { ConfirmationRim } from "./ConfirmationRim";
import { buttonSeed } from "./buttonMaterial";
import { FigmaMicIcon, FigmaHeadphonesIcon } from "../FigmaIcons";
import { IconInterfaceCross,
  IconMailChatBubbleTextSquare, IconInterfacePageControllerSettings, IconInterfaceArrowUp, IconInterfaceArrowUpRight } from "../CustomIcons";
import { animate, prefersReducedMotion } from "../animations/core";
import { usePresence } from "../animations/usePresence";
import "./DesktopAvatar.css";

type Snapshot = DesktopConversationSnapshot & { ack?: string; command_error?: string };
type PanelKind = "chat" | "tools";
type Preview = "chat-preview" | "tools-preview";
type Panel = PanelKind | Preview;
const isPreview = (panel: Panel | null): panel is Preview => panel === "chat-preview" || panel === "tools-preview";
const PANEL_PREVIEW_DELAY = 65;
const PANEL_LEAVE_DELAY = 320;
const empty: DesktopConversationSnapshot = { session_id:null, ready:false, loading:false, document_busy:false,
  microphone_active:false, microphone_starting:false, sound_muted:false, voice_state:"idle", cue:"", error:null };

function AvatarControl({ children, active = false }: { children: ReactNode; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const motion = animate(ref.current, { opacity: hovered || focused ? 1 : active ? .78 : .52,
      duration: prefersReducedMotion() ? 0 : 150, ease: "outQuad" });
    return () => { motion.cancel(); };
  }, [hovered, focused, active]);
  return <div ref={ref} className="desktop-avatar-control" data-avatar-interactive
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={event => setFocused((event.target as HTMLElement).matches(":focus-visible"))} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false);
    }}>{children}</div>;
}

export function DesktopAvatar() {
  const [overlay, setOverlay] = useState<AvatarOverlaySettings | null>(null);
  const [geometry, setGeometry] = useState<DesktopAvatarGeometry | null>(null);
  const [conversation, setConversation] = useState<Snapshot>(empty);
  const [subtitle, setSubtitle] = useState<{ session: string | null; text: string }>({session:null,text:""});
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const lastPanel = useRef<Panel>("tools");
  const panelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusTools = useRef(false);
  const focusChat = useRef(false);
  const [editor, setEditor] = useState<EditorAvailability | null>(null);
  const [voiceEditor, setVoiceEditor] = useState<{ id: number } | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const [picking, setPicking] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const pickerActive=useRef(false);
  const fileBusyRef=useRef(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [panelHeight, setPanelHeight] = useState(200);
  const [clock, setClock] = useState(Date.now());
  const lastSnapshot = useRef(0);
  const snapshotPending = useRef(false);
  const captionElement = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const textTrigger = useRef<HTMLButtonElement>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshot = useRef(conversation); snapshot.current=conversation;
  const pending = useRef(new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());

  const command = useCallback((type: DesktopConversationCommand["type"], extra: Partial<DesktopConversationCommand> = {}) => {
    if(type === "snapshot" && snapshotPending.current) return Promise.resolve();
    if(type === "snapshot") snapshotPending.current=true;
    const id=crypto.randomUUID();
    return new Promise<void>((resolve,reject) => {
      const timer=setTimeout(() => { pending.current.delete(id); reject(new Error("Основное окно Iris не ответило. Откройте приложение.")); },type === "snapshot" ? 8000 : 120_000);
      pending.current.set(id,{resolve,reject,timer});
      void invoke("desktop_avatar_command", { command: { id,type,session_id:snapshot.current.session_id,...extra } }).catch(cause => {
        clearTimeout(timer); pending.current.delete(id); reject(cause);
      });
    }).finally(() => { if(type === "snapshot") snapshotPending.current=false; });
  },[]);

  useEffect(() => {
    document.documentElement.classList.add("desktop-avatar-root");
    document.body.classList.add("desktop-avatar-body");
    let disposed=false; let socket: WebSocket | null=null;
    let retry: ReturnType<typeof setTimeout>; let loading=false;
    const load = async () => {
      if (loading || disposed) return;
      loading=true;
      try {
        const next=await getAvatarOverlay(); if(disposed) return;
        setOverlay(next);
        const g=await configureDesktopAvatar(next); if(disposed) return;
        setGeometry(g);
        if(g && !next.layouts?.[g.desktop_mode]) {
          await updateAvatarOverlay({layouts:{[g.desktop_mode]:g.layout}});
        }
        setError("");
      } catch { if(!disposed) retry=setTimeout(() => void load(),1200); }
      finally { loading=false; }
    };
    const connect = () => {
      if(disposed) return;
      socket=new WebSocket(WS_EVENTS_URL);
      socket.onopen=() => void load();
      socket.onmessage=message => {
        try {
          const event=JSON.parse(message.data) as BackendEvent;
          if(event.type === "avatar.overlay_updated") void load();
          if(event.type === "documents.changed") window.dispatchEvent(new Event(DOCUMENT_CHANGED));
        } catch { /* Ignore malformed event frames. */ }
      };
      socket.onclose=() => { if(!disposed) retry=setTimeout(connect,1500); };
    };
    const listeners=[
      listen<EditorAvailability>(EDITOR_SETTING_EVENT, ({payload}) => {
        catalogRequest.current?.abort();
        setEditor(payload);
        if (!payload.enabled) setVoiceEditor(null);
      }),
      listen<number>("text-editor-reveal", ({payload}) => {
        if (disposed) return;
        clearTimeout(panelTimer.current);
        setOpenPanel("tools");
        setVoiceEditor({ id: payload });
      }),
      listen("text-editor-close-requested", () => {
        setVoiceEditor(null);
        setOpenPanel(current => current === "tools" ? null : current);
      }),
      listen<boolean>("desktop-avatar-hover", ({payload:over}) => {
        if(disposed) return;
        // Native polling covers Unity, the avatar bounds and all control regions.
        // DOM leave/blur can occur between those windows while still inside them.
        clearTimeout(leaveTimer.current);
        if(over) setHover(true);
        else leaveTimer.current=setTimeout(()=>setHover(false),350);
      }),
      listen<DesktopAvatarGeometry>("desktop-avatar-geometry", ({payload:g}) => {
        if(disposed) return; setGeometry(g);
        if(g.commit) {
          void updateAvatarOverlay({layouts:{[g.desktop_mode]:g.layout}}).then(setOverlay)
            .catch(() => setError("Не удалось сохранить положение Iris. Повторите перемещение."));
        }
      }),
      listen<Snapshot>("desktop-avatar-conversation", ({payload:next}) => {
        if(disposed) return;
        if(next.session_id !== snapshot.current.session_id) { setDraft(""); }
        snapshot.current=next; lastSnapshot.current=Date.now(); setConversation(next);
        if(next.ack) {
          const entry=pending.current.get(next.ack);
          if(entry) { clearTimeout(entry.timer); pending.current.delete(next.ack);
            if(next.command_error) entry.reject(new Error(next.command_error)); else entry.resolve(); }
        }
      }),
    ];
    void Promise.all(listeners).then(() => { if(!disposed) void command("snapshot").catch(() => {}); });
    void load(); connect();
    const heartbeat=setInterval(() => { setClock(Date.now()); void command("snapshot").catch(() => {}); },3000);
    return () => {
      document.documentElement.classList.remove("desktop-avatar-root");
      document.body.classList.remove("desktop-avatar-body");
      disposed=true; clearTimeout(retry); clearTimeout(leaveTimer.current); clearTimeout(panelTimer.current);
      clearInterval(heartbeat); socket?.close();
      for(const stop of listeners) void stop.then(unlisten => unlisten());
      for(const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error("Панель закрыта")); }
      pending.current.clear();
      void invoke("set_desktop_avatar_regions",{regions:[]});
    };
  },[command]);

  const visible = hover || focused || picking || fileBusy || openPanel !== null;
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    catalogRequest.current = controller;
    void getSkills(controller.signal).then(({ text_editor: skill }) => {
      if (!controller.signal.aborted) setEditor(skill);
    }, () => {});
    return () => controller.abort();
  }, [visible]);

  const textOpen = openPanel === "chat" || openPanel === "chat-preview";
  const toolsOpen = openPanel === "tools-preview" || openPanel === "tools";
  const [displayKind, setDisplayKind] = useState<PanelKind>("tools");
  const nextKind = textOpen ? "chat" : toolsOpen ? "tools" : displayKind;
  const switchingPanel = nextKind !== displayKind;
  const displayChat = displayKind === "chat";
  useLayoutEffect(() => { if (openPanel) lastPanel.current = openPanel; }, [openPanel]);
  const presence=usePresence<HTMLDivElement>(visible,0);
  const popover = usePresence<HTMLDivElement>(openPanel !== null && !switchingPanel, 14, {
    axis: "X", enterDuration: 165, initialOpacity: .42,
  });
  useLayoutEffect(() => {
    if (!popover.present && switchingPanel) setDisplayKind(nextKind);
  }, [nextKind, popover.present, switchingPanel]);
  const panel = useRef<HTMLDivElement>(null);
  const ready=conversation.ready && clock-lastSnapshot.current < 10_000;
  const speaking=ready && conversation.voice_state === "speaking";
  const subtitleCue=ready && subtitle.session === conversation.session_id ? subtitle.text : "";
  useEffect(() => {
    if (speaking) setSubtitle({session:conversation.session_id,text:conversation.cue});
  },[speaking,conversation.session_id,conversation.cue]);
  useEffect(() => {
    if (speaking) return;
    setSubtitle(current => current.session === conversation.session_id ? current : {session:null,text:""});
    // Measure from speech ending, not from cue updates or snapshot heartbeats.
    const timer=setTimeout(() => setSubtitle({session:null,text:""}),2000);
    return () => clearTimeout(timer);
  },[speaking,conversation.session_id]);
  const busy=conversation.loading || conversation.document_busy || sending;
  const rect=geometry ? localAvatarRect(geometry) : {x:0,y:0,width:0,height:0};
  const work: DesktopRect=geometry ? {x:0,y:0,width:geometry.monitor.area.width/geometry.monitor.scale,
    height:geometry.monitor.area.height/geometry.monitor.scale} : {x:0,y:0,width:innerWidth,height:innerHeight};
  const controls=desktopAvatarControls(rect,work);
  const position=placePanel(rect, (displayChat ? 276 : 296)+(controls.size-44)*5, panelHeight, work);
  const startTransform=(kind: "move" | "resize") => {
    if(overlay?.locked) return;
    clearTimeout(panelTimer.current);
    setVoiceEditor(null);
    setOpenPanel(current => current === "chat" ? current : null);
    void invoke("begin_desktop_avatar_transform",{kind}).catch(() => setError("Не удалось изменить размещение Iris."));
  };
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !popover.present) return;
    const measure = () => setPanelHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayChat, popover.present]);
  useEffect(() => {
    if (!isPreview(openPanel)) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      clearTimeout(panelTimer.current);
      if (lastPanel.current === "tools-preview") lastPanel.current = "tools";
      setOpenPanel(current => isPreview(current) ? null : current);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [openPanel]);
  useLayoutEffect(() => {
    if(!geometry) return;
    let stopped=false;
    const update=() => {
      if(stopped) return;
      const regions=Array.from(document.querySelectorAll<HTMLElement>("[data-avatar-interactive]"))
        .filter(element => element.getClientRects().length && !element.closest("[hidden], [inert]"))
        .map(element => { const r=element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; });
      void invoke("set_desktop_avatar_regions",{regions}).catch(() => {});
    };
    update(); const observer=new ResizeObserver(update);
    document.querySelectorAll<HTMLElement>("[data-avatar-interactive]").forEach(element => observer.observe(element));
    return () => { stopped=true; observer.disconnect(); };
  },[geometry,visible,presence.present,popover.present,openPanel,panelHeight,position.x,position.y,position.width,error,ready,conversation.error]);
  useEffect(() => {
    if(captionElement.current && subtitleCue) {
      const motion=animate(captionElement.current,{opacity:[0.55,1],duration:prefersReducedMotion()?80:150,ease:"outQuad"});
      return () => { motion.cancel(); };
    }
  },[subtitleCue]);
  useLayoutEffect(() => {
    if (!popover.present || switchingPanel) return;
    if (textOpen && focusChat.current) {
      focusChat.current = false;
      textarea.current?.focus();
    }
    if (openPanel === "tools" && focusTools.current) {
      focusTools.current = false;
      panel.current?.querySelector<HTMLButtonElement>(".desktop-tools button:not(:disabled, [aria-disabled=true])")?.focus();
    }
  }, [openPanel, popover.present, textOpen, switchingPanel]);
  useEffect(() => {
    const blur=() => {
      clearTimeout(panelTimer.current);
      focusTools.current = false;
      focusChat.current = false;
      setFocused(false);
      if (!pickerActive.current && !fileBusyRef.current) {
        if (lastPanel.current === "tools-preview") lastPanel.current = "tools";
        setOpenPanel(null); setVoiceEditor(null);
      }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !textTrigger.current?.contains(target) && !toolsTrigger.current?.contains(target)) blur();
    };
    window.addEventListener("blur",blur);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("blur",blur); document.removeEventListener("pointerdown", outside); };
  },[]);
  const onPickerInteraction=useCallback((value:boolean) => {pickerActive.current=value;setPicking(value);},[]);
  const onFileBusy=useCallback((value:boolean) => {
    fileBusyRef.current=value;
    setFileBusy(value); void command("attachment_busy",{busy:value}).catch(() => {});
  },[command]);
  const act=(type: "sound" | "microphone") => { setError(""); void command(type).catch(cause => setError(String(cause.message ?? cause))); };
  const send=async () => {
    if(!draft.trim() || !ready || busy || fileBusy) return;
    const text=draft; setSending(true); setError("");
    try { await command("send",{text}); setDraft(current => current===text ? "" : current); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "Не удалось отправить сообщение"); }
    finally { setSending(false); }
  };
  const captions=subtitleCue && (overlay?.subtitles_enabled ?? true);
  const captionWidth=Math.min(400,work.width-24);
  let caption:DesktopRect={x:rect.x+(rect.width-captionWidth)/2,y:rect.y-76,width:captionWidth,height:64};
  if(overlay?.subtitle_position==="below") caption.y=rect.y+rect.height+12;
  if(overlay?.subtitle_position==="left") {caption.x=rect.x-captionWidth-12; caption.y=rect.y+rect.height*0.3;}
  if(overlay?.subtitle_position==="right") {caption.x=rect.x+rect.width+12; caption.y=rect.y+rect.height*0.3;}
  if(caption.y+caption.height>work.height-12) caption.y=rect.y-76;
  if(caption.y<12) {caption.y=12; caption.x=rect.x-captionWidth-12;}
  caption.x=Math.max(12,Math.min(caption.x,work.width-captionWidth-12));
  caption.y=Math.max(12,Math.min(caption.y,work.height-caption.height-12));
  const style=(r:DesktopRect) => ({left:r.x,top:r.y,width:r.width});
  const previewPanel = (kind: PanelKind) => {
    clearTimeout(panelTimer.current);
    if (openPanel === null || isPreview(openPanel)) panelTimer.current = setTimeout(() => {
      setOpenPanel(current => current === null || isPreview(current) ? `${kind}-preview` : current);
    }, PANEL_PREVIEW_DELAY);
  };
  const leavePanel = () => {
    clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => {
      setOpenPanel(current => isPreview(current) ? null : current);
    }, PANEL_LEAVE_DELAY);
  };
  const closePanel=() => {
    clearTimeout(panelTimer.current);
    if (lastPanel.current === "tools-preview") lastPanel.current = "tools";
    setVoiceEditor(null);
    if (!isPreview(openPanel) || panel.current?.contains(document.activeElement)) {
      (textOpen ? textTrigger : toolsTrigger).current?.focus();
    }
    setOpenPanel(null);
  };
  if(!geometry || !overlay) return null;
  return <main className="desktop-avatar-surface" aria-label="Iris на рабочем столе"
    style={{"--avatar-control-size": `${controls.size}px`, "--avatar-control-gap": `${controls.gap}px`} as CSSProperties}
    onKeyDown={event => {
    if(event.key==="Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && (textOpen || toolsOpen)) {event.preventDefault();closePanel();}
  }} onFocusCapture={event => setFocused((event.target as HTMLElement).matches(":focus-visible") || Boolean(panel.current?.contains(event.target as Node)))} onBlurCapture={event => {
    if(!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false);
  }}>
    <div data-avatar-interactive={overlay.locked?undefined:true} className={`desktop-avatar-hit${overlay.locked?" is-locked":""}`}
      style={{...style(rect),height:rect.height}}
      onPointerDown={event => {if(event.button===0) startTransform("move");}} aria-label="Переместить Iris" />
    {visible && !overlay.locked && <button data-avatar-interactive type="button" className="desktop-avatar-resize"
      style={{left:rect.x+rect.width-16,top:rect.y+4}} aria-label="Изменить размер Iris"
      onPointerDown={event => {event.preventDefault(); if(event.button===0) startTransform("resize");}}><IconInterfaceArrowUpRight size={18} aria-hidden="true"/></button>}
    {captions && <div ref={captionElement} className="desktop-avatar-captions desktop-avatar-glass" style={style(caption)} role="region" aria-label="Субтитры Iris" data-i18n-skip>
      <p>{subtitleCue}</p></div>}
    <div ref={presence.ref} hidden={!presence.present} inert={!visible || undefined} className="desktop-avatar-controls"
      role="toolbar" aria-label="Управление Iris">
      <div className="desktop-avatar-left" style={style(controls.left)}>
        <AvatarControl active={textOpen}><MaterialButton materialKey="desktop.text" ref={textTrigger} type="button" className={`desktop-avatar-icon${textOpen?" is-active":""}`}
          tone={textOpen?"accent":"graphite"} aria-label="Написать Iris" aria-haspopup="dialog" aria-expanded={textOpen} aria-controls="desktop-avatar-popover"
          onPointerEnter={event => { if (event.pointerType === "mouse") previewPanel("chat"); }}
          onPointerLeave={leavePanel} onPointerCancel={leavePanel}
          onClick={event => {
            clearTimeout(panelTimer.current);
            setVoiceEditor(null);
            if (openPanel === "chat") {
              setOpenPanel(null);
              return;
            }
            if (textOpen) textarea.current?.focus();
            else focusChat.current = true;
            setOpenPanel("chat");
          }}><IconMailChatBubbleTextSquare size={21}/></MaterialButton></AvatarControl>
        <AvatarControl active={toolsOpen}><MaterialButton materialKey="desktop.tools" ref={toolsTrigger} type="button" className={`desktop-avatar-icon${toolsOpen?" is-active":""}`}
          tone={toolsOpen?"accent":"graphite"} aria-label="Инструменты" aria-haspopup="dialog" aria-expanded={toolsOpen} aria-controls="desktop-avatar-popover"
          onPointerEnter={event => { if (event.pointerType === "mouse") previewPanel("tools"); }}
          onPointerLeave={leavePanel} onPointerCancel={leavePanel}
          onClick={event => {
            clearTimeout(panelTimer.current);
            focusTools.current = event.detail === 0 && openPanel !== "tools";
            setVoiceEditor(null);
            setOpenPanel(current => current === "tools" ? null : "tools");
          }}><IconInterfacePageControllerSettings size={21}/></MaterialButton></AvatarControl>
      </div>
      <div className="desktop-avatar-right" style={style(controls.right)}>
        <AvatarControl><MaterialButtonGroup materialKey="desktop.media" muted={[!conversation.microphone_active,conversation.sound_muted]}
          className="desktop-avatar-media" role="group" aria-label="Микрофон и звук"
          style={{"--button-contour":"url(#iris-material-media-vertical)"} as CSSProperties}>
          <MaterialButton materialKey="desktop.mic" appearance="joined" type="button" disabled={!ready || conversation.microphone_starting}
            aria-label={conversation.microphone_starting?"Микрофон подключается":conversation.microphone_active?"Выключить микрофон":"Включить микрофон"}
            aria-pressed={conversation.microphone_active} aria-busy={conversation.microphone_starting} onClick={() => act("microphone")}><FigmaMicIcon width={21} height={23}/></MaterialButton>
          <MaterialButton materialKey="desktop.sound" appearance="joined" type="button" disabled={!ready}
            aria-label={conversation.sound_muted?"Включить звук Iris":"Выключить звук Iris"}
            aria-pressed={!conversation.sound_muted} onClick={() => act("sound")}><FigmaHeadphonesIcon width={23} height={22}/></MaterialButton>
        </MaterialButtonGroup></AvatarControl>
      </div>
    </div>
    <div ref={panel} id="desktop-avatar-popover" hidden={!popover.present} inert={switchingPanel || !(textOpen || toolsOpen) || undefined}
      data-avatar-interactive={openPanel !== null ? true : undefined} className={`desktop-avatar-popover${displayChat?" is-chat":" is-tools"}`}
      style={{...style(position),maxHeight:work.height-24}} role="dialog" aria-modal="false" aria-label={displayChat?"Написать Iris":"Инструменты Iris"}
      onPointerEnter={() => clearTimeout(panelTimer.current)} onPointerLeave={leavePanel}
      onPointerDownCapture={() => {
        clearTimeout(panelTimer.current);
        setOpenPanel(current => current === "tools-preview" ? "tools" : current === "chat-preview" ? "chat" : current);
      }} onFocusCapture={() => {
        clearTimeout(panelTimer.current);
        setOpenPanel(current => current === "tools-preview" ? "tools" : current === "chat-preview" ? "chat" : current);
      }}>
      <div ref={popover.ref} className="desktop-avatar-popover-face desktop-avatar-glass">
        <div className="desktop-avatar-popover-body">
          <form hidden={!displayChat} className="desktop-avatar-composer" onSubmit={event => {event.preventDefault();void send();}}>
            <textarea ref={textarea} aria-label="Сообщение Iris" rows={4} value={draft} onChange={event => {
              const text = event.target.value;
              setDraft(text);
              if (text) setOpenPanel(current => current === "chat-preview" ? "chat" : current);
            }}
              onKeyDown={event => {if(event.key==="Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault();void send();}}}/>
            <MaterialButton materialKey="desktop.send" type="submit" disabled={!ready || busy || fileBusy || !draft.trim()} aria-label="Отправить сообщение"><IconInterfaceArrowUp size={18}/></MaterialButton>
          </form>
          <div hidden={displayChat} className="desktop-tools">
            {editor?.enabled &&
              <QuickTextActions key={editor.revision} skill={editor} voiceSession={voiceEditor} />}
            <DocumentAttachment variant="desktop" sessionId={conversation.session_id} disabled={!ready || conversation.loading} onBusyChange={onFileBusy} onInteractionChange={onPickerInteraction}/>
          </div>
        </div>
        <ConfirmationRim cardRef={popover.ref} seed={buttonSeed("desktop.panel")} active={textOpen || toolsOpen} />
      </div>
    </div>
    {visible && (!ready || error || conversation.error) && <div data-avatar-interactive className="desktop-avatar-error desktop-avatar-glass" style={{...style(position),top:(textOpen || toolsOpen)?Math.min(position.y+panelHeight+8,work.height-80):position.y}} role="status">{error || conversation.error || "Подключаюсь к Iris…"}
        {error && <button type="button" aria-label="Закрыть сообщение" onClick={()=>setError("")}><IconInterfaceCross size={12}/></button>}</div>}
  </main>;
}
