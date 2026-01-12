console.log("[wiz] app.js loaded");

const vscode = acquireVsCodeApi();

let tabs = [];
let activeKey = null;

const modelByKey = Object.create(null); // key -> monaco model
const baselineByKey = Object.create(null); // key -> string | null (null = never loaded)
const dirtyByKey = Object.create(null); // key -> boolean

let lastDropPosition = null;

// DOM
const $tabs = document.getElementById("tabs");
const $status = document.getElementById("status");
const $title = document.getElementById("folderTitle");
const $hint = document.getElementById("fileHint");

// -----------------------------
// utils
// -----------------------------
let __DROP_DECORATIONS__ = [];
function clearDropDecorations(editor) {
  if (!editor) return;
  if (__DROP_DECORATIONS__?.length) {
    __DROP_DECORATIONS__ = editor.deltaDecorations(__DROP_DECORATIONS__, []);
  }
}

function setStatus(text) {
  if ($status) $status.textContent = text || "";
}

function ensureEditorReady(fn) {
  const tryRun = () => {
    const ed = window.__WIZ_EDITOR__;
    if (ed) return fn(ed);
    setTimeout(tryRun, 30);
  };
  tryRun();
}

function setLanguageByKeySafe(key) {
  try {
    window.__WIZ_SET_LANG__?.(key);
  } catch {}
}

function updateHintForKey(key) {
  const tab = tabs.find((t) => t.key === key);
  if ($hint) $hint.textContent = tab?.filename ?? "";
}

function renderTabs() {
  if (!$tabs) return;
  $tabs.innerHTML = "";

  for (const t of tabs) {
    const btn = document.createElement("div");
    btn.className = "tab" + (t.key === activeKey ? " active" : "");
    btn.onclick = () => openTab(t.key);

    const label = document.createElement("span");
    label.textContent = t.label ?? t.key;
    btn.appendChild(label);

    if (dirtyByKey[t.key]) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = "●";
      btn.appendChild(dot);
    }

    $tabs.appendChild(btn);
  }
}

function normalizeTemplateText(t) {
  if (t == null) return "";
  if (typeof t !== "string") {
    try {
      return JSON.stringify(t, null, 2);
    } catch {
      return String(t);
    }
  }
  return t;
}

function ensureModel(key) {
  if (modelByKey[key]) return modelByKey[key];

  const model = monaco.editor.createModel("", "plaintext");
  modelByKey[key] = model;

  if (!(key in baselineByKey)) baselineByKey[key] = null;
  if (!(key in dirtyByKey)) dirtyByKey[key] = false;

  model.onDidChangeContent(() => {
    const base = baselineByKey[key];
    const baseText = base == null ? "" : base;
    dirtyByKey[key] = model.getValue() !== baseText;
    renderTabs();
  });

  return model;
}

function insertAtPosition(text, pos) {
  ensureEditorReady((editor) => {
    const model = editor.getModel();
    if (!model) return;

    const p = pos || editor.getPosition();
    if (!p) return;

    const toInsert = normalizeTemplateText(text);
    const finalText = toInsert + (toInsert.endsWith("\n") ? "" : "\n");

    editor.executeEdits("wiz-template-drop", [
      {
        range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column),
        text: finalText,
        forceMoveMarkers: true,
      },
    ]);

    editor.focus();
  });
}

// -----------------------------
// tab open/load
// -----------------------------
function openTab(key) {
  activeKey = key;
  renderTabs();

  ensureEditorReady((editor) => {
    const model = ensureModel(key);

    editor.setModel(model);
    setLanguageByKeySafe(key);
    updateHintForKey(key);

    if (baselineByKey[key] === null) {
      vscode.postMessage({ type: "read", key });
      setStatus("Loading...");
      return;
    }

    setStatus(dirtyByKey[key] ? "Modified" : "Loaded");
  });
}

// -----------------------------
// drop helpers
// -----------------------------
function stripVsCodeSuffix(p) {
  return typeof p === "string" ? p.replace(/\$\d+$/, "") : p;
}

function extractFsPathFromDroppedText(s) {
  if (!s) return null;
  s = String(s).trim();

  // "$0" 같은 suffix 제거
  s = s.replace(/\$\d+$/, "");

  // file:///...
  if (s.startsWith("file://")) {
    try {
      const u = new URL(s);
      return decodeURIComponent(u.pathname).replace(/\$\d+$/, "");
    } catch {
      return s.replace(/^file:\/\//, "").replace(/\$\d+$/, "");
    }
  }

  // vscode-file:, vscode-resource:
  if (s.startsWith("vscode-file:") || s.startsWith("vscode-resource:")) {
    try {
      const u = new URL(s);
      return decodeURIComponent(u.pathname).replace(/\$\d+$/, "");
    } catch {}
  }

  // 그냥 절대경로
  if (s.startsWith("/")) return s;

  // Users/... 로 오는 경우
  if (s.startsWith("Users/")) return "/" + s;

  return null;
}

function readDropLines(e) {
  // VSCode webview에서 실제로 들어오는 타입 우선순위
  const candidates = [
    "resourceurls",
    "application/vnd.code.uri-list",
    "text/uri-list",
    "text/plain",
  ];

  for (const t of candidates) {
    const v = e.dataTransfer?.getData(t);
    if (v && String(v).trim()) return { type: t, raw: String(v) };
  }
  return { type: null, raw: "" };
}

function pickDroppedLine(e) {
  const { type, raw } = readDropLines(e);

  const lines = String(raw)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("#")) continue;

    const fsPath = extractFsPathFromDroppedText(line);
    return { raw: line, fsPath, sourceType: type };
  }
  return null;
}

// -----------------------------
// drop (external template -> insert into pug)
// -----------------------------
let __DROP_BOUND__ = false;
function bindExternalDrop() {
  if (__DROP_BOUND__) return;
  __DROP_BOUND__ = true;

  const editorHost = document.getElementById("editor") || document.body;
  const isInsideEditor = (target) => target && editorHost.contains(target);

  const shouldHandle = (e) => {
    const types = Array.from(e.dataTransfer?.types || []);
    return (
      types.includes("resourceurls") ||
      types.includes("application/vnd.code.uri-list") ||
      types.includes("text/uri-list") ||
      types.includes("text/plain") ||
      types.includes("application/vnd.code.tree.wizexplorer")
    );
  };

  const block = (e) => {
    if (!shouldHandle(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function")
      e.stopImmediatePropagation();
  };

  // 드래그 중 “미리보기 커서/하이라이트”
  let raf = 0;
  let dropDecorations = [];
  let savedSelection = null;

  function clearAll(editor) {
    clearDropDecorations(editor);
    if (savedSelection) {
      editor.setSelection(savedSelection);
      savedSelection = null;
    }
  }

  function updateDropPreview(editor, e) {
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
    const pos = target?.position;
    if (!pos) return;

    // 처음 들어왔을 때 원래 선택/커서 저장
    if (!savedSelection) savedSelection = editor.getSelection();

    // 커서 위치를 드래그 위치로 “보이게” 이동
    editor.setPosition(pos);
    editor.revealPositionInCenterIfOutsideViewport(pos);

    // 라인 하이라이트(원하면 className 바꿔도 됨)
    const range = new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1);
    __DROP_DECORATIONS__ = editor.deltaDecorations(__DROP_DECORATIONS__, [
      {
        range,
        options: {
          isWholeLine: true,
          className: "wiz-drop-line",
        },
      },
    ]);
  }

  const onDragEnter = (e) => {
    if (!shouldHandle(e)) return;
    block(e);

    // 드래그 시작 시점에 현재 탭이 pug 아니면 전환 (미리보기 커서가 pug에 보이게)
    if (activeKey !== "pug") openTab("pug");
  };

  const onDragOver = (e) => {
    if (!shouldHandle(e)) return;
    block(e);

    if (!isInsideEditor(e.target)) {
      ensureEditorReady((editor) => clearAll(editor)); // 밖으로 나가면 즉시 지움
      return;
    }

    // 너무 자주 호출되지 않게 rAF로 스로틀
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      ensureEditorReady((editor) => updateDropPreview(editor, e));
    });
  };

  const onDragLeave = (e) => {
    if (!shouldHandle(e)) return;
    // editorHost 밖으로 나가는 leave면 clear
    if (!isInsideEditor(e.target)) {
      ensureEditorReady((editor) => clearAll(editor));
    }
  };

  const onDropCapture = (e) => {
    if (!shouldHandle(e)) return;
    block(e);

    ensureEditorReady((editor) => clearAll(editor)); // drop이면 무조건 한번 정리

    if (!isInsideEditor(e.target)) {
      setStatus("Drop ignored (outside editor)");
      return;
    }

    ensureEditorReady((editor) => {
      const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
      lastDropPosition = target?.position ?? editor.getPosition();

      vscode.postMessage({ type: "requestTemplateFromLastDrag" });
      setStatus("Loading template...");
    });
  };

  window.addEventListener("dragenter", onDragEnter, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDropCapture, true);
  window.addEventListener(
    "dragend",
    () => ensureEditorReady((editor) => clearAll(editor)),
    true
  );
  window.addEventListener(
    "blur",
    () => ensureEditorReady((editor) => clearAll(editor)),
    true
  );
}

// -----------------------------
// save
// -----------------------------
function saveKey(key) {
  ensureEditorReady(() => {
    const model = modelByKey[key];
    const text = model ? model.getValue() : "";
    vscode.postMessage({ type: "write", key, text });
    setStatus("Saving...");
  });
}

function saveActive() {
  if (!activeKey) return;
  saveKey(activeKey);
}

window.addEventListener(
  "keydown",
  (e) => {
    const isSave = (e.key === "s" || e.key === "S") && (e.metaKey || e.ctrlKey);
    if (!isSave) return;
    e.preventDefault();
    e.stopPropagation();
    saveActive();
  },
  true
);

// -----------------------------
// VSCode -> Webview messages
// -----------------------------
function onMessage(event) {
  const msg = event?.data;
  const type = msg?.type;
  if (!type) return;

  const handler = messageHandlers[type];
  if (!handler) return;

  handler(msg);
}

const messageHandlers = Object.freeze({
  init: handleInit,
  openTab: handleOpenTab,
  content: handleContent,
  saved: handleSaved,
  deleted: handleDeleted,
  template: handleTemplate,
});

window.addEventListener("message", onMessage);

function handleInit(msg) {
  if ($title) $title.textContent = msg.folderName ?? "Wiz Folder";
  tabs = msg.tabs || [];

  for (const t of tabs) {
    dirtyByKey[t.key] = false;
    baselineByKey[t.key] = null;
  }

  renderTabs();
  ensureEditorReady(() => {
    bindExternalDrop();
  });
}

function handleOpenTab(msg) {
  openTab(msg.key);
}

function handleContent(msg) {
  const key = msg.key;
  const incoming = msg.text ?? "";
  const missing = !!msg.missing;

  ensureEditorReady((editor) => {
    const model = ensureModel(key);

    if (dirtyByKey[key]) {
      if (key === activeKey) setStatus("Modified (incoming ignored)");
      return;
    }

    model.setValue(incoming);
    baselineByKey[key] = incoming;
    dirtyByKey[key] = false;

    if (key === activeKey) {
      editor.setModel(model);
      setLanguageByKeySafe(key);
      updateHintForKey(key);
      setStatus(missing ? "File missing (will be created on Save)" : "Loaded");
    }

    renderTabs();
  });
}

function handleSaved(msg) {
  const key = msg.key;

  ensureEditorReady(() => {
    const model = modelByKey[key];
    if (!model) return;

    baselineByKey[key] = model.getValue();
    dirtyByKey[key] = false;

    renderTabs();
    if (key === activeKey) setStatus("Saved");
  });
}

function handleDeleted(msg) {
  const key = msg.key;
  if (!key) return;

  if (!dirtyByKey[key]) {
    baselineByKey[key] = "";
    const model = modelByKey[key];
    if (model) model.setValue("");
  }

  if (key === activeKey) setStatus("File deleted");
  renderTabs();
}

function handleTemplate(msg) {
  const text = msg.text ?? "";
  const missing = !!msg.missing;

  ensureEditorReady((editor) => {
    clearDropDecorations(editor);

    const trimmed = String(text).trim();
    if (missing || !trimmed) {
      lastDropPosition = null;
      setStatus("Template not found");
      return;
    }

    if (activeKey !== "pug") openTab("pug");
    insertAtPosition(text, lastDropPosition || editor.getPosition());
    lastDropPosition = null;
    setStatus("Template inserted");
  });
}

// optional
if (window.__WIZ_EDITOR_READY__) {
  console.log("[wiz] app.js sees editor already ready");
} else {
  window.addEventListener("wiz-editor-ready", () => {
    console.log("[wiz] app.js sees editor ready");
  });
}
