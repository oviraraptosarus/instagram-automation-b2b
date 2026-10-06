import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { Logger } from './logger';

export class ProcessControl {
  private static getPidDir(): string {
    const pidsDir = path.join(config.paths.dataDir, 'pids');
    if (!fs.existsSync(pidsDir)) {
      fs.mkdirSync(pidsDir, { recursive: true });
    }
    return pidsDir;
  }

  /**
   * Save running process PID for a given worker/daemon.
   */
  static savePid(name: string, pid: number = process.pid): void {
    const pidFile = path.join(this.getPidDir(), `${name}.pid`);
    fs.writeFileSync(pidFile, String(pid), 'utf8');
    Logger.info(`[ProcessControl] Saved PID ${pid} to ${pidFile}`);
  }

  /**
   * Read stored PID for a given process name.
   */
  static getPid(name: string): number | null {
    const pidFile = path.join(this.getPidDir(), `${name}.pid`);
    if (!fs.existsSync(pidFile)) return null;
    try {
      const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
      return parseInt(pidStr, 10);
    } catch (e) {
      return null;
    }
  }

  /**
   * Stop specific process gracefully by PID without using broad taskkill.
   */
  static killProcess(name: string): boolean {
    const pid = this.getPid(name);
    if (!pid) {
      Logger.warn(`[ProcessControl] No PID file found for process "${name}"`);
      return false;
    }

    try {
      process.kill(pid, 'SIGTERM');
      Logger.success(`[ProcessControl] Gracefully terminated process "${name}" (PID: ${pid})`);
      this.removePid(name);
      return true;
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        Logger.info(`[ProcessControl] Process "${name}" (PID: ${pid}) was not running.`);
        this.removePid(name);
        return true;
      }
      Logger.error(`[ProcessControl] Failed to stop process "${name}" (PID: ${pid}): ${err.message}`);
      return false;
    }
  }

  /**
   * Clean up PID file on exit.
   */
  static removePid(name: string): void {
    const pidFile = path.join(this.getPidDir(), `${name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        fs.unlinkSync(pidFile);
      } catch (e) {}
    }
  }
}
