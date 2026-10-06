import chalk from 'chalk';
import fs from 'fs';
import { config } from '../config';

export class Logger {
    private accountId?: string;

    constructor(accountId?: string) {
        this.accountId = accountId;
    }

    private static writeToFile(line: string) {
        try {
            fs.appendFileSync(config.paths.logsFile, line + '\n');
        } catch (e) {}
    }

    static info(msg: string, ...args: any[]) {
        const time = new Date().toLocaleTimeString();
        const str = `[${time}] INFO: ${msg}`;
        console.log(chalk.blue(str), ...args);
        this.writeToFile(str);
    }

    static success(msg: string, ...args: any[]) {
        const time = new Date().toLocaleTimeString();
        const str = `[${time}] SUCCESS: ${msg}`;
        console.log(chalk.green(str), ...args);
        this.writeToFile(str);
    }

    static warn(msg: string, ...args: any[]) {
        const time = new Date().toLocaleTimeString();
        const str = `[${time}] WARN: ${msg}`;
        console.log(chalk.yellow(str), ...args);
        this.writeToFile(str);
    }

    static error(msg: string, ...args: any[]) {
        const time = new Date().toLocaleTimeString();
        const str = `[${time}] ERROR: ${msg}`;
        console.log(chalk.red(str), ...args);
        this.writeToFile(str);
    }
    
    static action(action: string, msg: string) {
        const time = new Date().toLocaleTimeString();
        const str = `[${time}] [${action}]: ${msg}`;
        console.log(chalk.cyan(str));
        this.writeToFile(str);
    }

    // Instance methods for dependency injection
    info(msg: string, ...args: any[]) {
        Logger.info(this.prefix(msg), ...args);
    }

    success(msg: string, ...args: any[]) {
        Logger.success(this.prefix(msg), ...args);
    }

    warn(msg: string, ...args: any[]) {
        Logger.warn(this.prefix(msg), ...args);
    }

    error(msg: string, ...args: any[]) {
        Logger.error(this.prefix(msg), ...args);
    }

    action(action: string, msg: string) {
        Logger.action(action, this.prefix(msg));
    }

    private prefix(msg: string): string {
        return this.accountId ? `[${this.accountId}] ${msg}` : msg;
    }
}
