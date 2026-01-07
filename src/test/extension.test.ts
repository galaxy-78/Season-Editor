import * as assert from "assert";
import * as vscode from "vscode";

suite("Season Editor Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start Season Editor tests.");

  test("VS Code API should be available", () => {
    assert.ok(vscode);
    assert.ok(vscode.window);
    assert.ok(vscode.commands);
  });

  test("Extension should be present", async () => {
    const ext = vscode.extensions.getExtension("galaxy-78.season-editor");
    assert.ok(ext, "Extension not found");
  });

  test("Extension should activate", async () => {
    const ext = vscode.extensions.getExtension("galaxy-78.season-editor");
    assert.ok(ext);

    if (!ext.isActive) {
      await ext.activate();
    }

    assert.strictEqual(ext.isActive, true, "Extension did not activate");
  });

  test("Wiz Explorer view should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const hasExplorerFocus = commands.includes("wizExplorer.focus");
    assert.ok(hasExplorerFocus, "wizExplorer view is not registered");
  });

  test("Core Wiz commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "wiz.newFile",
      "wiz.newFolder",
      "wiz.newWizPage",
      "wiz.refresh",
      "wiz.openFolder",
      "seasonExplorer.undo",
      "seasonExplorer.redo",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command not registered: ${cmd}`);
    }
  });
});
