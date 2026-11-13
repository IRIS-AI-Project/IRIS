import { useState } from "react";
import { InstallerWindow } from "./InstallerWindow";
import type { InstallerScenario } from "./types";
import "./installer.css";

const scenarios: { id: InstallerScenario; label: string }[] = [
  { id: "normal", label: "Установка" },
  { id: "upgrade", label: "Обновление" },
  { id: "low-disk", label: "Мало места" },
  { id: "process-running", label: "Iris запущена" },
  { id: "uninstall", label: "Удаление" },
];

export function InstallerPreviewApp() {
  const [scenario, setScenario] = useState<InstallerScenario>("normal");
  const [action, setAction] = useState("");
  return <div className="iris-launcher-preview-shell">
    <header className="iris-launcher-preview-toolbar">
      <div className="iris-launcher-preview-title">Установщик Iris <span className="iris-launcher-preview-title-badge">960 × 580</span></div>
      <nav className="iris-launcher-scenarios-group" aria-label="Сценарии предпросмотра">
        {scenarios.map(item => <button key={item.id} type="button" aria-pressed={scenario === item.id}
          className={`iris-launcher-pill-btn${scenario === item.id ? " is-active" : ""}`}
          onClick={() => { setScenario(item.id); setAction(""); }}>{item.label}</button>)}
      </nav>
    </header>
    <main className="iris-launcher-preview-stage">
      <InstallerWindow currentScenario={scenario} onScenarioChange={setScenario}
        onClose={() => setAction("Предпросмотр: закрытие установщика.")}
        onMinimize={() => setAction("Предпросмотр: сворачивание окна.")}
        onLaunchIris={() => setAction("Предпросмотр: запуск Iris и закрытие установщика.")}
        onOpenAppFolder={() => setAction("Предпросмотр: открытие папки установки.")} />
    </main>
    <footer className="iris-launcher-preview-footer">
      <span>Предпросмотр интерфейса · Установка и системные действия имитируются</span>
      <span role="status">{action}</span>
    </footer>
  </div>;
}
