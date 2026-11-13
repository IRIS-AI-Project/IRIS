import React from "react";
import ReactDOM from "react-dom/client";
import { MaterialButtonContours } from "./components/MaterialButtonContours";
import { ScrollEdgeFades } from "./components/ScrollEdgeFades";
import { InstallerPreviewApp } from "./installer/InstallerPreviewApp";
import "./tokens.css";
import "./styles.css";
import "./product-improvements.css";
import "./components/NotificationHost.css";
import "./components/ConfirmationSurface.css";
import "./components/MaterialButton.css";
import "./components/FieldMaterial.css";
import "./components/StatusBadge.css";
import "./animations/motion.css";
import "./installer/installer.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MaterialButtonContours />
    <ScrollEdgeFades />
    <InstallerPreviewApp />
  </React.StrictMode>
);
