// src/lib/wiz-utils.ts
import * as path from "path";

export const ALL_WIZ_MODES = ["page", "component", "layout", "portal"] as const;
export type WizMode = (typeof ALL_WIZ_MODES)[number];

export function isWizMode(x: any): x is WizMode {
  return (ALL_WIZ_MODES as readonly string[]).includes(String(x));
}

export function makeDefaultIdPrefix(mode: WizMode) {
  if (mode === "portal") return "";
  return `${mode}.`;
}

function trimDots(s: string): string {
  let start = 0;
  let end = s.length;

  while (start < end && s.charCodeAt(start) === 46) start++; // '.'
  while (end > start && s.charCodeAt(end - 1) === 46) end--; // '.'

  return s.slice(start, end);
}

export function deriveIdAndNamespace(mode: WizMode, raw: string) {
  const id = raw.trim();

  if (mode === "portal") {
    return { id, namespace: id };
  }

  const prefix = `${mode}.`;
  const fixedId = id.startsWith(prefix) ? id : prefix + id;

  let ns = fixedId.slice(prefix.length);
  ns = trimDots(ns);

  return { id: fixedId, namespace: ns };
}

export function normalizeNamespace(ns: string) {
  return trimDots(String(ns ?? "").trim());
}

export function namespaceToDash(ns: string) {
  const clean = normalizeNamespace(ns);
  if (!clean) return "";
  return clean.split(".").filter(Boolean).join("-");
}

/**
 * baseFsPath: 폴더의 fsPath 문자열
 * 예) /.../portal/app1/src  -> app1
 */
export function getPortalFromBaseFsPath(baseFsPath: string): string | null {
  const segs = baseFsPath.split(path.sep).filter(Boolean);
  const idx = segs.lastIndexOf("portal");
  if (idx === -1) return null;
  const appName = segs[idx + 1];
  return appName ? appName : null;
}

/**
 * buildTemplate은 vscode.Uri에 의존하지 않게 "baseFsPath(string)"로 받게 변경
 */
export function buildTemplate(
  mode: WizMode,
  namespace: string,
  baseFsPath: string
) {
  const tail = namespaceToDash(namespace);

  if (mode === "portal") {
    const appName = getPortalFromBaseFsPath(baseFsPath);
    if (!appName) {
      throw new Error(
        "portal Wiz Page는 'portal/<app_name>/...' 경로 아래에서만 생성할 수 있습니다."
      );
    }
    return `wiz-portal-${appName}${tail ? "-" + tail : ""}()`;
  }

  return `wiz-${mode}${tail ? "-" + tail : ""}()`;
}

export function splitName(name: string) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return { base, ext };
}

/**
 * VSCode webview wrapper 직렬화/제어문자 이슈 대응
 * - U+2028/U+2029 escape
 * - 깨진 surrogate 제거
 * - Cc/Cf 제거 (단 \n \r \t 유지)
 */
export function sanitizeForWebview(html: string) {
  html = html.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

  html = html.replaceAll(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ""
  );

  html = html.replaceAll(/[\p{Cc}\p{Cf}]/gu, (ch) => {
    return ch === "\n" || ch === "\r" || ch === "\t" ? ch : "";
  });

  return html;
}
