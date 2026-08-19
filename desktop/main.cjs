const { app, BrowserWindow, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const extract = require('extract-zip');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

let serverProcess;
let mainWindow;
let serverOutput = '';
let quitting = false;

function ts() {
  return new Date().toISOString();
}

function appendLog(text) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const lines = String(text)
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => `[${ts()}] ${line}\n`)
      .join('');
    if (lines) fs.appendFileSync(path.join(logDir, 'server.log'), lines);
  } catch (_) {}
}

function getPidFile() {
  return path.join(app.getPath('userData'), 'server.pid');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function killProcessTree(pid, reason = 'cleanup') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  appendLog(`Stopping server process tree PID=${pid} reason=${reason}`);

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.stdout?.trim()) appendLog(`[taskkill stdout] ${result.stdout.trim()}`);
    if (result.stderr?.trim()) appendLog(`[taskkill stderr] ${result.stderr.trim()}`);
    appendLog(`taskkill exit code: ${result.status}`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {}
}

function cleanupStaleServerProcess() {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return;

  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      appendLog(`Found stale server PID=${pid} from previous run`);
      killProcessTree(pid, 'stale pid file');
    }
  } catch (error) {
    appendLog(`Failed to inspect stale PID file: ${error?.message || error}`);
  }

  try {
    fs.rmSync(pidFile, { force: true });
  } catch (_) {}
}

function rememberServerPid(pid) {
  try {
    fs.writeFileSync(getPidFile(), String(pid));
    appendLog(`Server PID recorded: ${pid}`);
  } catch (error) {
    appendLog(`Failed to record server PID ${pid}: ${error?.message || error}`);
  }
}

function forgetServerPid(pid) {
  try {
    const pidFile = getPidFile();
    if (!fs.existsSync(pidFile)) return;
    const savedPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid || savedPid === pid) fs.rmSync(pidFile, { force: true });
  } catch (_) {}
}

function stopServer(reason = 'app quit') {
  const pid = serverProcess?.pid;
  if (pid) {
    killProcessTree(pid, reason);
    forgetServerPid(pid);
  }
  serverProcess = undefined;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const exitHandler = (code, signal) => {
      fail(new Error(`MoonTVPlus server exited before startup (code=${code}, signal=${signal || 'none'}).\n\n${serverOutput || 'No server output was captured.'}`));
    };
    serverProcess.once('exit', exitHandler);

    const probe = () => {
      if (finished) return;
      const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        if (!finished) {
          finished = true;
          serverProcess.removeListener('exit', exitHandler);
          resolve();
        }
      });
      req.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          fail(new Error(`MoonTVPlus server did not start in time: 127.0.0.1:${port}\n\n${serverOutput || 'No server output was captured.'}`));
        } else {
          setTimeout(probe, 400);
        }
      });
      req.on('timeout', () => req.destroy());
    };
    probe();
  });
}

function readRuntimeConfig() {
  const configPath = path.join(process.resourcesPath, 'runtime-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
}

function isValidServerDir(dir) {
  return fs.existsSync(path.join(dir, 'server.js')) &&
    fs.existsSync(path.join(dir, 'node_modules', 'next', 'package.json'));
}

function findExtractedServerDir(root) {
  if (isValidServerDir(root)) return root;

  const candidates = [
    path.join(root, 'server'),
    path.join(root, 'runtime', 'server'),
  ];
  for (const candidate of candidates) {
    if (isValidServerDir(candidate)) return candidate;
  }

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (isValidServerDir(candidate)) return candidate;
    }
  } catch (_) {}

  return null;
}

async function ensureServerExtracted(config) {
  const buildId = config.BUILD_ID || 'unknown';
  const runtimeBase = path.join(app.getPath('userData'), 'runtime');
  const runtimeRoot = path.join(runtimeBase, buildId);
  const existing = findExtractedServerDir(runtimeRoot);
  if (existing) return existing;

  const archive = path.join(process.resourcesPath, 'server.zip');
  if (!fs.existsSync(archive)) throw new Error(`Missing packaged server archive: ${archive}`);

  fs.mkdirSync(runtimeBase, { recursive: true });
  const tempRoot = path.join(runtimeBase, `${buildId}.extract-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempRoot, { recursive: true });

  appendLog(`Extracting server archive to temporary directory: ${tempRoot}`);
  try {
    await extract(archive, { dir: tempRoot });
    const extractedServerDir = findExtractedServerDir(tempRoot);
    if (!extractedServerDir) {
      const topLevel = fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).join(', ') : '(missing)';
      throw new Error(`Extracted server runtime is invalid. Top-level entries: ${topLevel}`);
    }

    const targetRoot = path.join(runtimeBase, `${buildId}-${Date.now()}`);
    fs.renameSync(tempRoot, targetRoot);
    const finalServerDir = findExtractedServerDir(targetRoot);
    if (!finalServerDir) throw new Error(`Extracted runtime became invalid after activation: ${targetRoot}`);

    appendLog(`Activated extracted runtime: ${finalServerDir}`);
    return finalServerDir;
  } catch (error) {
    appendLog(`Runtime extraction failed: ${error?.stack || String(error)}`);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (cleanupError) {
      appendLog(`Temporary runtime cleanup failed: ${cleanupError?.message || cleanupError}`);
    }
    throw error;
  }
}

async function startServer() {
  const port = await getFreePort();
  const config = readRuntimeConfig();
  const serverDir = await ensureServerExtracted(config);
  const serverEntry = path.join(serverDir, 'server.js');
  const nodeExe = path.join(process.resourcesPath, 'node', 'node.exe');

  if (!fs.existsSync(nodeExe)) throw new Error(`Missing bundled Node runtime: ${nodeExe}`);

  const env = {
    ...process.env,
    ...config,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
  };

  appendLog(`=== MoonTVPlus startup ===`);
  appendLog(`Build: ${config.BUILD_ID || 'unknown'}`);
  appendLog(`Node: ${nodeExe}`);
  appendLog(`Server: ${serverEntry}`);
  appendLog(`Port: ${port}`);

  serverProcess = spawn(nodeExe, [serverEntry], {
    cwd: serverDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  rememberServerPid(serverProcess.pid);
  serverProcess.once('exit', (code, signal) => {
    appendLog(`Server process exited PID=${serverProcess?.pid || 'unknown'} code=${code} signal=${signal || 'none'}`);
    forgetServerPid(serverProcess?.pid);
  });

  const capture = (prefix, data) => {
    const text = `${prefix}${data.toString()}`;
    serverOutput = (serverOutput + text).slice(-12000);
    appendLog(text);
  };
  serverProcess.stdout.on('data', (data) => capture('[stdout] ', data));
  serverProcess.stderr.on('data', (data) => capture('[stderr] ', data));

  await waitForServer(port);
  return port;
}

async function createWindow() {
  const port = await startServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(async () => {
  try {
    cleanupStaleServerProcess();
    await createWindow();
  } catch (error) {
    appendLog(`[fatal] ${error?.stack || String(error)}`);
    stopServer('startup failure');
    dialog.showErrorBox('MoonTVPlus startup failed', error?.stack || String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  stopServer('before-quit');
});

process.on('exit', () => {
  stopServer('process exit');
});
