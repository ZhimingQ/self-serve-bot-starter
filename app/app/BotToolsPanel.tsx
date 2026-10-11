"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import type { Messages } from "../../lib/i18n";
import type { BotToolId } from "../../lib/botTools";
import { SectionState, errorText, statusText, toolFetch, type SectionProps } from "./botTools/shared";
import PowerSection from "./botTools/PowerSection";
import BackupSection from "./botTools/BackupSection";
import SshSection from "./botTools/SshSection";
import FilesSection from "./botTools/FilesSection";
import EndpointSection from "./botTools/EndpointSection";
import ImportSection from "./botTools/ImportSection";
import DesktopSection from "./botTools/DesktopSection";
import ComputerSection from "./botTools/ComputerSection";
import VideoSection from "./botTools/VideoSection";

/**
 * "Bot tools" — power, backup, SSH, files, API endpoint, restore, desktop,
 * "my computer" and video for the customer's OWN assistant.
 *
 * Rendered only when BOT_TOOLS leaves at least one tool on; `tools` is that
 * list, and a section is shown only when its tool is in it. The server enforces
 * the same list (app/api/bot-tools answers 404 for a disabled tool), so hiding a
 * tab here is presentation, not the security boundary.
 *
 * EXTENSION POINT: each tool is one self-contained section component in
 * ./botTools/, registered in SECTIONS below. To add a tool, add its id to
 * knownBotTools (lib/botTools.ts), its server actions to
 * lib/botToolsHandlers.ts, its strings under botTools in lib/i18n.ts (both
 * locales), and one line here.
 */
const SECTIONS: { id: BotToolId; Component: ComponentType<SectionProps> }[] = [
  { id: "power", Component: PowerSection },
  { id: "backup", Component: BackupSection },
  { id: "import", Component: ImportSection },
  { id: "files", Component: FilesSection },
  { id: "ssh", Component: SshSection },
  { id: "endpoint", Component: EndpointSection },
  { id: "desktop", Component: DesktopSection },
  { id: "computer", Component: ComputerSection },
  { id: "video", Component: VideoSection },
];

const PREVIEW_CATEGORIES = ["config", "agents", "skills", "sessions", "knowledge"];

interface Info {
  status: string;
  backupCategories: string[];
}

export default function BotToolsPanel({ copy, preview, tools }: { copy: Messages; preview: boolean; tools: BotToolId[] }) {
  const t = copy.botTools;
  const sections = SECTIONS.filter((s) => tools.includes(s.id));
  const [active, setActive] = useState<BotToolId | null>(sections[0]?.id ?? null);
  const [info, setInfo] = useState<Info | null>(preview ? { status: "running", backupCategories: PREVIEW_CATEGORIES } : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "no_instance">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<Info>("info");
    if (res.ok) {
      setInfo({
        status: typeof res.data.status === "string" ? res.data.status : "unknown",
        backupCategories: Array.isArray(res.data.backupCategories) ? res.data.backupCategories : [],
      });
      setLoad("ready");
    } else if (res.data.error === "no_instance") {
      setLoad("no_instance");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onStatus = useCallback((status: string) => {
    setInfo((current) => (current ? { ...current, status } : current));
  }, []);

  const current = sections.find((s) => s.id === active) ?? sections[0];

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{t.kicker}</span>
        <h1>{t.title}</h1>
        <p>{t.body}</p>
      </section>

      {preview && <p className="byok-note">{t.previewNote}</p>}

      {load === "loading" && <SectionState kind="loading" text={t.loading} />}
      {load === "no_instance" && <SectionState kind="note" text={errorText(copy, "no_instance")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && info && current && (
        <>
          <div className="bt-tabs" role="tablist" aria-label={t.tabsLabel}>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`bt-tab-${s.id}`}
                aria-selected={s.id === current.id}
                aria-controls="bt-tabpanel"
                className={s.id === current.id ? "is-active" : ""}
                onClick={() => setActive(s.id)}
              >
                {t.tabs[s.id]}
              </button>
            ))}
            {/* The Power tab shows the status itself. */}
            {current.id !== "power" && (
              <span className={`bt-status is-${info.status}`} role="status">
                <i aria-hidden="true" />
                {t.statusLabel}: {statusText(copy, info.status)}
              </span>
            )}
          </div>
          <div id="bt-tabpanel" role="tabpanel" aria-labelledby={`bt-tab-${current.id}`}>
            {/* Keyed by tool so switching tabs starts each section fresh. */}
            <current.Component
              key={current.id}
              copy={copy}
              preview={preview}
              status={info.status}
              onStatus={onStatus}
              backupCategories={info.backupCategories}
            />
          </div>
        </>
      )}
    </div>
  );
}
