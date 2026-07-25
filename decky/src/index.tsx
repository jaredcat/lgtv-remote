import { callable, definePlugin, toaster } from "@decky/api";
import {
  ButtonItem,
  DialogBody,
  DialogButton,
  DialogButtonPrimary,
  DialogFooter,
  DialogHeader,
  Field,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  showModal,
  staticClasses,
  TextField,
  ToggleField,
} from "@decky/ui";
import { useCallback, useEffect, useState } from "react";
import { FaTv } from "react-icons/fa";

type Settings = {
  tv_name: string;
  tv_ip: string;
  use_ssl: boolean;
  client_key: string | null;
  mac: string | null;
  connected: boolean;
};

type Result = Settings & {
  success: boolean;
  message?: string;
  error?: string;
};

const getSettings = callable<[], Settings>("get_settings");
const setTvIpSetting = callable<[string], Result>("set_tv_ip");
const setTvNameSetting = callable<[string], Result>("set_tv_name");
const setUseSslSetting = callable<[boolean], Result>("set_use_ssl");
const authenticate = callable<[], Result>("authenticate");
const connect = callable<[], Result>("connect");
const disconnect = callable<[], Result>("disconnect");
const getStatus = callable<[], { connected: boolean }>("get_status");
const sendButton = callable<[button: string], Result>("send_button");
const volumeUp = callable<[], Result>("volume_up");
const volumeDown = callable<[], Result>("volume_down");
const setMute = callable<[mute: boolean], Result>("set_mute");
const powerOff = callable<[], Result>("power_off");
const powerOn = callable<[], Result>("power_on");

const textFieldStyle = {
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box" as const,
};

function RemoteRow({
  label,
  onClick,
  disabled = false,
}: Readonly<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
}>) {
  return (
    <PanelSectionRow>
      <ButtonItem layout="inline" disabled={disabled} onClick={onClick}>
        {label}
      </ButtonItem>
    </PanelSectionRow>
  );
}

function TextPromptModal({
  title,
  label,
  initial,
  closeModal,
  onSave,
}: Readonly<{
  title: string;
  label: string;
  initial: string;
  closeModal: () => void;
  onSave: (value: string) => Promise<boolean>;
}>) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toaster.toast({ title: "Error", body: "Enter a value first" });
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const ok = await onSave(trimmed);
      if (ok) closeModal();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalRoot
      bAllowFullSize
      closeModal={closeModal}
      onCancel={closeModal}
      onOK={() => void handleSave()}
    >
      <DialogHeader>{title}</DialogHeader>
      <DialogBody>
        <Field label={label}>
          <TextField
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={textFieldStyle}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={closeModal} disabled={saving}>
          Cancel
        </DialogButton>
        <DialogButtonPrimary
          onClick={() => void handleSave()}
          disabled={saving || !value.trim()}
        >
          {saving ? "Saving…" : "Save"}
        </DialogButtonPrimary>
      </DialogFooter>
    </ModalRoot>
  );
}

function openTextPrompt(
  title: string,
  label: string,
  initial: string,
  onSave: (value: string) => Promise<boolean>,
) {
  const handle = showModal(
    <TextPromptModal
      title={title}
      label={label}
      initial={initial}
      onSave={onSave}
      closeModal={() => handle.Close()}
    />,
    globalThis,
    { strTitle: title, bHideMainWindowForPopouts: false },
  );
}

function toastResult(result: Result, okTitle: string) {
  if (result.success) {
    toaster.toast({ title: okTitle, body: result.message ?? "" });
  } else {
    toaster.toast({ title: "Error", body: result.error ?? "Unknown error" });
  }
}

function applySettings(result: Result, apply: (values: Settings) => void) {
  apply({
    tv_name: result.tv_name ?? "TV",
    tv_ip: result.tv_ip ?? "",
    use_ssl: result.use_ssl ?? true,
    client_key: result.client_key ?? null,
    mac: result.mac ?? null,
    connected: result.connected ?? false,
  });
}

function handleSettingsLoadError(error: unknown) {
  console.error("Failed to load settings", error);
  toaster.toast({
    title: "Error",
    body: "Could not load saved settings",
  });
}

function updateConnectionState(
  isConnected: boolean,
  setConnected: (value: boolean | ((wasConnected: boolean) => boolean)) => void,
  setSetupOpen: (value: boolean) => void,
) {
  setConnected((wasConnected) => {
    if (isConnected && !wasConnected) {
      setSetupOpen(false);
    }
    return isConnected;
  });
}

async function pollConnectionStatus(
  setConnected: (value: boolean | ((wasConnected: boolean) => boolean)) => void,
  setSetupOpen: (value: boolean) => void,
) {
  try {
    const status = await getStatus();
    updateConnectionState(status.connected, setConnected, setSetupOpen);
  } catch {
    // Ignore transient poll failures.
  }
}

function createAsyncHandler(
  runVoid: (fn: () => Promise<Result>) => Promise<void>,
  action: () => Promise<Result>,
) {
  return () => void runVoid(action);
}

function Content() {
  const [tvName, setTvName] = useState("TV");
  const [tvIp, setTvIp] = useState("");
  const [useSsl, setUseSsl] = useState(true);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [mac, setMac] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(true);

  const hasIp = Boolean(tvIp.trim());
  const paired = Boolean(clientKey);
  const configured = hasIp && paired;

  const applyLoadedSettings = useCallback((s: Settings) => {
    setTvName(s.tv_name);
    setTvIp(s.tv_ip);
    setUseSsl(s.use_ssl);
    setClientKey(s.client_key);
    setMac(s.mac);
    setConnected(s.connected);
    if (s.connected) {
      setSetupOpen(false);
    } else if (!s.tv_ip.trim() || !s.client_key) {
      setSetupOpen(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    const s = await getSettings();
    applyLoadedSettings(s);
  }, [applyLoadedSettings]);

  useEffect(() => {
    void refresh().catch(handleSettingsLoadError);
    const id = setInterval(() => {
      void pollConnectionStatus(setConnected, setSetupOpen);
    }, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const applySaveResult = (result: Result, okTitle: string) => {
    if (result.success) {
      applySettings(result, applyLoadedSettings);
      toastResult(result, okTitle);
      return true;
    }
    toastResult(result, okTitle);
    return false;
  };

  const persistSetting = async (
    save: () => Promise<Result>,
    okTitle: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await save();
      return applySaveResult(result, okTitle);
    } catch (error) {
      console.error(error);
      toaster.toast({
        title: "Error",
        body: error instanceof Error ? error.message : "Could not save",
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const editTvName = () => {
    openTextPrompt("TV name", "Name shown in the plugin", tvName, (name) =>
      persistSetting(() => setTvNameSetting(name.trim() || "TV"), "Name saved"),
    );
  };

  const editTvIp = () => {
    openTextPrompt("TV IP address", "IP address of your LG TV", tvIp, (ip) =>
      persistSetting(() => setTvIpSetting(ip), "IP saved"),
    );
  };

  const onSslChange = async (checked: boolean) => {
    setUseSsl(checked);
    if (!hasIp || busy) return;
    setBusy(true);
    try {
      const result = await setUseSslSetting(checked);
      applySaveResult(result, "SSL setting saved");
    } catch (error) {
      console.error(error);
      toaster.toast({
        title: "Error",
        body:
          error instanceof Error ? error.message : "Could not save SSL setting",
      });
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<Result>, okTitle: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fn();
      toastResult(result, okTitle);
      if (result.success) {
        if (result.tv_ip === undefined) {
          await refresh();
        } else {
          applySettings(result, applyLoadedSettings);
        }
      }
    } catch (error) {
      console.error(error);
      toaster.toast({
        title: "Error",
        body: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const runVoid = async (fn: () => Promise<Result>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fn();
      if (!result.success) {
        toaster.toast({ title: "Error", body: result.error ?? "Failed" });
      }
    } catch (error) {
      console.error(error);
      toaster.toast({
        title: "Error",
        body: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setBusy(false);
    }
  };

  let statusLine: string;
  if (connected) {
    const ipSuffix = tvIp ? ` (${tvIp})` : "";
    statusLine = `Connected to ${tvName}${ipSuffix}`;
  } else if (configured) {
    statusLine = `Disconnected · ${tvName}`;
  } else if (hasIp) {
    statusLine = "IP saved · tap Authenticate next";
  } else {
    statusLine = "Set your TV IP to get started";
  }

  const showSetupPanel = setupOpen || !connected;

  return (
    <>
      {!showSetupPanel && (
        <PanelSection title={statusLine}>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setSetupOpen(true)}>
              Setup & settings
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {showSetupPanel && (
        <>
          <PanelSection title={connected ? "Settings" : "Setup"}>
            {connected && (
              <PanelSectionRow>
                <ButtonItem layout="below" onClick={() => setSetupOpen(false)}>
                  Hide setup
                </ButtonItem>
              </PanelSectionRow>
            )}
            <RemoteRow label="TV name" disabled={busy} onClick={editTvName} />
            <RemoteRow label="TV IP" disabled={busy} onClick={editTvIp} />
            <PanelSectionRow>
              <ToggleField
                label="Use SSL (recommended)"
                checked={useSsl}
                disabled={busy || !hasIp}
                onChange={(checked) => void onSslChange(checked)}
              />
            </PanelSectionRow>
          </PanelSection>

          {!connected && (
            <PanelSection title="Connection">
              <RemoteRow
                label="Authenticate (pair with TV)"
                disabled={busy || !hasIp}
                onClick={() =>
                  run(authenticate, "Authenticate — accept prompt on TV")
                }
              />
              {paired && (
                <RemoteRow
                  label="Connect"
                  disabled={busy || !configured}
                  onClick={() => run(connect, "Connected")}
                />
              )}
              <PanelSectionRow>
                <div>
                  {statusLine}
                  {mac ? ` · MAC: ${mac}` : ""}
                  {!hasIp && " · Set TV IP first"}
                  {hasIp && !paired && " · Pair before connecting"}
                </div>
              </PanelSectionRow>
            </PanelSection>
          )}

          {connected && (
            <PanelSection title="Connection">
              <PanelSectionRow>
                <div>
                  {statusLine}
                  {mac ? ` · MAC: ${mac}` : ""}
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  disabled={busy}
                  onClick={() => run(disconnect, "Disconnected")}
                >
                  Disconnect
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          )}
        </>
      )}

      {connected && (
        <>
          <PanelSection title="Navigation">
            <RemoteRow
              label="▲ Up"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("UP"))}
            />
            <RemoteRow
              label="◀ Left"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("LEFT"))}
            />
            <RemoteRow
              label="OK"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("ENTER"))}
            />
            <RemoteRow
              label="▶ Right"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("RIGHT"))}
            />
            <RemoteRow
              label="▼ Down"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("DOWN"))}
            />
            <RemoteRow
              label="Back"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("BACK"))}
            />
            <RemoteRow
              label="Home"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("HOME"))}
            />
          </PanelSection>

          <PanelSection title="Media">
            <RemoteRow
              label="Rewind"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("REWIND"))}
            />
            <RemoteRow
              label="Play"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("PLAY"))}
            />
            <RemoteRow
              label="Pause"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("PAUSE"))}
            />
            <RemoteRow
              label="Stop"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => sendButton("STOP"))}
            />
            <RemoteRow
              label="Fast forward"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () =>
                sendButton("FASTFORWARD"),
              )}
            />
          </PanelSection>

          <PanelSection title="Volume">
            <RemoteRow
              label="Volume down"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, volumeDown)}
            />
            <RemoteRow
              label="Mute"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => setMute(true))}
            />
            <RemoteRow
              label="Unmute"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, () => setMute(false))}
            />
            <RemoteRow
              label="Volume up"
              disabled={busy}
              onClick={createAsyncHandler(runVoid, volumeUp)}
            />
          </PanelSection>

          <PanelSection title="Power">
            <RemoteRow
              label="Power on"
              disabled={busy}
              onClick={() => run(powerOn, "Wake sent")}
            />
            <RemoteRow
              label="Power off"
              disabled={busy}
              onClick={() => run(powerOff, "Power off sent")}
            />
          </PanelSection>
        </>
      )}

      {!connected && configured && (
        <PanelSection title="Power">
          <RemoteRow
            label="Power on (Wake-on-LAN)"
            disabled={busy}
            onClick={() => run(powerOn, "Wake sent")}
          />
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => ({
  name: "LG TV Remote",
  titleView: <div className={staticClasses.Title}>LG TV Remote</div>,
  content: <Content />,
  icon: <FaTv />,
}));
