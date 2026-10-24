const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.cache',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
]);

const SCANNER_CONFIGS = {
  knip: ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc'],
  jscpd: ['.jscpd.json', '.jscpd.jsonc', '.config/jscpd.json', 'jscpd.json', 'jscpd.jsonc'],
};

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findRepositoryRoot(inputPath) {
  const resolved = path.resolve(inputPath || process.cwd());
  let current = isDirectory(resolved) ? resolved : path.dirname(resolved);
  let nearestPackageRoot = null;

  while (true) {
    if (isFile(path.join(current, 'package.json')) && !nearestPackageRoot) {
      nearestPackageRoot = current;
    }
    if (isDirectory(path.join(current, '.git')) || isFile(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return nearestPackageRoot || resolved;
    }
    current = parent;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function relativePath(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/') || '.';
}

function detectPackageManager(root) {
  const lockfiles = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['npm', 'package-lock.json'],
    ['bun', 'bun.lockb'],
  ];
  const lockfile = lockfiles.find(([, name]) => isFile(path.join(root, name)));
  return lockfile ? { name: lockfile[0], lockfile: lockfile[1] } : { name: null, lockfile: null };
}

function readWorkspacePatterns(packageJson) {
  if (Array.isArray(packageJson?.workspaces)) {
    return packageJson.workspaces;
  }
  if (Array.isArray(packageJson?.workspaces?.packages)) {
    return packageJson.workspaces.packages;
  }
  return [];
}

function workspaceCandidates(root, patterns) {
  const packages = new Set();
  const knownRoots = new Set(['apps', 'packages', 'components', 'modules', 'plugins', 'services']);

  function visit(directory, depth) {
    if (depth > 4 || !isDirectory(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = path.join(directory, entry.name);
      if (isFile(path.join(child, 'package.json'))) {
        packages.add(relativePath(root, child));
      }
      visit(child, depth + 1);
    }
  }

  const shouldInspect = patterns.length > 0 || [...knownRoots].some((name) => isDirectory(path.join(root, name)));
  if (shouldInspect) visit(root, 0);

  return [...packages].filter((candidate) => {
    if (patterns.length === 0) return true;
    const normalized = candidate.replace(/\/package\.json$/, '');
    return patterns.some((pattern) => workspacePatternMatches(pattern, normalized));
  }).sort();
}

function workspacePatternMatches(pattern, candidate) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped.replace(/\/$/, '')}(?:/.*)?$`).test(candidate);
}

function detectLanguages(root) {
  const extensions = new Set();
  function visit(directory, depth) {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(child, depth + 1);
      } else {
        const extension = path.extname(entry.name).toLowerCase();
        if (extension) extensions.add(extension);
      }
    }
  }
  visit(root, 0);
  const languages = [];
  if ([...extensions].some((extension) => ['.js', '.jsx', '.mjs', '.cjs'].includes(extension))) languages.push('javascript');
  if ([...extensions].some((extension) => ['.ts', '.tsx', '.mts', '.cts'].includes(extension))) languages.push('typescript');
  if (extensions.has('.py')) languages.push('python');
  if (extensions.has('.go')) languages.push('go');
  if (extensions.has('.rs')) languages.push('rust');
  return languages.sort();
}

function resolveLocalBinary(root, name) {
  const binDirectory = path.join(root, 'node_modules', '.bin');
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const filename = candidates.find((candidate) => isFile(path.join(binDirectory, candidate)));
  return filename ? path.join(binDirectory, filename) : null;
}

function scannerDetection(root, packageJson, name) {
  const configPaths = SCANNER_CONFIGS[name]
    .filter((filename) => isFile(path.join(root, filename)))
    .map((filename) => filename);
  const packageConfig = packageJson && packageJson[name] ? true : false;
  const scripts = Object.entries(packageJson?.scripts || {})
    .filter(([, command]) => new RegExp(`(?:^|[\\s&])${name}(?:[\\s@]|$)`).test(command))
    .map(([script]) => script);
  const binary = resolveLocalBinary(root, name);
  return {
    name,
    installed: Boolean(binary),
    configuration: configPaths,
    packageConfiguration: packageConfig,
    scripts,
  };
}

function discover(inputPath) {
  const root = findRepositoryRoot(inputPath);
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = readJsonFile(packageJsonPath) || {};
  const workspacePatterns = readWorkspacePatterns(packageJson);
  const packageManager = detectPackageManager(root);
  const scanners = ['knip', 'jscpd'].map((name) => scannerDetection(root, packageJson, name));

  return {
    root,
    repositoryName: packageJson.name || path.basename(root),
    packageManager,
    languages: detectLanguages(root),
    workspaces: {
      declared: workspacePatterns,
      packages: workspaceCandidates(root, workspacePatterns),
    },
    scanners,
    configurations: scanners.flatMap((scanner) => scanner.configuration.map((file) => ({ scanner: scanner.name, path: file }))),
    packageJson,
  };
}

module.exports = {
  SCANNER_CONFIGS,
  discover,
  findRepositoryRoot,
  relativePath,
  resolveLocalBinary,
};
