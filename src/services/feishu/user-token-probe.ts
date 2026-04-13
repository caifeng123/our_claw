/**
 * UserTokenProbe — 多用户定时心跳探活
 *
 * V2.0 重构:
 *   - 改为遍历 CliProfileManager 管理的所有用户
 *   - 对每个用户执行 `lark-cli auth status --verify`（注入对应 env）
 *   - 触发 cli 内部 GetValidAccessToken() 自动刷新 access_token
 *   - 保持 refresh_token 活跃，防止不活跃用户 30 天过期
 *
 * lark-cli auth status --verify 内部行为：
 *   1. 从 OS keychain / 加密文件读取 StoredUAToken
 *   2. 调用 GetValidAccessToken()：
 *      - access_token 有效 → 直接用
 *      - access_token 过期但 refresh_token 有效 → 自动刷新并写回
 *      - refresh_token 也过期 → 报错
 *   3. 用 access_token 调 /authen/v1/user_info 验证
 *   4. 输出文本，含 "Verified: ✓" 或错误信息
 */

import type { CliProfileManager } from './cli-profile-manager.js';

export interface UserTokenProbeOptions {
  /** CliProfileManager 实例 */
  profileManager: CliProfileManager;
  /** 正常探活间隔，默认 24h */
  intervalMs?: number;
  /** 失败后缩短的重试间隔，默认 30min */
  retryIntervalMs?: number;
  /** 单个用户连续失败几次后告警，默认 3 */
  maxConsecutiveFails?: number;
  /** 告警回调（发飞书消息等），不传则只写日志 */
  onAlert?: (openId: string, message: string) => Promise<void>;
}

export interface UserProbeResult {
  openId: string;
  success: boolean;
  error?: string;
}

export interface ProbeRoundResult {
  timestamp: Date;
  total: number;
  succeeded: number;
  failed: number;
  results: UserProbeResult[];
}

const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000;        // 24h
const DEFAULT_RETRY_INTERVAL = 30 * 60 * 1000;       // 30min
const DEFAULT_MAX_CONSECUTIVE_FAILS = 3;

export class UserTokenProbe {
  private profileManager: CliProfileManager;
  private opts: {
    intervalMs: number;
    retryIntervalMs: number;
    maxConsecutiveFails: number;
    onAlert?: (openId: string, msg: string) => Promise<void>;
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRound: ProbeRoundResult | null = null;

  /** 每个用户的连续失败计数 */
  private failCounts = new Map<string, number>();
  /** 已发过告警的用户（避免重复告警） */
  private alerted = new Set<string>();

  constructor(options: UserTokenProbeOptions) {
    this.profileManager = options.profileManager;
    this.opts = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL,
      retryIntervalMs: options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL,
      maxConsecutiveFails: options.maxConsecutiveFails ?? DEFAULT_MAX_CONSECUTIVE_FAILS,
      onAlert: options.onAlert,
    };
  }

  /**
   * 启动探活：立即执行一次，然后按间隔定时执行
   */
  start(): void {
    console.log(
      `🔑 [UserTokenProbe] 启动，正常间隔=${this.opts.intervalMs / 1000 / 60}min，` +
      `重试间隔=${this.opts.retryIntervalMs / 1000 / 60}min`,
    );
    this.runRound();
  }

  /**
   * 停止探活
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('🔑 [UserTokenProbe] 已停止');
  }

  /**
   * 手动执行一轮探活
   */
  async probeOnce(): Promise<ProbeRoundResult> {
    return this.executeRound();
  }

  /**
   * 获取上一轮探活结果
   */
  getLastRound(): ProbeRoundResult | null {
    return this.lastRound;
  }

  // ─── 内部实现 ───

  private runRound(): void {
    this.executeRound()
      .then(result => this.scheduleNext(result.failed === 0))
      .catch(() => this.scheduleNext(false));
  }

  private scheduleNext(allSucceeded: boolean): void {
    if (this.timer) clearTimeout(this.timer);

    // 如果有失败的用户，使用较短的重试间隔
    const interval = allSucceeded ? this.opts.intervalMs : this.opts.retryIntervalMs;

    this.timer = setTimeout(() => this.runRound(), interval);

    // 不阻止 Node.js 进程退出
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    console.log(
      `🔑 [UserTokenProbe] 下次探活: ${Math.round(interval / 1000 / 60)}min 后` +
      ` (${allSucceeded ? '全部成功' : '有失败，缩短间隔'})`,
    );
  }

  private async executeRound(): Promise<ProbeRoundResult> {
    const userIds = this.profileManager.getAllUserIds();

    if (userIds.length === 0) {
      console.log('🔑 [UserTokenProbe] 无已注册用户，跳过探活');
      const result: ProbeRoundResult = {
        timestamp: new Date(),
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      };
      this.lastRound = result;
      return result;
    }

    console.log(`🔑 [UserTokenProbe] 开始探活，共 ${userIds.length} 个用户...`);

    const results: UserProbeResult[] = [];

    // 串行执行，避免 cli 并发冲突
    for (const openId of userIds) {
      const probeResult = await this.probeUser(openId);
      results.push(probeResult);
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const round: ProbeRoundResult = {
      timestamp: new Date(),
      total: userIds.length,
      succeeded,
      failed,
      results,
    };

    this.lastRound = round;

    console.log(`🔑 [UserTokenProbe] 探活完成: ${succeeded}/${userIds.length} 成功，${failed} 失败`);

    return round;
  }

  private async probeUser(openId: string): Promise<UserProbeResult> {
    const result = await this.profileManager.verifyAndRefresh(openId);

    if (result.success) {
      // 成功：重置计数
      this.failCounts.delete(openId);
      this.alerted.delete(openId);
      console.log(`  ✅ ${openId}: token 有效`);
      return { openId, success: true };
    }

    // 失败：递增计数
    const count = (this.failCounts.get(openId) ?? 0) + 1;
    this.failCounts.set(openId, count);
    console.warn(`  ❌ ${openId}: 探活失败 #${count} — ${result.error}`);

    // 达到阈值且未告警过
    if (count >= this.opts.maxConsecutiveFails && !this.alerted.has(openId)) {
      this.alerted.add(openId);
      const alertMsg = `用户 ${openId} 的 token 已连续 ${count} 次刷新失败，可能需要重新授权。最后错误: ${result.error}`;
      console.error(`🚨 [UserTokenProbe] ${alertMsg}`);
      if (this.opts.onAlert) {
        try {
          await this.opts.onAlert(openId, alertMsg);
        } catch (e) {
          console.error('告警回调执行失败:', e);
        }
      }
    }

    return { openId, success: false, error: result.error };
  }
}
