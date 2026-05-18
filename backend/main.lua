local logger = require("logger")
local millennium = require("millennium")

math.randomseed(os.time())

local function trim(value)
    if type(value) ~= "string" then return "" end
    return value:match("^%s*(.-)%s*$") or ""
end

local function is_windows()
    return package.config:sub(1, 1) == "\\" or (os.getenv("OS") or ""):lower():find("windows", 1, true) ~= nil
end

local function sep()
    return is_windows() and "\\" or "/"
end

local function path_join(left, right)
    local s = sep()
    if not left or left == "" then return right end
    if left:sub(-1) == "\\" or left:sub(-1) == "/" then return left .. right end
    return left .. s .. right
end

local function dirname(path)
    if not path then return nil end
    return path:match("^(.*)[/\\][^/\\]+$")
end

local function module_dir()
    local info = debug.getinfo(1, "S")
    local source = info and info.source or ""
    if source:sub(1, 1) == "@" then
        return dirname(source:sub(2))
    end
    return nil
end

local MODULE_DIR = module_dir() or "."
local CONFIG_CONNECT_PATH = path_join(MODULE_DIR, "controller_command_runner_connect.txt")
local CONFIG_DISCONNECT_PATH = path_join(MODULE_DIR, "controller_command_runner_disconnect.txt")

local function get_temp_dir()
    if is_windows() then
        return os.getenv("TEMP") or os.getenv("TMP") or "."
    end
    return os.getenv("TMPDIR") or "/tmp"
end

local function log_path()
    return path_join(get_temp_dir(), "controller_command_runner.log")
end

local function file_exists(path)
    local handle = io.open(path, "r")
    if handle then
        handle:close()
        return true
    end
    return false
end

local function read_text_file(path)
    local handle = io.open(path, "r")
    if not handle then return "" end
    local content = handle:read("*a") or ""
    handle:close()
    return content
end

local function write_text_file(path, content)
    local handle, err = io.open(path, "w")
    if not handle then return false, err end
    handle:write(content or "")
    handle:close()
    return true, nil
end

local function command_path_for_action(action)
    action = trim(action):lower()
    if action == "disconnect" then return CONFIG_DISCONNECT_PATH end
    return CONFIG_CONNECT_PATH
end

local function read_config_command(action)
    return trim(read_text_file(command_path_for_action(action)))
end

local function save_config_command(action, command)
    action = trim(action):lower()
    if action ~= "connect" and action ~= "disconnect" then
        return false, "Invalid action: " .. tostring(action)
    end

    local ok, err = write_text_file(command_path_for_action(action), command or "")
    if not ok then
        return false, "Could not save " .. action .. " command: " .. tostring(err)
    end

    logger:info("Controller Command Runner: saved " .. action .. " command. Length=" .. tostring(#(command or "")))
    return true, "Saved " .. action .. " command."
end

local function json_escape(value)
    value = tostring(value or "")
    value = value:gsub('\\', '\\\\')
    value = value:gsub('"', '\\"')
    value = value:gsub('\r', '\\r')
    value = value:gsub('\n', '\\n')
    value = value:gsub('\t', '\\t')
    return '"' .. value .. '"'
end

local function normalise_action_payload(first, second)
    if type(first) == "table" then
        return trim(first.action), trim(first.source)
    end
    return trim(first), trim(second)
end

local function normalise_save_payload(first, second)
    if type(first) == "table" then
        return trim(first.action), trim(first.command)
    end
    return trim(first), trim(second)
end

local function shell_quote_posix(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function windows_cmd_quote(value)
    return '"' .. tostring(value):gsub('"', '""') .. '"'
end

local function strip_outer_quotes(value)
    value = trim(value)
    if #value >= 2 then
        local first = value:sub(1, 1)
        local last = value:sub(-1)
        if (first == '"' and last == '"') or (first == "'" and last == "'") then
            return value:sub(2, -2)
        end
    end
    return value
end

local function split_windows_path(path)
    local normalised = path:gsub("/", "\\")
    local dir, file = normalised:match("^(.*)\\([^\\]+)$")
    return dir, file
end

local function get_extension(path)
    local ext = path:match("%.([^%.\\/]+)$")
    if not ext then return "" end
    return ext:lower()
end

local function unique_temp_path(extension)
    local temp_dir = get_temp_dir()
    for _ = 1, 20 do
        local suffix = tostring(os.time()) .. "_" .. tostring(math.random(100000, 999999))
        local path = path_join(temp_dir, "controller_command_runner_" .. suffix .. extension)
        if not file_exists(path) then return path end
    end
    return path_join(temp_dir, "controller_command_runner_" .. tostring(os.time()) .. extension)
end

local function safe_echo_text(value)
    value = tostring(value or "")
    value = value:gsub("%%", "%%%%")
    value = value:gsub("\r", " "):gsub("\n", " ")
    return value
end

local function make_windows_user_block(command)
    local unquoted = strip_outer_quotes(command)
    local ext = get_extension(unquoted)

    if file_exists(unquoted) and (ext == "bat" or ext == "cmd") then
        local dir = split_windows_path(unquoted)
        local lines = {}
        if dir and dir ~= "" then
            table.insert(lines, "pushd " .. windows_cmd_quote(dir))
            table.insert(lines, "if errorlevel 1 exit /b %ERRORLEVEL%")
        end
        table.insert(lines, "call " .. windows_cmd_quote(unquoted))
        table.insert(lines, "set CCR_EXIT=%ERRORLEVEL%")
        if dir and dir ~= "" then table.insert(lines, "popd") end
        table.insert(lines, "exit /b %CCR_EXIT%")
        return lines
    end

    if file_exists(unquoted) and ext ~= "" then
        return {
            "start " .. windows_cmd_quote("") .. " " .. windows_cmd_quote(unquoted),
            "exit /b 0"
        }
    end

    return {
        command,
        "exit /b %ERRORLEVEL%"
    }
end

local function run_windows(command, source, action)
    local batch_path = unique_temp_path(".cmd")
    local log_file = log_path()
    local user_block = make_windows_user_block(command)

    local lines = {
        "@echo off",
        "setlocal EnableExtensions",
        "echo. >> " .. windows_cmd_quote(log_file),
        "echo [%date% %time%] Controller Command Runner action=" .. safe_echo_text(action) .. " source=" .. safe_echo_text(source) .. " >> " .. windows_cmd_quote(log_file),
        "echo Command: " .. safe_echo_text(command) .. " >> " .. windows_cmd_quote(log_file),
        "echo Runner: " .. safe_echo_text(batch_path) .. " >> " .. windows_cmd_quote(log_file),
        "(",
    }

    for _, line in ipairs(user_block) do
        table.insert(lines, "  " .. line)
    end

    table.insert(lines, ") >> " .. windows_cmd_quote(log_file) .. " 2>&1")
    table.insert(lines, "set CCR_EXIT=%ERRORLEVEL%")
    table.insert(lines, "echo [%date% %time%] ExitCode=%CCR_EXIT% >> " .. windows_cmd_quote(log_file))
    table.insert(lines, "del \"%~f0\" >nul 2>nul")
    table.insert(lines, "exit /b %CCR_EXIT%")
    table.insert(lines, "")

    local ok, err = write_text_file(batch_path, table.concat(lines, "\r\n"))
    if not ok then
        local msg = "Could not write temporary batch file: " .. tostring(err)
        logger:error("Controller Command Runner: " .. msg)
        return false, msg
    end

    local launch_command = "cmd.exe /d /c start " .. windows_cmd_quote("") .. " /min " .. windows_cmd_quote(batch_path)
    logger:info("Controller Command Runner: launch command = " .. launch_command)

    local result_ok, reason, code = os.execute(launch_command)
    if result_ok == true or result_ok == 0 then
        local msg = "Command runner started. Log: " .. log_file
        logger:info("Controller Command Runner: " .. msg)
        return true, msg
    end

    local status = "Could not launch Windows runner: ok=" .. tostring(result_ok)
    if reason ~= nil then status = status .. ", reason=" .. tostring(reason) end
    if code ~= nil then status = status .. ", code=" .. tostring(code) end
    logger:warn("Controller Command Runner: " .. status)
    return false, status .. ". Log: " .. log_file
end

local function run_posix(command, source, action)
    local script_path = unique_temp_path(".sh")
    local log_file = log_path()

    local script_content = table.concat({
        "#!/bin/sh",
        "{",
        "  echo",
        "  echo \"[$(date)] Controller Command Runner action=" .. action:gsub('"', '\\"') .. " source=" .. source:gsub('"', '\\"') .. "\"",
        "  echo \"Command: " .. command:gsub('"', '\\"') .. "\"",
        "} >> " .. shell_quote_posix(log_file) .. " 2>&1",
        command .. " >> " .. shell_quote_posix(log_file) .. " 2>&1",
        "CCR_EXIT=$?",
        "echo \"[$(date)] ExitCode=$CCR_EXIT\" >> " .. shell_quote_posix(log_file) .. " 2>&1",
        "rm -f -- \"$0\"",
        "exit $CCR_EXIT",
        ""
    }, "\n")

    local ok, err = write_text_file(script_path, script_content)
    if not ok then
        local msg = "Could not write temporary shell script: " .. tostring(err)
        logger:error("Controller Command Runner: " .. msg)
        return false, msg
    end

    os.execute("chmod +x " .. shell_quote_posix(script_path) .. " >/dev/null 2>&1")
    local launch_command = "nohup /bin/sh " .. shell_quote_posix(script_path) .. " >/dev/null 2>&1 &"
    logger:info("Controller Command Runner: launch command = " .. launch_command)
    local result_ok, reason, code = os.execute(launch_command)

    if result_ok == true or result_ok == 0 then
        local msg = "Command runner started. Log: " .. log_file
        logger:info("Controller Command Runner: " .. msg)
        return true, msg
    end

    local status = "Could not launch POSIX runner: ok=" .. tostring(result_ok)
    if reason ~= nil then status = status .. ", reason=" .. tostring(reason) end
    if code ~= nil then status = status .. ", code=" .. tostring(code) end
    logger:warn("Controller Command Runner: " .. status)
    return false, status .. ". Log: " .. log_file
end

local function run_configured_action(action, source)
    action = trim(action):lower()
    if action ~= "connect" and action ~= "disconnect" then action = "connect" end
    source = trim(source)
    if source == "" then source = "unknown source" end
    source = source:gsub("[\r\n]", " ")

    local command = read_config_command(action)
    logger:info("Controller Command Runner: requested action=" .. action .. " source=" .. source .. " command_length=" .. tostring(#command))

    if command == "" then
        local msg = "No " .. action .. " command configured in backend."
        logger:warn("Controller Command Runner: " .. msg)
        return msg
    end

    logger:info("Controller Command Runner: command = " .. command)
    local ok, status
    if is_windows() then ok, status = run_windows(command, source, action) else ok, status = run_posix(command, source, action) end
    return status
end

function frontend_log(first)
    local message = ""
    if type(first) == "table" then message = trim(first.message) else message = trim(first) end
    if message ~= "" then logger:info("Controller Command Runner frontend: " .. message) end
    return "ok"
end

function set_command(first, second)
    local action, command = normalise_save_payload(first, second)
    local ok, status = save_config_command(action, command)
    if not ok then logger:warn("Controller Command Runner: " .. status) end
    return status
end

function get_config()
    local connect_command = read_config_command("connect")
    local disconnect_command = read_config_command("disconnect")
    return "{\"connect\":" .. json_escape(connect_command) .. ",\"disconnect\":" .. json_escape(disconnect_command) .. ",\"log\":" .. json_escape(log_path()) .. "}"
end

function run_action(first, second)
    local action, source = normalise_action_payload(first, second)
    return run_configured_action(action, source)
end

-- Backwards compatibility with older frontend builds. Accepts command directly.
function run_command(first, second, third)
    local command, source, action
    if type(first) == "table" then
        command = trim(first.command)
        source = trim(first.source)
        action = trim(first.action)
    else
        command = trim(first)
        source = trim(second)
        action = trim(third)
    end
    if action == "" then action = "connect" end
    if command ~= "" then save_config_command(action, command) end
    return run_configured_action(action, source)
end

local function on_load()
    logger:info("Controller Command Runner loaded with Millennium " .. millennium.version())
    logger:info("Controller Command Runner config connect path: " .. CONFIG_CONNECT_PATH)
    logger:info("Controller Command Runner config disconnect path: " .. CONFIG_DISCONNECT_PATH)
    logger:info("Controller Command Runner command log path: " .. log_path())
    millennium.ready()
end

local function on_unload()
    logger:info("Controller Command Runner unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload
}
