import React, { useEffect, useState } from 'react';
import { callable, definePlugin } from '@steambrew/client';

type CommandAction = 'connect' | 'disconnect';

type RunActionPayload = {
  [key: string]: string;
  action: CommandAction;
  source: string;
};

type SetCommandPayload = {
  [key: string]: string;
  action: CommandAction;
  command: string;
};

type FrontendLogPayload = {
  [key: string]: string;
  message: string;
};

type BackendConfig = {
  connect?: string;
  disconnect?: string;
  log?: string;
};

type Unregisterable = {
  unregister?: () => void;
  Unregister?: () => void;
  unregisterAll?: () => void;
};

type ControllerInfoLike = {
  strName?: string;
  nControllerIndex?: number;
  unUniqueID?: number;
  unVendorID?: number;
  unProductID?: number;
  eControllerType?: number;
};

type ControllerEventLike = {
  nControllerIndex?: number;
  unControllerIndex?: number;
  nC?: number;
  unControllerHandle?: number | string;
  ulControllerHandle?: number | string;
};

const CONNECT_SETTINGS_KEY = 'controller_command_runner.command.connect.v5';
const DISCONNECT_SETTINGS_KEY = 'controller_command_runner.command.disconnect.v1';
const LEGACY_CONNECT_SETTINGS_KEYS = [
  'controller_command_runner.command.v4',
  'controller_command_runner.command.v3',
  'controller_command_runner.command.v2',
  'controller_command_runner.command',
];

const GLOBAL_ACTION_COOLDOWN_MS = 2000;
const SAME_CONTROLLER_RECOGNITION_RESET_MS = 30000;
const STEAM_EVENT_KEY_TTL_MS = 60000;
const SUPPRESS_CONNECT_AFTER_DISCONNECT_MS = 3500;
const STEAM_INPUT_REGISTER_RETRY_MS = 1000;
const STEAM_INPUT_REGISTER_MAX_ATTEMPTS = 30;
const BROWSER_GAMEPAD_POLL_MS = 1500;

const runAction = callable<[RunActionPayload], string>('run_action');
const setBackendCommand = callable<[SetCommandPayload], string>('set_command');
const getBackendConfig = callable<[], string>('get_config');
const frontendLog = callable<[FrontendLogPayload], string>('frontend_log');

let detectorStarted = false;
let steamInputRegistered = false;
let steamInputRegisterAttempts = 0;
let steamInputRetryTimer: number | undefined;
let browserPollTimer: number | undefined;
let unregisterCallbacks: Unregisterable[] = [];
let knownSteamListControllerKeys = new Set<string>();
let knownBrowserGamepadKeys = new Set<string>();
let lastDisconnectAt = 0;

const steamEventLastSeenAt = new Map<string, number>();
const lastRunAtByAction = new Map<CommandAction, number>();
const commandInFlightByAction = new Set<CommandAction>();

function log(message: string) {
  console.log(`[Controller Command Runner] ${message}`);
  void frontendLog({ message }).catch(() => undefined);
}

function warn(message: string, error?: unknown) {
  console.warn(`[Controller Command Runner] ${message}`, error ?? '');
  const suffix = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
  void frontendLog({ message: `WARN: ${message}${suffix}` }).catch(() => undefined);
}

function readStoredCommand(action: CommandAction): string {
  const key = action === 'connect' ? CONNECT_SETTINGS_KEY : DISCONNECT_SETTINGS_KEY;
  const current = window.localStorage.getItem(key);
  if (current !== null) return current.trim();

  if (action === 'connect') {
    for (const legacyKey of LEGACY_CONNECT_SETTINGS_KEYS) {
      const legacyValue = window.localStorage.getItem(legacyKey);
      if (legacyValue !== null && legacyValue.trim()) {
        window.localStorage.setItem(CONNECT_SETTINGS_KEY, legacyValue.trim());
        return legacyValue.trim();
      }
    }
  }

  return '';
}

function writeStoredCommand(action: CommandAction, command: string) {
  const key = action === 'connect' ? CONNECT_SETTINGS_KEY : DISCONNECT_SETTINGS_KEY;
  window.localStorage.setItem(key, command);
}

function parseBackendConfig(raw: string): BackendConfig {
  try {
    return JSON.parse(raw || '{}') as BackendConfig;
  } catch (error) {
    warn('Could not parse backend config', error);
    return {};
  }
}

async function saveCommandEverywhere(action: CommandAction, command: string) {
  writeStoredCommand(action, command);
  try {
    const result = await setBackendCommand({ action, command });
    log(`Saved ${action} command to backend: ${result || 'ok'}`);
  } catch (error) {
    warn(`Could not save ${action} command to backend`, error);
  }
}

async function hydrateBackendFromStoredCommands() {
  try {
    const raw = await getBackendConfig();
    const config = parseBackendConfig(raw);
    const storedConnect = readStoredCommand('connect');
    const storedDisconnect = readStoredCommand('disconnect');

    if (!(config.connect || '').trim() && storedConnect) {
      await setBackendCommand({ action: 'connect', command: storedConnect });
      log('Migrated stored connect command to backend config.');
    }

    if (!(config.disconnect || '').trim() && storedDisconnect) {
      await setBackendCommand({ action: 'disconnect', command: storedDisconnect });
      log('Migrated stored disconnect command to backend config.');
    }

    log(`Backend config loaded. connectLength=${(config.connect || storedConnect || '').length}, disconnectLength=${(config.disconnect || storedDisconnect || '').length}, log=${config.log || 'unknown'}`);
  } catch (error) {
    warn('Could not hydrate backend config from stored commands', error);
  }
}

async function maybeRunConfiguredCommand(action: CommandAction, source: string) {
  const label = action === 'connect' ? 'connect' : 'disconnect';
  const now = Date.now();
  const lastRunAt = lastRunAtByAction.get(action) ?? 0;

  if (now - lastRunAt < GLOBAL_ACTION_COOLDOWN_MS) {
    log(`Detected controller ${label} event from ${source}, skipped because ${label} cooldown is active.`);
    return;
  }

  if (commandInFlightByAction.has(action)) {
    log(`Detected controller ${label} event from ${source}, skipped because the previous ${label} backend call is still running.`);
    return;
  }

  lastRunAtByAction.set(action, now);
  commandInFlightByAction.add(action);
  log(`Requesting backend to run ${label} command because of ${source}.`);

  try {
    const result = await runAction({ action, source });
    log(`Backend result for ${label}: ${result || 'no result'}`);
  } catch (error) {
    warn(`Failed to call backend run_action for ${label}`, error);
  } finally {
    commandInFlightByAction.delete(action);
  }
}

function pruneOldSteamEventKeys(now: number) {
  for (const [key, seenAt] of steamEventLastSeenAt.entries()) {
    if (now - seenAt > STEAM_EVENT_KEY_TTL_MS) {
      steamEventLastSeenAt.delete(key);
    }
  }
}

function triggerConnect(source: string, recognitionKey?: string) {
  const now = Date.now();

  if (now - lastDisconnectAt < SUPPRESS_CONNECT_AFTER_DISCONNECT_MS) {
    log(`Ignored possible connect event from ${source} because it arrived just after a disconnect.`);
    return;
  }

  if (!recognitionKey) {
    void maybeRunConfiguredCommand('connect', source);
    return;
  }

  pruneOldSteamEventKeys(now);

  const previousSeenAt = steamEventLastSeenAt.get(recognitionKey);
  steamEventLastSeenAt.set(recognitionKey, now);

  if (previousSeenAt === undefined) {
    void maybeRunConfiguredCommand('connect', `${source} controller=${recognitionKey}`);
    return;
  }

  if (now - previousSeenAt > SAME_CONTROLLER_RECOGNITION_RESET_MS) {
    void maybeRunConfiguredCommand('connect', `${source} controller=${recognitionKey} after idle gap`);
    return;
  }

  log(`Detected ${source} for already-active controller=${recognitionKey}; not rerunning connect yet.`);
}

function triggerDisconnect(source: string) {
  lastDisconnectAt = Date.now();
  steamEventLastSeenAt.clear();
  void maybeRunConfiguredCommand('disconnect', source);
}

function controllerInfoKey(controller: ControllerInfoLike, fallbackIndex: number): string {
  const index = controller.nControllerIndex ?? fallbackIndex;
  const unique = controller.unUniqueID ?? 'noUniqueId';
  const vendor = controller.unVendorID ?? 'noVendor';
  const product = controller.unProductID ?? 'noProduct';
  const type = controller.eControllerType ?? 'noType';
  const name = controller.strName ?? 'Unknown controller';
  return `${index}:${unique}:${vendor}:${product}:${type}:${name}`;
}

function eventControllerKey(event: ControllerEventLike): string | undefined {
  const index = event.nControllerIndex ?? event.unControllerIndex ?? event.nC;
  const handle = event.unControllerHandle ?? event.ulControllerHandle;

  if (handle !== undefined && handle !== null) return `handle:${handle}`;
  if (index !== undefined && index !== null) return `index:${index}`;

  return undefined;
}

function markControllerFromEvent(source: string, event: ControllerEventLike) {
  const key = eventControllerKey(event);
  triggerConnect(source, key);
}

function markControllerList(source: string, controllersLike: unknown) {
  const controllers = Array.isArray(controllersLike) ? controllersLike as ControllerInfoLike[] : [];

  if (controllers.length === 0) {
    if (knownSteamListControllerKeys.size > 0 || steamEventLastSeenAt.size > 0) {
      log(`${source} fired with empty controller list; controller disconnected.`);
      knownSteamListControllerKeys.clear();
      triggerDisconnect(`${source}: empty controller list`);
    } else {
      log(`${source} fired with empty controller list.`);
    }

    return;
  }

  const nextKnown = new Set<string>();
  const newlyRecognised: string[] = [];
  const removed: string[] = [];

  controllers.forEach((controller, index) => {
    const key = controllerInfoKey(controller, index);
    nextKnown.add(key);

    if (!knownSteamListControllerKeys.has(key)) {
      newlyRecognised.push(controller.strName || key);
    }
  });

  for (const previousKey of knownSteamListControllerKeys) {
    if (!nextKnown.has(previousKey)) {
      removed.push(previousKey);
    }
  }

  knownSteamListControllerKeys = nextKnown;

  if (removed.length > 0) {
    log(`${source}: controller removed ${removed.join(', ')}`);
    triggerDisconnect(`${source}: controller removed`);
  }

  if (newlyRecognised.length > 0) {
    log(`${source}: newly recognised controller ${newlyRecognised.join(', ')}`);
    void maybeRunConfiguredCommand('connect', source);
  } else if (removed.length === 0) {
    log(`${source}: controller list changed, but no newly recognised or removed controller was found.`);
  }
}

function getSteamInputApi(): any | undefined {
  return (window as any).SteamClient?.Input;
}

function registerSteamInputCallback(name: string, callback: (payload: any) => void) {
  const input = getSteamInputApi();
  const register = input?.[name];

  if (typeof register !== 'function') {
    log(`SteamClient.Input.${name} is not available.`);
    return;
  }

  try {
    const unregisterable = register.call(input, callback);
    if (unregisterable && typeof unregisterable === 'object') {
      unregisterCallbacks.push(unregisterable);
    }
    log(`Registered SteamClient.Input.${name}.`);
  } catch (error) {
    warn(`Could not register SteamClient.Input.${name}`, error);
  }
}

function tryRegisterSteamInputDetectors() {
  steamInputRegisterAttempts += 1;

  const input = getSteamInputApi();
  if (!input) {
    log(`SteamClient.Input not available yet. Attempt ${steamInputRegisterAttempts}/${STEAM_INPUT_REGISTER_MAX_ATTEMPTS}.`);
    return false;
  }

  registerSteamInputCallback('RegisterForControllerListChanges', (controllers: unknown) => {
    markControllerList('SteamInput controller list change', controllers);
  });

  registerSteamInputCallback('RegisterForUnboundControllerListChanges', (controllers: unknown) => {
    markControllerList('SteamInput unbound controller list change', controllers);
  });

  registerSteamInputCallback('RegisterForControllerStateChanges', (changes: unknown) => {
    const items = Array.isArray(changes) ? changes as ControllerEventLike[] : [];
    if (items.length === 0) return;
    for (const item of items) markControllerFromEvent('SteamInput controller state change', item);
  });

  registerSteamInputCallback('RegisterForControllerInputMessages', (messages: unknown) => {
    const items = Array.isArray(messages) ? messages as ControllerEventLike[] : [];
    if (items.length === 0) return;
    for (const item of items) markControllerFromEvent('SteamInput controller input message', item);
  });

  registerSteamInputCallback('RegisterForControllerCommandMessages', (message: unknown) => {
    markControllerFromEvent('SteamInput controller command message', message as ControllerEventLike);
  });

  registerSteamInputCallback('RegisterForControllerAnalogInputMessages', (messages: unknown) => {
    const items = Array.isArray(messages) ? messages as ControllerEventLike[] : [];
    if (items.length === 0) return;
    for (const item of items) markControllerFromEvent('SteamInput controller analog input message', item);
  });

  steamInputRegistered = true;
  return true;
}

function startSteamInputDetectors() {
  if (steamInputRegistered) return;

  if (tryRegisterSteamInputDetectors()) return;

  steamInputRetryTimer = window.setInterval(() => {
    if (steamInputRegistered || steamInputRegisterAttempts >= STEAM_INPUT_REGISTER_MAX_ATTEMPTS) {
      if (steamInputRetryTimer !== undefined) {
        window.clearInterval(steamInputRetryTimer);
        steamInputRetryTimer = undefined;
      }
      return;
    }

    if (tryRegisterSteamInputDetectors() && steamInputRetryTimer !== undefined) {
      window.clearInterval(steamInputRetryTimer);
      steamInputRetryTimer = undefined;
    }
  }, STEAM_INPUT_REGISTER_RETRY_MS);
}

function gamepadKey(gamepad: Gamepad): string {
  return `${gamepad.index}:${gamepad.id || 'Unknown browser gamepad'}`;
}

function getConnectedGamepads(): Gamepad[] {
  if (!navigator.getGamepads) return [];

  return Array.from(navigator.getGamepads()).filter(
    (gamepad): gamepad is Gamepad => Boolean(gamepad && gamepad.connected),
  );
}

function scanBrowserGamepads(source: string) {
  const connected = getConnectedGamepads();
  const nextKnown = new Set<string>();
  let sawNewGamepad = false;
  let sawRemovedGamepad = false;

  for (const gamepad of connected) {
    const key = gamepadKey(gamepad);
    nextKnown.add(key);

    if (!knownBrowserGamepadKeys.has(key)) {
      sawNewGamepad = true;
      void maybeRunConfiguredCommand('connect', `${source}: ${gamepad.id || 'Unknown browser gamepad'}`);
    }
  }

  for (const previousKey of knownBrowserGamepadKeys) {
    if (!nextKnown.has(previousKey)) {
      sawRemovedGamepad = true;
      log(`browser gamepad disconnected: ${previousKey}`);
    }
  }

  knownBrowserGamepadKeys = nextKnown;

  if (sawRemovedGamepad) {
    triggerDisconnect(`${source}: browser gamepad disconnected`);
  }

  if (!sawNewGamepad && !sawRemovedGamepad && source !== 'browser polling scan') {
    log(`${source}: browser gamepad scan found no changes.`);
  }
}

function startBrowserGamepadFallback() {
  window.addEventListener('gamepadconnected', (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad;
    if (gamepad) {
      const key = gamepadKey(gamepad);
      const wasKnown = knownBrowserGamepadKeys.has(key);
      knownBrowserGamepadKeys.add(key);

      if (!wasKnown) {
        void maybeRunConfiguredCommand('connect', `browser gamepadconnected: ${gamepad.id || 'Unknown browser gamepad'}`);
      } else {
        log(`browser gamepadconnected fired for already-known gamepad: ${key}`);
      }
    } else {
      scanBrowserGamepads('browser gamepadconnected');
    }
  });

  window.addEventListener('gamepaddisconnected', (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad;
    if (gamepad) {
      const key = gamepadKey(gamepad);
      const wasKnown = knownBrowserGamepadKeys.delete(key);
      log(`browser gamepaddisconnected: ${key}`);
      if (wasKnown) {
        triggerDisconnect(`browser gamepaddisconnected: ${gamepad.id || 'Unknown browser gamepad'}`);
      }
    } else {
      scanBrowserGamepads('browser gamepaddisconnected');
    }
  });

  scanBrowserGamepads('browser startup scan');
  browserPollTimer = window.setInterval(() => scanBrowserGamepads('browser polling scan'), BROWSER_GAMEPAD_POLL_MS);
}

function startControllerDetector() {
  if (detectorStarted) return;
  detectorStarted = true;

  log('Starting controller detector v1.9.0.');
  void hydrateBackendFromStoredCommands();
  startSteamInputDetectors();
  startBrowserGamepadFallback();
}

function stopControllerDetector() {
  if (steamInputRetryTimer !== undefined) {
    window.clearInterval(steamInputRetryTimer);
    steamInputRetryTimer = undefined;
  }

  if (browserPollTimer !== undefined) {
    window.clearInterval(browserPollTimer);
    browserPollTimer = undefined;
  }

  for (const unregisterable of unregisterCallbacks) {
    try {
      unregisterable.unregister?.();
      unregisterable.Unregister?.();
      unregisterable.unregisterAll?.();
    } catch (error) {
      warn('Failed to unregister a Steam Input callback', error);
    }
  }

  unregisterCallbacks = [];
  steamInputRegistered = false;
  detectorStarted = false;
  knownSteamListControllerKeys.clear();
  knownBrowserGamepadKeys.clear();
  steamEventLastSeenAt.clear();
}

function CommandInput(props: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  bottomSeparator?: boolean;
}) {
  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: '100%',
        padding: '14px 0',
        borderBottom: props.bottomSeparator === false ? 'none' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <label
        style={{
          display: 'block',
          marginBottom: 8,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.25,
          color: '#dcdedf',
        }}
      >
        {props.label}
      </label>

      <input
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        style={{
          boxSizing: 'border-box',
          display: 'block',
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          height: 32,
          padding: '6px 8px',
          borderRadius: 3,
          border: '1px solid rgba(255,255,255,0.22)',
          outline: 'none',
          background: 'rgba(0,0,0,0.28)',
          color: '#dfe3e6',
          fontSize: 13,
          fontFamily: 'inherit',
        }}
      />

      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          lineHeight: 1.35,
          color: '#8f98a0',
        }}
      >
        {props.description}
      </div>
    </div>
  );
}

function CommandSettings() {
  const [connectCommand, setConnectCommand] = useState(() => readStoredCommand('connect'));
  const [disconnectCommand, setDisconnectCommand] = useState(() => readStoredCommand('disconnect'));
  const isWindows = navigator.platform.toLowerCase().includes('win');

  useEffect(() => {
    let active = true;

    getBackendConfig()
      .then((raw) => {
        if (!active) return;
        const config = parseBackendConfig(raw);
        const backendConnect = (config.connect || '').trim();
        const backendDisconnect = (config.disconnect || '').trim();

        if (backendConnect) {
          setConnectCommand(backendConnect);
          writeStoredCommand('connect', backendConnect);
        } else if (connectCommand.trim()) {
          void saveCommandEverywhere('connect', connectCommand.trim());
        }

        if (backendDisconnect) {
          setDisconnectCommand(backendDisconnect);
          writeStoredCommand('disconnect', backendDisconnect);
        } else if (disconnectCommand.trim()) {
          void saveCommandEverywhere('disconnect', disconnectCommand.trim());
        }
      })
      .catch((error) => warn('Could not load backend config for settings UI', error));

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void saveCommandEverywhere('connect', connectCommand);
  }, [connectCommand]);

  useEffect(() => {
    void saveCommandEverywhere('disconnect', disconnectCommand);
  }, [disconnectCommand]);

  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '100%',
        padding: '4px 24px 18px 24px',
        overflowX: 'hidden',
      }}
    >
      <CommandInput
        label="Command when controller is connected"
        description="Runs once when Steam Input recognises a controller. Leave empty to do nothing. Saved by the Lua backend."
        value={connectCommand}
        onChange={setConnectCommand}
        placeholder={isWindows ? 'notepad.exe' : 'notify-send "Controller connected"'}
      />
      <CommandInput
        label="Command when controller is disconnected"
        description="Runs only after the controller disappears. Leave empty to do nothing."
        value={disconnectCommand}
        onChange={setDisconnectCommand}
        placeholder={isWindows ? 'cmd /c echo Controller disconnected' : 'notify-send "Controller disconnected"'}
        bottomSeparator={false}
      />
    </div>
  );
}

startControllerDetector();

export default definePlugin(() => {
  startControllerDetector();

  return {
    title: 'Controller Command Runner',
    icon: <span>🎮</span>,
    content: <CommandSettings />,
  };
});
