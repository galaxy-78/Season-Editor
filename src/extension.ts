import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import {
  ALL_WIZ_MODES,
  WizMode,
  isWizMode,
  makeDefaultIdPrefix,
  deriveIdAndNamespace,
  getPortalFromBaseFsPath,
  buildTemplate,
  sanitizeForWebview,
} from "./lib/wiz-utils";

type FsOp =
  | { type: "createFile"; uri: vscode.Uri; contents?: Uint8Array }
  | { type: "deleteFile"; uri: vscode.Uri; contents: Uint8Array }
  | { type: "rename"; from: vscode.Uri; to: vscode.Uri }
  | { type: "mkdir"; uri: vscode.Uri }
  | { type: "rmdir"; uri: vscode.Uri; snapshot: DirSnapshot }
  | { type: "batch"; ops: FsOp[] };

type DirSnapshot = {
  // 복구 순서 보장 위해 dirs/files 분리
  dirs: string[]; // folder root 기준 상대경로들 ("" 포함 가능)
  files: Array<{ rel: string; contents: Uint8Array }>;
};

const undoStack: FsOp[] = [];
const redoStack: FsOp[] = [];

function pushOp(op: FsOp) {
  undoStack.push(op);
  redoStack.length = 0;
}

// wiz “폴더=문서”에 포함되는 파일들(네 스샷 기준 + socket.py)
const WIZ_FILES = [
  { key: "info", label: "Info", filename: "app.json" },
  { key: "pug", label: "Pug", filename: "view.pug" },
  { key: "ts", label: "Component", filename: "view.ts" },
  { key: "scss", label: "SCSS", filename: "view.scss" },
  { key: "html", label: "HTML", filename: "view.html" },
  { key: "api", label: "API", filename: "api.py" },
  { key: "socket", label: "Socket", filename: "socket.py" },
];

function getSeasonConfig() {
  const cfg = vscode.workspace.getConfiguration("seasonEditor");

  const defaultModesRaw = cfg.get<string[]>("defaultModes", [
    "page",
    "component",
    "layout",
    "portal",
  ]);

  // settings.json 직접 수정 같은 케이스 방어
  const defaultModes = defaultModesRaw.filter(isWizMode);

  return { defaultModes };
}

async function promptMode(): Promise<WizMode | undefined> {
  const { defaultModes } = getSeasonConfig();

  // 설정이 비었거나 잘못되면 전체 모드로 fallback
  const modes: WizMode[] = defaultModes.length
    ? defaultModes
    : [...ALL_WIZ_MODES];

  return (await vscode.window.showQuickPick([...modes], {
    title: "Select Wiz mode",
    placeHolder: modes.join(" / "),
  })) as WizMode | undefined;
}

function buildAppJson(
  mode: WizMode,
  id: string,
  namespace: string,
  template: string
) {
  return JSON.stringify(
    {
      mode,
      id,
      title: "",
      namespace,
      viewuri: "",
      category: "",
      controller: "",
      "ng.build": { id: "", name: "", path: "" },
      ng: { selector: "", inputs: [], outputs: [] },
      template,
    },
    null,
    2
  );
}

const DEFAULT_WIZ_FILES = {
  ".wizpage": "",

  "view.pug": `//- wiz page
div
    | New Wiz Page
`,

  "view.ts": `import { OnInit } from '@angular/core';
import { Service } from '@wiz/libs/portal/season/service';

export class Component implements OnInit {
    constructor(
        public service: Service,
    ) { }
    
    public async ngOnInit() {
        await this.service.render();
    }
}
`,

  "view.scss": `/* New Wiz Page styles */\n`,
  "view.html": "",
  "api.py": `# New Wiz Page API\n\ndef handler():\n    return {"ok": True}\n`,
  "socket.py": "",
} as const;

async function getFileTypeSafe(
  uri: vscode.Uri
): Promise<vscode.FileType | null> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type;
  } catch {
    return null;
  }
}

async function isWizFolder(folderUri: vscode.Uri): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    const names = new Set(entries.map(([name]) => name));
    return (
      names.has("view.pug") ||
      names.has("view.ts") ||
      names.has("api.py") ||
      names.has("socket.py")
    );
  } catch {
    return false;
  }
}

function isSkippableDir(name: string) {
  return name === "node_modules" || name === ".git" || name.startsWith(".");
}
function relPath(root: vscode.Uri, u: vscode.Uri) {
  const r = root.fsPath;
  const p = u.fsPath;
  return p.startsWith(r)
    ? p.slice(r.length).replace(/^[/\\]/, "")
    : path.basename(p);
}

async function snapshotDir(root: vscode.Uri): Promise<DirSnapshot> {
  const out: DirSnapshot = { dirs: [""], files: [] };

  async function walk(dir: vscode.Uri) {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const u = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        out.dirs.push(relPath(root, u));
        await walk(u);
      } else {
        const buf = await vscode.workspace.fs.readFile(u);
        out.files.push({ rel: relPath(root, u), contents: buf });
      }
    }
  }

  await walk(root);
  // dirs는 상위->하위 생성 위해 정렬(짧은 경로 먼저)
  out.dirs.sort((a, b) => a.length - b.length);
  return out;
}

async function restoreDir(root: vscode.Uri, snap: DirSnapshot) {
  // 1) dirs
  for (const d of snap.dirs) {
    const u = d ? vscode.Uri.joinPath(root, d) : root;
    await vscode.workspace.fs.createDirectory(u);
  }
  // 2) files
  for (const f of snap.files) {
    const u = vscode.Uri.joinPath(root, f.rel);
    await vscode.workspace.fs.writeFile(u, f.contents);
  }
}

async function readFileSafe(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
}

async function statSafe(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

function splitName(name: string) {
  // file.ext / file
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return { base, ext };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function pickNonConflictingUri(destDir: vscode.Uri, baseName: string) {
  const { base, ext } = splitName(baseName);

  // 1) 그대로 시도
  let candidate = vscode.Uri.joinPath(destDir, baseName);
  if (!(await exists(candidate))) return candidate;

  // 2) (1) (2) ... 붙이기
  for (let i = 1; i < 10_000; i++) {
    const nextName = `${base} (${i})${ext}`;
    candidate = vscode.Uri.joinPath(destDir, nextName);
    if (!(await exists(candidate))) return candidate;
  }

  // 현실적으로 여기 올 일 거의 없음
  throw new Error(`Too many name conflicts for: ${baseName}`);
}

async function safeRename(
  from: vscode.Uri,
  to: vscode.Uri,
  mode: "undo" | "redo"
): Promise<vscode.Uri> {
  // from이 없으면 할 수 없음
  if (!(await exists(from))) return to;

  // 목적지가 비어있으면 그대로
  if (!(await exists(to))) {
    await vscode.workspace.fs.rename(from, to, { overwrite: false });
    return to;
  }

  // 목적지에 뭐가 있으면 자동으로 다른 이름으로 보냄
  const dir = vscode.Uri.file(path.dirname(to.fsPath));
  const originalName = path.basename(to.fsPath);

  const suffix = mode === "undo" ? " (restored)" : " (moved)";

  const { base, ext } = splitName(originalName);
  const alt = await pickNonConflictingUri(dir, `${base}${suffix}${ext}`);

  await vscode.workspace.fs.rename(from, alt, { overwrite: false });
  return alt;
}

type NodeKind =
  | "workspace"
  | "folder"
  | "file"
  | "wizFolder"
  | "wizModeRoot"
  | "modeGroup";

class FsNodeItem extends vscode.TreeItem {
  public readonly uri?: vscode.Uri;
  public readonly kind: NodeKind;
  public readonly parent?: vscode.Uri;
  public readonly modeKey?: string;

  constructor(
    args:
      | {
          kind: "workspace" | "folder" | "file" | "wizFolder";
          uri: vscode.Uri;
          parent?: vscode.Uri;
        }
      | { kind: "wizModeRoot"; parent: vscode.Uri } // ✅ 추가
      | { kind: "modeGroup"; parent: vscode.Uri; modeKey: string }
  ) {
    const { kind } = args;

    const label =
      kind === "wizModeRoot"
        ? "Wiz (by mode)"
        : kind === "modeGroup"
          ? args.modeKey
          : path.basename(args.uri.fsPath);

    super(
      label,
      kind === "workspace" ||
        kind === "folder" ||
        kind === "wizModeRoot" ||
        kind === "modeGroup"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.kind = kind;

    if (kind === "wizModeRoot") {
      this.parent = args.parent;
      this.contextValue = "wizModeRoot";
      this.iconPath = new vscode.ThemeIcon("folder-library");
      this.tooltip = "Wiz folders grouped by mode";
      return;
    }

    if (kind === "modeGroup") {
      this.parent = args.parent;
      this.modeKey = args.modeKey;
      this.contextValue = "modeGroup";
      this.iconPath = new vscode.ThemeIcon("folder");
      this.tooltip = `mode: ${args.modeKey}`;
      return;
    }

    // 여기부터는 uri가 무조건 있음
    this.uri = args.uri;
    this.parent = args.parent;
    if (
      kind === "file" ||
      kind === "folder" ||
      kind === "workspace" ||
      kind === "wizFolder"
    ) {
      this.resourceUri = args.uri;
    }
    this.tooltip = args.uri.fsPath;

    if (kind === "wizFolder") {
      this.contextValue = "wizFolder";
      this.iconPath = new vscode.ThemeIcon("file");
      const entryUri = vscode.Uri.joinPath(args.uri, ".wizpage");
      this.command = {
        command: "wiz.openFolder",
        title: "Open Wiz Folder",
        arguments: [entryUri, args.uri],
      };
      return;
    }

    if (kind === "file") {
      this.contextValue = "file";
      this.iconPath = new vscode.ThemeIcon("file");
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [args.uri],
      };
      return;
    }

    this.contextValue = kind;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

async function listDirectWizFolders(dir: vscode.Uri): Promise<vscode.Uri[]> {
  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }

  const out: vscode.Uri[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    if (isSkippableDir(name)) continue;

    const u = vscode.Uri.joinPath(dir, name);
    if (await isWizFolder(u)) out.push(u);
  }
  return out;
}

async function findDirectWizFolders(dir: vscode.Uri): Promise<vscode.Uri[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }

  const out: vscode.Uri[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    if (isSkippableDir(name)) continue;

    const u = vscode.Uri.joinPath(dir, name);
    if (await isWizFolder(u)) out.push(u);
  }
  return out;
}

async function readModeFromAppJson(wizFolder: vscode.Uri): Promise<string> {
  const appJsonUri = vscode.Uri.joinPath(wizFolder, "app.json");
  const buf = await readFileSafe(appJsonUri);
  if (!buf) return "unknown";

  try {
    const text = Buffer.from(buf).toString("utf8");
    const json = JSON.parse(text);
    const mode = json?.mode ?? json?.Mode ?? json?.MODE;
    const s = String(mode ?? "unknown").trim();
    return s || "unknown";
  } catch {
    return "unknown";
  }
}

class WizExplorerProvider implements vscode.TreeDataProvider<FsNodeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FsNodeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FsNodeItem): Promise<FsNodeItem[]> {
    const wss = vscode.workspace.workspaceFolders;
    if (!wss || wss.length === 0) return [];

    // Root: workspace folders
    if (!element) {
      return wss.map(
        (ws) => new FsNodeItem({ kind: "workspace", uri: ws.uri })
      );
    }

    // modeGroup은 children 가짐
    if (element.kind === "modeGroup") {
      const parentDir = element.parent; // ✅ modeGroup은 parent에 “실제 폴더 uri”가 들어있어야 함
      if (!parentDir) return [];

      const mode = element.modeKey ?? "unknown";
      const wizFolders = await findDirectWizFolders(parentDir);

      const filtered: vscode.Uri[] = [];
      for (const f of wizFolders) {
        const m = await readModeFromAppJson(f);
        if (m === mode) filtered.push(f);
      }

      filtered.sort((a, b) =>
        path.basename(a.fsPath).localeCompare(path.basename(b.fsPath))
      );

      return filtered.map((u) => new FsNodeItem({ kind: "wizFolder", uri: u }));
    }

    // workspace / folder 만 children
    if (element.kind !== "workspace" && element.kind !== "folder") return [];

    const dir = element.uri;
    if (!dir) return [];

    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    // 1) 실제 폴더/파일 분리
    const folders: Array<{ name: string; uri: vscode.Uri }> = [];
    const files: Array<{ name: string; uri: vscode.Uri }> = [];

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (isSkippableDir(name)) continue;
        folders.push({ name, uri: vscode.Uri.joinPath(dir, name) });
      } else {
        files.push({ name, uri: vscode.Uri.joinPath(dir, name) });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    // 2) 이 위치(dir) 바로 아래의 wizFolder만 골라서 mode로 그룹핑
    const wizFolders: vscode.Uri[] = [];
    const normalFolders: vscode.Uri[] = [];

    for (const f of folders) {
      const wiz = await isWizFolder(f.uri);
      if (wiz) wizFolders.push(f.uri);
      else normalFolders.push(f.uri);
    }

    const modeMap = new Map<string, vscode.Uri[]>();
    for (const wf of wizFolders) {
      const mode = await readModeFromAppJson(wf);
      const arr = modeMap.get(mode) ?? [];
      arr.push(wf);
      modeMap.set(mode, arr);
    }

    // modeGroup 노드 생성 (라벨은 mode 그대로)
    const modeGroups = [...modeMap.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (mode) =>
          new FsNodeItem({ kind: "modeGroup", parent: dir, modeKey: mode })
      );

    // 3) 일반 폴더/파일 노드 생성 (wiz 폴더는 여기서 제외해서 중복 방지)
    const folderItems = normalFolders.map(
      (u) => new FsNodeItem({ kind: "folder", uri: u })
    );
    const fileItems = files.map(
      (f) => new FsNodeItem({ kind: "file", uri: f.uri })
    );

    // ✅ 반환 순서: [modeGroup들] + [일반 폴더] + [파일]
    return [...modeGroups, ...folderItems, ...fileItems];
  }
}

const TREE_MIME = "application/vnd.code.tree.wizExplorer";
// Copilot/Chat/Explorer 계열이 가장 잘 먹는 트리 MIME
const EXPLORER_TREE_MIME = "application/vnd.code.tree.explorer";
const URI_LIST_MIME = "application/vnd.code.uri-list";

class SeasonExplorerDnD implements vscode.TreeDragAndDropController<FsNodeItem> {
  readonly dragMimeTypes = [
    TREE_MIME,
    EXPLORER_TREE_MIME,
    URI_LIST_MIME,
    "text/uri-list",
    "resourceurls",
    "text/plain",
  ];
  readonly dropMimeTypes = [TREE_MIME];

  private lastDraggedUris: vscode.Uri[] = [];

  constructor(private readonly refresh: () => void) {}

  getLastDraggedUris(): vscode.Uri[] {
    return this.lastDraggedUris;
  }

  private async toExternalUriText(u: vscode.Uri): Promise<string> {
    try {
      const st = await vscode.workspace.fs.stat(u);
      const isDir =
        (st.type & vscode.FileType.Directory) === vscode.FileType.Directory;

      // ✅ 폴더면 무조건 trailing slash
      if (isDir && !u.path.endsWith("/")) {
        u = u.with({ path: u.path + "/" });
      }
    } catch {
      // stat 실패면 그대로
    }
    return u.toString();
  }

  async handleDrag(
    source: readonly FsNodeItem[],
    dataTransfer: vscode.DataTransfer
  ) {
    const draggedUris = source
      .map((s) => s.uri ?? s.resourceUri)
      .filter((u): u is vscode.Uri => !!u);

    this.lastDraggedUris = draggedUris;

    // -----------------------------
    // 1) 내부용(웹뷰 템플릿 인서트)
    // -----------------------------
    dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(draggedUris));

    // -----------------------------
    // 2) Explorer tree 타입 유지 (Copilot/Chat이 가끔 이걸 씀)
    // -----------------------------
    dataTransfer.set(
      EXPLORER_TREE_MIME,
      new vscode.DataTransferItem(draggedUris)
    );

    // -----------------------------
    // 3) vnd.code.uri-list 는 Uri[] 유지 (VSCode 내부 소비)
    // -----------------------------
    dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(draggedUris));

    // -----------------------------
    // 4) ✅ 외부 attach 핵심: uri-list 문자열을 "폴더 trailing slash"로 구성
    // -----------------------------
    const uriTextList = (
      await Promise.all(draggedUris.map((u) => this.toExternalUriText(u)))
    ).join("\n");

    dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uriTextList));
    dataTransfer.set(
      "application/vnd.code.uri-list",
      new vscode.DataTransferItem(uriTextList)
    );

    // -----------------------------
    // 5) ✅ resourceurls: 문자열만 1번만 세팅 (덮어쓰기 금지)
    //    (여기서 Uri[]로 다시 set하면 webview getData가 꼬일 수 있음)
    // -----------------------------
    dataTransfer.set("resourceurls", new vscode.DataTransferItem(uriTextList));

    // -----------------------------
    // 6) text/plain fallback: fsPath 라인들 (폴더는 path.sep 추가)
    // -----------------------------
    const fsTextList = await Promise.all(
      draggedUris.map(async (u) => {
        try {
          const st = await vscode.workspace.fs.stat(u);
          const isDir =
            (st.type & vscode.FileType.Directory) === vscode.FileType.Directory;
          if (isDir) {
            return u.fsPath.endsWith(path.sep) ? u.fsPath : u.fsPath + path.sep;
          }
        } catch {}
        return u.fsPath;
      })
    );
    dataTransfer.set(
      "text/plain",
      new vscode.DataTransferItem(fsTextList.join("\n"))
    );

    console.log("[DnD] drag payload", {
      count: draggedUris.length,
      types: Array.from(dataTransfer).map(([k]) => k),
      sample: uriTextList.split("\n")[0],
    });
  }

  async handleDrop(
    target: FsNodeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ) {
    console.log("[DnD] handleDrop fired", {
      targetKind: target?.kind,
      targetPath: target?.uri?.fsPath,
    });

    const item = dataTransfer.get(TREE_MIME);
    if (!item) return;

    const dragged = item.value as vscode.Uri[] | undefined;
    if (!dragged?.length) {
      console.log("[DnD] dragged empty", { valueType: typeof item.value });
      return;
    }

    // 목적지 계산
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders?.length) return;

    const fromWs =
      vscode.workspace.getWorkspaceFolder(dragged[0]) ?? wsFolders[0];
    let destDir: vscode.Uri = fromWs.uri;

    if (target?.kind === "modeGroup") return;

    if (target) {
      if (!target.uri) return; // ✅ 추가 (modeGroup 제외했으니 사실상 안전장치)

      if (target.kind === "workspace" || target.kind === "folder") {
        destDir = target.uri;
      } else {
        destDir = vscode.Uri.file(path.dirname(target.uri.fsPath));
      }
    }

    // ✅ wizFolder 위/안으로 drop 금지
    if (target?.kind === "wizFolder") {
      vscode.window.showInformationMessage(
        "Wiz folder 내부로 이동은 지원하지 않습니다."
      );
      return;
    }

    if (await isWizFolder(destDir)) {
      vscode.window.showInformationMessage(
        "Wiz folder 내부로 이동은 지원하지 않습니다."
      );
      return;
    }

    // ----------------------------
    // ✅ 중복 자동 rename + 우리 undo/redo용 batch 기록
    // ----------------------------
    const skipped: string[] = [];
    const renamed: Array<{ from: string; to: string }> = [];
    const movedPairs: Array<{ from: vscode.Uri; to: vscode.Uri }> = [];

    // 같은 드롭에서 동일 이름이 여러 개면 pickNonConflictingUri가
    // “파일시스템 stat”만 보게 되면 충돌이 날 수 있음.
    // 그래서 이번 드롭에서 예약된 이름도 같이 체크.
    const reserved = new Set<string>(); // destDir 내에서 예약된 basename

    const reserveKey = (u: vscode.Uri) => u.fsPath.toLowerCase();

    try {
      for (const src of dragged) {
        if (src.scheme !== "file") continue;

        const baseName = path.basename(src.fsPath);

        // ✅ 같은 폴더(=현재 부모)로 드롭이면 아무 일도 안 함
        const srcParent = vscode.Uri.file(path.dirname(src.fsPath));
        if (srcParent.fsPath === destDir.fsPath) {
          // 메시지/스킵 기록도 굳이 하지 않는 게 자연스러움
          continue;
        }

        // ✅ wizFolder 자체 이동 막기
        if (await isWizFolder(src)) {
          vscode.window.showInformationMessage(
            `"${baseName}"는 Wiz 형식이라 이동할 수 없습니다.`
          );
          continue;
        }

        // ✅ 동일 이름 충돌 시 자동 새 이름
        let dst = await pickNonConflictingUri(destDir, baseName);

        // ✅ 이번 드롭 내에서도 이름 충돌 방지 (reserved)
        // pickNonConflictingUri는 "이미 존재하는 파일"만 보므로,
        // 같은 드롭에서 같은 이름을 두 개 옮기면 둘 다 file(1)로 잡힐 수 있음.
        while (reserved.has(reserveKey(dst))) {
          const dstName = path.basename(dst.fsPath);
          dst = await pickNonConflictingUri(destDir, dstName); // 한 번 더 밀어
        }
        reserved.add(reserveKey(dst));

        if (src.fsPath === dst.fsPath) continue;

        const dstName = path.basename(dst.fsPath);
        if (dstName !== baseName) renamed.push({ from: baseName, to: dstName });

        // ✅ 실제 이동 (applyEdit 사용 X)
        await vscode.workspace.fs.rename(src, dst, { overwrite: false });

        movedPairs.push({ from: src, to: dst });
      }
    } catch (e: any) {
      console.error("[DnD] move error", e);
      vscode.window.showErrorMessage(`Move error: ${e?.message ?? String(e)}`);
      // 부분 성공/부분 실패가 생길 수 있음.
      // 여기서는 “성공한 것만 batch 기록”하고 끝낼 수도 있지만,
      // 보통은 실패 메시지 보여주고, 성공한 건 정상 반영되게 두는 편이 안전함.
    }

    if (movedPairs.length === 0) {
      if (skipped.length) {
        vscode.window.showInformationMessage(
          `이동할 항목이 없어요. (스킵 ${skipped.length}개)`
        );
      }
      return;
    }

    // ✅ 성공한 최종 from->to를 batch로 기록 (Undo/Redo가 이걸로 동작)
    pushOp({
      type: "batch",
      ops: movedPairs.map((p) => ({ type: "rename", from: p.from, to: p.to })),
    });

    setTimeout(() => this.refresh(), 0);

    // ✅ 결과 요약
    if (renamed.length || skipped.length) {
      const msgParts: string[] = [];
      if (renamed.length) msgParts.push(`이름 변경 ${renamed.length}개`);
      if (skipped.length) msgParts.push(`스킵 ${skipped.length}개`);

      const detail = [
        ...renamed.slice(0, 5).map((r) => `- ${r.from} → ${r.to}`),
        ...skipped.slice(0, 5).map((s) => `- ${s}`),
      ];

      vscode.window.showInformationMessage(
        `${msgParts.join(", ")}\n${detail.join("\n")}`.trim()
      );
    }
  }
}

class WizFolderEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "wiz.folderEditor";
  public static currentPanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dnd: SeasonExplorerDnD
  ) {}

  openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): vscode.CustomDocument {
    // uri: wizfolder:/abs/path/to/folder
    // “문서”는 사실 폴더 자체
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const writing = new Set<string>();
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    WizFolderEditorProvider.currentPanel = webviewPanel;
    webviewPanel.onDidDispose(() => {
      if (WizFolderEditorProvider.currentPanel === webviewPanel) {
        WizFolderEditorProvider.currentPanel = undefined;
      }
    });

    // 폴더 경로 얻기
    const entryFsPath = document.uri.fsPath; // .../somefolder/.wizpage
    const folderFsPath = path.dirname(entryFsPath); // .../somefolder
    const folderUri = vscode.Uri.file(folderFsPath);
    const folderName = path.basename(folderFsPath);

    const raw = this.getHtml(webviewPanel.webview);
    // 디버그: 렌더된 HTML을 임시로 저장
    const debugUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "wiz-debug.html"
    );
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(debugUri, Buffer.from(raw, "utf8"));
    console.log("[wiz] debug html:", debugUri.fsPath);
    webviewPanel.webview.html = sanitizeForWebview(raw);

    const post = (msg: any) => webviewPanel.webview.postMessage(msg);
    post({ type: "init", folderName, tabs: WIZ_FILES });

    const readText = async (fileUri: vscode.Uri) => {
      try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        return Buffer.from(data).toString("utf8");
      } catch {
        return null;
      }
    };

    const writeText = async (fileUri: vscode.Uri, text: string) => {
      const data = Buffer.from(text, "utf8");
      await vscode.workspace.fs.writeFile(fileUri, data);
    };

    // 파일 변경 감지(외부 수정 반영)
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folderUri, "*")
    );
    const onChange = async (u: vscode.Uri) => {
      const basename = path.basename(u.fsPath);

      // ✅ 내가 방금 저장한 파일이면 watcher 에코 무시
      if (writing.has(basename)) return;

      const tab = WIZ_FILES.find((t) => t.filename === basename);
      if (!tab) return;
      const text = await readText(u);
      if (text === null) return;
      post({ type: "content", key: tab.key, filename: basename, text });
    };

    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete((u) => {
      const basename = path.basename(u.fsPath);
      const tab = WIZ_FILES.find((t) => t.filename === basename);
      if (!tab) return;
      post({ type: "deleted", key: tab.key, filename: basename });
    });

    webviewPanel.onDidDispose(() => watcher.dispose());

    // webview <-> extension 메시지
    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "read") {
        const tab = WIZ_FILES.find((t) => t.key === msg.key);
        if (!tab) return;

        const fileUri = vscode.Uri.joinPath(folderUri, tab.filename);
        const text = await readText(fileUri);
        post({
          type: "content",
          key: tab.key,
          filename: tab.filename,
          text: text ?? "",
          missing: text === null,
        });
        return;
      }

      if (msg?.type === "write") {
        const tab = WIZ_FILES.find((t) => t.key === msg.key);
        if (!tab?.filename) return;

        const fileUri = vscode.Uri.joinPath(folderUri, tab.filename);

        // ✅ watcher 에코 방지 시작
        writing.add(tab.filename);
        try {
          await writeText(fileUri, msg.text ?? "");
          post({ type: "saved", key: tab.key, filename: tab.filename });
        } finally {
          // ✅ 파일시스템 이벤트가 약간 늦게 올 수 있어서 살짝 딜레이 후 해제
          setTimeout(() => writing.delete(tab.filename!), 150);
        }
        return;
      }
      // ✅ 드롭된 값(문자열/경로)을 "wiz 폴더"로 최대한 정확히 복원
      function stripVsCodeSuffix(p: string) {
        // "/path/to/foo$0" 같은 suffix 제거
        return p.replace(/\$\d+$/, "");
      }

      async function resolveDroppedToWizFolder(
        msg: any
      ): Promise<vscode.Uri | null> {
        // 1) webview가 fsPath를 줬으면 최우선
        let rawPath: string | null = null;

        if (typeof msg?.path === "string" && msg.path.trim()) {
          rawPath = stripVsCodeSuffix(msg.path.trim());
        }

        // 2) uri 문자열로 왔으면 파싱 시도
        let dropped: vscode.Uri | null = null;

        if (rawPath) {
          dropped = vscode.Uri.file(rawPath);
        } else if (msg?.uri) {
          const raw = String(msg.uri).trim();

          // "/Users/..." 같은 순수 경로로 오는 케이스도 있음
          if (raw.startsWith("/")) {
            dropped = vscode.Uri.file(stripVsCodeSuffix(raw));
          } else {
            try {
              const parsed = vscode.Uri.parse(raw);

              if (parsed.scheme === "file") {
                dropped = parsed;
              } else if (
                parsed.scheme === "vscode-file" ||
                parsed.scheme === "vscode-resource"
              ) {
                if (parsed.path?.startsWith("/"))
                  dropped = vscode.Uri.file(stripVsCodeSuffix(parsed.path));
              } else if (
                parsed.scheme === "http" ||
                parsed.scheme === "https"
              ) {
                if (parsed.path?.startsWith("/"))
                  dropped = vscode.Uri.file(stripVsCodeSuffix(parsed.path));
              }
            } catch {
              // 마지막 fallback: 그냥 파일 경로로 취급
              if (raw.includes("/"))
                dropped = vscode.Uri.file(stripVsCodeSuffix(raw));
            }
          }
        }

        if (!dropped) return null;

        // 3) ".wizpage"를 드롭한 경우 => 부모가 wiz 폴더
        if (path.basename(dropped.fsPath) === ".wizpage") {
          return vscode.Uri.file(path.dirname(dropped.fsPath));
        }

        // 4) 파일이면 부모 폴더, 폴더면 그대로
        const st = await statSafe(dropped);
        const candidateFolder =
          st &&
          (st.type & vscode.FileType.Directory) === vscode.FileType.Directory
            ? dropped
            : vscode.Uri.file(path.dirname(dropped.fsPath));

        return candidateFolder;
      }

      const readJsonSafe = async (fileUri: vscode.Uri) => {
        const text = await readText(fileUri);
        if (text == null) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };

      const getTemplateFromWizFolder = async (wizFolderUri: vscode.Uri) => {
        const appJsonUri = vscode.Uri.joinPath(wizFolderUri, "app.json");
        const json = await readJsonSafe(appJsonUri);
        if (!json) return { text: "", missing: true };

        const t = json?.template ?? json?.Template ?? json?.TEMPLATE;
        if (t == null) return { text: "", missing: true };

        // ✅ 여기서 "template 문자열"만 보낸다
        if (typeof t === "string") return { text: t, missing: false };

        // template이 객체/배열이면 stringify (혹시 모를 케이스)
        try {
          return { text: JSON.stringify(t, null, 2), missing: false };
        } catch {
          return { text: String(t), missing: false };
        }
      };

      if (msg?.type === "requestTemplate") {
        try {
          const wizFolder = await resolveDroppedToWizFolder(msg);
          console.log(
            "[requestTemplate] resolved wizFolder:",
            wizFolder?.fsPath,
            msg
          );

          if (!wizFolder) {
            post({ type: "template", text: "", missing: true });
            return;
          }

          // ✅ 진짜 wiz 폴더인지 체크
          if (!(await isWizFolder(wizFolder))) {
            post({ type: "template", text: "", missing: true });
            return;
          }

          const { text, missing } = await getTemplateFromWizFolder(wizFolder);

          // ✅ "app.json 전체"를 보내는 실수 방지: template은 보통 짧은 한 줄
          // 혹시 실수로 전체 json이 들어오면 여기서 차단해도 됨(선택)
          // if (String(text).trim().startsWith("{")) { ... }

          post({ type: "template", text, missing });
        } catch (e: any) {
          console.error("[requestTemplate] failed", e);
          post({ type: "template", text: "", missing: true });
        }
        return;
      }

      if (msg?.type === "requestTemplateFromLastDrag") {
        try {
          const dragged = this.dnd.getLastDraggedUris(); // ✅ 위에서 만든 dnd 인스턴스 사용
          if (!dragged?.length) {
            post({ type: "template", text: "", missing: true });
            return;
          }

          // 여러 개면 첫 번째만 처리 (원하면 loop)
          const first = dragged[0];

          // wiz folder인지 판별: folder면 그대로, file이면 부모
          const st = await statSafe(first);
          const candidateFolder =
            st &&
            (st.type & vscode.FileType.Directory) === vscode.FileType.Directory
              ? first
              : vscode.Uri.file(path.dirname(first.fsPath));

          if (!(await isWizFolder(candidateFolder))) {
            post({ type: "template", text: "", missing: true });
            return;
          }

          const { text, missing } =
            await getTemplateFromWizFolder(candidateFolder);
          post({ type: "template", text, missing });
        } catch (e) {
          console.error("[requestTemplateFromLastDrag] failed", e);
          post({ type: "template", text: "", missing: true });
        }
        return;
      }
    });

    // 처음 열릴 때 Pug를 기본 로드
    post({ type: "openTab", key: "pug" });
  }

  private getNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");

    // wiz assets are under media/wiz/
    const wizRoot = vscode.Uri.joinPath(mediaRoot, "wiz");

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(wizRoot, "wiz.css")
    );
    const monacoBootstrapUri = webview.asWebviewUri(
      vscode.Uri.joinPath(wizRoot, "monaco-bootstrap.js")
    );
    const appJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(wizRoot, "app.js")
    );

    const monacoVs = vscode.Uri.joinPath(mediaRoot, "monaco", "vs");
    const monacoBaseUri = webview.asWebviewUri(monacoVs).toString();
    const loaderUri = webview.asWebviewUri(
      vscode.Uri.joinPath(monacoVs, "loader.js")
    );

    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />

        <meta http-equiv="Content-Security-Policy"
          content="
            default-src 'none';
            img-src ${webview.cspSource} data:;
            style-src ${webview.cspSource} 'unsafe-inline';
            font-src ${webview.cspSource} data:;
            script-src ${webview.cspSource} 'nonce-${nonce}' blob:;
            worker-src blob:;
            connect-src 'none';
          ">

        <link rel="stylesheet" href="${cssUri}">
      </head>

      <body>
        <div class="top">
          <div class="title" id="folderTitle">Wiz Folder</div>
          <div class="hint" id="fileHint"></div>
        </div>

        <div class="tabbar" id="tabs"></div>

        <div class="main">
          <div id="editor"></div>
          <div class="status" id="status"></div>
        </div>

        <script nonce="${nonce}" src="${loaderUri}"></script>
        <script nonce="${nonce}">
          require.config({ paths: { vs: "${monacoBaseUri}" }});
          window.__WIZ_MONACO_BASE__ = "${monacoBaseUri}";
        </script>

        <script nonce="${nonce}" src="${monacoBootstrapUri}"></script>
        <script nonce="${nonce}" src="${appJsUri}"></script>
      </body>
      </html>`;
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function parentDirUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

async function promptName(title: string, placeHolder: string, value?: string) {
  return vscode.window.showInputBox({
    title,
    placeHolder,
    value,
    validateInput: (v) => {
      if (!v || !v.trim()) return "이름을 입력해주세요.";
      if (v.includes("/") || v.includes("\\"))
        return "경로 구분자(/, \\)는 사용할 수 없습니다.";
      return null;
    },
  });
}

async function createFileUndoable(fileUri: vscode.Uri, contents = "") {
  const data = Buffer.from(contents, "utf8");
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(fileUri, {
    overwrite: false,
    ignoreIfExists: false,
    contents: data,
  });
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error("applyEdit failed");

  pushOp({ type: "createFile", uri: fileUri, contents: data });
  console.log("[pushOp] createFile", undoStack.length);
}

async function deleteFileUndoable(fileUri: vscode.Uri) {
  const st = await statSafe(fileUri);
  if (!st) return;
  if ((st.type & vscode.FileType.Directory) === vscode.FileType.Directory)
    return;

  const contents = await readFileSafe(fileUri);
  if (!contents) return;

  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(fileUri, { recursive: false, ignoreIfNotExists: true });

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error("applyEdit failed");

  pushOp({ type: "deleteFile", uri: fileUri, contents });
}

async function renameUndoable(oldUri: vscode.Uri, newUri: vscode.Uri) {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri, { overwrite: false });
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error("applyEdit failed");

  pushOp({ type: "rename", from: oldUri, to: newUri });
}

async function mkdirUndoable(folderUri: vscode.Uri) {
  await vscode.workspace.fs.createDirectory(folderUri);
  pushOp({ type: "mkdir", uri: folderUri });
}

async function rmdirUndoable(folderUri: vscode.Uri) {
  const snap = await snapshotDir(folderUri);
  await vscode.workspace.fs.delete(folderUri, { recursive: true });
  pushOp({ type: "rmdir", uri: folderUri, snapshot: snap });
}

function getBaseUriFromTreeItem(
  ws: vscode.WorkspaceFolder,
  item?: any
): vscode.Uri {
  let baseUri = ws.uri;

  if (item?.kind === "modeGroup") {
    baseUri = item.parent ?? ws.uri;
  } else if (item?.uri) {
    switch (item.kind) {
      case "workspace":
      case "folder":
        baseUri = item.uri;
        break;
      case "file":
      case "wizFolder":
        baseUri = parentDirUri(item.uri);
        break;
    }
  }

  return baseUri;
}

async function createWizPageUndoable(
  parentDir: vscode.Uri,
  folderName: string,
  mode: WizMode,
  id: string,
  namespace: string
) {
  const wizDir = vscode.Uri.joinPath(parentDir, folderName);

  if (await uriExists(wizDir)) {
    throw new Error("이미 같은 이름의 폴더가 있습니다.");
  }

  const ops: FsOp[] = [];

  await vscode.workspace.fs.createDirectory(wizDir);
  ops.push({ type: "mkdir", uri: wizDir });

  for (const [name, text] of Object.entries(DEFAULT_WIZ_FILES)) {
    const fileUri = vscode.Uri.joinPath(wizDir, name);
    const data = Buffer.from(text ?? "", "utf8");
    await vscode.workspace.fs.writeFile(fileUri, data);
    ops.push({ type: "createFile", uri: fileUri, contents: data });
  }

  // ✅ app.json (mode/id/namespace/template 반영)
  {
    const template = buildTemplate(mode, namespace, parentDir.fsPath);
    const fileUri = vscode.Uri.joinPath(wizDir, "app.json");
    const data = Buffer.from(
      buildAppJson(mode, id, namespace, template),
      "utf8"
    );
    await vscode.workspace.fs.writeFile(fileUri, data);
    ops.push({ type: "createFile", uri: fileUri, contents: data });
  }

  pushOp({ type: "batch", ops });
  return wizDir;
}

let extensionDisposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage("Season Editor: activated!");
  console.log("[season-editor] activated");

  const explorer = new WizExplorerProvider();

  const dnd = new SeasonExplorerDnD(() => explorer.refresh());

  const treeView = vscode.window.createTreeView("wizExplorer", {
    treeDataProvider: explorer,
    dragAndDropController: dnd,
    showCollapseAll: true,
  });

  const fsWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  fsWatcher.onDidCreate(() => explorer.refresh());
  fsWatcher.onDidDelete(() => explorer.refresh());
  fsWatcher.onDidChange(() => explorer.refresh());

  context.subscriptions.push(treeView, fsWatcher);

  extensionDisposables.push(fsWatcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("wiz.refresh", () => {
      explorer.refresh();
    })
  );

  async function setSeasonExplorerFocused(v: boolean) {
    await vscode.commands.executeCommand(
      "setContext",
      "seasonExplorerFocused",
      v
    );
  }

  // 초기값
  setSeasonExplorerFocused(false);

  // view 보임/숨김
  treeView.onDidChangeVisibility((e) => {
    // visible만으론 focus 보장 안 되지만, 최소한 보일 때는 true로 두는 전략
    setSeasonExplorerFocused(e.visible);
  });

  // selection 바뀌면 거의 항상 트리뷰에 포커스가 들어온 상태
  treeView.onDidChangeSelection(() => {
    setSeasonExplorerFocused(true);
  });

  // 에디터로 포커스 갔을 가능성이 있으면 끄기(완벽하진 않지만 체감 확 좋아짐)
  vscode.window.onDidChangeActiveTextEditor(() => {
    setSeasonExplorerFocused(false);
  });

  context.subscriptions.push(treeView);

  // ---- 파일/폴더 조작 커맨드들 ----

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("seasonEditor.defaultModes")) {
        explorer.refresh();
      }
    }),
    vscode.commands.registerCommand("wiz.newFile", async (item?: any) => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) return;

      let baseUri = ws.uri;

      // 1) 가상 그룹 노드: parent가 실제 폴더
      if (item?.kind === "modeGroup") {
        baseUri = item.parent ?? ws.uri;
      }
      // 2) uri가 있는 노드들: uri 기반으로 처리
      else if (item?.uri) {
        switch (item.kind) {
          case "workspace":
          case "folder":
            baseUri = item.uri;
            break;

          case "file":
          case "wizFolder":
            baseUri = parentDirUri(item.uri);
            break;
        }
      }

      const name = await promptName("New File", "예: hello.txt");
      if (!name) return;

      const fileUri = vscode.Uri.joinPath(baseUri, name);

      if (await uriExists(fileUri)) {
        vscode.window.showErrorMessage(
          "이미 같은 이름의 파일/폴더가 있습니다."
        );
        return;
      }

      await createFileUndoable(fileUri, "");
      await vscode.commands.executeCommand("vscode.open", fileUri);
    }),

    vscode.commands.registerCommand("wiz.newFolder", async (item?: any) => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) return;

      let baseUri = ws.uri;

      // 1) 가상 그룹 노드: parent가 실제 폴더
      if (item?.kind === "modeGroup") {
        baseUri = item.parent ?? ws.uri;
      }
      // 2) uri가 있는 노드들: uri 기반으로 처리
      else if (item?.uri) {
        switch (item.kind) {
          case "workspace":
          case "folder":
            baseUri = item.uri;
            break;

          case "file":
          case "wizFolder":
            baseUri = parentDirUri(item.uri);
            break;
        }
      }

      const name = await promptName("New Folder", "예: new-folder");
      if (!name) return;

      const folderUri = vscode.Uri.joinPath(baseUri, name);

      if (await uriExists(folderUri)) {
        vscode.window.showErrorMessage(
          "이미 같은 이름의 파일/폴더가 있습니다."
        );
        return;
      }

      await mkdirUndoable(folderUri);
      setTimeout(() => explorer.refresh(), 0);
    }),

    vscode.commands.registerCommand("wiz.newWizPage", async (item?: any) => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) return;

      const baseUri = getBaseUriFromTreeItem(ws, item);

      if (await isWizFolder(baseUri)) {
        vscode.window.showErrorMessage(
          "Wiz folder 내부에는 새 Wiz Page를 만들 수 없습니다."
        );
        return;
      }

      const mode = await promptMode();
      if (!mode) return;

      if (mode === "portal") {
        const appName = getPortalFromBaseFsPath(baseUri.fsPath);
        if (!appName) {
          vscode.window.showErrorMessage(
            "portal Wiz Page는 'portal/<app_name>/...' 경로 아래에서만 생성할 수 있습니다."
          );
          return;
        }
      }

      const prefix = makeDefaultIdPrefix(mode);

      // mode별 입력창
      const rawName = await vscode.window.showInputBox({
        title: mode === "portal" ? "New Portal" : `New ${mode}`,
        placeHolder:
          mode === "portal" ? "예: nav.admin" : `예: ${mode}.nav.admin`,
        value: mode === "portal" ? "" : prefix,
        validateInput: (v) => {
          if (!v || !v.trim()) return "이름을 입력해주세요.";
          if (v.includes("/") || v.includes("\\"))
            return "경로 구분자(/, \\)는 사용할 수 없습니다.";

          const s = v.trim();

          if (mode !== "portal") {
            if (!s.startsWith(prefix))
              return `반드시 "${prefix}"로 시작해야 합니다.`;
            if (s === prefix)
              return `"${prefix}" 뒤에 namespace를 붙여주세요. (예: ${mode}.nav.admin)`;
            if (s.endsWith(".")) return "마지막은 '.'로 끝날 수 없습니다.";
          }

          // portal은 그냥 허용(원하면 '.' 금지/허용 등 정책 추가 가능)
          return null;
        },
      });

      if (!rawName) return;

      const { id, namespace } = deriveIdAndNamespace(mode, rawName);

      const folderName = id;

      try {
        const wizDir = await createWizPageUndoable(
          baseUri,
          folderName,
          mode,
          id,
          namespace
        );

        setTimeout(() => explorer.refresh(), 0);

        const entryUri = vscode.Uri.joinPath(wizDir, ".wizpage");
        await vscode.commands.executeCommand(
          "vscode.openWith",
          entryUri,
          WizFolderEditorProvider.viewType
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? String(e));
      }
    }),

    vscode.commands.registerCommand("wiz.rename", async (item: any) => {
      if (!item?.uri) return;

      const oldUri: vscode.Uri = item.uri;
      const oldName = path.basename(oldUri.fsPath);

      const newName = await promptName("Rename", "새 이름", oldName);
      if (!newName || newName === oldName) return;

      const parentUri = parentDirUri(oldUri);
      const newUri = vscode.Uri.joinPath(parentUri, newName);

      if (await uriExists(newUri)) {
        vscode.window.showErrorMessage(
          "이미 같은 이름의 파일/폴더가 있습니다."
        );
        return;
      }

      await renameUndoable(oldUri, newUri);
    }),

    vscode.commands.registerCommand("wiz.delete", async (item: any) => {
      if (!item?.uri) return;

      const targetUri: vscode.Uri = item.uri;
      const name = path.basename(targetUri.fsPath);

      const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to delete '${name}'?`,
        { modal: true },
        "Delete"
      );
      if (choice !== "Delete") return;

      const t = await getFileTypeSafe(targetUri);
      if (t === null) return; // 이미 없음

      // ✅ 폴더면: VSCode undo 시스템에 태우지 말고 우리 로컬로 처리
      if ((t & vscode.FileType.Directory) === vscode.FileType.Directory) {
        await rmdirUndoable(targetUri);
        setTimeout(() => explorer.refresh(), 0);
        return;
      }

      // ✅ 파일이면: WorkspaceEdit deleteFile (VSCode bulk undo/redo 대상)
      await deleteFileUndoable(targetUri);
    })
  );

  // ---- wiz 폴더 열기 (너 기존 코드가 어딘가에 있어야 함) ----
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wiz.openFolder",
      async (entryUri: vscode.Uri) => {
        try {
          await vscode.workspace.fs.stat(entryUri);
        } catch {
          await vscode.workspace.fs.writeFile(
            entryUri,
            Buffer.from("", "utf8")
          );
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          entryUri,
          WizFolderEditorProvider.viewType
        );
      }
    ),

    vscode.window.registerCustomEditorProvider(
      WizFolderEditorProvider.viewType,
      new WizFolderEditorProvider(context, dnd),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  async function focusWizExplorer() {
    // contributed view는 보통 "<viewId>.focus" 커맨드가 자동 생성됩니다.
    // 안 되면 catch로 무시
    try {
      await vscode.commands.executeCommand("wizExplorer.focus");
    } catch {}
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("seasonExplorer.undo", async () => {
      // await focusWizExplorer();
      console.log(
        "[seasonExplorer.undo] fired",
        undoStack.length,
        redoStack.length
      );

      if (undoStack.length === 0) {
        await vscode.commands.executeCommand("undo");
        return;
      }

      const op = undoStack.pop();
      if (!op) return;

      try {
        switch (op.type) {
          case "createFile": {
            await vscode.workspace.fs.delete(op.uri, { recursive: false });
            break;
          }

          case "deleteFile": {
            try {
              await vscode.workspace.fs.createDirectory(
                vscode.Uri.file(path.dirname(op.uri.fsPath))
              );
              await vscode.workspace.fs.writeFile(op.uri, op.contents);
            } catch (e) {
              console.error("[undo deleteFile] failed", op.uri.fsPath, e);
              vscode.window.showErrorMessage(
                `Undo restore failed: ${op.uri.fsPath}`
              );
            }
            break;
          }

          case "batch": {
            // ✅ undo는 역순으로 되돌리기
            for (let i = op.ops.length - 1; i >= 0; i--) {
              const inner = op.ops[i];
              if (inner.type === "rename") {
                await vscode.workspace.fs.rename(inner.to, inner.from, {
                  overwrite: false,
                });
              } else if (inner.type === "createFile") {
                await vscode.workspace.fs.delete(inner.uri, {
                  recursive: false,
                });
              } else if (inner.type === "deleteFile") {
                await vscode.workspace.fs.createDirectory(
                  vscode.Uri.file(path.dirname(inner.uri.fsPath))
                );
                await vscode.workspace.fs.writeFile(inner.uri, inner.contents);
              } else if (inner.type === "mkdir") {
                await vscode.workspace.fs.delete(inner.uri, {
                  recursive: true,
                });
              } else if (inner.type === "rmdir") {
                await restoreDir(inner.uri, inner.snapshot);
              }
            }
            break;
          }

          case "rename":
            await vscode.workspace.fs.rename(op.to, op.from, {
              overwrite: false,
            });
            break;

          case "mkdir":
            await vscode.workspace.fs.delete(op.uri, { recursive: true });
            break;

          case "rmdir":
            await restoreDir(op.uri, op.snapshot);
            break;
        }

        redoStack.push(op);
      } finally {
        setTimeout(() => explorer.refresh(), 0);
      }
    }),

    vscode.commands.registerCommand("seasonExplorer.redo", async () => {
      // await focusWizExplorer();
      console.log(
        "[seasonExplorer.redo] fired",
        undoStack.length,
        redoStack.length
      );

      if (redoStack.length === 0) {
        await vscode.commands.executeCommand("redo");
        return;
      }

      const op = redoStack.pop();
      if (!op) return;

      try {
        switch (op.type) {
          case "createFile":
            await vscode.workspace.fs.writeFile(
              op.uri,
              op.contents ?? new Uint8Array()
            );
            break;

          case "deleteFile":
            await vscode.workspace.fs.delete(op.uri, { recursive: false });
            break;

          case "batch": {
            // ✅ redo는 정순으로 다시 적용
            for (const inner of op.ops) {
              if (inner.type === "rename") {
                await vscode.workspace.fs.rename(inner.from, inner.to, {
                  overwrite: false,
                });
              } else if (inner.type === "createFile") {
                await vscode.workspace.fs.writeFile(
                  inner.uri,
                  inner.contents ?? new Uint8Array()
                );
              } else if (inner.type === "deleteFile") {
                await vscode.workspace.fs.delete(inner.uri, {
                  recursive: false,
                });
              } else if (inner.type === "mkdir") {
                await vscode.workspace.fs.createDirectory(inner.uri);
              } else if (inner.type === "rmdir") {
                await vscode.workspace.fs.delete(inner.uri, {
                  recursive: true,
                });
              }
            }
            break;
          }

          case "rename":
            await vscode.workspace.fs.rename(op.from, op.to, {
              overwrite: false,
            });
            break;

          case "mkdir":
            await vscode.workspace.fs.createDirectory(op.uri);
            break;

          case "rmdir":
            await vscode.workspace.fs.delete(op.uri, { recursive: true });
            break;
        }

        undoStack.push(op);
      } finally {
        setTimeout(() => explorer.refresh(), 0);
      }
    })
  );
}

export function deactivate() {
  for (const d of extensionDisposables) {
    try {
      d.dispose();
    } catch {}
  }
  extensionDisposables = [];
}
