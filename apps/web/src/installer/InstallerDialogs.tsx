import React from "react";
import { AppDialog } from "../components/AppDialog";
import { MaterialButton } from "../components/MaterialButton";

export function ProcessLockDialog({
  open,
  onCloseAppAndRetry,
  onCancel,
  container,
}: {
  open: boolean;
  onCloseAppAndRetry: () => void;
  onCancel: () => void;
  container?: HTMLElement | null;
}) {
  return (
    <AppDialog
      showRim={false}
      className="installer-dialog"
      open={open}
      onClose={onCancel}
      title="Iris сейчас запущена"
      description="Закройте Iris, чтобы установщик мог заменить файлы приложения. Затем повторите проверку."
      variant="warning"
      presentation="spotlight"
      container={container}
    >
      <div className="dialog-actions">
        <MaterialButton
          materialKey="dialog.lock.cancel"
          className="secondary"
          onClick={onCancel}
        >
          Отмена
        </MaterialButton>
        <MaterialButton
          materialKey="dialog.lock.retry"
          className="primary-button"
          onClick={onCloseAppAndRetry}
        >
          Повторить проверку
        </MaterialButton>
      </div>
    </AppDialog>
  );
}

export function LowDiskDialog({
  open,
  onSelectAnotherDrive,
  onCancel,
  container,
}: {
  open: boolean;
  onSelectAnotherDrive: () => void;
  onCancel: () => void;
  container?: HTMLElement | null;
}) {
  return (
    <AppDialog
      showRim={false}
      className="installer-dialog installer-low-disk-dialog"
      open={open}
      onClose={onCancel}
      title="Недостаточно места на диске C:"
      variant="danger"
      presentation="spotlight"
      container={container}
    >
      <div className="installer-low-disk-scene">
        <img className="installer-scene-chibi" src="/brand/installer/chibi-low-disk.png" alt="" width={782} height={1024} draggable={false} />
        <div className="installer-low-disk-copy">
          <dl className="installer-disk-facts">
            <div><dt>Нужно для установки</dt><dd>1,8 ГБ</dd></div>
            <div><dt>Свободно на диске</dt><dd>640 МБ</dd></div>
          </dl>
          <p>Освободите место или выберите другую папку.</p>
        </div>
      </div>
      <div className="dialog-actions">
        <MaterialButton
          materialKey="dialog.disk.cancel"
          className="secondary"
          onClick={onCancel}
        >
          Отмена
        </MaterialButton>
        <MaterialButton
          materialKey="dialog.disk.select"
          className="primary-button"
          tone="accent"
          onClick={onSelectAnotherDrive}
        >
          Выбрать другой диск
        </MaterialButton>
      </div>
    </AppDialog>
  );
}
