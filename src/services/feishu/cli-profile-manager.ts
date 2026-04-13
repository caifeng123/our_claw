/**
 * CliProfileManager — 多用户 lark-cli 环境隔离管理
 *
 * 为每个用户创建独立 lark-cli 环境：
 *   data/cli-profiles/{openId}/config/   → config.json
 *   data/cli-profiles/{openId}/data/     → 加密 token 存储
 *
 * 职责：
 *   1. ensureProfile(openId) — 创建用户目录 + lark-cli config init（幂等）
 *   2. getCliEnv(openId)     — 返回 env vars，供 Agent 执行 cli 命令时注入
 *   3. isAuthorized(openId)  — 检查用户是否已授权
 *   4. verifyAndRefresh(openId) — 触发 token 续期（心跳用）
 *   5. getAllUserIds()        — 列出所有已注册用户
 *
 * 授权流程不由本模块发起，而是由 Agent 在执行 lark-cli 命令遇到
 * "No user logged in" 时，按 lark-shared skill 指导自然触发：
 *   lark-cli auth login --recommend --json &
 */

import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const execAsync = promisify(exec);
const CLI_TIMEOUT = 30_000;

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
        .filter(d => d.isDirectory() && d.name.startsWith('ou_'))
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

  private getUserDir(openId: string): string {
    return join(this.profilesRoot, openId);
  }
}
