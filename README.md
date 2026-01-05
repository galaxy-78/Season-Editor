# Season Editor

Season Editor is a VS Code extension for managing **Wiz folders** (folder-as-document) used in Season/Wiz projects.

## Features

- **Wiz Explorer View**
  - Browse workspace files and folders
  - Detect Wiz folders (contains `view.pug`, `view.ts`, `api.py`, or `socket.py`)
  - Group Wiz folders by `mode` read from `app.json`

- **Create Wiz Page**
  - Create a new Wiz folder with default files
  - Supports modes: `page`, `component`, `layout`, `portal`
  - Automatically generates `id`, `namespace`, and `template` in `app.json`
  - Portal mode can be created only under `portal/<app_name>/...`

- **Wiz Folder Editor**
  - Custom editor for Wiz folders
  - Tab-based editing for `app.json`, `view.pug`, `view.ts`, `view.scss`, `view.html`, `api.py`, `socket.py`

- **Drag & Drop**
  - Drag files/folders from the Wiz Explorer view
  - Move items within the workspace (with name conflict handling)

- **Undo / Redo**
  - Undo/redo for extension actions (create, delete, rename, mkdir, rmdir, batch operations)

## Commands

- `Wiz: New File`
- `Wiz: New Folder`
- `Wiz: New Wiz Page`
- `Wiz: Open Wiz Folder`
- `Wiz: Refresh`
- `Season Explorer: Undo`
- `Season Explorer: Redo`

## Extension Settings

- `seasonEditor.defaultModes`: Mode list shown in “New Wiz Page” QuickPick.

## Release Notes

### 0.0.1
- Initial release
