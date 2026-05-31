import { spawn } from 'child_process';

/**
 * Run the Grok Build CLI headlessly for one prompt and return its stdout text.
 * Subscription-billed (no per-token cost) -> inputTokens/outputTokens reported 0.
 * Reuses the spawn+timeout+SIGKILL shape from gemini-captioner.js.
 *
 * grok-build is a CODING agent: it spawns `git` at startup and needs a real
 * working directory. The caller MUST pass a cwd that exists and is writable;
 * the Docker image installs `git` for this reason.
 */
export function callGrokCli({ bin = 'grok', prompt, timeoutMs = 180000, cwd, logger = null }) {
  if (!cwd) throw new Error('callGrokCli: cwd is required (grok-build needs a working directory)');
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'plain', '--disable-web-search', '--cwd', cwd];
    const env = { ...process.env };
    delete env.XAI_API_KEY;
    delete env.GROK_DEPLOYMENT_KEY;
    delete env.GROK_CODE_XAI_API_KEY;

    // shell:true is required on Windows so that .bat wrappers (used by tests)
    // are dispatched via cmd.exe. On Linux/Docker (prod) shell stays false.
    const child = spawn(bin, args, { cwd, env, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger?.warn?.(`[grok-cli] timeout after ${timeoutMs}ms`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`grok-cli timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`grok-cli spawn failed: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        logger?.warn?.(`[grok-cli] empty stdout (exit ${code})`);
        reject(new Error(`grok-cli returned empty stdout (exit ${code}); stderr: ${stderr.slice(0, 300)}`));
        return;
      }
      logger?.info?.(`[grok-cli] ok (${text.length}b)`);
      resolve({ text, inputTokens: 0, outputTokens: 0 });
    });
  });
}
