# 🎮 Controller Command Runner

A simple plugin that runs configured commands when a controller is connected or disconnected to Steam. This can be used to start Steam Big Picture or change the display to a TV when a controller is connected for e.g.

<img width="2212" height="902" alt="demo" src="https://github.com/user-attachments/assets/704c9934-6aae-4786-ad9a-980892560244" />

## Overview

When the system detects a controller connection via Steam Input, the backend executes a configured command; a separate command runs on disconnection. Settings are saved in the plugin folder.

## Settings

- Command to run when a controller is connected
- Command to run when a controller is disconnected

Commands may be paths to executables, `.bat`/`.cmd` scripts on Windows, or shell commands on Linux.

## Examples (Windows)

Open Steam Big Picture when a controller connects:

```bat
"C:\Program Files (x86)\Steam\steam.exe" -bigpicture
```

Run a script by absolute path:

```bat
C:\Users\your_user\Desktop\my_script.bat
```

Change to TV when the controller connects:
```bat
DisplaySwitch.exe /external
```



## Examples (Linux)

Send a desktop notification:

```bash
    steam -bigpicture
```

## Repository structure

- `backend/` — Lua backend and scripts
- `frontend/` — small TypeScript/React interface
- `plugin.json` — plugin metadata
- `LICENSE` — project license

## Installation & usage

1. Place the plugin into your plugin folder (or clone the repository).
2. Configure the commands via the plugin options or by editing the backend configuration files.
3. Test by connecting and disconnecting a controller.


## Contributing

Issues and pull requests are welcome. Please describe your changes and use cases.

## License

See the `LICENSE` file.
