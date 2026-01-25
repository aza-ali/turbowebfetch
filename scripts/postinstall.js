#!/usr/bin/env node
/**
 * TurboWebFetch Postinstall Script
 *
 * Automatically sets up Python environment and shows registration instructions.
 * Cross-platform: works on macOS, Linux, and Windows.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, chmodSync } from 'fs';
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
 */
function findPython() {
  const candidates = platform() === 'win32'
    ? ['python', 'python3', 'py -3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd.split(' ')[0], [...cmd.split(' ').slice(1), '--version'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.status === 0) {
        const version = result.stdout.trim() || result.stderr.trim();
        // Check it's Python 3.8+
        const match = version.match(/Python (\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1]);
          const minor = parseInt(match[2]);
          if (major >= 3 && minor >= 8) {
            return { cmd: cmd.split(' ')[0], args: cmd.split(' ').slice(1), version };
          }
        }
      }
    } catch {
      continue;
    }
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

  // Make fetcher.py executable (Unix only)
  if (platform() !== 'win32') {
    try {
      chmodSync(join(PYTHON_DIR, 'fetcher.py'), 0o755);
    } catch {
      // Ignore chmod errors
    }
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
  log('  claude mcp add turbo-web-fetch npx -y turbowebfetch', colors.yellow);
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
    showSuccessMessage();
  } else {
    showFailureMessage();
  }
}

main();
