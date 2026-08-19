const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

let serverProcess;
let mainWindow;
let serverOutput = '';

function appendLog(text) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'server.log'), text);
  } catch (_) {}
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

async function startServer() {
  const port = await getFreePort();
  const config = readRuntimeConfig();
  const serverDir = path.join(process.resourcesPath, 'server');
  const serverEntry = path.join(serverDir, 'server.js');
  const nodeExe = path.join(process.resourcesPath, 'node', 'node.exe');

  if (!fs.existsSync(serverEntry)) throw new Error(`Missing Next.js server: ${serverEntry}`);
  if (!fs.existsSync(nodeExe)) throw new Error(`Missing bundled Node runtime: ${nodeExe}`);

  const env = {
    ...process.env,
    ...config,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
  };

  appendLog(`\n=== MoonTVPlus startup ${new Date().toISOString()} ===\n`);
  appendLog(`Build: ${config.BUILD_ID || 'unknown'}\nNode: ${nodeExe}\nServer: ${serverEntry}\nPort: ${port}\n`);

  serverProcess = spawn(nodeExe, [serverEntry], {
    cwd: serverDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
    await createWindow();
  } catch (error) {
    appendLog(`\n[fatal] ${error?.stack || String(error)}\n`);
    dialog.showErrorBox('MoonTVPlus startup failed', error?.stack || String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
