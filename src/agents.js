const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const AGENT_PROTOCOL_VERSION = '0.1-draft';

function commandPath(command) {
  if (command) return command;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = String(lookup.stdout || '').split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return first || 'codex';
}

function runProcess(command, args, cwd, prompt) {
  return new Promise((resolve) => {
    const windowsCommand = process.platform === 'win32' && String(command).toLowerCase().endsWith('.cmd');
    const child = spawn(command, args, {
      cwd,
      shell: windowsCommand,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: 'FAILED', exitCode: null, stdout, stderr, error: error.message }));
    child.on('close', (exitCode) => resolve({ status: exitCode === 0 ? 'COMPLETED' : 'FAILED', exitCode, stdout, stderr }));
    child.stdin.end(prompt);
  });
}

function createCodexAdapter(options = {}) {
  return {
    name: 'codex',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    capabilities: { boundedWorkspaceWrite: false, strongWorkspaceConfinement: false, externalEffects: 'NOT_OBSERVABLE', commits: false, pushes: false, baselineMutation: false },
    async execute({ root, prompt }) {
      const lastMessage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-codex-')), 'last-message.txt');
      try {
        const command = commandPath(options.command);
        const args = [
          'exec',
          '--approve-for-me',
          '--ephemeral',
          '--output-last-message', lastMessage,
          '-',
        ];
        const result = await runProcess(command, args, root, prompt);
        return {
          ...result,
          command: [command, ...args].join(' '),
          lastMessage: fs.existsSync(lastMessage) ? fs.readFileSync(lastMessage, 'utf8') : '',
        };
      } finally {
        try { fs.rmSync(path.dirname(lastMessage), { recursive: true, force: true }); } catch { /* evidence is already captured */ }
      }
    },
  };
}

function createCommandAdapter(name, command) {
  if (!command) throw new Error('--agent-command is required for a command agent.');
  return {
    name,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    capabilities: { boundedWorkspaceWrite: false, strongWorkspaceConfinement: false, externalEffects: 'NOT_OBSERVABLE', commits: false, pushes: false, baselineMutation: false },
    async execute({ root, prompt }) {
      const result = await runProcess(command, [], root, prompt);
      return { ...result, command };
    },
  };
}

function createDeterministicAdapter() {
  return {
    name: 'deterministic-test-agent',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    capabilities: { boundedWorkspaceWrite: true, strongWorkspaceConfinement: true, externalEffects: 'NONE', commits: false, pushes: false, baselineMutation: false },
    async execute({ root, allowedFiles, allowedPhysicalFiles = {} }) {
      let changed = 0;
      for (const relative of allowedFiles) {
        const filePath = allowedPhysicalFiles[relative] || path.join(root, relative.split('/').join(path.sep));
        try {
          if (!fs.lstatSync(filePath).isFile() || fs.realpathSync(filePath) !== filePath) throw new Error(`Physical allowlist changed for ${relative}.`);
        } catch (error) {
          return { status: 'FAILED', exitCode: null, stdout: '', stderr: error.message, command: 'deterministic-test-agent' };
        }
        if (!fs.existsSync(filePath)) continue;
        const before = fs.readFileSync(filePath, 'utf8');
        const after = before.replace(/QAK_FIX_ME/g, 'QAK_FIXED');
        if (after !== before) {
          fs.writeFileSync(filePath, after, 'utf8');
          changed += 1;
        }
      }
      return { status: 'COMPLETED', exitCode: 0, stdout: `deterministic-test-agent changed ${changed} approved file(s)`, stderr: '', command: 'deterministic-test-agent' };
    },
  };
}

function createAgentAdapter(name = 'codex', options = {}) {
  if (name === 'codex') return createCodexAdapter(options);
  if (name === 'command') return createCommandAdapter(name, options.command);
  if (name === 'deterministic') return createDeterministicAdapter();
  throw new Error(`Unsupported agent adapter: ${name}`);
}

module.exports = { AGENT_PROTOCOL_VERSION, createAgentAdapter, createCodexAdapter, createCommandAdapter, createDeterministicAdapter };
