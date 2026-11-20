// The OS folder dialog for the machine running the server. Only meaningful when the page is
// opened on that same desktop, so the /api/cwd routes gate on a loopback request.
import { spawn } from "node:child_process";

export type PickedDirectory = { path: string } | { cancelled: true };

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** The folder-dialog command for this platform, or null where we know no chooser. */
export function pickerCommand(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform === "win32") {
    // ponytail: the classic WinForms dialog, not IFileOpenDialog — it works from a non-console
    // parent without COM plumbing; swap in the Vista-style picker if the look ever matters.
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$d.Description = 'Select a folder'",
          "$d.SelectedPath = $env:USERPROFILE",
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
        ].join("; "),
      ],
    };
  }
  if (platform === "darwin") return { file: "osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Select a folder")'] };
  if (platform === "linux") return { file: "zenity", args: ["--file-selection", "--directory", "--title", "Select a folder"] };
  return null;
}

/** Opens the dialog and waits for it; null when this platform has no chooser. */
export function pickDirectory(platform: NodeJS.Platform = process.platform): Promise<PickedDirectory | null> {
  const command = pickerCommand(platform);
  if (!command) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), DIALOG_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const path = stdout.trim();
      if (path) return resolve({ path });
      // Dismissed: zenity and osascript exit 1, the Windows dialog still exits 0 with no output.
      if (code === 0 || code === 1) return resolve({ cancelled: true });
      reject(new Error(stderr.trim() || `The folder dialog exited with code ${code}`));
    });
  });
}
