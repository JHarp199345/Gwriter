import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { sha256 } from './ContentHash';

export interface TombstoneEntry {
    runId: string;
    fromPath: string;
    trashedAt: number;
    sizeBytes: number;
    reason: string;
}

export interface TrashIndex {
    entries: TombstoneEntry[];
    lastUpdated: number;
}

/**
 * TrashService manages reversible deletion of run artifacts.
 * Moves runs to .gwriter/trash/ instead of hard deletion.
 */
export class TrashService {
    private readonly vault: Vault;
    private readonly plugin: WritingDashboardPlugin;
    private readonly trashRoot: string = '.gwriter/trash';
    private readonly indexPath: string = `${this.trashRoot}/index.json`;

    constructor(vault: Vault, plugin: WritingDashboardPlugin) {
        this.vault = vault;
        this.plugin = plugin;
    }

    /**
     * Moves a run to trash and creates a tombstone entry.
     */
    async trashRun(runId: string, fromPath: string, reason: string = 'Manual cleanup'): Promise<void> {
        await this.ensureTrashFolder();

        const sourceFolder = this.vault.getAbstractFileByPath(fromPath);
        if (!(sourceFolder instanceof TFolder)) {
            throw new Error(`Run folder not found: ${fromPath}`);
        }

        // Calculate size
        const sizeBytes = await this.calculateFolderSize(sourceFolder);

        // Move to trash
        const trashPath = `${this.trashRoot}/${runId}`;
        try {
            // Note: Obsidian doesn't have a direct "move" API, so we need to copy and delete
            // For now, we'll use adapter methods
            await this.vault.adapter.rename(fromPath, trashPath);
        } catch (err) {
            console.error(`[TrashService] Failed to move run to trash:`, err);
            throw err;
        }

        // Update tombstone index
        await this.addTombstoneEntry({
            runId,
            fromPath,
            trashedAt: Date.now(),
            sizeBytes,
            reason
        });
    }

    /**
     * Restores a run from trash back to its original location.
     */
    async restoreRun(runId: string): Promise<void> {
        const index = await this.readTrashIndex();
        const entry = index.entries.find(e => e.runId === runId);
        if (!entry) {
            throw new Error(`Run ${runId} not found in trash index`);
        }

        const trashPath = `${this.trashRoot}/${runId}`;
        await this.vault.adapter.rename(trashPath, entry.fromPath);

        // Remove from index
        index.entries = index.entries.filter(e => e.runId !== runId);
        index.lastUpdated = Date.now();
        await this.writeTrashIndex(index);
    }

    /**
     * Purges trash entries based on age or size limits.
     */
    async purgeTrash(opts: {
        olderThanDays?: number;
        maxSizeMB?: number;
        keepLatest?: number;
    }): Promise<{ purged: string[]; kept: string[] }> {
        const index = await this.readTrashIndex();
        const now = Date.now();
        const purged: string[] = [];
        const kept: string[] = [];

        // Sort by trashedAt (newest first)
        const sorted = [...index.entries].sort((a, b) => b.trashedAt - a.trashedAt);

        let totalSizeBytes = 0;
        const maxSizeBytes = opts.maxSizeMB ? opts.maxSizeMB * 1024 * 1024 : undefined;

        for (const entry of sorted) {
            const ageDays = (now - entry.trashedAt) / (1000 * 60 * 60 * 24);
            const shouldPurgeByAge = opts.olderThanDays && ageDays > opts.olderThanDays;
            const shouldPurgeBySize = maxSizeBytes && (totalSizeBytes + entry.sizeBytes) > maxSizeBytes;
            const shouldKeep = opts.keepLatest && kept.length < opts.keepLatest;

            const shouldPurge = (shouldPurgeByAge || shouldPurgeBySize) && !shouldKeep;
            if (!shouldPurge) {
                kept.push(entry.runId);
                totalSizeBytes += entry.sizeBytes;
                continue;
            }
            await this.purgeEntry(entry.runId);
            purged.push(entry.runId);
        }

        // Update index with remaining entries
        index.entries = index.entries.filter(e => kept.includes(e.runId));
        index.lastUpdated = Date.now();
        await this.writeTrashIndex(index);

        return { purged, kept };
    }

    /**
     * Lists all runs in trash.
     */
    async listTrash(): Promise<TombstoneEntry[]> {
        const index = await this.readTrashIndex();
        return index.entries;
    }

    private async purgeEntry(runId: string): Promise<void> {
        const trashPath = `${this.trashRoot}/${runId}`;
        try {
            const trashFolder = this.vault.getAbstractFileByPath(trashPath);
            if (trashFolder) {
                await this.vault.delete(trashFolder);
            } else {
                await this.vault.adapter.remove(trashPath);
            }
        } catch (err) {
            console.error(`[TrashService] Failed to purge ${runId}:`, err);
        }
    }

    private async ensureTrashFolder(): Promise<void> {
        const trashFolder = this.vault.getAbstractFileByPath(this.trashRoot);
        if (!(trashFolder instanceof TFolder)) {
            await this.vault.adapter.mkdir(this.trashRoot);
        }
    }

    private async readTrashIndex(): Promise<TrashIndex> {
        try {
            const file = this.vault.getAbstractFileByPath(this.indexPath);
            if (file instanceof TFile) {
                const content = await this.vault.read(file);
                return JSON.parse(content);
            }
        } catch (err) {
            // Index doesn't exist yet
        }
        return { entries: [], lastUpdated: Date.now() };
    }

    private async writeTrashIndex(index: TrashIndex): Promise<void> {
        await this.ensureTrashFolder();
        index.lastUpdated = Date.now();
        await this.vault.adapter.write(this.indexPath, JSON.stringify(index, null, 2));
    }

    private async addTombstoneEntry(entry: TombstoneEntry): Promise<void> {
        const index = await this.readTrashIndex();
        // Remove if exists (shouldn't happen, but be safe)
        index.entries = index.entries.filter(e => e.runId !== entry.runId);
        index.entries.push(entry);
        await this.writeTrashIndex(index);
    }

    private async calculateFolderSize(folder: TFolder): Promise<number> {
        let total = 0;
        for (const child of folder.children) {
            if (child instanceof TFile) {
                total += child.stat.size;
            } else if (child instanceof TFolder) {
                total += await this.calculateFolderSize(child);
            }
        }
        return total;
    }
}

