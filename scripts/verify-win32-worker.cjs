'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WORKER_SCRIPT } = require('../win32-input');

function extractWorkerCSharp() {
  const match = String(WORKER_SCRIPT || '').match(/\$code\s*=\s*@"([\s\S]*?)"@/);
  if (!match || !match[1]) {
    throw new Error('Could not extract C# worker source from win32-input.js.');
  }
  const source = match[1];
  for (const requiredToken of [
    'public static class MswnlinkWin32Worker',
    'SendInput',
    'EscapeElevatedForeground',
    'Shell_TrayWnd',
    'TapCtrlShortcut'
  ]) {
    if (!source.includes(requiredToken)) {
      throw new Error(`Extracted C# worker source is missing expected symbol: ${requiredToken}`);
    }
  }
  return source;
}

function main() {
  const csharpSource = extractWorkerCSharp();

  if (process.platform !== 'win32') {
    console.log(`[verify-win32-worker] Verified C# worker source structure (${csharpSource.length} chars; non-Windows host).`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mswnlink-win32-verify-'));
  const csPath = path.join(tmpDir, 'MswnlinkWin32Worker.cs');
  const ps1Path = path.join(tmpDir, 'verify.ps1');

  try {
    fs.writeFileSync(csPath, csharpSource, 'utf8');
    const escapedCsPath = csPath.replace(/'/g, "''");
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      `$code = Get-Content -LiteralPath '${escapedCsPath}' -Raw -Encoding UTF8`,
      'Add-Type -TypeDefinition $code -Language CSharp',
      '$t = [MswnlinkWin32Worker]',
      'if ($null -eq $t) { throw "MswnlinkWin32Worker failed to load." }',
      '[void][MswnlinkWin32Worker]::IsElevated()',
      'Write-Output "OK"'
    ].join('\r\n');
    fs.writeFileSync(ps1Path, psScript, 'utf8');

    // Run against powershell.exe (Windows PowerShell 5.1 / .NET Framework),
    // the exact binary win32-input.js spawns in production.
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true }
    );
    if (!String(output).includes('OK')) {
      throw new Error(`Unexpected powershell.exe verification output: ${output}`);
    }
    console.log('[verify-win32-worker] Compiled and verified MswnlinkWin32Worker with powershell.exe.');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[verify-win32-worker] Failed:', error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

module.exports = { extractWorkerCSharp, main };
