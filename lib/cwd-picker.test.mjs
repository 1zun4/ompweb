import assert from "node:assert/strict";
import test from "node:test";

const { pickDirectory, pickerCommand } = await import("./cwd-picker.ts");

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

test("no chooser means no dialog and no error", async () => {
  assert.equal(await pickDirectory("freebsd"), null);
});
