const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENGINE_NAME = 'maintainability';
const ENGINE_VERSION = '1.1.0';
const PARSER_NAME = 'qak-lexical-ast';
const PARSER_VERSION = '1.0.0';
const FUNCTION_ID_VERSION = 'v1';
const METRIC_DEFINITION_VERSION = '1';
const SUPPORTED_EXTENSIONS = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
]);
const UNSUPPORTED_CODE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.go', '.java', '.php', '.py', '.rb', '.rs', '.swift', '.vue', '.svelte']);
const SKIP_DIRECTORIES = new Set([
  '.git', '.next', '.cache', 'build', 'coverage', 'dist', 'node_modules', 'out', 'vendor',
  'generated', '__generated__', '.qak',
]);
const POLICY_EXCLUDED_NAMES = [/\.min\.[cm]?[jt]sx?$/i, /\.bundle\.[cm]?[jt]sx?$/i, /\.generated\.[cm]?[jt]sx?$/i];
const SOURCE_REVISION_STATUSES = new Set(['VERIFIED', 'UNVERIFIED', 'UNKNOWN']);
const FUNCTION_MEASUREMENT_STATUSES = new Set(['MEASURED']);
const MEASUREMENT_DIRECTIONS = new Set(['LOWER_IS_BETTER', 'HIGHER_IS_BETTER']);
const PROVENANCE_KINDS = new Set(['REPORT', 'EXECUTION']);
const COVERAGE_STATUSES = new Set(['MEASURED', 'PARTIAL', 'NOT_MEASURED', 'FAILURE', 'SKIPPED_BY_POLICY']);
const CONTROL_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'try']);
const MULTI_CHARACTER_TOKENS = ['===', '!==', '>>>', '**=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '...', '::'];

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function relativePath(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/') || '.';
}

function sourceRevisionOrUnknown(sourceRevision) {
  return sourceRevision && typeof sourceRevision === 'object'
    ? {
      status: sourceRevision.status || 'UNKNOWN',
      sha: sourceRevision.sha || null,
      basis: String(sourceRevision.basis || 'No source revision evidence was provided.'),
    }
    : { status: 'UNKNOWN', sha: null, basis: 'No source revision evidence was provided.' };
}

function extensionInfo(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const language = SUPPORTED_EXTENSIONS.get(extension);
  return language ? { extension, language } : null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePhysicalPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function physicallyConfinedReportPath(root, reportPath) {
  const lexicalRoot = path.resolve(root);
  const resolved = path.isAbsolute(reportPath) ? path.resolve(reportPath) : path.resolve(lexicalRoot, reportPath);
  if (!isInside(lexicalRoot, resolved)) throw new Error('Maintainability report must remain inside the analyzed repository.');

  let realRoot;
  try {
    const rootStat = fs.lstatSync(lexicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Repository root is not a physical directory.');
    realRoot = fs.realpathSync(lexicalRoot);
  } catch (error) {
    throw new Error(`Maintainability report repository boundary cannot be resolved: ${error.message}`);
  }

  let candidateStat;
  try { candidateStat = fs.lstatSync(resolved); } catch (error) {
    throw new Error(`Maintainability report path cannot be resolved: ${error.message}`);
  }
  if (candidateStat.isSymbolicLink()) throw new Error('Maintainability report cannot be a symbolic link.');
  if (!candidateStat.isFile()) throw new Error('Maintainability report must be a regular file.');

  let current = resolved;
  while (true) {
    let stat;
    let physical;
    try {
      stat = fs.lstatSync(current);
      physical = fs.realpathSync(current);
    } catch (error) {
      throw new Error(`Maintainability report path cannot be resolved physically: ${error.message}`);
    }
    if (stat.isSymbolicLink() || !samePhysicalPath(current, physical)) throw new Error('Maintainability report path cannot traverse a symbolic link or junction.');
    if (!isInside(realRoot, physical)) throw new Error('Maintainability report resolves outside the analyzed repository.');
    if (samePhysicalPath(current, lexicalRoot)) break;
    const parent = path.dirname(current);
    if (samePhysicalPath(parent, current)) throw new Error('Maintainability report path does not reach the repository boundary.');
    current = parent;
  }
  return resolved;
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let expression = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') { expression += '.*'; index += 1; }
      else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'i');
}

function matchesPolicy(patterns, relative) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const candidate = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return globToRegExp(candidate).test(relative) || globToRegExp(`**/${candidate}`).test(relative);
  });
}

function mayContainIncludedFile(relative, patterns) {
  const normalized = relative.replace(/\\/g, '/');
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const candidate = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
    return candidate.includes('*') || candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function readIgnorePatterns(root) {
  const ignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(ignorePath)) return [];
  return fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

function gitIgnored(root, relative, cache) {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  if (cache.has(relative)) return cache.get(relative);
  const result = spawnSync('git', ['check-ignore', '-q', '--', relative], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
  });
  const ignored = result.status === 0;
  cache.set(relative, ignored);
  return ignored;
}

function policyReason(root, relative, entryName, options, ignorePatterns, ignoreCache) {
  const normalized = relative.replace(/\\/g, '/');
  if (SKIP_DIRECTORIES.has(entryName)) return 'DEFAULT_GENERATED_OR_DEPENDENCY_DIRECTORY';
  if (POLICY_EXCLUDED_NAMES.some((pattern) => pattern.test(entryName))) return 'DEFAULT_GENERATED_ARTIFACT';
  if (Array.isArray(options.exclude) && matchesPolicy(options.exclude, normalized)) return 'EXCLUDED_BY_POLICY';
  if (Array.isArray(options.include) && options.include.length && !matchesPolicy(options.include, normalized)) return 'OUTSIDE_AUTHORIZED_INCLUDE';
  if (gitIgnored(root, normalized, ignoreCache)) return 'IGNORED_BY_GIT';
  if (ignorePatterns.some((pattern) => matchesPolicy([pattern], normalized))) return 'IGNORED_BY_POLICY';
  return null;
}

function discoverFiles(root, options = {}) {
  const ignorePatterns = readIgnorePatterns(root);
  const ignoreCache = new Map();
  const files = [];
  const excludedFiles = [];
  const unsupportedFiles = [];
  const errorFiles = [];
  const visited = new Set();

  function recordDiscoveryError(directory, code, error) {
    const failure = {
      path: relativePath(root, directory),
      status: 'FAILURE',
      reason: `${code}: ${error.message}`,
    };
    excludedFiles.push(failure);
    errorFiles.push(failure);
  }

  function visit(directory) {
    let realDirectory;
    try { realDirectory = fs.realpathSync(directory); } catch (error) {
      recordDiscoveryError(directory, 'DIRECTORY_REALPATH_FAILED', error);
      return;
    }
    if (!isInside(root, realDirectory) || visited.has(realDirectory)) return;
    visited.add(realDirectory);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      recordDiscoveryError(directory, 'DIRECTORY_READ_FAILED', error);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      const relative = relativePath(root, candidate);
      if (entry.isSymbolicLink()) {
        excludedFiles.push({ path: relative, status: 'SKIPPED_BY_POLICY', reason: 'SYMLINK_NOT_FOLLOWED' });
        continue;
      }
      if (entry.isDirectory()) {
        const reason = policyReason(root, relative, entry.name, options, ignorePatterns, ignoreCache);
        if (reason && !(reason === 'OUTSIDE_AUTHORIZED_INCLUDE' && mayContainIncludedFile(relative, options.include))) {
          excludedFiles.push({ path: relative, status: 'SKIPPED_BY_POLICY', reason });
        } else visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = extensionInfo(candidate);
      if (!info) {
        if (UNSUPPORTED_CODE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
          unsupportedFiles.push({ path: relative, status: 'NOT_MEASURED', reason: 'UNSUPPORTED_FILE_EXTENSION' });
        }
        continue;
      }
      const reason = policyReason(root, relative, entry.name, options, ignorePatterns, ignoreCache);
      if (reason) excludedFiles.push({ path: relative, status: 'SKIPPED_BY_POLICY', reason, language: info.language });
      else files.push({ path: relative, absolutePath: candidate, ...info });
    }
  }

  visit(root);
  return { files, excludedFiles, unsupportedFiles, errorFiles };
}

function isIdentifierStart(character) { return /[A-Za-z_$]/.test(character) || character === '\\u200C' || character === '\\u200D'; }
function isIdentifierPart(character) { return /[A-Za-z0-9_$]/.test(character) || character === '\\u200C' || character === '\\u200D'; }

function token(line, value, start, end, type = 'punctuation') {
  return { line, value, start, end, type };
}

function tokenize(source, filePath) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let previousSignificant = null;
  const add = (value, start, end, type = 'punctuation', tokenLine = line) => {
    const item = token(tokenLine, value, start, end, type);
    tokens.push(item);
    previousSignificant = item;
  };
  const advanceText = (text) => { line += (text.match(/\n/g) || []).length; };
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) { if (character === '\n') line += 1; index += 1; continue; }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error(`Unterminated block comment in ${filePath} at line ${line}.`);
      advanceText(source.slice(index, end + 2)); index = end + 2; continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      const quote = character; const start = index; const tokenLine = line; index += 1;
      let closed = false;
      if (quote === '`') {
        let interpolationDepth = 0;
        while (index < source.length) {
          const current = source[index];
          if (current === '\\') { index += 2; continue; }
          if (current === '\n') { line += 1; index += 1; continue; }
          if (interpolationDepth === 0 && current === '`') { index += 1; closed = true; break; }
          if (current === '$' && source[index + 1] === '{') { interpolationDepth += 1; index += 2; continue; }
          if (interpolationDepth > 0 && (current === '\'' || current === '"') && source[index - 1] !== '/') {
            const nestedQuote = current; index += 1;
            while (index < source.length) {
              if (source[index] === '\\') { index += 2; continue; }
              if (source[index] === nestedQuote) { index += 1; break; }
              if (source[index] === '\n') line += 1;
              index += 1;
            }
            continue;
          }
          if (interpolationDepth > 0 && current === '`') {
            index += 1;
            while (index < source.length) {
              if (source[index] === '\\') { index += 2; continue; }
              if (source[index] === '\n') line += 1;
              if (source[index] === '`') { index += 1; break; }
              index += 1;
            }
            continue;
          }
          if (interpolationDepth > 0 && current === '{') interpolationDepth += 1;
          else if (interpolationDepth > 0 && current === '}') interpolationDepth -= 1;
          index += 1;
        }
      }
      while (index < source.length) {
        if (quote === '`') break;
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === quote) { index += 1; closed = true; break; }
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      if (!closed) throw new Error(`Unterminated ${quote === '`' ? 'template' : 'string'} literal in ${filePath} at line ${tokenLine}.`);
      add(source.slice(start, index), start, index, 'string', tokenLine); continue;
    }
    if (isIdentifierStart(character)) {
      const start = index; const tokenLine = line; index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      add(source.slice(start, index), start, index, 'identifier', tokenLine); continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index; const tokenLine = line; index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
      add(source.slice(start, index), start, index, 'number', tokenLine); continue;
    }
    const multi = MULTI_CHARACTER_TOKENS.find((candidate) => source.startsWith(candidate, index));
    if (multi) { const tokenLine = line; add(multi, index, index + multi.length, 'operator', tokenLine); index += multi.length; continue; }
    if (character === '/') {
      const canStartRegex = !previousSignificant || ['(', '[', '{', '=', ':', ',', ';', 'return', '=>', '||', '&&', '!', '?', 'case'].includes(previousSignificant.value);
      if (canStartRegex && source[index + 1] !== '=') {
        const start = index; const tokenLine = line; index += 1; let escaped = false; let inClass = false; let closed = false;
        while (index < source.length) {
          const current = source[index];
          if (current === '\n') break;
          if (escaped) { escaped = false; index += 1; continue; }
          if (current === '\\') { escaped = true; index += 1; continue; }
          if (current === '[') { inClass = true; index += 1; continue; }
          if (current === ']') { inClass = false; index += 1; continue; }
          if (current === '/' && !inClass) { index += 1; while (/[A-Za-z]/.test(source[index] || '')) index += 1; closed = true; break; }
          index += 1;
        }
        if (closed) { add(source.slice(start, index), start, index, 'regex', tokenLine); continue; }
        index = start;
      }
    }
    add(character, index, index + 1, 'punctuation', line); index += 1;
  }
  return tokens;
}

function matchingPairs(tokens, filePath) {
  const pairs = new Map(); const stack = [];
  const opening = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  const closing = new Set([')', ']', '}']);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (opening.has(value)) stack.push({ index, expected: opening.get(value) });
    else if (closing.has(value)) {
      const current = stack.pop();
      if (!current || current.expected !== value) throw new Error(`Unmatched ${value} in ${filePath} at line ${tokens[index].line}.`);
      pairs.set(current.index, index); pairs.set(index, current.index);
    }
  }
  if (stack.length) throw new Error(`Unmatched ${stack[stack.length - 1].expected === ')' ? '(' : '{'} in ${filePath} at line ${tokens[stack[stack.length - 1].index].line}.`);
  return pairs;
}

function previousIdentifier(tokens, index) {
  const item = tokens[index];
  return item && item.type === 'identifier' ? item.value : null;
}

function findExpressionEnd(tokens, start, pairs) {
  let parentheses = 0; let brackets = 0;
  let end = Math.max(start, start - 1);
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parentheses += 1;
    else if (value === ')') { if (parentheses === 0 && brackets === 0) break; parentheses -= 1; }
    else if (value === '[') brackets += 1;
    else if (value === ']') brackets -= 1;
    if (parentheses === 0 && brackets === 0 && [',', ';'].includes(value)) break;
    if (index > start && parentheses === 0 && brackets === 0 && tokens[index].line > tokens[index - 1].line && ['const', 'let', 'var', 'return', 'function', 'class'].includes(value)) break;
    end = index;
    if (pairs.has(index) && ['(', '['].includes(value)) index = pairs.get(index);
  }
  return end;
}

function classifyCallback(tokens, index, parameterStart = index) {
  const previous = tokens[parameterStart - 1]?.value;
  if (previous === '(' || previous === ',') return 'CALLBACK';
  return null;
}

function extractFunctions(tokens, pairs) {
  const functions = []; const seen = new Set();
  const addFunction = (item) => {
    const key = `${item.startToken}:${item.endToken}`;
    if (seen.has(key)) return;
    seen.add(key); functions.push(item);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === 'function') {
      let cursor = index + 1;
      if (tokens[cursor]?.value === '*') cursor += 1;
      const name = previousIdentifier(tokens, cursor) ? tokens[cursor].value : 'anonymous';
      if (name !== 'anonymous') cursor += 1;
      while (tokens[cursor] && tokens[cursor].value !== '(' && !['{', ';'].includes(tokens[cursor].value)) cursor += 1;
      const parameterStart = tokens[cursor]?.value === '(' ? cursor : -1;
      const parameterEnd = parameterStart >= 0 ? pairs.get(parameterStart) : undefined;
      if (parameterEnd === undefined) continue;
      let bodyStart = parameterEnd + 1;
      while (tokens[bodyStart] && tokens[bodyStart].value !== '{' && tokens[bodyStart].value !== ';') bodyStart += 1;
      if (tokens[bodyStart]?.value !== '{') continue;
      const bodyEnd = pairs.get(bodyStart);
      if (bodyEnd === undefined) continue;
      addFunction({ startToken: index, endToken: bodyEnd, bodyStart, bodyEnd, name, role: classifyCallback(tokens, index) || (name === 'anonymous' ? 'FUNCTION_EXPRESSION' : 'FUNCTION_DECLARATION') });
    }
    if (tokens[index].value === '=>') {
      const previous = tokens[index - 1];
      let parameterStart = index - 1; let parameterEnd = index - 1;
      if (previous?.value === ')') { parameterStart = pairs.get(index - 1); parameterEnd = index - 1; }
      else if (previous?.type !== 'identifier') continue;
      if (parameterStart === undefined || parameterStart < 0) continue;
      let bodyStart = index + 1; let bodyEnd;
      if (tokens[bodyStart]?.value === '{') bodyEnd = pairs.get(bodyStart);
      else bodyEnd = findExpressionEnd(tokens, bodyStart, pairs);
      if (bodyEnd === undefined || bodyEnd < bodyStart) continue;
      const beforeParameter = tokens[parameterStart - 1]?.value;
      const assignedName = beforeParameter === '=' ? tokens[parameterStart - 2]?.value : beforeParameter === ':' ? tokens[parameterStart - 2]?.value : null;
      const name = assignedName && /^[A-Za-z_$]/.test(assignedName) ? assignedName : 'anonymous';
      const role = classifyCallback(tokens, index, parameterStart) || 'ARROW_FUNCTION';
      addFunction({ startToken: parameterStart, endToken: bodyEnd, bodyStart: tokens[bodyStart]?.value === '{' ? bodyStart : bodyStart, bodyEnd, name, role });
    }
  }
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index].value !== '(' || tokens[index - 1].type !== 'identifier' || CONTROL_METHOD_NAMES.has(tokens[index - 1].value) || ['function', '*'].includes(tokens[index - 2]?.value)) continue;
    const end = pairs.get(index); const bodyStart = end !== undefined ? end + 1 : undefined;
    if (bodyStart === undefined || tokens[bodyStart]?.value !== '{') continue;
    const bodyEnd = pairs.get(bodyStart); if (bodyEnd === undefined) continue;
    addFunction({ startToken: index - 1, endToken: bodyEnd, bodyStart, bodyEnd, name: tokens[index - 1].value, role: 'METHOD' });
  }
  return functions.sort((left, right) => left.startToken - right.startToken || left.endToken - right.endToken);
}

function statementEnd(tokens, start, pairs, limit) {
  if (start === undefined || start >= limit) return Math.max(start || 0, start || 0);
  if (tokens[start]?.value === '{') return Math.min(pairs.get(start) ?? limit - 1, limit - 1);
  const value = tokens[start]?.value;
  if (value === 'if') {
    const conditionStart = start + 1;
    const conditionEnd = tokens[conditionStart]?.value === '(' ? pairs.get(conditionStart) : conditionStart;
    let end = statementEnd(tokens, (conditionEnd ?? start) + 1, pairs, limit);
    if (tokens[end + 1]?.value === 'else') end = statementEnd(tokens, end + 2, pairs, limit);
    return end;
  }
  let parentheses = 0; let brackets = 0;
  for (let index = start; index < limit; index += 1) {
    const valueAtIndex = tokens[index].value;
    if (valueAtIndex === '(') parentheses += 1;
    else if (valueAtIndex === ')') parentheses -= 1;
    else if (valueAtIndex === '[') brackets += 1;
    else if (valueAtIndex === ']') brackets -= 1;
    if (valueAtIndex === ';' && parentheses === 0 && brackets === 0) return index;
    if (index > start && parentheses === 0 && brackets === 0 && valueAtIndex === '}') return index - 1;
    if (tokens[index].value === '{' && parentheses === 0 && brackets === 0) return Math.min(pairs.get(index) ?? limit - 1, limit - 1);
  }
  return limit - 1;
}

function decisionHeader(tokens, index, pairs, limit) {
  const value = tokens[index]?.value;
  if (['if', 'for', 'while', 'switch', 'catch'].includes(value)) {
    const conditionStart = index + 1;
    const conditionEnd = tokens[conditionStart]?.value === '(' ? pairs.get(conditionStart) : conditionStart;
    const bodyStart = (conditionEnd ?? index) + 1;
    return { conditionStart, conditionEnd, bodyStart, endToken: statementEnd(tokens, bodyStart, pairs, limit) };
  }
  if (value === 'do') return { conditionStart: index, conditionEnd: index, bodyStart: index + 1, endToken: statementEnd(tokens, index + 1, pairs, limit) };
  return null;
}

function isNestedFunctionToken(index, functionInfo, functions) {
  return functions.some((candidate) => candidate !== functionInfo
    && candidate.startToken > functionInfo.startToken
    && candidate.endToken <= functionInfo.endToken
    && index >= candidate.startToken && index <= candidate.endToken);
}

function structuralComplexity(tokens, functionInfo, functions, pairs) {
  const limit = functionInfo.bodyEnd;
  const events = [];
  const primary = [];
  const switchContexts = [];
  const doLoops = [];
  const inFunction = (index) => index > functionInfo.bodyStart && index < limit && !isNestedFunctionToken(index, functionInfo, functions);

  for (let index = functionInfo.bodyStart + 1; index < limit; index += 1) {
    if (!inFunction(index)) continue;
    const value = tokens[index].value;
    if (['if', 'for', 'while', 'switch', 'catch', 'do'].includes(value)) {
      const header = decisionHeader(tokens, index, pairs, limit);
      if (!header) continue;
      if (value === 'while' && doLoops.some((loop) => loop.trailingWhileToken === index)) continue;
      const item = { index, kind: value === 'do' ? 'doWhile' : value, startToken: index, endToken: header.endToken, bodyStart: header.bodyStart, conditionStart: header.conditionStart, conditionEnd: header.conditionEnd };
      if (value === 'do') {
        const bodyEnd = header.endToken;
        const trailingWhileToken = tokens[bodyEnd + 1]?.value === 'while' ? bodyEnd + 1 : undefined;
        item.endToken = trailingWhileToken !== undefined ? statementEnd(tokens, trailingWhileToken, pairs, limit) : bodyEnd;
        item.trailingWhileToken = trailingWhileToken;
        doLoops.push(item);
      }
      primary.push(item);
      if (value === 'switch') switchContexts.push(item);
      continue;
    }
    if (value === 'case' || value === 'default') {
      primary.push({ index, kind: value, startToken: index, endToken: limit - 1, bodyStart: index + 1 });
      continue;
    }
    if (value === '?' && tokens[index - 1]?.value !== '?.' && tokens[index + 1]?.value !== '.') events.push({ index, kind: 'ternary', startToken: index, endToken: findExpressionEnd(tokens, index, pairs) });
    else if (['&&', '||', '??'].includes(value)) events.push({ index, kind: 'logical', startToken: index, endToken: findExpressionEnd(tokens, index, pairs) });
  }

  for (const item of primary) {
    if (!['case', 'default'].includes(item.kind)) continue;
    const owner = switchContexts.find((candidate) => item.index > candidate.bodyStart && item.index < candidate.endToken);
    if (!owner) { item.endToken = Math.min(limit - 1, statementEnd(tokens, item.index + 1, pairs, limit)); continue; }
    const nextLabel = primary.find((candidate) => candidate !== item
      && ['case', 'default'].includes(candidate.kind)
      && candidate.index > item.index && candidate.index < owner.endToken);
    item.endToken = nextLabel ? nextLabel.index - 1 : owner.endToken;
  }
  for (const item of primary) {
    item.endToken = Math.max(item.startToken, Math.min(item.endToken ?? limit - 1, limit - 1));
    item.isElseIf = item.kind === 'if' && tokens[item.index - 1]?.value === 'else';
  }

  const sortedPrimary = primary.sort((left, right) => left.index - right.index);
  for (const item of sortedPrimary) {
    const containers = sortedPrimary.filter((candidate) => candidate !== item && candidate.startToken < item.startToken && candidate.endToken >= item.endToken);
    let parent = containers.sort((left, right) => (left.endToken - left.startToken) - (right.endToken - right.startToken))[0];
    if (item.isElseIf && parent?.kind === 'if') parent = sortedPrimary.find((candidate) => candidate !== item && candidate.startToken < parent.startToken && candidate.endToken >= parent.endToken && !candidate.isElseIf);
    item.parent = parent || null;
    item.depth = (parent?.depth || 0) + 1;
    events.push(item);
  }
  for (const event of events) {
    if (event.kind === 'logical' || event.kind === 'ternary') {
      const owner = sortedPrimary.filter((candidate) => candidate.startToken < event.index && candidate.endToken >= event.index)
        .sort((left, right) => right.startToken - left.startToken)[0];
      event.depth = owner?.depth || 1;
    }
  }
  events.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind));
  const decisions = events.map((event) => ({ ...event, line: tokens[event.index].line }));
  const subtreeCandidates = [
    ...sortedPrimary.filter((item) => item.endToken >= item.startToken),
    ...events.filter((event) => event.kind === 'logical' || event.kind === 'ternary'),
  ].map((item) => {
    const contained = decisions.filter((event) => event.index >= item.startToken && event.index <= item.endToken);
    return {
      count: contained.length,
      startLine: tokens[item.startToken].line,
      endLine: tokens[item.endToken].line,
      rootKind: item.kind,
    };
  });
  subtreeCandidates.sort((left, right) => right.count - left.count || left.startLine - right.startLine || left.endLine - right.endLine || left.rootKind.localeCompare(right.rootKind));
  const subtree = subtreeCandidates[0] || { count: 0, startLine: null, endLine: null, rootKind: null };
  return {
    decisionCount: decisions.length,
    maxDecisionDepth: decisions.reduce((max, event) => Math.max(max, event.depth || 1), 0),
    nestedDecisionCount: decisions.filter((event) => (event.depth || 1) > 1).length,
    maxSubtreeDecisionCount: subtree.count,
    maxSubtreeStartLine: subtree.startLine,
    maxSubtreeEndLine: subtree.endLine,
    maxSubtreeRootKind: subtree.rootKind,
  };
}

function complexity(tokens, functionInfo, functions) {
  let cyclomatic = 1; let cognitive = 0; let nesting = 0;
  const decisionWords = new Set(['if', 'for', 'while', 'case', 'catch']);
  for (let index = functionInfo.bodyStart + 1; index < functionInfo.bodyEnd; index += 1) {
    if (isNestedFunctionToken(index, functionInfo, functions)) continue;
    const value = tokens[index].value;
    if (value === '{') nesting += 1;
    if (value === '}') nesting = Math.max(0, nesting - 1);
    if (decisionWords.has(value)) { cyclomatic += 1; cognitive += 1 + nesting; }
    else if (value === '?' && tokens[index - 1]?.value !== '?.') { cyclomatic += 1; cognitive += 1 + nesting; }
    else if (['&&', '||', '??'].includes(value)) { cyclomatic += 1; cognitive += 1; }
  }
  return { cyclomatic, cognitive };
}

function metricRecord({ path: filePath, language, functionInfo, tokens, metricId, value, unit, direction, sourceRevision, contentSha256, details = {} }) {
  const startLine = tokens[functionInfo.startToken].line;
  const endLine = tokens[functionInfo.endToken].line;
  const functionId = `${FUNCTION_ID_VERSION}:${digest([filePath, functionInfo.role, functionInfo.name, tokens[functionInfo.startToken].start, tokens[functionInfo.endToken].end].join('|')).slice(0, 24)}`;
  const evidenceRef = `${filePath}#${functionId}:${metricId}`;
  return {
    measurementId: `${ENGINE_NAME}:${digest(evidenceRef).slice(0, 32)}`,
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    metricId,
    metricVersion: METRIC_DEFINITION_VERSION,
    language,
    path: filePath,
    functionId,
    functionName: functionInfo.name,
    astRole: functionInfo.role,
    startLine,
    endLine,
    value,
    unit,
    direction,
    status: 'MEASURED',
    provenance: {
      kind: 'EXECUTION',
      reference: `${PARSER_NAME}@${PARSER_VERSION}`,
      sourceRevision,
      contentSha256,
    },
    evidenceRef,
    ...details,
  };
}

function analyzeFile(file, sourceRevision, options = {}) {
  const source = fs.readFileSync(file.absolutePath, 'utf8');
  const contentSha256 = digest(source);
  const tokens = tokenize(source, file.path);
  const pairs = matchingPairs(tokens, file.path);
  const functions = extractFunctions(tokens, pairs);
  const measurements = [];
  const diagnostics = [];
  for (const functionInfo of functions) {
    const values = complexity(tokens, functionInfo, functions);
    const length = tokens[functionInfo.endToken].line - tokens[functionInfo.startToken].line + 1;
    measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'cognitiveComplexity', value: values.cognitive, unit: 'score', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
    measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'cyclomaticComplexity', value: values.cyclomatic, unit: 'score', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
    measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'functionLength', value: length, unit: 'lines', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
    if (options.structural !== false) {
      const structural = structuralComplexity(tokens, functionInfo, functions, pairs);
      measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'decisionCount', value: structural.decisionCount, unit: 'decisions', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
      measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'maxDecisionDepth', value: structural.maxDecisionDepth, unit: 'levels', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
      measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'nestedDecisionCount', value: structural.nestedDecisionCount, unit: 'decisions', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256 }));
      measurements.push(metricRecord({ path: file.path, language: file.language, functionInfo, tokens, metricId: 'maxSubtreeDecisionCount', value: structural.maxSubtreeDecisionCount, unit: 'decisions', direction: 'LOWER_IS_BETTER', sourceRevision, contentSha256, details: { subtreeStartLine: structural.maxSubtreeStartLine, subtreeEndLine: structural.maxSubtreeEndLine, subtreeRootKind: structural.maxSubtreeRootKind } }));
    }
    if (values.cognitive >= 15) diagnostics.push({ kind: 'MAINTAINABILITY_DIAGNOSTIC', code: 'HIGH_COGNITIVE_COMPLEXITY', path: file.path, functionId: measurements[measurements.length - 3].functionId, message: `Function ${functionInfo.name} has cognitive complexity ${values.cognitive}.` });
    if (length >= 50) diagnostics.push({ kind: 'MAINTAINABILITY_DIAGNOSTIC', code: 'LONG_FUNCTION', path: file.path, functionId: measurements[measurements.length - 3].functionId, message: `Function ${functionInfo.name} spans ${length} lines.` });
  }
  return { measurements, functions: functions.length, diagnostics, contentSha256 };
}

function emptyCoverage() {
  return {
    schemaVersion: '0.1-draft',
    status: 'NOT_MEASURED',
    eligibleFiles: [],
    measuredFiles: [],
    excludedFiles: [],
    unsupportedFiles: [],
    errorFiles: [],
    functionsMeasured: 0,
    engines: [],
  };
}

function unavailableResult(reason) {
  const coverage = emptyCoverage();
  coverage.reason = reason;
  return { status: 'NOT_MEASURED', measurements: [], coverage, diagnostics: [{ kind: 'MAINTAINABILITY_DIAGNOSTIC', code: 'ANALYZER_UNAVAILABLE', message: reason }] };
}

function analyzeRepository(root, options = {}) {
  const sourceRevision = sourceRevisionOrUnknown(options.sourceRevision);
  const adapters = options.adapters === undefined ? [PARSER_NAME] : options.adapters;
  if (!Array.isArray(adapters) || !adapters.includes(PARSER_NAME)) {
    return unavailableResult(`No compatible local maintainability parser is available for ${[...SUPPORTED_EXTENSIONS.keys()].join(', ')}; no dependency was installed.`);
  }
  const discovered = discoverFiles(root, options);
  const coverage = emptyCoverage();
  coverage.eligibleFiles = discovered.files.map((file) => ({ path: file.path, language: file.language, status: 'NOT_MEASURED', functionsMeasured: 0 }));
  coverage.excludedFiles = discovered.excludedFiles;
  coverage.unsupportedFiles = discovered.unsupportedFiles;
  coverage.errorFiles = discovered.errorFiles || [];
  const measurements = [];
  const diagnostics = coverage.errorFiles.map((file) => ({
    kind: 'MAINTAINABILITY_DIAGNOSTIC',
    code: 'DISCOVERY_ERROR',
    path: file.path,
    message: file.reason,
  }));
  const measuredPaths = new Set();
  for (const file of discovered.files) {
    const inventory = coverage.eligibleFiles.find((entry) => entry.path === file.path);
    try {
      const result = analyzeFile(file, sourceRevision, options);
      inventory.status = 'MEASURED'; inventory.functionsMeasured = result.functions;
      measuredPaths.add(file.path); measurements.push(...result.measurements); diagnostics.push(...result.diagnostics);
    } catch (error) {
      inventory.status = 'FAILURE'; inventory.reason = error.message;
      coverage.errorFiles.push({ path: file.path, status: 'FAILURE', reason: error.message, language: file.language });
      diagnostics.push({ kind: 'MAINTAINABILITY_DIAGNOSTIC', code: 'PARSE_ERROR', path: file.path, message: error.message });
    }
  }
  coverage.measuredFiles = [...measuredPaths].sort();
  coverage.functionsMeasured = new Set(measurements.map((measurement) => measurement.functionId)).size;
  coverage.engines = [{ name: ENGINE_NAME, version: ENGINE_VERSION, parser: `${PARSER_NAME}@${PARSER_VERSION}` }];
  coverage.status = coverage.errorFiles.length
    ? (coverage.measuredFiles.length ? 'PARTIAL' : 'FAILURE')
    : coverage.measuredFiles.length ? 'MEASURED' : 'NOT_MEASURED';
  return { status: coverage.status, measurements, coverage, diagnostics };
}

function importError(message) {
  throw new Error(`Invalid maintainability report: ${message}`);
}

function requireImportObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) importError(`${label} must be an object.`);
}

function requireImportString(value, label, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum) importError(`${label} must be a non-empty string.`);
}

function validateImportedSourceRevision(value, label) {
  requireImportObject(value, label);
  if (!SOURCE_REVISION_STATUSES.has(value.status)) importError(`${label}.status is invalid.`);
  if (typeof value.basis !== 'string' || !value.basis) importError(`${label}.basis is required.`);
  if (value.sha !== null && value.sha !== undefined && !/^[a-f0-9]{40}$/i.test(String(value.sha))) importError(`${label}.sha is invalid.`);
  if (value.status === 'VERIFIED' && !/^[a-f0-9]{40}$/i.test(String(value.sha || ''))) importError(`${label} cannot be VERIFIED without a valid SHA.`);
  if (value.status === 'UNKNOWN' && value.sha !== null && value.sha !== undefined) importError(`${label} cannot be UNKNOWN with a SHA.`);
}

function validateImportedRelativePath(value, label) {
  requireImportString(value, label);
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) importError(`${label} must be repository-relative.`);
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) importError(`${label} must not traverse a parent directory.`);
}

function validateImportedMeasurement(measurement, index) {
  const label = `functionMeasurements[${index}]`;
  requireImportObject(measurement, label);
  for (const field of ['measurementId', 'engineVersion', 'metricId', 'metricVersion', 'language', 'path', 'functionId', 'functionName', 'astRole', 'unit', 'evidenceRef']) requireImportString(measurement[field], `${label}.${field}`);
  if (measurement.engine !== ENGINE_NAME) importError(`${label}.engine must be ${ENGINE_NAME}.`);
  validateImportedRelativePath(measurement.path, `${label}.path`);
  if (!Number.isInteger(measurement.startLine) || measurement.startLine < 1 || !Number.isInteger(measurement.endLine) || measurement.endLine < measurement.startLine) importError(`${label} has an invalid source interval.`);
  if (!Number.isFinite(measurement.value) || measurement.value < 0) importError(`${label}.value must be a finite non-negative number.`);
  if (!MEASUREMENT_DIRECTIONS.has(measurement.direction)) importError(`${label}.direction is invalid.`);
  if (!FUNCTION_MEASUREMENT_STATUSES.has(measurement.status)) importError(`${label}.status must be MEASURED.`);
  requireImportObject(measurement.provenance, `${label}.provenance`);
  if (!PROVENANCE_KINDS.has(measurement.provenance.kind)) importError(`${label}.provenance.kind is invalid.`);
  requireImportString(measurement.provenance.reference, `${label}.provenance.reference`);
  validateImportedSourceRevision(measurement.provenance.sourceRevision, `${label}.provenance.sourceRevision`);
  if (measurement.provenance.contentSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(measurement.provenance.contentSha256))) importError(`${label}.provenance.contentSha256 is invalid.`);
  if (measurement.subtreeStartLine !== undefined && measurement.subtreeStartLine !== null && (!Number.isInteger(measurement.subtreeStartLine) || measurement.subtreeStartLine < 1)) importError(`${label}.subtreeStartLine is invalid.`);
  if (measurement.subtreeEndLine !== undefined && measurement.subtreeEndLine !== null && (!Number.isInteger(measurement.subtreeEndLine) || measurement.subtreeEndLine < 1)) importError(`${label}.subtreeEndLine is invalid.`);
  if (measurement.subtreeStartLine !== undefined && measurement.subtreeEndLine !== undefined && measurement.subtreeStartLine !== null && measurement.subtreeEndLine !== null && measurement.subtreeEndLine < measurement.subtreeStartLine) importError(`${label} has an invalid subtree interval.`);
}

function validateImportedCoverage(coverage, measurements) {
  requireImportObject(coverage, 'maintainabilityCoverage');
  if (coverage.schemaVersion !== '0.1-draft') importError('maintainabilityCoverage.schemaVersion is invalid.');
  if (!COVERAGE_STATUSES.has(coverage.status)) importError('maintainabilityCoverage.status is invalid.');
  for (const field of ['eligibleFiles', 'measuredFiles', 'excludedFiles', 'unsupportedFiles', 'errorFiles', 'engines']) if (!Array.isArray(coverage[field])) importError(`maintainabilityCoverage.${field} must be an array.`);
  if (!Number.isInteger(coverage.functionsMeasured) || coverage.functionsMeasured < 0) importError('maintainabilityCoverage.functionsMeasured is invalid.');

  const eligibleByPath = new Map();
  for (const [index, file] of coverage.eligibleFiles.entries()) {
    requireImportObject(file, `maintainabilityCoverage.eligibleFiles[${index}]`);
    validateImportedRelativePath(file.path, `maintainabilityCoverage.eligibleFiles[${index}].path`);
    if (eligibleByPath.has(file.path)) importError(`maintainabilityCoverage.eligibleFiles contains duplicate path ${file.path}.`);
    eligibleByPath.set(file.path, file);
    if (!['MEASURED', 'NOT_MEASURED', 'FAILURE'].includes(file.status)) importError(`maintainabilityCoverage.eligibleFiles[${index}].status is invalid.`);
    if (!Number.isInteger(file.functionsMeasured) || file.functionsMeasured < 0) importError(`maintainabilityCoverage.eligibleFiles[${index}].functionsMeasured is invalid.`);
  }
  const measuredFiles = new Set();
  for (const [index, filePath] of coverage.measuredFiles.entries()) {
    validateImportedRelativePath(filePath, `maintainabilityCoverage.measuredFiles[${index}]`);
    if (measuredFiles.has(filePath)) importError(`maintainabilityCoverage.measuredFiles contains duplicate path ${filePath}.`);
    measuredFiles.add(filePath);
    if (!eligibleByPath.has(filePath)) importError(`maintainabilityCoverage.measuredFiles contains unknown path ${filePath}.`);
  }
  for (const [collection, allowedStatuses] of [['excludedFiles', ['SKIPPED_BY_POLICY', 'FAILURE']], ['unsupportedFiles', ['NOT_MEASURED']], ['errorFiles', ['FAILURE']]]) {
    for (const [index, file] of coverage[collection].entries()) {
      requireImportObject(file, `maintainabilityCoverage.${collection}[${index}]`);
      validateImportedRelativePath(file.path, `maintainabilityCoverage.${collection}[${index}].path`);
      if (!allowedStatuses.includes(file.status)) importError(`maintainabilityCoverage.${collection}[${index}].status is invalid.`);
      requireImportString(file.reason, `maintainabilityCoverage.${collection}[${index}].reason`);
    }
  }
  for (const [index, engine] of coverage.engines.entries()) {
    requireImportObject(engine, `maintainabilityCoverage.engines[${index}]`);
    requireImportString(engine.name, `maintainabilityCoverage.engines[${index}].name`);
    requireImportString(engine.version, `maintainabilityCoverage.engines[${index}].version`);
    requireImportString(engine.parser, `maintainabilityCoverage.engines[${index}].parser`);
  }
  if (!coverage.engines.some((engine) => engine.name === ENGINE_NAME)) importError('maintainabilityCoverage.engines must include the maintainability engine.');

  const functionIds = new Set();
  const functionsByPath = new Map();
  const metricKeys = new Set();
  const identitiesByFunction = new Map();
  for (const [index, measurement] of measurements.entries()) {
    validateImportedMeasurement(measurement, index);
    if (!eligibleByPath.has(measurement.path)) importError(`functionMeasurements[${index}].path is not an eligible file.`);
    if (!measuredFiles.has(measurement.path)) importError(`functionMeasurements[${index}].path is not in measuredFiles.`);
    functionIds.add(measurement.functionId);
    const identity = [measurement.path, measurement.functionName, measurement.astRole, measurement.language, measurement.startLine, measurement.endLine].join('\0');
    if (identitiesByFunction.has(measurement.functionId) && identitiesByFunction.get(measurement.functionId) !== identity) importError(`functionMeasurements contains conflicting identities for ${measurement.functionId}.`);
    identitiesByFunction.set(measurement.functionId, identity);
    if (!functionsByPath.has(measurement.path)) functionsByPath.set(measurement.path, new Set());
    functionsByPath.get(measurement.path).add(measurement.functionId);
    const metricKey = `${measurement.functionId}\0${measurement.metricId}`;
    if (metricKeys.has(metricKey)) importError(`functionMeasurements contains duplicate metric ${measurement.metricId} for ${measurement.functionId}.`);
    metricKeys.add(metricKey);
  }
  if (coverage.functionsMeasured !== functionIds.size) importError('maintainabilityCoverage.functionsMeasured does not match functionMeasurements.');
  for (const [filePath, file] of eligibleByPath) {
    const measuredCount = functionsByPath.get(filePath)?.size || 0;
    if (file.functionsMeasured !== measuredCount) importError(`eligible file ${filePath} has an incoherent functionsMeasured count.`);
  }
  const hasErrors = coverage.errorFiles.length > 0 || coverage.eligibleFiles.some((file) => file.status === 'FAILURE');
  const allEligibleMeasured = coverage.eligibleFiles.length > 0 && coverage.eligibleFiles.every((file) => file.status === 'MEASURED') && measuredFiles.size === coverage.eligibleFiles.length;
  if (coverage.status === 'MEASURED' && (!allEligibleMeasured || hasErrors || coverage.excludedFiles.some((file) => file.status === 'FAILURE'))) importError('maintainabilityCoverage declares MEASURED but its inventory is incomplete or contains failures.');
  if (coverage.status === 'MEASURED' && measurements.length === 0 && coverage.functionsMeasured !== 0) importError('maintainabilityCoverage declares MEASURED with an incoherent empty measurement set.');
  if (coverage.status === 'PARTIAL' && !hasErrors) importError('maintainabilityCoverage declares PARTIAL without a recorded failure.');
  if (coverage.status === 'FAILURE' && (measuredFiles.size > 0 || measurements.length > 0)) importError('maintainabilityCoverage declares FAILURE while retaining measured files.');
  if ((coverage.status === 'NOT_MEASURED' || coverage.status === 'SKIPPED_BY_POLICY') && (measuredFiles.size > 0 || measurements.length > 0)) importError(`maintainabilityCoverage declares ${coverage.status} with measured files.`);
}

function importReport(root, reportPath) {
  const resolved = physicallyConfinedReportPath(root, reportPath);
  let report;
  try { report = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch (error) {
    throw new Error(`Invalid maintainability report JSON: ${error.message}`);
  }
  requireImportObject(report, 'maintainability report');
  if (!Array.isArray(report.functionMeasurements) || !report.maintainabilityCoverage) importError('report must contain functionMeasurements and maintainabilityCoverage.');
  if (report.sourceRevision !== undefined) validateImportedSourceRevision(report.sourceRevision, 'report.sourceRevision');
  if (report.diagnostics !== undefined && !Array.isArray(report.diagnostics)) importError('report.diagnostics must be an array.');
  const measurements = report.functionMeasurements;
  validateImportedCoverage(report.maintainabilityCoverage, measurements);
  const sourceRevision = sourceRevisionOrUnknown(report.sourceRevision);
  const diagnostics = [...(Array.isArray(report.diagnostics) ? report.diagnostics : [])];
  if (report.sourceRevision === undefined) diagnostics.push({ kind: 'MAINTAINABILITY_DIAGNOSTIC', code: 'SOURCE_REVISION_UNKNOWN', message: 'The imported report did not attest its source revision; checkout Git context was not used as a substitute.' });
  return { status: report.maintainabilityCoverage.status, measurements, coverage: report.maintainabilityCoverage, diagnostics, sourceRevision };
}

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  PARSER_NAME,
  PARSER_VERSION,
  SUPPORTED_EXTENSIONS,
  analyzeRepository,
  discoverFiles,
  importReport,
};
