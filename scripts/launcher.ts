#!/usr/bin/env node
/**
 * Launcher - 服务启动器
 * 作为父进程管理业务服务子进程，取代 tsx watch 模式
 * 功能：
 * - 不自动热更新（Claude Code 修改文件不会导致服务重启）
 * - 手动触发重启（用户发送 /restart 指令）
 * - 启动失败自动回滚（如果是 git 仓库则 stash 暂存问题代码）
 */

import { fork, execSync, ChildProcess, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置
const READY_TIMEOUT = 30000;
const MAX_RESTART_RETRIES = 1;
const GRACEFUL_SHUTDOWN_TIMEOUT = 5000;

/**
 * 检测当前目录是否是 git 仓库
 */
function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 子进程管理器
class Launcher {
  private child: ChildProcess | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private restartRetries = 0;
  private isShuttingDown = false;
  private isRestarting = false;
  private readonly hasGit: boolean;

  constructor() {
    this.hasGit = isGitRepo();
    this.setupSignalHandlers();
  }

  // ==================== 生命周期 ====================

  async start(): Promise<void> {
    console.log('🚀 Launcher 启动中...');
    console.log(`📁 工作目录: ${process.cwd()}`);
    if (!this.hasGit) {
      console.log('ℹ️ 非 git 仓库，跳过 git 相关功能');
    }

    await this.forkChild();
  }

  private async forkChild(): Promise<void> {
    if (this.child) {
      console.log('⚠️ 子进程已存在，先停止旧进程');
      await this.killChild();
    }

    console.log('📤 正在启动子进程...');

    this.child = fork(join(__dirname, '../src', 'index.ts'), [], {
      execArgv: ['--import', 'tsx/esm'],
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });

    this.child.on('message', (msg: any) => {
      this.handleChildMessage(msg);
    });

    this.child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal);
    });

    this.child.on('error', (err) => {
      console.error('❌ 子进程错误:', err);
    });

    this.readyTimeout = setTimeout(() => {
      console.error('⏱️ 子进程启动超时（未收到 ready 信号）');
      this.handleStartupFailure(new Error('启动超时'));
    }, READY_TIMEOUT);
  }

  // ==================== 消息处理 ====================

  private handleChildMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ready':
        this.handleChildReady();
        break;
      case 'restart':
        this.handleRestartRequest();
        break;
      case 'error':
        console.error('📨 子进程报告错误:', msg.error);
        break;
      default:
        console.log('📨 收到子进程消息:', msg);
    }
  }

  /**
   * 子进程就绪处理
   * 重启成功且有 git：commit 新代码
   */
  private async handleChildReady(): Promise<void> {
    console.log('✅ 子进程已就绪');

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.restartRetries = 0;

    // 如果有 git 且是重启后，自动 commit
    if (this.isRestarting && this.hasGit) {
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        if (status) {
          console.log('📦 新代码验证通过，自动 commit...');
          execFileSync('git', ['add', '-A'], { stdio: 'inherit' });
          execFileSync('git', ['commit', '-m', 'auto: verified restart commit'], { stdio: 'inherit' });
          console.log('✅ 已 commit');
        }
      } catch (e) {
        console.warn('⚠️ 自动 commit 失败:', e);
      }
    }
  }

  /**
   * 处理重启请求
   */
  private handleRestartRequest(): void {
    console.log('🔄 收到子进程重启请求');
    this.performRestart();
  }

  // ==================== 重启与回滚 ====================

  private async performRestart(): Promise<void> {
    if (this.isRestarting) return;
    this.isRestarting = true;

    console.log('🔄 正在执行重启...');

    try {
      await this.killChild();
      await this.forkChild();
    } finally {
      this.isRestarting = false;
    }
  }

  private handleChildExit(code: number | null, signal: string | null): void {
    console.log(`📤 子进程退出，code: ${code}, signal: ${signal}`);

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.child = null;

    if (this.isShuttingDown || this.isRestarting) return;

    if (code === 0) {
      console.log('🔄 子进程正常退出，准备重启...');
      this.performRestart().catch((err) => {
        console.error('❌ 重启失败:', err);
        this.handleStartupFailure(err);
      });
      return;
    }

    console.log('❌ 子进程异常退出');
    this.handleStartupFailure(new Error(`进程异常退出，code: ${code}`));
  }

  private async handleStartupFailure(error: Error): Promise<void> {
    if (this.restartRetries < MAX_RESTART_RETRIES) {
      this.restartRetries++;
      console.log(`🔄 启动失败，进行第 ${this.restartRetries} 次重试...`);
      await this.forkChild();
      return;
    }

    // 有 git 时尝试回滚，否则直接退出
    if (this.hasGit) {
      console.log('❌ 重启后启动失败，执行回滚...');
      await this.performRollback(error);
    } else {
      console.error('❌ 启动失败，无 git 仓库无法回滚，退出');
      console.error(`   错误: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * 执行回滚：stash 新代码 → 工作区恢复到上次 commit → 用旧代码启动
   * 仅在 git 仓库中执行
   */
  private async performRollback(error: Error): Promise<void> {
    console.log('📦 开始回滚流程...');

    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: 'pipe' }).trim();

      if (status) {
        console.log('📦 git stash push -u 暂存问题代码（含新增文件）...');
        execFileSync('git', ['stash', 'push', '-u', '-m', 'launcher-auto-stash'], { stdio: 'inherit' });
        console.log('✅ 问题代码已暂存到 stash');
      } else {
        console.log('ℹ️ 工作区干净，无需暂存');
      }

      console.log('🔄 使用上次验证通过的代码重新启动...');
      this.restartRetries = 0;
      await this.forkChild();
    } catch (rollbackError) {
      console.error('❌ 回滚流程失败:', rollbackError);
      process.exit(1);
    }
  }

  // ==================== 工具方法 ====================

  private killChild(): Promise<void> {
    if (!this.child) return Promise.resolve();

    return new Promise((resolve) => {
      const child = this.child!;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        this.child = null;
        resolve();
      };

      child.once('exit', cleanup);
      child.kill('SIGTERM');

      const forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          console.log('⚠️ 子进程未响应 SIGTERM，强制终止');
          child.kill('SIGKILL');
        }
        setTimeout(cleanup, 1000);
      }, GRACEFUL_SHUTDOWN_TIMEOUT);
    });
  }

  private setupSignalHandlers(): void {
    process.on('SIGINT', () => {
      console.log('\n🛑 收到 SIGINT，正在关闭...');
      this.shutdown();
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 收到 SIGTERM，正在关闭...');
      this.shutdown();
    });

    process.on('uncaughtException', (err) => {
      console.error('❌ 未捕获的异常:', err);
      this.shutdown(1);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('❌ 未处理的 Promise 拒绝:', reason);
    });
  }

  private async shutdown(exitCode = 0): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.child) {
      await this.killChild();
    }

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
    }

    console.log('✅ Launcher 已关闭');
    process.exit(exitCode);
  }
}

// 启动
const launcher = new Launcher();
launcher.start().catch((err) => {
  console.error('❌ Launcher 启动失败:', err);
  process.exit(1);
});
