const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const source = path.join(__dirname, 'runtime', 'server');
  const resources = path.join(context.appOutDir, 'resources');
  const target = path.join(resources, 'server');

  if (!fs.existsSync(path.join(source, 'server.js'))) {
    throw new Error(`Desktop server source is missing: ${source}`);
  }
  if (!fs.existsSync(path.join(source, 'node_modules', 'next', 'package.json'))) {
    throw new Error(`Desktop Next runtime is missing: ${path.join(source, 'node_modules', 'next', 'package.json')}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    force: true,
  });

  const required = [
    path.join(target, 'server.js'),
    path.join(target, 'node_modules', 'next', 'package.json'),
    path.join(target, 'node_modules', 'styled-jsx', 'package.json'),
    path.join(target, 'node_modules', '@swc', 'helpers', 'package.json'),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error(`afterPack runtime copy missing: ${file}`);
  }

  console.log(`MoonTVPlus desktop server copied to ${target}`);
};
