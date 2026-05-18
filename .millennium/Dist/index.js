const MILLENNIUM_IS_CLIENT_MODULE = true;
const pluginName = "controller_command_runner";
function InitializePlugins() {
    var _a, _b;
    /**
     * This function is called n times depending on n plugin count,
     * Create the plugin list if it wasn't already created
     */
    (_a = (window.PLUGIN_LIST || (window.PLUGIN_LIST = {})))[pluginName] || (_a[pluginName] = {});
    (_b = (window.MILLENNIUM_PLUGIN_SETTINGS_STORE || (window.MILLENNIUM_PLUGIN_SETTINGS_STORE = {})))[pluginName] || (_b[pluginName] = {});
    window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS || (window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS = {});
    /**
     * Accepted IPC message types from Millennium backend.
     */
    let IPCType;
    (function (IPCType) {
        IPCType[IPCType["CallServerMethod"] = 0] = "CallServerMethod";
    })(IPCType || (IPCType = {}));
    let MillenniumStore = window.MILLENNIUM_PLUGIN_SETTINGS_STORE[pluginName];
    let IPCMessageId = `Millennium.Internal.IPC.[${pluginName}]`;
    let isClientModule = MILLENNIUM_IS_CLIENT_MODULE;
    const ComponentTypeMap = {
        DropDown: ['string', 'number', 'boolean'],
        NumberTextInput: ['number'],
        StringTextInput: ['string'],
        FloatTextInput: ['number'],
        CheckBox: ['boolean'],
        NumberSlider: ['number'],
        FloatSlider: ['number'],
    };
    MillenniumStore.ignoreProxyFlag = false;
    function DelegateToBackend(pluginName, name, value) {
        return MILLENNIUM_BACKEND_IPC.postMessage(IPCType.CallServerMethod, {
            pluginName,
            methodName: '__builtins__.__update_settings_value__',
            argumentList: { name, value },
        });
    }
    async function ClientInitializeIPC() {
        /** Wait for the MainWindowBrowser to not be undefined */
        while (typeof MainWindowBrowserManager === 'undefined') {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        MainWindowBrowserManager?.m_browser?.on('message', (messageId, data) => {
            if (messageId !== IPCMessageId) {
                return;
            }
            const { name, value } = JSON.parse(data);
            MillenniumStore.ignoreProxyFlag = true;
            MillenniumStore.settingsStore[name] = value;
            DelegateToBackend(pluginName, name, value);
            MillenniumStore.ignoreProxyFlag = false;
        });
    }
    if (isClientModule) {
        ClientInitializeIPC();
    }
    const StartSettingPropagation = (name, value) => {
        if (MillenniumStore.ignoreProxyFlag) {
            return;
        }
        if (isClientModule) {
            DelegateToBackend(pluginName, name, value);
            /** If the browser doesn't exist yet, no use sending anything to it. */
            if (typeof MainWindowBrowserManager !== 'undefined') {
                MainWindowBrowserManager?.m_browser?.PostMessage(IPCMessageId, JSON.stringify({ name, value }));
            }
        }
        else {
            /** Send the message to the SharedJSContext */
            SteamClient.BrowserView.PostMessageToParent(IPCMessageId, JSON.stringify({ name, value }));
        }
    };
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    const DefinePluginSetting = (obj) => {
        return new Proxy(obj, {
            set(target, property, value) {
                if (!(property in target)) {
                    throw new TypeError(`Property ${String(property)} does not exist on plugin settings`);
                }
                const settingType = ComponentTypeMap[target[property].type];
                const range = target[property]?.range;
                /** Clamp the value between the given range */
                if (settingType.includes('number') && typeof value === 'number') {
                    if (range) {
                        value = clamp(value, range[0], range[1]);
                    }
                    value || (value = 0); // Fallback to 0 if the value is undefined or null
                }
                /** Check if the value is of the proper type */
                if (!settingType.includes(typeof value)) {
                    throw new TypeError(`Expected ${settingType.join(' or ')}, got ${typeof value}`);
                }
                target[property].value = value;
                StartSettingPropagation(String(property), value);
                return true;
            },
            get(target, property) {
                if (property === '__raw_get_internals__') {
                    return target;
                }
                if (property in target) {
                    return target[property].value;
                }
                return undefined;
            },
        });
    };
    MillenniumStore.DefinePluginSetting = DefinePluginSetting;
    MillenniumStore.settingsStore = DefinePluginSetting({});
}
InitializePlugins()
const __call_server_method__ = (methodName, kwargs) => Millennium.callServerMethod(pluginName, methodName, kwargs)
function __wrapped_callable__(route) {
    if (route.startsWith('webkit:')) {
        return MILLENNIUM_API.callable((methodName, kwargs) => MILLENNIUM_API.__INTERNAL_CALL_WEBKIT_METHOD__(pluginName, methodName, kwargs), route.replace(/^webkit:/, ''));
    }
    return MILLENNIUM_API.callable(__call_server_method__, route);
}
let PluginEntryPointMain = function() { var millennium_main = (function (exports, jsxRuntime, react, client) {
    'use strict';

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
    const runAction = __wrapped_callable__('run_action');
    const setBackendCommand = __wrapped_callable__('set_command');
    const getBackendConfig = __wrapped_callable__('get_config');
    const frontendLog = __wrapped_callable__('frontend_log');
    let detectorStarted = false;
    let steamInputRegistered = false;
    let steamInputRegisterAttempts = 0;
    let steamInputRetryTimer;
    let unregisterCallbacks = [];
    let knownSteamListControllerKeys = new Set();
    let knownBrowserGamepadKeys = new Set();
    let lastDisconnectAt = 0;
    const steamEventLastSeenAt = new Map();
    const lastRunAtByAction = new Map();
    const commandInFlightByAction = new Set();
    function log(message) {
        console.log(`[Controller Command Runner] ${message}`);
        void frontendLog({ message }).catch(() => undefined);
    }
    function warn(message, error) {
        console.warn(`[Controller Command Runner] ${message}`, error ?? '');
        const suffix = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
        void frontendLog({ message: `WARN: ${message}${suffix}` }).catch(() => undefined);
    }
    function readStoredCommand(action) {
        const key = action === 'connect' ? CONNECT_SETTINGS_KEY : DISCONNECT_SETTINGS_KEY;
        const current = window.localStorage.getItem(key);
        if (current !== null)
            return current.trim();
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
    function writeStoredCommand(action, command) {
        const key = action === 'connect' ? CONNECT_SETTINGS_KEY : DISCONNECT_SETTINGS_KEY;
        window.localStorage.setItem(key, command);
    }
    function parseBackendConfig(raw) {
        try {
            return JSON.parse(raw || '{}');
        }
        catch (error) {
            warn('Could not parse backend config', error);
            return {};
        }
    }
    async function saveCommandEverywhere(action, command) {
        writeStoredCommand(action, command);
        try {
            const result = await setBackendCommand({ action, command });
            log(`Saved ${action} command to backend: ${result || 'ok'}`);
        }
        catch (error) {
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
        }
        catch (error) {
            warn('Could not hydrate backend config from stored commands', error);
        }
    }
    async function maybeRunConfiguredCommand(action, source) {
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
        }
        catch (error) {
            warn(`Failed to call backend run_action for ${label}`, error);
        }
        finally {
            commandInFlightByAction.delete(action);
        }
    }
    function pruneOldSteamEventKeys(now) {
        for (const [key, seenAt] of steamEventLastSeenAt.entries()) {
            if (now - seenAt > STEAM_EVENT_KEY_TTL_MS) {
                steamEventLastSeenAt.delete(key);
            }
        }
    }
    function triggerConnect(source, recognitionKey) {
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
    function triggerDisconnect(source) {
        lastDisconnectAt = Date.now();
        steamEventLastSeenAt.clear();
        void maybeRunConfiguredCommand('disconnect', source);
    }
    function controllerInfoKey(controller, fallbackIndex) {
        const index = controller.nControllerIndex ?? fallbackIndex;
        const unique = controller.unUniqueID ?? 'noUniqueId';
        const vendor = controller.unVendorID ?? 'noVendor';
        const product = controller.unProductID ?? 'noProduct';
        const type = controller.eControllerType ?? 'noType';
        const name = controller.strName ?? 'Unknown controller';
        return `${index}:${unique}:${vendor}:${product}:${type}:${name}`;
    }
    function eventControllerKey(event) {
        const index = event.nControllerIndex ?? event.unControllerIndex ?? event.nC;
        const handle = event.unControllerHandle ?? event.ulControllerHandle;
        if (handle !== undefined && handle !== null)
            return `handle:${handle}`;
        if (index !== undefined && index !== null)
            return `index:${index}`;
        return undefined;
    }
    function markControllerFromEvent(source, event) {
        const key = eventControllerKey(event);
        triggerConnect(source, key);
    }
    function markControllerList(source, controllersLike) {
        const controllers = Array.isArray(controllersLike) ? controllersLike : [];
        if (controllers.length === 0) {
            if (knownSteamListControllerKeys.size > 0 || steamEventLastSeenAt.size > 0) {
                log(`${source} fired with empty controller list; controller disconnected.`);
                knownSteamListControllerKeys.clear();
                triggerDisconnect(`${source}: empty controller list`);
            }
            else {
                log(`${source} fired with empty controller list.`);
            }
            return;
        }
        const nextKnown = new Set();
        const newlyRecognised = [];
        const removed = [];
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
        }
        else if (removed.length === 0) {
            log(`${source}: controller list changed, but no newly recognised or removed controller was found.`);
        }
    }
    function getSteamInputApi() {
        return window.SteamClient?.Input;
    }
    function registerSteamInputCallback(name, callback) {
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
        }
        catch (error) {
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
        registerSteamInputCallback('RegisterForControllerListChanges', (controllers) => {
            markControllerList('SteamInput controller list change', controllers);
        });
        registerSteamInputCallback('RegisterForUnboundControllerListChanges', (controllers) => {
            markControllerList('SteamInput unbound controller list change', controllers);
        });
        registerSteamInputCallback('RegisterForControllerStateChanges', (changes) => {
            const items = Array.isArray(changes) ? changes : [];
            if (items.length === 0)
                return;
            for (const item of items)
                markControllerFromEvent('SteamInput controller state change', item);
        });
        registerSteamInputCallback('RegisterForControllerInputMessages', (messages) => {
            const items = Array.isArray(messages) ? messages : [];
            if (items.length === 0)
                return;
            for (const item of items)
                markControllerFromEvent('SteamInput controller input message', item);
        });
        registerSteamInputCallback('RegisterForControllerCommandMessages', (message) => {
            markControllerFromEvent('SteamInput controller command message', message);
        });
        registerSteamInputCallback('RegisterForControllerAnalogInputMessages', (messages) => {
            const items = Array.isArray(messages) ? messages : [];
            if (items.length === 0)
                return;
            for (const item of items)
                markControllerFromEvent('SteamInput controller analog input message', item);
        });
        steamInputRegistered = true;
        return true;
    }
    function startSteamInputDetectors() {
        if (steamInputRegistered)
            return;
        if (tryRegisterSteamInputDetectors())
            return;
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
    function gamepadKey(gamepad) {
        return `${gamepad.index}:${gamepad.id || 'Unknown browser gamepad'}`;
    }
    function getConnectedGamepads() {
        if (!navigator.getGamepads)
            return [];
        return Array.from(navigator.getGamepads()).filter((gamepad) => Boolean(gamepad && gamepad.connected));
    }
    function scanBrowserGamepads(source) {
        const connected = getConnectedGamepads();
        const nextKnown = new Set();
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
        window.addEventListener('gamepadconnected', (event) => {
            const gamepad = event.gamepad;
            if (gamepad) {
                const key = gamepadKey(gamepad);
                const wasKnown = knownBrowserGamepadKeys.has(key);
                knownBrowserGamepadKeys.add(key);
                if (!wasKnown) {
                    void maybeRunConfiguredCommand('connect', `browser gamepadconnected: ${gamepad.id || 'Unknown browser gamepad'}`);
                }
                else {
                    log(`browser gamepadconnected fired for already-known gamepad: ${key}`);
                }
            }
            else {
                scanBrowserGamepads('browser gamepadconnected');
            }
        });
        window.addEventListener('gamepaddisconnected', (event) => {
            const gamepad = event.gamepad;
            if (gamepad) {
                const key = gamepadKey(gamepad);
                const wasKnown = knownBrowserGamepadKeys.delete(key);
                log(`browser gamepaddisconnected: ${key}`);
                if (wasKnown) {
                    triggerDisconnect(`browser gamepaddisconnected: ${gamepad.id || 'Unknown browser gamepad'}`);
                }
            }
            else {
                scanBrowserGamepads('browser gamepaddisconnected');
            }
        });
        scanBrowserGamepads('browser startup scan');
        window.setInterval(() => scanBrowserGamepads('browser polling scan'), BROWSER_GAMEPAD_POLL_MS);
    }
    function startControllerDetector() {
        if (detectorStarted)
            return;
        detectorStarted = true;
        log('Starting controller detector v1.9.0.');
        void hydrateBackendFromStoredCommands();
        startSteamInputDetectors();
        startBrowserGamepadFallback();
    }
    function CommandInput(props) {
        return (jsxRuntime.jsxs("div", { style: {
                boxSizing: 'border-box',
                width: '100%',
                padding: '14px 0',
                borderBottom: props.bottomSeparator === false ? 'none' : '1px solid rgba(255,255,255,0.08)',
            }, children: [jsxRuntime.jsx("label", { style: {
                        display: 'block',
                        marginBottom: 8,
                        fontSize: 14,
                        fontWeight: 600,
                        lineHeight: 1.25,
                        color: '#dcdedf',
                    }, children: props.label }), jsxRuntime.jsx("input", { value: props.value, onChange: (event) => props.onChange(event.currentTarget.value), placeholder: props.placeholder, spellCheck: false, style: {
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
                    } }), jsxRuntime.jsx("div", { style: {
                        marginTop: 8,
                        fontSize: 12,
                        lineHeight: 1.35,
                        color: '#8f98a0',
                    }, children: props.description })] }));
    }
    function CommandSettings() {
        const [connectCommand, setConnectCommand] = react.useState(() => readStoredCommand('connect'));
        const [disconnectCommand, setDisconnectCommand] = react.useState(() => readStoredCommand('disconnect'));
        const isWindows = navigator.platform.toLowerCase().includes('win');
        react.useEffect(() => {
            let active = true;
            getBackendConfig()
                .then((raw) => {
                if (!active)
                    return;
                const config = parseBackendConfig(raw);
                const backendConnect = (config.connect || '').trim();
                const backendDisconnect = (config.disconnect || '').trim();
                if (backendConnect) {
                    setConnectCommand(backendConnect);
                    writeStoredCommand('connect', backendConnect);
                }
                else if (connectCommand.trim()) {
                    void saveCommandEverywhere('connect', connectCommand.trim());
                }
                if (backendDisconnect) {
                    setDisconnectCommand(backendDisconnect);
                    writeStoredCommand('disconnect', backendDisconnect);
                }
                else if (disconnectCommand.trim()) {
                    void saveCommandEverywhere('disconnect', disconnectCommand.trim());
                }
            })
                .catch((error) => warn('Could not load backend config for settings UI', error));
            return () => {
                active = false;
            };
        }, []);
        react.useEffect(() => {
            void saveCommandEverywhere('connect', connectCommand);
        }, [connectCommand]);
        react.useEffect(() => {
            void saveCommandEverywhere('disconnect', disconnectCommand);
        }, [disconnectCommand]);
        return (jsxRuntime.jsxs("div", { style: {
                boxSizing: 'border-box',
                width: '100%',
                maxWidth: '100%',
                padding: '4px 24px 18px 24px',
                overflowX: 'hidden',
            }, children: [jsxRuntime.jsx(CommandInput, { label: "Command when controller is connected", description: "Runs once when Steam Input recognises a controller. Leave empty to do nothing. Saved by the Lua backend.", value: connectCommand, onChange: setConnectCommand, placeholder: isWindows ? 'notepad.exe' : 'notify-send "Controller connected"' }), jsxRuntime.jsx(CommandInput, { label: "Command when controller is disconnected", description: "Runs only after the controller disappears. Leave empty to do nothing.", value: disconnectCommand, onChange: setDisconnectCommand, placeholder: isWindows ? 'cmd /c echo Controller disconnected' : 'notify-send "Controller disconnected"', bottomSeparator: false })] }));
    }
    startControllerDetector();
    var index = client.definePlugin(() => {
        startControllerDetector();
        return {
            title: 'Controller Command Runner',
            icon: jsxRuntime.jsx("span", { children: "\uD83C\uDFAE" }),
            content: jsxRuntime.jsx(CommandSettings, {}),
        };
    });

    exports.default = index;

    Object.defineProperty(exports, '__esModule', { value: true });

    return exports;

})({}, SP_JSX_FACTORY, window.SP_REACT, window.MILLENNIUM_API);
 return millennium_main; };
function ExecutePluginModule() {
    let MillenniumStore = window.MILLENNIUM_PLUGIN_SETTINGS_STORE[pluginName];
    function OnPluginConfigChange(key, __, value) {
        if (key in MillenniumStore.settingsStore) {
            MillenniumStore.ignoreProxyFlag = true;
            MillenniumStore.settingsStore[key] = value;
            MillenniumStore.ignoreProxyFlag = false;
        }
    }
    /** Expose the OnPluginConfigChange so it can be called externally */
    MillenniumStore.OnPluginConfigChange = OnPluginConfigChange;
    MILLENNIUM_BACKEND_IPC.postMessage(0, { pluginName: pluginName, methodName: '__builtins__.__millennium_plugin_settings_parser__' }).then(async (response) => {
        /**
         * __millennium_plugin_settings_parser__ will return false if the plugin has no settings.
         * If the plugin has settings, it will return a base64 encoded string.
         * The string is then decoded and parsed into an object.
         */
        if (typeof response.returnValue === 'string') {
            MillenniumStore.ignoreProxyFlag = true;
            /** Initialize the settings store from the settings returned from the backend. */
            MillenniumStore.settingsStore = MillenniumStore.DefinePluginSetting(Object.fromEntries(JSON.parse(atob(response.returnValue)).map((item) => [item.functionName, item])));
            MillenniumStore.ignoreProxyFlag = false;
        }
        /** @ts-ignore: call the plugin main after the settings have been parsed. This prevent plugin settings from being undefined at top level. */
        let PluginModule = PluginEntryPointMain();
        /** Assign the plugin on plugin list. */
        Object.assign(window.PLUGIN_LIST[pluginName], {
            ...PluginModule,
            __millennium_internal_plugin_name_do_not_use_or_change__: pluginName,
        });
        /** Run the rolled up plugins default exported function */
        let pluginProps = await PluginModule.default();
        function isValidSidebarNavComponent(obj) {
            return obj && obj.title !== undefined && obj.icon !== undefined && obj.content !== undefined;
        }
        if (pluginProps && isValidSidebarNavComponent(pluginProps)) {
            window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS[pluginName] = pluginProps;
        }
        else {
            console.warn(`Plugin ${pluginName} does not contain proper SidebarNavigation props and therefor can't be mounted by Millennium. Please ensure it has a title, icon, and content.`);
            return;
        }
        /** If the current module is a client module, post message id=1 which calls the front_end_loaded method on the backend. */
        if (MILLENNIUM_IS_CLIENT_MODULE) {
            MILLENNIUM_BACKEND_IPC.postMessage(1, { pluginName: pluginName });
        }
    });
}
ExecutePluginModule()