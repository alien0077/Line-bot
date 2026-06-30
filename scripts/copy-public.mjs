import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, 'dist', 'public'), { recursive: true });
await cp(join(root, 'public'), join(root, 'dist', 'public'), { recursive: true });
