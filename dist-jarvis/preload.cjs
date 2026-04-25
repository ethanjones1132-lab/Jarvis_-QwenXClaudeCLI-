// desktop-electron/preload.ts
var import_electron = require("electron");
var api = {
  bootstrap: () => import_electron.ipcRenderer.invoke("jarvis:bootstrap"),
  getConfig: () => import_electron.ipcRenderer.invoke("jarvis:get-config"),
  saveConfig: (config) => import_electron.ipcRenderer.invoke("jarvis:save-config", config),
  getShell: () => import_electron.ipcRenderer.invoke("jarvis:get-shell"),
  saveShell: (shell) => import_electron.ipcRenderer.invoke("jarvis:save-shell", shell),
  getFeatures: () => import_electron.ipcRenderer.invoke("jarvis:get-features"),
  getModels: () => import_electron.ipcRenderer.invoke("jarvis:get-models"),
  checkRemoteHealth: (config) => import_electron.ipcRenderer.invoke("jarvis:check-remote-health", { config }),
  startSession: (config, options) => import_electron.ipcRenderer.invoke("jarvis:start-session", { config, ...options }),
  sendPrompt: (content) => import_electron.ipcRenderer.invoke("jarvis:send-prompt", content),
  interruptSession: () => import_electron.ipcRenderer.invoke("jarvis:interrupt-session"),
  stopSession: () => import_electron.ipcRenderer.invoke("jarvis:stop-session"),
  clearTranscript: (options) => import_electron.ipcRenderer.invoke("jarvis:clear-transcript", options ?? {}),
  respondToPermission: (requestId, decision, permanent) => import_electron.ipcRenderer.invoke("jarvis:respond-to-permission", requestId, decision, permanent),
  getSandboxStatus: () => import_electron.ipcRenderer.invoke("jarvis:get-sandbox-status"),
  listCompanionProfiles: () => import_electron.ipcRenderer.invoke("jarvis:list-companion-profiles"),
  runCompanionAction: (action) => import_electron.ipcRenderer.invoke("jarvis:run-companion-action", action),
  createCompanionProfile: (profile) => import_electron.ipcRenderer.invoke("jarvis:create-companion-profile", profile),
  updateCompanionProfile: (profileId, profile) => import_electron.ipcRenderer.invoke("jarvis:update-companion-profile", profileId, profile),
  selectCompanionProfile: (profileId) => import_electron.ipcRenderer.invoke("jarvis:select-companion-profile", profileId),
  deleteCompanionProfile: (profileId) => import_electron.ipcRenderer.invoke("jarvis:delete-companion-profile", profileId),
  onEvent: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("jarvis:event", wrapped);
    return () => {
      import_electron.ipcRenderer.off("jarvis:event", wrapped);
    };
  },
  onBackendState: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("jarvis:backend-state", wrapped);
    return () => {
      import_electron.ipcRenderer.off("jarvis:backend-state", wrapped);
    };
  },
  getPlatform: () => import_electron.ipcRenderer.invoke("jarvis:get-platform"),
  minimizeWindow: () => import_electron.ipcRenderer.invoke("jarvis:minimize-window"),
  maximizeWindow: () => import_electron.ipcRenderer.invoke("jarvis:maximize-window"),
  closeWindow: () => import_electron.ipcRenderer.invoke("jarvis:close-window"),
  // Drive setup wizard
  getDriveStatus: () => import_electron.ipcRenderer.invoke("jarvis:drive-status"),
  saveDriveCredentials: (credentialsPath) => import_electron.ipcRenderer.invoke("jarvis:drive-save-credentials", credentialsPath),
  authorizeDrive: () => import_electron.ipcRenderer.invoke("jarvis:drive-authorize"),
  // Thunder Compute
  thunderOpenTerminal: () => import_electron.ipcRenderer.invoke("thunder:open-terminal"),
  thunderBeginAutomation: (instanceId, bridgeApiKey) => import_electron.ipcRenderer.invoke("thunder:begin-automation", instanceId, bridgeApiKey),
  thunderAbortAutomation: () => import_electron.ipcRenderer.invoke("thunder:abort-automation"),
  thunderHealthCheck: (publicUrl, apiKey) => import_electron.ipcRenderer.invoke("thunder:health-check", publicUrl, apiKey),
  thunderCheckSession: (instanceId) => import_electron.ipcRenderer.invoke("thunder:check-session", instanceId),
  thunderForwardPort: (instanceId) => import_electron.ipcRenderer.invoke("thunder:forward-port", instanceId),
  thunderGetSteps: () => import_electron.ipcRenderer.invoke("thunder:get-steps"),
  // V2 snapshot-driven pathway
  thunderStartSession: (bridgeApiKey, snapshotName) => import_electron.ipcRenderer.invoke("thunder:start-session", bridgeApiKey, snapshotName),
  thunderGetStepsV2: () => import_electron.ipcRenderer.invoke("thunder:get-steps-v2"),
  thunderAttachInstance: (instanceId, bridgeApiKey) => import_electron.ipcRenderer.invoke("thunder:attach-instance", instanceId, bridgeApiKey),
  thunderGetStepsV2Attach: () => import_electron.ipcRenderer.invoke("thunder:get-steps-v2-attach"),
  onThunderSessionDetected: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("thunder:session-detected", wrapped);
    return () => {
      import_electron.ipcRenderer.off("thunder:session-detected", wrapped);
    };
  },
  onThunderStepUpdate: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("thunder:step-update", wrapped);
    return () => {
      import_electron.ipcRenderer.off("thunder:step-update", wrapped);
    };
  },
  onThunderLogStream: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    import_electron.ipcRenderer.on("thunder:log-stream", wrapped);
    return () => {
      import_electron.ipcRenderer.off("thunder:log-stream", wrapped);
    };
  }
};
import_electron.contextBridge.exposeInMainWorld("jarvis", api);
