// 让 node --experimental-strip-types 能把相对路径的 .js 导入解析到 .ts 源码。
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}

void pathToFileURL;
