#!/usr/bin/env node
/**
 * TurboWebFetch Postinstall Script
 *
 * Automatically sets up Python environment and shows registration instructions.
 * Cross-platform: works on macOS, Linux, and Windows.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const PYTHON_DIR = join(ROOT_DIR, 'python');
const VENV_DIR = join(PYTHON_DIR, 'venv');

// Colors for terminal output
const colors = {
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function log(message, color = '') {
  console.log(color ? `${color}${message}${colors.reset}` : message);
}

function logStep(message) {
  console.log(`${colors.gray}→${colors.reset} ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

/**
 * Find Python 3 executable
 *
 * Prefers Python 3.8-3.13 over 3.14+ because nodriver has non-UTF-8 bytes
 * in source comments (cdp/network.py) that Python 3.14's strict encoding
 * enforcement rejects with SyntaxError. We try versioned binaries first
 * (python3.13, python3.12, etc.) before falling back to bare python3.
 */
function findPython() {
  // Try specific compatible versions first, then fall back to generic python3/python.
  // Python 3.14+ breaks nodriver imports, so we prefer 3.13 down to 3.8.
  const versionedCandidates = [];
  for (let minor = 13; minor >= 8; minor--) {
    versionedCandidates.push(`python3.${minor}`);
  }

  const genericCandidates = platform() === 'win32'
    ? ['python', 'python3', 'py -3']
    : ['python3', 'python'];

  const allCandidates = [...versionedCandidates, ...genericCandidates];

  let fallback = null; // Store 3.14+ as fallback in case nothing else works

  for (const cmd of allCandidates) {
    try {
      const result = spawnSync(cmd.split(' ')[0], [...cmd.split(' ').slice(1), '--version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.status === 0) {
        const version = result.stdout.trim() || result.stderr.trim();
        const match = version.match(/Python (\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1]);
          const minor = parseInt(match[2]);
          if (major >= 3 && minor >= 8) {
            const entry = { cmd: cmd.split(' ')[0], args: cmd.split(' ').slice(1), version };

            if (minor <= 13) {
              // Compatible version found, use it immediately
              return entry;
            } else if (!fallback) {
              // Python 3.14+ -- save as fallback but keep looking for compatible versions
              fallback = entry;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // If no 3.8-3.13 found, use 3.14+ as last resort (may work if nodriver fixes the encoding issue)
  if (fallback) {
    logStep(`Warning: Only ${fallback.version} found. Python 3.13 or lower is recommended for compatibility.`);
    return fallback;
  }

  return null;
}

/**
 * Get path to Python executable in venv
 */
function getVenvPython() {
  return platform() === 'win32'
    ? join(VENV_DIR, 'Scripts', 'python.exe')
    : join(VENV_DIR, 'bin', 'python');
}

/**
 * Get path to pip in venv
 */
function getVenvPip() {
  return platform() === 'win32'
    ? join(VENV_DIR, 'Scripts', 'pip.exe')
    : join(VENV_DIR, 'bin', 'pip');
}

/**
 * Find Chrome browser installation
 */
function findChrome() {
  const os = platform();

  if (os === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return paths.find(p => existsSync(p)) || null;
  }

  if (os === 'win32') {
    const paths = [
      join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return paths.find(p => existsSync(p)) || null;
  }

  // Linux
  const cmds = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
  for (const cmd of cmds) {
    try {
      const result = spawnSync('which', [cmd], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    } catch { continue; }
  }
  return null;
}

/**
 * Patch nodriver source files that contain invalid UTF-8 bytes.
 *
 * nodriver 0.48.x has a raw Latin-1 byte (0xb1, the plus-minus sign) in
 * cdp/network.py that Python 3.14+ rejects with SyntaxError. This function
 * finds and fixes such bytes after pip install, so the package works with
 * any Python version.
 */
function patchNodriverEncoding() {
  // Find the site-packages dir inside the venv
  const venvLib = platform() === 'win32'
    ? join(VENV_DIR, 'Lib', 'site-packages', 'nodriver')
    : null;

  let nodriverDir = venvLib;

  if (!nodriverDir) {
    // Unix: python/venv/lib/python3.X/site-packages/nodriver
    const libDir = join(VENV_DIR, 'lib');
    if (!existsSync(libDir)) return;

    const pythonDirs = readdirSync(libDir).filter(d => d.startsWith('python'));
    for (const pyDir of pythonDirs) {
      const candidate = join(libDir, pyDir, 'site-packages', 'nodriver');
      if (existsSync(candidate)) {
        nodriverDir = candidate;
        break;
      }
    }
  }

  if (!nodriverDir || !existsSync(nodriverDir)) return;

  // Walk all .py files under nodriver and fix invalid UTF-8
  let patchCount = 0;
  const walkAndPatch = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndPatch(fullPath);
      } else if (entry.name.endsWith('.py')) {
        try {
          const buf = readFileSync(fullPath);
          // Check if file has any non-UTF-8 bytes
          try {
            buf.toString('utf-8');
            // Verify by re-encoding - Buffer.toString('utf-8') replaces bad bytes with U+FFFD
            const roundtripped = Buffer.from(buf.toString('utf-8'), 'utf-8');
            if (buf.length === roundtripped.length && buf.compare(roundtripped) === 0) {
              continue; // File is valid UTF-8
            }
          } catch { /* fall through to patch */ }

          // Replace non-UTF-8 bytes with their Unicode equivalents
          // Common case: 0xb1 (Latin-1 plus-minus) -> UTF-8 U+00B1
          const patched = Buffer.alloc(buf.length * 2); // Worst case: every byte doubles
          let writeIdx = 0;
          for (let i = 0; i < buf.length; i++) {
            const byte = buf[i];
            if (byte <= 0x7f) {
              // ASCII - keep as-is
              patched[writeIdx++] = byte;
            } else if ((byte & 0xe0) === 0xc0 && i + 1 < buf.length && (buf[i + 1] & 0xc0) === 0x80) {
              // Valid 2-byte UTF-8 sequence
              patched[writeIdx++] = byte;
              patched[writeIdx++] = buf[++i];
            } else if ((byte & 0xf0) === 0xe0 && i + 2 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
              // Valid 3-byte UTF-8 sequence
              patched[writeIdx++] = byte;
              patched[writeIdx++] = buf[++i];
              patched[writeIdx++] = buf[++i];
            } else if ((byte & 0xf8) === 0xf0 && i + 3 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80 && (buf[i + 3] & 0xc0) === 0x80) {
              // Valid 4-byte UTF-8 sequence
              patched[writeIdx++] = byte;
              patched[writeIdx++] = buf[++i];
              patched[writeIdx++] = buf[++i];
              patched[writeIdx++] = buf[++i];
            } else {
              // Invalid byte (Latin-1 range 0x80-0xFF) - encode as UTF-8
              // Latin-1 byte values map directly to Unicode code points
              patched[writeIdx++] = 0xc0 | (byte >> 6);
              patched[writeIdx++] = 0x80 | (byte & 0x3f);
            }
          }

          const result = patched.subarray(0, writeIdx);
          writeFileSync(fullPath, result);
          patchCount++;
        } catch { /* skip files we can't read/write */ }
      }
    }
  };

  walkAndPatch(nodriverDir);

  if (patchCount > 0) {
    logSuccess(`Patched ${patchCount} nodriver file(s) for Python 3.14+ compatibility`);
  }
}

/**
 * Verify that the venv Python can actually import the required modules
 */
function verifyImports() {
  const venvPython = getVenvPython();
  try {
    const result = spawnSync(venvPython, ['-c', 'import nodriver; import readability; import markdownify; print("ok")'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    if (result.status === 0 && result.stdout.trim() === 'ok') {
      return true;
    }
    // Import failed - log stderr for debugging
    if (result.stderr) {
      logError(`Import verification failed: ${result.stderr.slice(0, 200)}`);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Setup Python virtual environment
 */
function setupPython() {
  // Find Python
  logStep('Checking for Python 3.8+...');
  const python = findPython();

  if (!python) {
    logError('Python 3.8+ not found');
    console.log('');
    console.log('Please install Python 3.8 or higher:');
    console.log('  macOS:   brew install python3');
    console.log('  Ubuntu:  sudo apt install python3 python3-venv');
    console.log('  Windows: https://www.python.org/downloads/');
    console.log('');
    console.log('Then run: npm run setup:python');
    return false;
  }

  logSuccess(`Found ${python.version}`);

  // Create venv if it doesn't exist
  if (!existsSync(VENV_DIR)) {
    logStep('Creating virtual environment...');
    try {
      const venvArgs = [...python.args, '-m', 'venv', VENV_DIR];
      execSync(`${python.cmd} ${venvArgs.join(' ')}`, {
        cwd: PYTHON_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logSuccess('Virtual environment created');
    } catch (err) {
      logError('Failed to create virtual environment');
      console.log('Try: pip install virtualenv && python -m venv python/venv');
      return false;
    }
  } else {
    logSuccess('Virtual environment exists');
  }

  // Install dependencies
  logStep('Installing Python dependencies...');
  try {
    const pip = getVenvPip();
    execSync(`"${pip}" install --upgrade pip -q`, {
      cwd: PYTHON_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync(`"${pip}" install -r requirements.txt -q`, {
      cwd: PYTHON_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logSuccess('Dependencies installed');
  } catch (err) {
    logError('Failed to install dependencies');
    console.log('Try manually: cd python && ./venv/bin/pip install -r requirements.txt');
    return false;
  }

  // Patch nodriver source files for Python 3.14+ compatibility
  patchNodriverEncoding();

  // Make fetcher.py executable (Unix only)
  if (platform() !== 'win32') {
    try {
      chmodSync(join(PYTHON_DIR, 'fetcher.py'), 0o755);
    } catch {
      // Ignore chmod errors
    }
  }

  // Verify that imports actually work
  logStep('Verifying Python imports...');
  if (verifyImports()) {
    logSuccess('All Python imports verified');
  } else {
    logError('Python import verification failed. The MCP server may not work correctly.');
    logStep('Try: cd python && ./venv/bin/python -c "import nodriver" to debug');
    // Don't return false - the venv and deps were installed, they just might not import.
    // The runtime validator will catch this and provide better error messages.
  }

  return true;
}

/**
 * Show success message with registration instructions
 */
function showSuccessMessage() {
  console.log('');
  log('TurboWebFetch — Turn websites into LLM-ready data, locally.', colors.cyan + colors.bold);
  console.log('');
  console.log('Reliably fetches content where standard tools fail. Handles dynamic JS,');
  console.log('Cloudflare challenges, and rendering automatically. 14 parallel browsers.');
  console.log('Zero API keys.');
  console.log('');
  log('By Mourtaza Ali | mourtaza.com', colors.gray);
  console.log('');
  console.log('Register with Claude Code:');
  log('  claude mcp add turbowebfetch npx -y turbowebfetch', colors.yellow);
  console.log('');
}

/**
 * Show failure message
 */
function showFailureMessage() {
  console.log('');
  log('TurboWebFetch — Setup incomplete', colors.yellow);
  console.log('');
  console.log('Python setup failed. The package is installed but needs Python.');
  console.log('');
  console.log('To complete setup manually:');
  log('  cd node_modules/turbowebfetch && npm run setup:python', colors.gray);
  console.log('');
}

// Main
function main() {
  // Skip in CI environments
  if (process.env.CI || process.env.TURBOWEBFETCH_SKIP_POSTINSTALL) {
    return;
  }

  console.log('');
  logStep('Setting up TurboWebFetch...');

  const success = setupPython();

  if (success) {
    // Check for Chrome
    const chrome = findChrome();
    if (chrome) {
      logSuccess(`Found Chrome: ${chrome}`);
    } else {
      logStep(`Warning: Google Chrome not found. TurboWebFetch requires Chrome to be installed.`);
      console.log('  Install from: https://www.google.com/chrome/');
    }

    showSuccessMessage();
  } else {
    showFailureMessage();
  }
}

main();
