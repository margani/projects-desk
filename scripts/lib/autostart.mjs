// What makes scripts/watch.mjs start at login. Separate from the installer so
// the file contents can be tested on any system.
import path from 'node:path';

export const STARTUP_FILE = 'projects-desk.cmd';
export const LAUNCHD_LABEL = 'dev.projects-desk.watch';

/** FOLDERID_Startup. A per-user folder, so no administrator rights are needed. */
export function windowsStartupDir(appData) {
  return path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** A .cmd rather than a .ps1, which Windows clients refuse to run by default. */
export function windowsStartupScript({ node, watch }) {
  const quote = (p) => `"${p.replaceAll('%', '%%')}"`;
  // chcp 65001 first: this file is UTF-8, and a user name may not be ASCII.
  return ['@echo off', 'chcp 65001 >nul', `${quote(node)} ${quote(watch)} --background`, ''].join('\r\n');
}

const xml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function launchdPlist({ node, watch, cwd, pathVariable }) {
  const string = (text) => `<string>${xml(text)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${string(node)}
    ${string(watch)}
  </array>
  <key>WorkingDirectory</key>
  ${string(cwd)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${string(pathVariable)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}
