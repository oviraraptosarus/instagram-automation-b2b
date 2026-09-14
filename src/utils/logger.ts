
import chalk from 'chalk';
import fs from 'fs';
import { config } from '../config';

export class Logger {
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
}
