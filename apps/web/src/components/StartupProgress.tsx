import type { StartupProgressState } from "../startup";
import { SegmentedProgress } from "./SegmentedProgress";

export function StartupProgress({ progress }: { progress: StartupProgressState }) {
  return <SegmentedProgress value={progress.value} label="Подготовка Iris" detail={progress.detail}
    max={progress.components.length} now={progress.settled} failed={progress.failed} complete={progress.complete} gradual />;
}
