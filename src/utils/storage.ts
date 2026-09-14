
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
    static getStats(): AppStats {
        if (!fs.existsSync(config.paths.statsFile)) {
            return this.resetStats();
        }
        try {
            const data = fs.readFileSync(config.paths.statsFile, 'utf8');
            const stats = JSON.parse(data) as AppStats;
            
            // Daily reset check
            const today = new Date().toDateString();
            if (stats.lastResetDate !== today) {
                return this.resetStats(stats.interactedPosts);
            }
            return stats;
        } catch (e) {
            return this.resetStats();
        }
    }

    static saveStats(stats: AppStats) {
        fs.mkdirSync(path.dirname(config.paths.statsFile), { recursive: true });
        fs.writeFileSync(config.paths.statsFile, JSON.stringify(stats, null, 2));
    }

    private static resetStats(history: string[] = []): AppStats {
        const initial = {
            likesToday: 0,
            commentsToday: 0,
            dMsToday: 0,
            lastResetDate: new Date().toDateString(),
            interactedPosts: history.slice(-500) // Keep last 500 to prevent infinite growth
        };
        this.saveStats(initial);
        return initial;
    }

    static addLike() {
        const s = this.getStats(); s.likesToday++; this.saveStats(s);
    }
    static addComment(postId: string) {
        const s = this.getStats(); 
        s.commentsToday++; 
        if(!s.interactedPosts.includes(postId)) s.interactedPosts.push(postId);
        this.saveStats(s);
    }
    static addDM() {
        const s = this.getStats(); s.dMsToday++; this.saveStats(s);
    }
    static hasInteracted(postId: string): boolean {
        return this.getStats().interactedPosts.includes(postId);
    }
}
