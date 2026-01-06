# Season Editor

**Season Editor** is a Visual Studio Code extension for managing **Wiz folders**  
(a folder-as-document pattern) used in Season / Wiz projects.

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=galaxy-78_Season-Editor&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=galaxy-78_Season-Editor)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=galaxy-78_Season-Editor&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=galaxy-78_Season-Editor)

---

## Features

### Wiz Explorer View
- Browse workspace files and folders
- Detect Wiz folders (containing `view.pug`, `view.ts`, `api.py`, or `socket.py`)
- Group Wiz folders by `mode` defined in `app.json`

### Create Wiz Page
- Create a new Wiz folder with default files
- Supported modes: `page`, `component`, `layout`, `portal`
- Automatically generates `id`, `namespace`, and `template` in `app.json`
- `portal` mode can only be created under `portal/<app_name>/...`

### Wiz Folder Editor
- Custom editor for Wiz folders
- Tab-based editing for:
  - `app.json`
  - `view.pug`, `view.ts`, `view.scss`, `view.html`
  - `api.py`, `socket.py`

### Drag & Drop
- Drag files and folders from the Wiz Explorer view
- Move items within the workspace with name conflict handling

### Undo / Redo
- Undo / redo extension actions:
  - create
  - delete
  - rename
  - mkdir / rmdir
  - batch operations

---

## Commands

- `Wiz: New File`
- `Wiz: New Folder`
- `Wiz: New Wiz Page`
- `Wiz: Open Wiz Folder`
- `Wiz: Refresh`
- `Season Explorer: Undo`
- `Season Explorer: Redo`

---

## Extension Settings

- `seasonEditor.defaultModes`  
  List of modes shown in the **New Wiz Page** QuickPick.

---

## Release Notes

### 0.0.1
- Initial release

---

## Contact

- **Jaewon Kim**
- 📧 magry78@gmail.com
- 🐙 GitHub: https://github.com/galaxy-78
