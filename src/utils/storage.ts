import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface AppStats {
    likesToday: number;
    commentsToday: number;
    dMsToday: number;
    lastResetDate: string;
    interactedPosts: string[]; // Store post IDs to avoid duplicates
}

export class Storage {
    private customStatsFile?: string;

    constructor(statsFile?: string) {
        this.customStatsFile = statsFile;
    }

    private get statsFilePath(): string {
        return this.customStatsFile || config.paths.statsFile;
    }

    static getStats(filePath?: string): AppStats {
        const targetPath = filePath || config.paths.statsFile;
        if (!fs.existsSync(targetPath)) {
            return this.resetStats([], targetPath);
        }
        try {
            const data = fs.readFileSync(targetPath, 'utf8');
            const stats = JSON.parse(data) as AppStats;
            
            // Daily reset check
            const today = new Date().toDateString();
            if (stats.lastResetDate !== today) {
                return this.resetStats(stats.interactedPosts, targetPath);
            }
            return stats;
        } catch (e) {
            return this.resetStats([], targetPath);
        }
    }

    static saveStats(stats: AppStats, filePath?: string) {
        const targetPath = filePath || config.paths.statsFile;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, JSON.stringify(stats, null, 2));
    }

    private static resetStats(history: string[] = [], filePath?: string): AppStats {
        const initial = {
            likesToday: 0,
            commentsToday: 0,
            dMsToday: 0,
            lastResetDate: new Date().toDateString(),
            interactedPosts: history.slice(-500) // Keep last 500 to prevent infinite growth
        };
        this.saveStats(initial, filePath);
        return initial;
    }

    static addLike(filePath?: string) {
        const s = this.getStats(filePath); s.likesToday++; this.saveStats(s, filePath);
    }
    static addComment(postId: string, filePath?: string) {
        const s = this.getStats(filePath); 
        s.commentsToday++; 
        if(!s.interactedPosts.includes(postId)) s.interactedPosts.push(postId);
        this.saveStats(s, filePath);
    }
    static addDM(filePath?: string) {
        const s = this.getStats(filePath); s.dMsToday++; this.saveStats(s, filePath);
    }
    static hasInteracted(postId: string, filePath?: string): boolean {
        return this.getStats(filePath).interactedPosts.includes(postId);
    }

    // Instance methods for dependency injection
    getStats(): AppStats {
        return Storage.getStats(this.statsFilePath);
    }
    saveStats(stats: AppStats): void {
        Storage.saveStats(stats, this.statsFilePath);
    }
    addLike(): void {
        Storage.addLike(this.statsFilePath);
    }
    addComment(postId: string): void {
        Storage.addComment(postId, this.statsFilePath);
    }
    addDM(): void {
        Storage.addDM(this.statsFilePath);
    }
    hasInteracted(postId: string): boolean {
        return Storage.hasInteracted(postId, this.statsFilePath);
    }
}
