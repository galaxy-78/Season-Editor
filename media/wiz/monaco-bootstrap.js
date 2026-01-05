// media/wiz/monaco-bootstrap.js
console.log("[wiz] monaco bootstrap start");

(function () {
  const base = window.__WIZ_MONACO_BASE__;
  if (!base) {
    console.error("[wiz] missing __WIZ_MONACO_BASE__");
    return;
  }

  if (typeof require === "undefined") {
    console.error("[wiz] AMD loader(require) is missing");
    return;
  }

  // 핵심: worker를 blob으로 강제 (getWorker 우선 제공)
  // (일부 monaco 번들은 getWorkerUrl을 무시하고 getWorker만 봄)
  const workerMain = `${base}/base/worker/workerMain.js`;

  function makeBlobWorker(label) {
    const code = `
      self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} };
      importScripts(${JSON.stringify(workerMain)});
    `;
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" })
    );
    // name은 디버깅용 (있어도/없어도 됨)
    return new Worker(url, { name: `monaco-${label || "worker"}` });
  }

  window.MonacoEnvironment = {
    // 최신/일부 빌드에서 이걸로 worker 생성
    getWorker(_moduleId, label) {
      return makeBlobWorker(label);
    },
    // 구버전/일부 빌드 fallback
    getWorkerUrl(_moduleId, label) {
      const code = `
        self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} };
        importScripts(${JSON.stringify(workerMain)});
      `;
      return URL.createObjectURL(
        new Blob([code], { type: "text/javascript" })
      );
    },
  };

  require.config({ paths: { vs: base } });

  require(["vs/editor/editor.main"], function () {
    const el = document.getElementById("editor");
    if (!el) {
      console.error("[wiz] #editor not found");
      return;
    }

    const getTheme = () => {
      const isDark =
        document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast");
      return isDark ? "vs-dark" : "vs";
    };

    const editor = monaco.editor.create(el, {
      value: "",
      language: "plaintext",
      theme: getTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
    });

    window.__WIZ_EDITOR__ = editor;

    window.__WIZ_SET_LANG__ = function setLanguageByKey(key) {
      const model = editor.getModel();
      if (!model) return;

      const map = {
        pug: "pug",
        ts: "typescript",
        scss: "scss",
        html: "html",
        api: "python",
        socket: "python",
        info: "json",
      };
      monaco.editor.setModelLanguage(model, map[key] || "plaintext");
    };

    window.__WIZ_EDITOR_READY__ = true;
    window.dispatchEvent(new CustomEvent("wiz-editor-ready"));

    console.log("[wiz] monaco editor ready");
  });
})();
