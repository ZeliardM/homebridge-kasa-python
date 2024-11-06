import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcDir = path.join(__dirname, 'src', 'python');
const destDir = path.join(__dirname, 'dist', 'python');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

fs.readdirSync(srcDir).forEach(file => {
  if (path.extname(file) === '.py') {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
});