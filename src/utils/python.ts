/**
 * Python utility module for calling nodriver fetcher
 *
 * Provides functions to check Python setup and execute the Python fetcher script.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const PYTHON_DIR = join(PROJECT_ROOT, 'python');
const VENV_DIR = join(PYTHON_DIR, 'venv');
const FETCHER_SCRIPT = join(PYTHON_DIR, 'fetcher.py');

/**
 * Get the path to the Python executable in the venv
 */
export function getPythonPath(): string {
  // macOS/Linux
  const unixPath = join(VENV_DIR, 'bin', 'python');
  if (existsSync(unixPath)) {
    return unixPath;
  }

  // Windows fallback (though not primary target)
  const winPath = join(VENV_DIR, 'Scripts', 'python.exe');
  if (existsSync(winPath)) {
    return winPath;
  }

  throw new Error('Python virtual environment not found. Run: npm run setup:python');
}

/**
 * Check if Python environment is properly set up
 */
export function isPythonSetup(): boolean {
  try {
    const pythonPath = getPythonPath();
    return existsSync(pythonPath) && existsSync(FETCHER_SCRIPT);
  } catch {
    return false;
  }
}

/**
 * Validate Python setup and throw helpful error if not ready
 */
export function validatePythonSetup(): void {
  if (!isPythonSetup()) {
    throw new Error(
      'Python environment not set up. Run the following command:\n' +
      '  npm run setup:python\n' +
      '\n' +
      'This will create a virtual environment and install nodriver dependencies.'
    );
  }
}

/**
 * Execute the Python fetcher script
 *
 * @param url - URL to fetch
 * @param format - Output format (html, text, markdown)
 * @param waitFor - Optional CSS selector to wait for
 * @param timeout - Timeout in milliseconds
 * @returns Promise resolving to fetcher output
 */
export async function executePythonFetcher(
  url: string,
  format: 'html' | 'text' | 'markdown' = 'text',
  waitFor?: string,
  timeout: number = 30000
): Promise<string> {
  validatePythonSetup();

  const pythonPath = getPythonPath();
  const args = [FETCHER_SCRIPT, url, '--format', format, '--timeout', String(timeout / 1000)];

  if (waitFor) {
    args.push('--wait-for', waitFor);
  }

  return new Promise((resolve, reject) => {
    const childProcess = spawn(pythonPath, args, {
      cwd: PYTHON_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    childProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const errorMsg = stderr.trim() || `Python fetcher exited with code ${code}`;
        reject(new Error(errorMsg));
      }
    });

    childProcess.on('error', (err: Error) => {
      reject(new Error(`Failed to start Python fetcher: ${err.message}`));
    });

    // Kill process on timeout
    const timeoutHandle = setTimeout(() => {
      childProcess.kill('SIGTERM');
      setTimeout(() => childProcess.kill('SIGKILL'), 5000);
      reject(new Error(`Python fetcher timed out after ${timeout}ms`));
    }, timeout + 5000); // Add buffer to Python's internal timeout

    childProcess.on('close', () => clearTimeout(timeoutHandle));
  });
}

/**
 * Execute Python fetcher for batch URLs
 *
 * @param urls - Array of URLs to fetch
 * @param format - Output format
 * @param timeout - Timeout per URL in milliseconds
 * @returns Promise resolving to array of results
 */
export async function executePythonFetcherBatch(
  urls: string[],
  format: 'html' | 'text' | 'markdown' = 'text',
  timeout: number = 30000
): Promise<Array<{ url: string; content?: string; error?: string }>> {
  validatePythonSetup();

  const pythonPath = getPythonPath();
  const args = [
    FETCHER_SCRIPT,
    '--batch',
    '--format',
    format,
    '--timeout',
    String(timeout / 1000),
    ...urls,
  ];

  return new Promise((resolve, reject) => {
    const childProcess = spawn(pythonPath, args, {
      cwd: PYTHON_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    childProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code: number | null) => {
      if (code === 0) {
        try {
          const results = JSON.parse(stdout.trim());
          resolve(results);
        } catch (err) {
          reject(new Error(`Failed to parse batch results: ${err}`));
        }
      } else {
        const errorMsg = stderr.trim() || `Python fetcher batch exited with code ${code}`;
        reject(new Error(errorMsg));
      }
    });

    childProcess.on('error', (err: Error) => {
      reject(new Error(`Failed to start Python fetcher batch: ${err.message}`));
    });

    // Kill process on timeout (batch timeout is per-url * count + overhead)
    const totalTimeout = timeout * urls.length + 10000;
    const timeoutHandle = setTimeout(() => {
      childProcess.kill('SIGTERM');
      setTimeout(() => childProcess.kill('SIGKILL'), 5000);
      reject(new Error(`Python fetcher batch timed out after ${totalTimeout}ms`));
    }, totalTimeout);

    childProcess.on('close', () => clearTimeout(timeoutHandle));
  });
}
