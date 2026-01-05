import fs from "fs";
import path from "path";

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const root = process.cwd();
const srcDir = path.join(root, "node_modules", "monaco-editor", "min", "vs");
const outDir = path.join(root, "media", "monaco", "vs");

if (!fs.existsSync(srcDir)) {
  console.error("❌ monaco source not found:", srcDir);
  console.error("   node_modules/monaco-editor 구조 확인 필요");
  process.exit(1);
}

copyDir(srcDir, outDir);
console.log("✅ Monaco copied to:", outDir);
