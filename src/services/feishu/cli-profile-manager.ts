/**
 * CliProfileManager — 单用户 lark-cli 环境隔离管理
 *
 * 全局共享一个 lark-cli profile（统一 openId = 'system'）：
 *   data/cli-profiles/system/config/   → config.json
 *   data/cli-profiles/system/data/     → 加密 token 存储
 *
 * 不同项目通过各自仓库下的 data/cli-profiles/ 天然隔离，
 * 不依赖 lark-cli 默认目录（~/.config/lark-cli），避免跨项目串数据。
 *
 * 职责：
 *   1. ensureProfile(openId)        — 创建目录 + lark-cli config init（幂等）
 *   2. getCliEnv(openId)            — 返回 env vars，供 Agent 执行 cli 命令时注入
 *   3. isAuthorized(openId)         — 检查是否已授权
 *   4. ensureLogin(openId, onUrl)   — 启动期主动触发授权,抠 verification URL 推到回调
 *   5. verifyAndRefresh(openId)     — 触发 token 续期（心跳用）
 *   6. getAllUserIds()              — 列出所有已注册 profile（单用户模式下通常仅 'system'）
 */

import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const execAsync = promisify(exec);
const CLI_TIMEOUT = 30_000;
const LOGIN_TIMEOUT = 5 * 60_000;

export interface CliProfileManagerOptions {
  appId: string;
  appSecret: string;
  brand?: string;
  profilesRoot?: string;
}

export class CliProfileManager {
  private appId: string;
  private appSecret: string;
  private brand: string;
  private profilesRoot: string;

  constructor(options: CliProfileManagerOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.brand = options.brand ?? 'feishu';
    this.profilesRoot = resolve(options.profilesRoot ?? 'data/cli-profiles');

    if (!existsSync(this.profilesRoot)) {
      mkdirSync(this.profilesRoot, { recursive: true });
    }
  }

  /**
   * 获取指定用户的 cli 环境变量
   */
  getCliEnv(openId: string): Record<string, string> {
    const userDir = this.getUserDir(openId);
    return {
      LARKSUITE_CLI_CONFIG_DIR: join(userDir, 'config'),
      LARKSUITE_CLI_DATA_DIR: join(userDir, 'data'),
    };
  }

  /**
   * 检查用户是否已授权
   *
   * lark-cli auth status --verify JSON 输出：
   *   已授权:  { "verified": true, "identity": "user", ... }
   *   未login: { "identity": "bot", "note": "No user logged in..." }
   *   未init:  { "ok": false, "error": { "type": "config" } }
   */
  async isAuthorized(openId: string): Promise<boolean> {
    const configDir = join(this.getUserDir(openId), 'config');
    if (!existsSync(join(configDir, 'config.json'))) {
      return false;
    }

    try {
      const env = { ...process.env, ...this.getCliEnv(openId) };
      const { stdout } = await execAsync('lark-cli auth status --verify', {
        timeout: CLI_TIMEOUT,
        env,
      });
      const result = JSON.parse(stdout.trim());
      return result.verified === true;
    } catch {
      return false;
    }
  }

  /**
   * 确保用户 cli profile 已初始化（幂等）
   */
  async ensureProfile(openId: string): Promise<void> {
    const userDir = this.getUserDir(openId);
    const configDir = join(userDir, 'config');
    const dataDir = join(userDir, 'data');

    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    if (existsSync(join(configDir, 'config.json'))) {
      return;
    }

    const env = { ...process.env, ...this.getCliEnv(openId) };
    const cmd = `echo "${this.appSecret}" | lark-cli config init --app-id ${this.appId} --app-secret-stdin --brand ${this.brand}`;

    try {
      await execAsync(cmd, { timeout: CLI_TIMEOUT, env });
      console.log(`✅ [CliProfileManager] profile 初始化完成: ${openId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ [CliProfileManager] profile 初始化失败: ${openId} — ${msg}`);
      throw new Error(`Failed to init cli profile for ${openId}: ${msg}`);
    }
  }

  /**
   * 获取所有已注册用户的 openId 列表
   */
  getAllUserIds(): string[] {
    try {
      if (!existsSync(this.profilesRoot)) return [];
      return readdirSync(this.profilesRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  /**
   * 运行 lark-cli auth status --verify 触发 token 续期
   */
  async verifyAndRefresh(openId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const env = { ...process.env, ...this.getCliEnv(openId) };
      const { stdout } = await execAsync('lark-cli auth status --verify', {
        timeout: CLI_TIMEOUT,
        env,
      });
      const result = JSON.parse(stdout.trim());
      if (result.verified === true) {
        return { success: true };
      }
      return { success: false, error: result.note ?? result.error?.message ?? 'not verified' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  }

  /**
   * 启动期主动触发授权 —— spawn lark-cli auth login --json,
   * 解析 NDJSON 输出拿到 verification_uri_complete,通过 onUrl 推到调用方,
   * 等待 cli 进程退出。
   *
   * exit 0  → token 落盘成功
   * 非 0    → throw
   * 超时    → throw(默认 5 分钟)
   */
  async ensureLogin(
    openId: string,
    onUrl: (url: string) => void | Promise<void>,
  ): Promise<void> {
    const env = { ...process.env, ...this.getCliEnv(openId) };

    return new Promise<void>((resolveFn, rejectFn) => {
      const child = spawn(
        'lark-cli',
        ['auth', 'login', '--recommend', '--json'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let urlCaptured = false;
      let stderrBuf = '';

      const extractUrl = (text: string): string | null => {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
          try {
            const obj = JSON.parse(trimmed);
            const url = obj?.verification_uri_complete ?? obj?.verification_uri ?? obj?.url;
            if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
          } catch {
            // 非 JSON 行,忽略
          }
        }
        return null;
      };

      const tryCaptureUrl = async (text: string) => {
        if (urlCaptured) return;
        const url = extractUrl(text);
        if (!url) return;
        urlCaptured = true;
        try {
          await onUrl(url);
        } catch (e) {
          console.warn('⚠️ [CliProfileManager] onUrl 回调失败:', e);
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        void tryCaptureUrl(chunk.toString());
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        rejectFn(new Error(`lark-cli auth login 超时(${LOGIN_TIMEOUT / 1000}s),用户未在限期内完成授权`));
      }, LOGIN_TIMEOUT);

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          console.log(`✅ [CliProfileManager] ${openId} 授权完成`);
          resolveFn();
        } else {
          rejectFn(new Error(`lark-cli auth login 退出 code=${code}\nstderr: ${stderrBuf.trim()}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        rejectFn(err);
      });
    });
  }

  private getUserDir(openId: string): string {
    return join(this.profilesRoot, openId);
  }
}
