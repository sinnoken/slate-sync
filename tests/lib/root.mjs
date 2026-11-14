// root.mjs — repo 根目錄的絕對路徑，給測試與工具組路徑用。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
