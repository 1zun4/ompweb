import assert from "node:assert/strict";
import test from "node:test";

const { hasPicker, pickDirectory, pickerAvailable, pickerCommand } = await import("./cwd-picker.ts");

test("every desktop platform gets a folder dialog, anything else gets none", () => {
  const win = pickerCommand("win32");
  assert.equal(win?.file, "powershell.exe");
  assert.ok(win?.args.includes("-STA"));
  assert.ok(win?.args.some((arg) => arg.includes("System.Windows.Forms.FolderBrowserDialog")));
  assert.ok(win?.args.some((arg) => arg.includes("[Console]::Out.Write")));
  assert.equal(pickerCommand("darwin")?.file, "osascript");
  assert.deepEqual(pickerCommand("linux")?.args.slice(0, 2), ["--file-selection", "--directory"]);
  assert.equal(pickerCommand("freebsd"), null);
});

test("no chooser means no dialog and no error, and no Browse button either", async () => {
  assert.equal(await pickDirectory("freebsd"), null);
  assert.equal(hasPicker("freebsd"), false);
  // Windows and macOS ship their chooser; Linux is the only platform whose binary can be missing.
  assert.equal(hasPicker("win32"), true);
  assert.equal(hasPicker("darwin"), true);
});

test("a connection from another machine never gets the dialog, whatever its Host header said", () => {
  // context.localPeer comes from the accepted socket, so a remote client cannot reach the dialog.
  assert.equal(pickerAvailable(false, "win32"), false);
  assert.equal(pickerAvailable(false, "darwin"), false);
  assert.equal(pickerAvailable(true, "win32"), true);
  assert.equal(pickerAvailable(true, "freebsd"), false);
});
