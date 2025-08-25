// zip.ts
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

interface ZipOptions {
  projectName?: string;
  sourceDir?: string;
  outputDir?: string;
  additionalExcludes?: string[];
}

// --- Read and parse .gitignore ---
function parseGitignore(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

export function createProjectZip(options: ZipOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const userAppDir = path.resolve(__dirname, "..");
    
    const {
      projectName = 'output',
      sourceDir = userAppDir,
      outputDir = userAppDir,
      additionalExcludes = []
    } = options;

    const folderToZip = path.resolve(sourceDir);
    const clientDir = path.join(folderToZip, 'client');
    const outputZipPath = path.resolve(outputDir, `${projectName}.zip`);

    // Check if client directory exists
    if (!fs.existsSync(clientDir)) {
      reject(new Error('Client directory not found'));
      return;
    }

    // Setup zip stream
    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`✅ Zip created: ${outputZipPath} (${archive.pointer()} bytes)`);
      resolve(outputZipPath);
    });

    archive.on('warning', err => {
      if (err.code === 'ENOENT') {
        console.warn('⚠️ Missing file warning:', err.message);
      } else {
        reject(err);
      }
    });

    archive.on('error', (err: any) => {
      console.error('❌ Archiver error:', err);
      reject(err);
    });

    archive.pipe(output);

    // Only include files from the client directory
    archive.directory(clientDir, false);

    archive.finalize();
  });
}
