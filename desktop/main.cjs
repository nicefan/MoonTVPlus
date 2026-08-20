const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const extract = require('extract-zip');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

let serverProcess;
let mainWindow;
let splashWindow;
let serverOutput = '';
let quitting = false;
let quitCleanupStarted = false;

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

function setStartupStatus(message, detail = '') {
  appendLog(`[startup] ${message}${detail ? ` - ${detail}` : ''}`);
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const payload = JSON.stringify({ message, detail });
  splashWindow.webContents.executeJavaScript(`window.setStatus(${payload})`).catch(() => {});
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 300,
    resizable: false,
    maximizable: false,
    minimizable: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MoonTVPlus</title><style>
    *{box-sizing:border-box}body{margin:0;background:#111827;color:#f9fafb;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
    .box{width:420px}.title{font-size:28px;font-weight:650;margin-bottom:28px}.bar{height:4px;border-radius:4px;background:#374151;overflow:hidden;margin-bottom:22px}.bar:before{content:'';display:block;width:42%;height:100%;background:#f9fafb;animation:move 1.2s ease-in-out infinite}.status{font-size:16px;margin-bottom:8px}.detail{font-size:12px;color:#9ca3af;line-height:1.5;word-break:break-all}@keyframes move{0%{transform:translateX(-110%)}100%{transform:translateX(350%)}}
  </style></head><body><div class="box"><div class="title">MoonTVPlus</div><div class="bar"></div><div id="status" class="status">正在启动…</div><div id="detail" class="detail">准备桌面运行环境</div></div><script>window.setStatus=function(v){document.getElementById('status').textContent=v.message||'';document.getElementById('detail').textContent=v.detail||''}</script></body></html>`;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => { splashWindow = undefined; });
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

function runTaskkill(pid, reason = 'cleanup') {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    appendLog(`Stopping server process tree PID=${pid} reason=${reason}`);

    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
      return resolve();
    }

    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => appendLog(`[taskkill stdout] ${data.toString()}`));
    child.stderr.on('data', (data) => appendLog(`[taskkill stderr] ${data.toString()}`));
    child.once('error', (error) => {
      appendLog(`taskkill failed PID=${pid}: ${error?.message || error}`);
      resolve();
    });
    child.once('exit', (code) => {
      appendLog(`taskkill exit code: ${code}`);
      resolve();
    });
  });
}

async function cleanupStaleServerProcess() {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return;

  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      setStartupStatus('正在清理上次残留进程…', `PID ${pid}`);
      appendLog(`Found stale server PID=${pid} from previous run`);
      await runTaskkill(pid, 'stale pid file');
    }
  } catch (error) {
    appendLog(`Failed to inspect stale PID file: ${error?.message || error}`);
  }

  try { fs.rmSync(pidFile, { force: true }); } catch (_) {}
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

async function stopServer(reason = 'app quit') {
  const pid = serverProcess?.pid;
  if (pid && isProcessAlive(pid)) await runTaskkill(pid, reason);
  forgetServerPid(pid);
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

function waitForServer(port, timeoutMs = 120000) {
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
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsed > 0 && elapsed % 5 === 0) setStartupStatus('正在等待本地服务…', `已等待 ${elapsed} 秒`);
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
  const candidates = [path.join(root, 'server'), path.join(root, 'runtime', 'server')];
  for (const candidate of candidates) if (isValidServerDir(candidate)) return candidate;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (isValidServerDir(candidate)) return candidate;
    }
  } catch (_) {}
  return null;
}

function getRuntimeBase() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, 'MoonTVPlus', 'runtime');
  return path.join(app.getPath('userData'), 'runtime');
}

function getReadyMarker(runtimeRoot) {
  return path.join(runtimeRoot, '.ready.json');
}

function isRuntimeReady(runtimeRoot, buildId) {
  const marker = getReadyMarker(runtimeRoot);
  if (!fs.existsSync(marker)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (meta.buildId !== buildId) return false;
    return Boolean(findExtractedServerDir(runtimeRoot));
  } catch (_) {
    return false;
  }
}

function markRuntimeReady(runtimeRoot, buildId, serverDir) {
  fs.writeFileSync(getReadyMarker(runtimeRoot), JSON.stringify({
    buildId,
    serverDir: path.relative(runtimeRoot, serverDir) || '.',
    readyAt: new Date().toISOString(),
  }, null, 2));
}

async function ensureServerExtracted(config) {
  const buildId = config.BUILD_ID || 'unknown';
  const runtimeBase = getRuntimeBase();
  const runtimeRoot = path.join(runtimeBase, buildId);

  if (isRuntimeReady(runtimeRoot, buildId)) {
    const existing = findExtractedServerDir(runtimeRoot);
    setStartupStatus('运行环境已就绪', existing);
    appendLog(`Reusing extracted runtime: ${existing}`);
    return existing;
  }

  const archive = path.join(process.resourcesPath, 'server.zip');
  if (!fs.existsSync(archive)) throw new Error(`Missing packaged server archive: ${archive}`);

  fs.mkdirSync(runtimeBase, { recursive: true });
  const tempRoot = path.join(runtimeBase, `${buildId}.extract-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempRoot, { recursive: true });

  setStartupStatus('首次启动，正在准备运行环境…', '正在解压服务文件，仅首次或升级后执行');
  appendLog(`Extracting server archive to temporary directory: ${tempRoot}`);
  try {
    await extract(archive, { dir: tempRoot });
    setStartupStatus('正在校验运行环境…', '检查 Next.js 依赖');
    const extractedServerDir = findExtractedServerDir(tempRoot);
    if (!extractedServerDir) {
      const topLevel = fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).join(', ') : '(missing)';
      throw new Error(`Extracted server runtime is invalid. Top-level entries: ${topLevel}`);
    }

    // Activate atomically at a stable build-specific path. Previous code used a
    // timestamped target, while startup looked only for runtime/<BUILD_ID>, which
    // forced a full re-extraction on every launch.
    if (fs.existsSync(runtimeRoot)) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
    fs.renameSync(tempRoot, runtimeRoot);

    const finalServerDir = findExtractedServerDir(runtimeRoot);
    if (!finalServerDir) throw new Error(`Extracted runtime became invalid after activation: ${runtimeRoot}`);
    markRuntimeReady(runtimeRoot, buildId, finalServerDir);

    appendLog(`Activated extracted runtime: ${finalServerDir}`);
    return finalServerDir;
  } catch (error) {
    appendLog(`Runtime extraction failed: ${error?.stack || String(error)}`);
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); } catch (_) {}
    throw error;
  }
}

async function startServer() {
  setStartupStatus('正在准备本地服务…', '检查运行环境');
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
  setStartupStatus('正在启动 MoonTVPlus 服务…', `127.0.0.1:${port}`);

  serverProcess = spawn(nodeExe, [serverEntry], {
    cwd: serverDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = serverProcess.pid;
  rememberServerPid(pid);
  serverProcess.once('exit', (code, signal) => {
    appendLog(`Server process exited PID=${pid || 'unknown'} code=${code} signal=${signal || 'none'}`);
    forgetServerPid(pid);
  });

  const capture = (prefix, data) => {
    const text = `${prefix}${data.toString()}`;
    serverOutput = (serverOutput + text).slice(-12000);
    appendLog(text);
  };
  serverProcess.stdout.on('data', (data) => capture('[stdout] ', data));
  serverProcess.stderr.on('data', (data) => capture('[stderr] ', data));

  await waitForServer(port);
  setStartupStatus('服务已启动', '正在打开界面…');
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
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.show();
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
}

app.whenReady().then(async () => {
  try {
    createSplashWindow();
    setStartupStatus('正在启动…', '检查上次运行状态');
    await cleanupStaleServerProcess();
    await createWindow();
  } catch (error) {
    appendLog(`[fatal] ${error?.stack || String(error)}`);
    await stopServer('startup failure');
    dialog.showErrorBox('MoonTVPlus startup failed', error?.stack || String(error));
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  setStartupStatus('正在退出…', '清理本地服务进程');
  appendLog('Application quit requested; waiting for server cleanup');
  stopServer('before-quit').finally(() => {
    quitting = true;
    appendLog('Server cleanup finished; exiting application');
    app.exit(0);
  });
});
