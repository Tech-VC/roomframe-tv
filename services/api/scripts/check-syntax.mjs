import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../src/', import.meta.url));

const files = [];
const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.name.endsWith('.mjs')) files.push(target);
  }
};

await visit(root);

for (const file of files.sort()) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Syntaxe invalide: ${file}`)));
  });
}

console.log(`${files.length} modules JavaScript vérifiés.`);
