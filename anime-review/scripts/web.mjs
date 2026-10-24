import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runtime = new URL('../.runtime/nginx/', import.meta.url);
const children = new Set();
let stopping = false;
let cleanup;

function stop(code = 0, message) {
  if (stopping) return cleanup;
  stopping = true;
  process.exitCode = code;
  if (message) console.error(message);

  const force = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 3000);
  force.unref();
  cleanup = Promise.all([...children].map(child => new Promise(resolve => {
    child.once('close', resolve);
    child.kill('SIGTERM');
  }))).finally(() => clearTimeout(force));
  return cleanup;
}

function launch(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  children.add(child);
  child.once('error', error => stop(1, `${command} 启动失败：${error.message}`));
  child.once('close', (code, signal) => {
    children.delete(child);
    if (!stopping) stop(1, `${command} 已退出（${signal || code}），正在停止网页服务。`);
  });
  return child;
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

async function main() {
  await mkdir(runtime, { recursive: true });
  const config = await readFile(new URL('../nginx/nginx.conf', import.meta.url), 'utf8');
  const port = config.match(/^\s*listen\s+(\d+)\s*;/m)?.[1];
  if (!port) throw new Error('请在 nginx/nginx.conf 中使用 listen 端口; 设置监听端口。');
  const localURL = `http://127.0.0.1:${port}`;
  if (stopping) return;

  console.log('正在启动 Nginx…');
  const nginx = launch('nginx', [
    '-e', 'stderr', '-p', projectRoot,
    '-c', 'nginx/nginx.conf', '-g', 'daemon off;',
  ]);

  const deadline = Date.now() + 10000;
  while (!stopping && Date.now() < deadline) {
    try {
      // 确认是本次启动的 Nginx，避免误把占用端口的其他服务公开。
      const pid = Number(await readFile(new URL('nginx.pid', runtime), 'utf8'));
      if (pid === nginx.pid) {
        const response = await fetch(localURL, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (!stopping && response.ok) {
          console.log(`本机：${localURL}/`);
          console.log('正在创建临时公网链接，请查看下方 cloudflared 输出。按 Ctrl+C 一并停止。');
          launch('cloudflared', ['tunnel', '--url', localURL]);
          return;
        }
      }
    } catch {
      // PID 文件与网页可能尚未就绪，稍后重试。
    }
    await delay(100);
  }
  if (!stopping) throw new Error('Nginx 在 10 秒内未就绪，请检查 .runtime/nginx/error.log。');
}

main().catch(error => stop(1, error.message));
